import crypto from "node:crypto";
import { chatTitle, mobileText } from "../services/personName.js";
import { assertRoomForContacts, assertImportFits, contactCount, roomForContacts } from "../services/limitsService.js";
import express from "express";
import {
  authenticateToken,
  requireTenantContext,
  requireScope,
  requireWriteAccess,
  requireRole,
} from "../middleware/auth.js";
import { audienceFor, recordPermission } from "../services/campaignService.js";
import { query, withTransaction } from "../db/index.js";
import { defaultWhatsAppProvider as provider } from "../services/whatsapp/WhatsAppProvider.js";
import { route, text, fail } from "../middleware/http.js";
import { normalizePhone, displayPhone, PHONE_HELP } from "../services/phone.js";
import { setContactLabels, setContactTags } from "../services/labelService.js";
import { avatarUrl } from "../services/avatarService.js";
const router = express.Router();
router.use(authenticateToken, requireTenantContext, requireScope("contacts"));
router.use(requireWriteAccess);
// Labels come with the contact when the query joins them in; the name WhatsApp shows is kept apart from the name
// the company gave the person.
const LABELS_OF = `COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'color',l.color) ORDER BY lower(l.name)) FROM contact_labels cl JOIN labels l ON l.id=cl.label_id WHERE cl.contact_id=contacts.id),'[]'::jsonb) AS labels`;
const CONSENT_OF = "(SELECT opt_in_status FROM consents WHERE tenant_id=contacts.tenant_id AND phone=contacts.phone) AS opt_in_status";
export const contactView = (c) => ({
  ...c,
  name: chatTitle(c.name, c.phone),
  displayPhone: mobileText(c.phone),
  avatar: (/^\d{6,20}$/.test(c.phone || "") && avatarUrl("contact", c)) || c.avatar || "",
  tags: Array.isArray(c.tags) ? c.tags : [],
  labels: Array.isArray(c.labels) ? c.labels : [],
  whatsappName: c.whatsapp_name || "",
  nameEdited: Boolean(c.name_edited),
  optIn: Boolean(c.opt_in_status),
  customTraits: c.custom_traits || {},
  assignedAgent: c.assigned_agent || "",
  lifetimeValue: null,
  storeConnected: false,
  orders: [],
  notes: [],
  channel: null,
  lastSeen: null,
  createdAt: c.created_at,
});
export async function syncContacts(tenantId, sessionName) {
  const contacts = await provider.getContacts(tenantId, sessionName);
  const byPhone = new Map();
  for (const c of contacts) {
    const phone = String(c.id?._serialized || c.id || "").replace(
      /@c\.us$/,
      "",
    );
    if (!phone || phone.endsWith("@g.us")) continue;
    byPhone.set(phone, {
      phone,
      name: c.name || c.pushname || c.verifiedName || phone,
      avatar: c.profilePicThumbObj?.eurl || "",
    });
  }
  // One statement per 500 contacts instead of one per contact. A company at its plan's contact limit still gets the
  // people it has updated, but no new ones are added from the phone.
  const all = [...byPhone.values()];
  let room = await roomForContacts(tenantId);
  let skipped = 0;
  for (let i = 0; i < all.length; i += 500) {
    let chunk = all.slice(i, i + 500);
    if (room !== null) {
      const have = new Set((await query("SELECT phone FROM contacts WHERE tenant_id=$1 AND phone = ANY($2::text[])", [tenantId, chunk.map((c) => c.phone)])).rows.map((r) => r.phone));
      const fresh = chunk.filter((c) => !have.has(c.phone));
      const take = new Set(fresh.slice(0, room).map((c) => c.phone));
      room -= take.size;
      skipped += fresh.length - take.size;
      chunk = chunk.filter((c) => have.has(c.phone) || take.has(c.phone));
    }
    if (!chunk.length) continue;
    await query(
      // WhatsApp's name is kept in whatsapp_name; the name a person on the team typed is never overwritten, and a
      // real name is never replaced by the bare number.
      `INSERT INTO contacts(id,tenant_id,name,whatsapp_name,phone,avatar)
       SELECT gen_random_uuid()::text,$1,x.name,x.name,x.phone,x.avatar FROM unnest($2::text[],$3::text[],$4::text[]) AS x(name,phone,avatar)
       ON CONFLICT(tenant_id,phone) DO UPDATE SET
         whatsapp_name=CASE WHEN EXCLUDED.name=EXCLUDED.phone THEN contacts.whatsapp_name ELSE EXCLUDED.name END,
         name=CASE WHEN contacts.name_edited THEN contacts.name WHEN EXCLUDED.name=EXCLUDED.phone AND contacts.name<>contacts.phone THEN contacts.name ELSE EXCLUDED.name END,
         avatar=COALESCE(NULLIF(EXCLUDED.avatar,''),contacts.avatar),updated_at=now()`,
      [
        tenantId,
        chunk.map((c) => c.name),
        chunk.map((c) => c.phone),
        chunk.map((c) => c.avatar),
      ],
    );
  }
  if (skipped) console.warn(`Contact sync: ${skipped} new contacts were not added because the plan's contact limit is reached`);
  return all.length - skipped;
}
const audit = (client, req, event, metadata) =>
  client.query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,$3,$4)", [req.tenantId, req.user?.id ?? null, event, JSON.stringify(metadata)]);
