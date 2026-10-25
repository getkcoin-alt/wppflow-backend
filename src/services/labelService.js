import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { fail } from "../middleware/http.js";

// Labels are the company's own, coloured, and many to a contact. contacts.tags stays as a copy of a contact's label
// names, so broadcasts, exports and anything older that reads tags keep working; every writer goes through here.
export const LABEL_COLORS = ["slate", "red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink"];
export const MAX_LABELS = 200;
export const MAX_BULK = 500;

const colorFor = (name) => LABEL_COLORS[[...name.toLowerCase()].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 7) % LABEL_COLORS.length];
export function cleanName(value) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 40) throw fail(400, "A label needs a name of up to 40 characters");
  return name;
}
// Tags typed in a spreadsheet or set by a rule can be longer than a label name allows: they are shortened, not refused.
const implicitName = (value) => cleanName(String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 40));
const cleanColor = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (!LABEL_COLORS.includes(value)) throw fail(400, `Choose a colour: ${LABEL_COLORS.join(", ")}`);
  return value;
};
export const labelView = (r) => ({ id: r.id, name: r.name, color: r.color });

export async function listLabels(tenantId) {
  const { rows } = await query(
    `SELECT l.id,l.name,l.color,(SELECT count(*)::int FROM contact_labels cl WHERE cl.label_id=l.id) AS contacts
     FROM labels l WHERE l.tenant_id=$1 ORDER BY lower(l.name)`,
    [tenantId],
  );
  return rows.map((r) => ({ ...labelView(r), contacts: r.contacts }));
}

// The label with this name (any capitalisation), made if it is new.
async function findOrCreate(client, tenantId, name, { color, actorId = null } = {}) {
  const found = await client.query("SELECT * FROM labels WHERE tenant_id=$1 AND lower(name)=lower($2)", [tenantId, name]);
  if (found.rows[0]) return { label: found.rows[0], created: false };
  const count = await client.query("SELECT count(*)::int AS n FROM labels WHERE tenant_id=$1", [tenantId]);
  if (count.rows[0].n >= MAX_LABELS) throw fail(400, `A company can have up to ${MAX_LABELS} labels. Delete one you no longer use.`);
  const { rows } = await client.query(
    "INSERT INTO labels(id,tenant_id,name,color,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *",
    [crypto.randomUUID(), tenantId, name, color || colorFor(name), actorId],
  );
  if (rows[0]) return { label: rows[0], created: true };
  // someone created the same name a moment ago
  return { label: (await client.query("SELECT * FROM labels WHERE tenant_id=$1 AND lower(name)=lower($2)", [tenantId, name])).rows[0], created: false };
}

export async function createLabel(tenantId, { name, color }, actorId) {
  const clean = cleanName(name);
  const wanted = cleanColor(color, undefined);
  const { label, created } = await withTransaction((c) => findOrCreate(c, tenantId, clean, { color: wanted, actorId }));
  if (!created) throw fail(409, `There is already a label called "${label.name}"`);
  return labelView(label);
}

// Makes contacts.tags match the contacts' labels.
export async function resyncTags(client, tenantId, contactIds) {
  if (!contactIds.length) return;
  await client.query(
    `UPDATE contacts SET tags=COALESCE((SELECT jsonb_agg(l.name ORDER BY lower(l.name)) FROM contact_labels cl JOIN labels l ON l.id=cl.label_id WHERE cl.contact_id=contacts.id),'[]'::jsonb)
     WHERE tenant_id=$1 AND id = ANY($2::text[])`,
    [tenantId, contactIds],
  );
}

async function ownLabels(client, tenantId, ids) {
  const wanted = [...new Set((ids || []).map(String))];
  if (!wanted.length) return [];
  const { rows } = await client.query("SELECT * FROM labels WHERE tenant_id=$1 AND id = ANY($2::text[])", [tenantId, wanted]);
  if (rows.length !== wanted.length) throw fail(404, "Label not found");
  return rows;
}

// The contact has exactly these labels.
export async function setContactLabels(client, tenantId, contactId, labelIds) {
  const labels = await ownLabels(client, tenantId, labelIds);
  await client.query("DELETE FROM contact_labels WHERE contact_id=$1 AND tenant_id=$2 AND NOT (label_id = ANY($3::text[]))", [contactId, tenantId, labels.map((l) => l.id)]);
  if (labels.length)
    await client.query(
      "INSERT INTO contact_labels(contact_id,label_id,tenant_id) SELECT $1,x,$2 FROM unnest($3::text[]) AS x ON CONFLICT DO NOTHING",
      [contactId, tenantId, labels.map((l) => l.id)],
    );
  await resyncTags(client, tenantId, [contactId]);
}