const changed = (req, contactIds = []) => {
  const io = req.app.get("io");
  io?.to(`tenant:${req.tenantId}`).emit("contact:changed", { contactId: contactIds[0] || null, contactIds });
};

router.get(
  "/",
  route(async (req, res) => {
    const params = [req.tenantId],
      filters = [];
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    if (req.query.cursor) {
      params.push(String(req.query.cursor));
      filters.push(`id>$${params.length}`);
    }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      filters.push(
        `(name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`,
      );
    }
    // ?label=id1,id2 keeps contacts with any of them (or all of them with ?labelMode=all); ?label=none keeps unlabelled ones
    const wanted = String(req.query.label || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (wanted.length === 1 && wanted[0] === "none") filters.push("NOT EXISTS (SELECT 1 FROM contact_labels cl WHERE cl.contact_id=contacts.id)");
    else if (wanted.length) {
      params.push(wanted);
      filters.push(
        req.query.labelMode === "all"
          ? `(SELECT count(DISTINCT cl.label_id) FROM contact_labels cl WHERE cl.contact_id=contacts.id AND cl.tenant_id=contacts.tenant_id AND cl.label_id = ANY($${params.length}::text[])) = ${new Set(wanted).size}`
          : `EXISTS (SELECT 1 FROM contact_labels cl WHERE cl.contact_id=contacts.id AND cl.tenant_id=contacts.tenant_id AND cl.label_id = ANY($${params.length}::text[]))`,
      );
    }
    const { rows } = await query(
      `SELECT contacts.*,${CONSENT_OF},${LABELS_OF} FROM contacts WHERE tenant_id=$1${filters.length ? " AND " + filters.join(" AND ") : ""} ORDER BY id LIMIT $${params.length + 1}`,
      [...params, limit + 1],
    );
    const items = rows.slice(0, limit);
    res.json({
      status: "success",
      contacts: items.map(contactView),
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit ? items.at(-1).id : null,
    });
  }),
);
// Before a chat is started with a typed number: is it a full number, and do we already know the person?
router.get(
  "/lookup",
  route(async (req, res) => {
    const phone = normalizePhone(req.query.phone);
    if (!phone) return res.json({ status: "success", valid: false, message: PHONE_HELP });
    const { rows } = await query(
      `SELECT contacts.*,${CONSENT_OF},${LABELS_OF} FROM contacts WHERE tenant_id=$1 AND phone = ANY($2::text[]) ORDER BY (phone=$3) DESC LIMIT 1`,
      [req.tenantId, [phone, `+${phone}`], phone],
    );
    res.json({ status: "success", valid: true, phone, display: displayPhone(phone), contact: rows[0] ? contactView(rows[0]) : null });
  }),
);
router.get(
  "/:id",
  route(async (req, res) => {
    const { rows } = await query(
      `SELECT contacts.*,${CONSENT_OF},${LABELS_OF} FROM contacts WHERE tenant_id=$1 AND id=$2`,
      [req.tenantId, req.params.id],
    );
    if (!rows[0]) throw fail(404, "Contact not found");
    res.json({ status: "success", contact: contactView(rows[0]) });
  }),
);
// The owner confirms that the people in a group agreed to hear from the business. It only covers contacts nobody
// has decided on: someone who said STOP, or was marked as not wanting messages, is left alone.
router.post(
  "/permission",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    if (req.body.confirm !== true) throw fail(400, "Confirm that these contacts agreed to receive your messages");
    const tag = req.body.tag ? text(String(req.body.tag), "Tag", 255) : "All Contacts";
    const recorded = await recordPermission(req.tenantId, tag, req.user.id);
    res.json({ status: "success", recorded, audience: await audienceFor(req.tenantId, tag) });
  }),
);
router.post(
  "/import",
  route(async (req, res) => {
    const rows = req.body.rows;
    if (!Array.isArray(rows) || !rows.length || rows.length > 200)
      throw fail(400, "Import 1–200 rows per batch");
    const skipped = [];
    let imported = 0;
    const touched = [];
    await withTransaction(async (c) => {
      const db = (sql, params) => c.query(sql, params);
      const before = await contactCount(req.tenantId, db);
      for (const row of rows) {
        // One row at a time: a row that cannot be used is reported and the rest of the file still goes in.
        await c.query("SAVEPOINT import_row");
        try {
          const name = text(row.name, "Name", 255),
            phone = normalizePhone(row.phone);
          if (!phone) throw fail(400, PHONE_HELP);
          const saved = await c.query(
            // A name in the file is a person on the team deciding what to call them, so it is kept like a typed name.
            `INSERT INTO contacts(id,tenant_id,name,phone,email,name_edited) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(tenant_id,phone) DO UPDATE SET name=EXCLUDED.name,name_edited=true,email=CASE WHEN EXCLUDED.email<>'' THEN EXCLUDED.email ELSE contacts.email END,updated_at=now() RETURNING id`,
            [crypto.randomUUID(), req.tenantId, name, phone, row.email || ""],
          );
          const id = saved.rows[0].id;
          touched.push(id);
          // A file without tags must not wipe the labels a contact already has.
          const tags = String(row.tags || "").split(";").map((t) => t.trim()).filter(Boolean);
          if (tags.length) await setContactTags(c, req.tenantId, id, tags, req.user?.id);
          // An "optin" column records permission. "yes" never overrides what a customer already decided (a
          // STOP stays a STOP); "no" always withdraws it.
          const said = String(row.optin ?? "").trim().toLowerCase();
          if (["yes", "y", "true", "1"].includes(said))
            await c.query(
              "INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,$2,true,'csv_import') ON CONFLICT(tenant_id,phone) DO NOTHING",
              [req.tenantId, phone],
            );
          else if (["no", "n", "false", "0"].includes(said))
            await c.query(
              "INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,$2,false,'csv_import') ON CONFLICT(tenant_id,phone) DO UPDATE SET opt_in_status=false,source='csv_import',consented_at=now()",
              [req.tenantId, phone],
            );
          await c.query("UPDATE conversations SET contact_name=$3 WHERE tenant_id=$1 AND contact_id=$2 AND NOT is_group", [req.tenantId, id, name]);
          await c.query("RELEASE SAVEPOINT import_row");
          imported += 1;
        } catch (e) {
          await c.query("ROLLBACK TO SAVEPOINT import_row");
          if (!e.status) throw e;
          skipped.push({ name: String(row?.name ?? "").slice(0, 60), phone: String(row?.phone ?? "").slice(0, 40), reason: e.message });
        }
      }
      // over the plan's contact limit: this batch is not saved at all, and the message says why
      await assertImportFits(req.tenantId, before, db);
    });
    changed(req, touched);
    res.json({ status: "success", imported, skipped: skipped.slice(0, 50), skippedCount: skipped.length });
  }),
);
router.post(
  "/",
  route(async (req, res) => {
    const name = text(req.body.name, "Name", 255);
    const phone = normalizePhone(req.body.phone);
    if (!phone) throw fail(400, PHONE_HELP);
    if (req.body.tags !== undefined && (!Array.isArray(req.body.tags) || req.body.tags.some((t) => typeof t !== "string")))
      throw fail(400, "Tags must be an array of strings");
    // A number is one person in a company. Saving it again does not overwrite the name: the existing contact is
    // pointed out so it can be opened or edited instead.
    const known = await query("SELECT id,name,phone FROM contacts WHERE tenant_id=$1 AND phone = ANY($2::text[]) LIMIT 1", [req.tenantId, [phone, `+${phone}`]]);
    if (known.rows[0])
      return res.status(409).json({
        status: "error",
        message: `${displayPhone(phone)} is already saved as "${known.rows[0].name}"`,
        contactId: known.rows[0].id,
      });
    await assertRoomForContacts(req.tenantId, 1);
    const contact = await withTransaction(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO contacts(id,tenant_id,name,phone,email,custom_traits,name_edited) VALUES($1,$2,$3,$4,$5,$6,true) RETURNING *`,
        [crypto.randomUUID(), req.tenantId, name, phone, req.body.email || "", JSON.stringify(req.body.customTraits || {})],
      );
      if (Array.isArray(req.body.labelIds) && req.body.labelIds.length) await setContactLabels(c, req.tenantId, rows[0].id, req.body.labelIds);
      else if (req.body.tags?.length) await setContactTags(c, req.tenantId, rows[0].id, req.body.tags, req.user?.id);
      const full = await c.query(`SELECT contacts.*,${LABELS_OF} FROM contacts WHERE id=$1`, [rows[0].id]);
      return contactView(full.rows[0]);
    });
    changed(req, [contact.id]);
    res.status(201).json({ status: "success", contact });
  }),
);
router.patch(
  "/:id",
  route(async (req, res) => {
    const body = req.body || {};
    if (body.tags && (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== "string")))
      throw fail(400, "Tags must be an array of strings");
    if (body.labelIds !== undefined && !Array.isArray(body.labelIds)) throw fail(400, "labelIds must be a list");
    const contact = await withTransaction(async (c) => {
      const current = await c.query("SELECT * FROM contacts WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [req.params.id, req.tenantId]);
      const before = current.rows[0];
      if (!before) throw fail(404, "Contact not found");
      // The CRM name is whatever the team decided. Typing the name WhatsApp shows hands the name back to WhatsApp.
      let name = before.name,
        edited = before.name_edited;
      if (body.resetName === true) {
        name = before.whatsapp_name || before.name;
        edited = false;
      } else if (body.name !== undefined) {
        const typed = text(String(body.name), "Name", 255);
        if (typed !== before.name) {
          name = typed;
          edited = typed !== before.whatsapp_name;
        }
      }
      const { rows } = await c.query(
        `UPDATE contacts SET name=$1,name_edited=$2,email=COALESCE($3,email),custom_traits=COALESCE($4,custom_traits),updated_at=now() WHERE id=$5 AND tenant_id=$6 RETURNING *`,
        [name, edited, body.email ?? null, body.customTraits ? JSON.stringify(body.customTraits) : null, req.params.id, req.tenantId],
      );
      if (Array.isArray(body.labelIds)) await setContactLabels(c, req.tenantId, req.params.id, body.labelIds);
      else if (body.tags) await setContactTags(c, req.tenantId, req.params.id, body.tags, req.user?.id);
      if (name !== before.name) {
        // the chat list shows the same name, and every chat with this person follows it
        await c.query("UPDATE conversations SET contact_name=$3,updated_at=now() WHERE tenant_id=$1 AND contact_id=$2 AND NOT is_group", [req.tenantId, req.params.id, name]);
        await audit(c, req, "contact.renamed", { contactId: req.params.id, phone: before.phone, from: before.name, to: name, whatsappName: before.whatsapp_name || null });
      }
      if (typeof body.optIn === "boolean")
        await c.query(
          `INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,$2,$3,'workspace_recorded') ON CONFLICT(tenant_id,phone) DO UPDATE SET opt_in_status=EXCLUDED.opt_in_status,consented_at=now()`,
          [req.tenantId, rows[0].phone, body.optIn],
        );
      const full = await c.query(`SELECT contacts.*,${CONSENT_OF},${LABELS_OF} FROM contacts WHERE id=$1`, [req.params.id]);
      return contactView(full.rows[0]);
    });
    changed(req, [contact.id]);
    res.json({ status: "success", contact });
  }),
);
router.delete(
  "/:id",
  route(async (req, res) => {
    const gone = await query("DELETE FROM contacts WHERE id=$1 AND tenant_id=$2 RETURNING name,phone", [req.params.id, req.tenantId]);
    if (gone.rows[0])
      await query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'contact.deleted',$3)", [
        req.tenantId,
        req.user?.id ?? null,
        JSON.stringify({ contactId: req.params.id, name: gone.rows[0].name, phone: gone.rows[0].phone }),
      ]);
    changed(req, [req.params.id]);
    res.json({ status: "success" });
  }),
);
export default router;