// The contact has exactly the labels with these names; names that are new become labels.
export async function setContactTags(client, tenantId, contactId, names, actorId = null) {
  const wanted = new Map();
  for (const n of names || []) {
    const clean = implicitName(n);
    wanted.set(clean.toLowerCase(), clean);
  }
  const ids = [];
  for (const name of wanted.values()) ids.push((await findOrCreate(client, tenantId, name, { actorId })).label.id);
  await setContactLabels(client, tenantId, contactId, ids);
}

export async function addContactTag(client, tenantId, contactId, name) {
  const { label } = await findOrCreate(client, tenantId, implicitName(name));
  await client.query("INSERT INTO contact_labels(contact_id,label_id,tenant_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [contactId, label.id, tenantId]);
  await resyncTags(client, tenantId, [contactId]);
}

export async function updateLabel(tenantId, id, patch) {
  return withTransaction(async (c) => {
    const found = await c.query("SELECT * FROM labels WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [id, tenantId]);
    if (!found.rows[0]) throw fail(404, "Label not found");
    const name = patch.name === undefined ? found.rows[0].name : cleanName(patch.name);
    const color = cleanColor(patch.color, found.rows[0].color);
    if (name.toLowerCase() !== found.rows[0].name.toLowerCase()) {
      const clash = await c.query("SELECT 1 FROM labels WHERE tenant_id=$1 AND lower(name)=lower($2) AND id<>$3", [tenantId, name, id]);
      if (clash.rowCount) throw fail(409, `There is already a label called "${name}"`);
    }
    const { rows } = await c.query("UPDATE labels SET name=$3,color=$4,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *", [id, tenantId, name, color]);
    const who = await c.query("SELECT contact_id FROM contact_labels WHERE label_id=$1 AND tenant_id=$2", [id, tenantId]);
    await resyncTags(c, tenantId, who.rows.map((r) => r.contact_id));
    return { label: labelView(rows[0]), renamedFrom: name !== found.rows[0].name ? found.rows[0].name : null, contactIds: who.rows.map((r) => r.contact_id) };
  });
}

export async function deleteLabel(tenantId, id) {
  return withTransaction(async (c) => {
    const found = await c.query("SELECT * FROM labels WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [id, tenantId]);
    if (!found.rows[0]) throw fail(404, "Label not found");
    const who = await c.query("SELECT contact_id FROM contact_labels WHERE label_id=$1 AND tenant_id=$2", [id, tenantId]);
    await c.query("DELETE FROM labels WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
    await resyncTags(c, tenantId, who.rows.map((r) => r.contact_id));
    return { label: labelView(found.rows[0]), contactIds: who.rows.map((r) => r.contact_id) };
  });
}

// Adds and removes labels on many contacts at once.
export async function applyLabels(tenantId, { contactIds, add = [], remove = [] }) {
  const ids = [...new Set((contactIds || []).map(String))];
  if (!ids.length) throw fail(400, "Choose at least one contact");
  if (ids.length > MAX_BULK) throw fail(400, `Choose up to ${MAX_BULK} contacts at a time`);
  if (!Array.isArray(add) || !Array.isArray(remove) || (!add.length && !remove.length)) throw fail(400, "Choose a label to add or remove");
  return withTransaction(async (c) => {
    const owned = await c.query("SELECT id FROM contacts WHERE tenant_id=$1 AND id = ANY($2::text[])", [tenantId, ids]);
    if (owned.rowCount !== ids.length) throw fail(404, "Contact not found");
    const adding = await ownLabels(c, tenantId, add);
    const removing = await ownLabels(c, tenantId, remove);
    if (adding.length)
      await c.query(
        "INSERT INTO contact_labels(contact_id,label_id,tenant_id) SELECT x.contact,y.label,$1 FROM unnest($2::text[]) AS x(contact) CROSS JOIN unnest($3::text[]) AS y(label) ON CONFLICT DO NOTHING",
        [tenantId, ids, adding.map((l) => l.id)],
      );
    if (removing.length)
      await c.query("DELETE FROM contact_labels WHERE tenant_id=$1 AND contact_id = ANY($2::text[]) AND label_id = ANY($3::text[])", [tenantId, ids, removing.map((l) => l.id)]);
    await resyncTags(c, tenantId, ids);
    return { updated: ids.length, added: adding.map(labelView), removed: removing.map(labelView) };
  });
}
