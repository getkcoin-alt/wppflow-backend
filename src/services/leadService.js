import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { fail } from "../middleware/http.js";
import { isManager } from "./access.js";
import { createNotifications } from "./notificationService.js";
import { emitForLead } from "./realtime.js";

// ── The pipeline ─────────────────────────────────────────────────────────────────────────────────
// Every preset has five open steps and then the two that end a lead, so switching preset only renames steps.
export const PRESETS = {
  general: { name: "General sales", stages: ["New", "Contacted", "Qualified", "Proposal", "Negotiation"], won: "Won", lost: "Lost" },
  real_estate: { name: "Real estate", stages: ["New enquiry", "Contacted", "Viewing booked", "Offer made", "Negotiation"], won: "Deal closed", lost: "Lost" },
  auto: { name: "Car dealer", stages: ["New enquiry", "Contacted", "Test drive booked", "Quotation sent", "Negotiation"], won: "Sold", lost: "Lost" },
  clinic: { name: "Clinic", stages: ["New enquiry", "Contacted", "Appointment booked", "Consultation done", "Treatment planned"], won: "Converted", lost: "Lost" },
};
export const CURRENCIES = ["AED", "INR"];
export const SOURCES = ["manual", "chat", "automation", "import", "api"];
const MAX_OPEN_STAGES = 8;

export const presetList = () => Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, stages: [...p.stages, p.won, p.lost] }));

// A company's pipeline is made the first time anyone needs it, from the general preset.
export async function ensurePipeline(tenantId, preset = "general") {
  const found = (await query("SELECT * FROM pipelines WHERE tenant_id=$1", [tenantId])).rows[0];
  if (found) return found;
  const chosen = PRESETS[preset] || PRESETS.general;
  return withTransaction(async (c) => {
    const id = crypto.randomUUID();
    const made = await c.query(
      "INSERT INTO pipelines(id,tenant_id,name,preset) VALUES($1,$2,'Sales',$3) ON CONFLICT(tenant_id) DO NOTHING RETURNING *",
      [id, tenantId, PRESETS[preset] ? preset : "general"],
    );
    if (!made.rows[0]) return (await c.query("SELECT * FROM pipelines WHERE tenant_id=$1", [tenantId])).rows[0];
    const names = [...chosen.stages.map((n) => [n, "open"]), [chosen.won, "won"], [chosen.lost, "lost"]];
    for (const [i, [name, kind]] of names.entries())
      await c.query("INSERT INTO pipeline_stages(id,tenant_id,pipeline_id,name,kind,position) VALUES($1,$2,$3,$4,$5,$6)", [crypto.randomUUID(), tenantId, id, name, kind, i]);
    return made.rows[0];
  });
}

export const stagesOf = async (pipelineId) =>
  (await query("SELECT id,name,kind,position FROM pipeline_stages WHERE pipeline_id=$1 ORDER BY position", [pipelineId])).rows;

const stageView = (s) => ({ id: s.id, name: s.name, kind: s.kind, position: s.position });

// ── Who can see which lead ───────────────────────────────────────────────────────────────────────
// The same rule as the inbox: managers see every lead; staff see the leads they own and the leads on the
// WhatsApp numbers they paired themselves.
export function visibleTo(req, params) {
  if (isManager(req)) return "TRUE";
  params.push(req.user.id);
  const p = `$${params.length}`;
  return `(l.owner_user_id=${p} OR EXISTS (SELECT 1 FROM whatsapp_sessions ws WHERE ws.tenant_id=l.tenant_id AND ws.session_name=l.session_name AND ws.owner_user_id=${p}))`;
}

const SELECT = `SELECT l.*,s.name AS stage_name,s.kind AS stage_kind,u.name AS owner_name,
    COALESCE(NULLIF(ct.name,''),NULLIF(l.contact_name,''),l.phone) AS display_name,ct.tags AS contact_tags,ct.email AS contact_email,
    cv.id AS conversation_id,cv.last_message,cv.last_active_epoch,cv.unread_count,
    (SELECT count(*)::int FROM lead_tasks t WHERE t.lead_id=l.id AND t.done_at IS NULL) AS open_tasks,
    nt.id AS next_task_id,nt.title AS next_task_title,nt.due_at AS next_task_due
  FROM leads l
  JOIN pipeline_stages s ON s.id=l.stage_id
  LEFT JOIN users u ON u.id=l.owner_user_id
  LEFT JOIN contacts ct ON ct.id=l.contact_id
  LEFT JOIN LATERAL (SELECT c.id,c.last_message,c.last_active_epoch,c.unread_count FROM conversations c
    WHERE c.tenant_id=l.tenant_id AND c.contact_id=l.contact_id AND (l.session_name IS NULL OR c.session_name=l.session_name)
    ORDER BY c.last_active_epoch DESC LIMIT 1) cv ON true
  LEFT JOIN LATERAL (SELECT t.id,t.title,t.due_at FROM lead_tasks t WHERE t.lead_id=l.id AND t.done_at IS NULL ORDER BY t.due_at LIMIT 1) nt ON true`;

export const leadView = (r) => ({
  id: r.id,
  title: r.title || r.display_name,
  contactId: r.contact_id,
  contactName: r.display_name,
  phone: r.phone,
  email: r.contact_email || "",
  tags: Array.isArray(r.contact_tags) ? r.contact_tags : [],
  sessionName: r.session_name,
  conversationId: r.conversation_id || null,
  stageId: r.stage_id,
  stageName: r.stage_name,
  stageKind: r.stage_kind,
  status: r.status,
  value: Number(r.value),
  source: r.source,
  ownerUserId: r.owner_user_id,
  ownerName: r.owner_name || "",
  lostReason: r.lost_reason,
  expectedClose: r.expected_close ? new Date(r.expected_close).toISOString().slice(0, 10) : null,
  stageChangedAt: r.stage_changed_at,
  closedAt: r.closed_at,
  createdAt: r.created_at,
  lastMessage: r.last_message?.text ? { text: String(r.last_message.text).slice(0, 140), fromMe: Boolean(r.last_message.fromMe), at: r.last_active_epoch ? Number(r.last_active_epoch) : null } : null,
  unread: r.unread_count || 0,
  openTasks: r.open_tasks || 0,
  nextTask: r.next_task_id ? { id: r.next_task_id, title: r.next_task_title, dueAt: r.next_task_due } : null,
});

export async function findLead(req, id) {
  const params = [req.tenantId, id];
  const { rows } = await query(`${SELECT} WHERE l.tenant_id=$1 AND l.id=$2 AND ${visibleTo(req, params)}`, params);
  if (!rows[0]) throw fail(404, "Lead not found");
  return rows[0];
}

// ── The board and the list ───────────────────────────────────────────────────────────────────────
const PER_COLUMN = 30;
function filterSql(req, params, f) {
  const where = ["l.tenant_id=$1", visibleTo(req, params)];
  if (f.ownerId === "none") where.push("l.owner_user_id IS NULL");
  else if (f.ownerId) {
    params.push(Number(f.ownerId) || 0);
    where.push(`l.owner_user_id=$${params.length}`);
  }
  if (f.sessionName) {
    params.push(String(f.sessionName));
    where.push(`l.session_name=$${params.length}`);
  }
  if (f.source && SOURCES.includes(f.source)) {
    params.push(f.source);
    where.push(`l.source=$${params.length}`);
  }
  if (f.q) {
    params.push(`%${String(f.q).slice(0, 80)}%`);
    where.push(`(l.title ILIKE $${params.length} OR l.contact_name ILIKE $${params.length} OR l.phone ILIKE $${params.length} OR ct.name ILIKE $${params.length})`);
  }
  if (f.overdue)
    where.push("EXISTS (SELECT 1 FROM lead_tasks t WHERE t.lead_id=l.id AND t.done_at IS NULL AND t.due_at < now())");
  return where;
}

export async function board(req, filters = {}) {
  const pipeline = await ensurePipeline(req.tenantId);
  const stages = await stagesOf(pipeline.id);
  const currency = (await query("SELECT currency FROM tenants WHERE id=$1", [req.tenantId])).rows[0]?.currency || "AED";
  const params = [req.tenantId];
  const where = filterSql(req, params, filters);
  // the board shows open leads in the open steps, and this month's closed ones at the end
  const { rows: sums } = await query(
    `SELECT l.stage_id,count(*)::int AS n,COALESCE(sum(l.value),0) AS total FROM leads l LEFT JOIN contacts ct ON ct.id=l.contact_id
     WHERE ${where.join(" AND ")} AND (l.status='open' OR l.closed_at > now() - interval '30 days') GROUP BY l.stage_id`,
    params,
  );
  const sum = Object.fromEntries(sums.map((r) => [r.stage_id, r]));
  const columns = [];
  for (const s of stages) {
    const p = [...params];
    const w = [...where, `l.stage_id=$${p.push(s.id)}`];
    if (s.kind !== "open") w.push("l.closed_at > now() - interval '30 days'");
    const { rows } = await query(`${SELECT} WHERE ${w.join(" AND ")} ORDER BY l.rank, l.created_at DESC LIMIT ${PER_COLUMN}`, p);
    columns.push({ ...stageView(s), count: sum[s.id]?.n || 0, value: Number(sum[s.id]?.total || 0), leads: rows.map(leadView) });
  }
  const open = columns.filter((c) => c.kind === "open");
  return {
    pipeline: { id: pipeline.id, name: pipeline.name, preset: pipeline.preset },
    currency,
    stages: columns,
    totals: {
      open: open.reduce((n, c) => n + c.count, 0),
      openValue: open.reduce((n, c) => n + c.value, 0),
      won: columns.find((c) => c.kind === "won")?.value || 0,
    },
    perColumn: PER_COLUMN,
  };
}

export async function listLeads(req, f = {}) {
  const params = [req.tenantId];
  const where = filterSql(req, params, f);
  if (f.stageId) where.push(`l.stage_id=$${params.push(String(f.stageId))}`);
  if (f.status && ["open", "won", "lost"].includes(f.status)) where.push(`l.status=$${params.push(f.status)}`);
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 100);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const total = (await query(`SELECT count(*)::int AS n FROM leads l LEFT JOIN contacts ct ON ct.id=l.contact_id WHERE ${where.join(" AND ")}`, params)).rows[0].n;
  const { rows } = await query(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY l.rank, l.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  return { leads: rows.map(leadView), total, limit, offset };
}

// ── Activity ─────────────────────────────────────────────────────────────────────────────────────
export const record = (db, lead, actor, type, detail = {}) =>
  db.query("INSERT INTO lead_activities(tenant_id,lead_id,actor_id,actor_name,type,detail) VALUES($1,$2,$3,$4,$5,$6)", [
    lead.tenant_id,
    lead.id,
    actor?.id ?? null,
    actor?.name || "",
    type,
    JSON.stringify(detail),
  ]);

export async function timeline(leadId, tenantId) {
  const { rows } = await query("SELECT id,actor_name,type,detail,created_at FROM lead_activities WHERE lead_id=$1 AND tenant_id=$2 ORDER BY id DESC LIMIT 100", [leadId, tenantId]);
  return rows.map((r) => ({ id: Number(r.id), actorName: r.actor_name, type: r.type, detail: r.detail, createdAt: r.created_at }));
}

const activeMember = async (tenantId, userId) =>
  (
    await query(
      `SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND u.id=$2`,
      [tenantId, Number(userId) || 0],
    )
  ).rows[0];

// ── Creating a lead ──────────────────────────────────────────────────────────────────────────────
const firstOpenStage = async (pipelineId) =>
  (await query("SELECT id FROM pipeline_stages WHERE pipeline_id=$1 AND kind='open' ORDER BY position LIMIT 1", [pipelineId])).rows[0].id;
const topRank = async (db, stageId) =>
  Number((await db.query("SELECT COALESCE(min(rank),0)-1 AS r FROM leads WHERE stage_id=$1", [stageId])).rows[0].r);

// Opens a lead for a contact. A contact with a lead already open gets that one back (`existing: true`).
export async function createLead({ tenantId, actor, contact, sessionName = null, title, value = 0, stageId, ownerUserId = null, source = "manual", expectedClose = null, io = null }) {
  const pipeline = await ensurePipeline(tenantId);
  if (!contact) throw fail(400, "Choose a contact for this lead");
  const open = (await query("SELECT id FROM leads WHERE tenant_id=$1 AND contact_id=$2 AND status='open'", [tenantId, contact.id])).rows[0];
  if (open) return { id: open.id, existing: true };
  let stage = stageId;
  if (stage) {
    const ok = (await query("SELECT kind FROM pipeline_stages WHERE id=$1 AND pipeline_id=$2", [stage, pipeline.id])).rows[0];
    if (!ok) throw fail(400, "That step isn't in your pipeline");
    if (ok.kind !== "open") throw fail(400, "A new lead starts in an open step");
  } else stage = await firstOpenStage(pipeline.id);
  if (ownerUserId && !(await activeMember(tenantId, ownerUserId))) throw fail(400, "The owner isn't an active teammate");
  const amount = Number(value) || 0;
  if (amount < 0 || amount > 9_999_999_999) throw fail(400, "Enter a value between 0 and 9,999,999,999");
  const id = crypto.randomUUID();
  try {
    await withTransaction(async (c) => {
      await c.query(
        `INSERT INTO leads(id,tenant_id,pipeline_id,stage_id,contact_id,contact_name,phone,session_name,title,value,source,owner_user_id,expected_close,rank,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, tenantId, pipeline.id, stage, contact.id, contact.name || "", contact.phone || "", sessionName, String(title || "").trim().slice(0, 255), amount, SOURCES.includes(source) ? source : "manual", ownerUserId || null, expectedClose || null, await topRank(c, stage), actor?.id ?? null],
      );
      await record(c, { tenant_id: tenantId, id }, actor, "created", { source });
    });
  } catch (e) {
    // two people pressing the button at once: the second gets the lead the first made
    if (e.code === "23505") {
      const again = (await query("SELECT id FROM leads WHERE tenant_id=$1 AND contact_id=$2 AND status='open'", [tenantId, contact.id])).rows[0];
      if (again) return { id: again.id, existing: true };
    }
    throw e;
  }
  if (ownerUserId) await syncChatOwner({ tenantId, lead: { id, contact_id: contact.id, session_name: sessionName }, ownerUserId, actor, io });
  await announce(io, tenantId, id);
  return { id, existing: false };
}

// A lead made from a chat takes the chat's number and the teammate it is assigned to. Used by the one-tap
// button and by the "create a lead" automation.
export async function createLeadFromChat({ tenantId, conversation, actor = null, source = "chat", title, value, stageId, ownerUserId, io = null }) {
  if (conversation.is_group) throw fail(400, "A group chat can't be a lead");
  const contact = conversation.contact_id ? (await query("SELECT id,name,phone FROM contacts WHERE id=$1 AND tenant_id=$2", [conversation.contact_id, tenantId])).rows[0] : null;
  if (!contact) throw fail(400, "This chat has no contact to make a lead from");
  const made = await createLead({
    tenantId, actor, contact, sessionName: conversation.session_name, title, value, stageId, source, io,
    ownerUserId: ownerUserId === undefined ? conversation.assigned_user_id || null : ownerUserId,
  });
  // a lead made by a rule tells the person whose number it arrived on
  if (!made.existing && source === "automation") {
    const owner = (await query("SELECT owner_user_id FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [tenantId, conversation.session_name])).rows[0]?.owner_user_id;
    await createNotifications({
      io, tenantId, actor: null, conversationId: conversation.id,
      recipients: [{ userId: owner, type: "lead" }, { userId: conversation.assigned_user_id, type: "lead" }],
      title: "New lead", body: contact.name || contact.phone,
    }).catch((e) => console.error("Lead notification failed:", e.message));
  }
  return made;
}

// ── Changing a lead ──────────────────────────────────────────────────────────────────────────────
// The lead's owner and the chat's assignee are one idea: changing either changes the other.
export async function syncChatOwner({ tenantId, lead, ownerUserId, actor, io }) {
  if (!lead.contact_id) return;
  const who = ownerUserId ? await activeMember(tenantId, ownerUserId) : null;
  // The chat on the lead's number, or the contact's most recent chat when the lead has no number.
  const { rows } = await query(
    `UPDATE conversations SET assigned_to=$1,assigned_user_id=$2,updated_at=now() WHERE id=(
       SELECT id FROM conversations WHERE tenant_id=$3 AND contact_id=$4 AND ($5::varchar IS NULL OR session_name=$5::varchar)
       ORDER BY last_active_epoch DESC LIMIT 1) AND assigned_user_id IS DISTINCT FROM $2::int RETURNING id`,
    [who?.name || "", who?.id ?? null, tenantId, lead.contact_id, lead.session_name || null],
  );
  if (who && rows[0])
    await createNotifications({ io, tenantId, actor, conversationId: rows[0].id, recipients: [{ userId: who.id, type: "assignment" }], title: `${actor?.name || "A teammate"} assigned you a chat`, body: "" }).catch(() => {});
}

// The other direction: a chat was assigned, so the open lead for that customer on that number gets the same owner.
export async function syncLeadOwner({ tenantId, conversation, ownerUserId, io }) {
  if (!conversation.contact_id) return;
  const { rows } = await query(
    `UPDATE leads SET owner_user_id=$1,updated_at=now() WHERE tenant_id=$2 AND contact_id=$3 AND status='open' AND (session_name IS NULL OR session_name=$4)
     AND owner_user_id IS DISTINCT FROM $1::int RETURNING id,session_name,owner_user_id`,
    [ownerUserId ?? null, tenantId, conversation.contact_id, conversation.session_name],
  );
  for (const lead of rows) {
    const who = ownerUserId ? await activeMember(tenantId, ownerUserId) : null;
    await record({ query }, { tenant_id: tenantId, id: lead.id }, null, "owner", { to: who?.name || "" });
    emitForLead(io, tenantId, lead);
  }
}

export async function updateLead(req, lead, body) {
  const sets = [],
    params = [];
  const set = (col, v) => {
    params.push(v);
    sets.push(`${col}=$${params.length}`);
  };
  const changes = {};
  if (body.title !== undefined) set("title", String(body.title).trim().slice(0, 255));
  if (body.value !== undefined) {
    const v = Number(body.value);
    if (!Number.isFinite(v) || v < 0 || v > 9_999_999_999) throw fail(400, "Enter a value between 0 and 9,999,999,999");
    if (v !== Number(lead.value)) changes.value = { from: Number(lead.value), to: v };
    set("value", v);
  }
  if (body.expectedClose !== undefined) {
    if (body.expectedClose && !/^\d{4}-\d{2}-\d{2}$/.test(body.expectedClose)) throw fail(400, "Use a date like 2026-12-31");
    set("expected_close", body.expectedClose || null);
  }
  let newOwner;
  if (body.ownerUserId !== undefined) {
    if (body.ownerUserId) {
      const m = await activeMember(req.tenantId, body.ownerUserId);
      if (!m) throw fail(400, "The owner isn't an active teammate");
      newOwner = m;
    } else newOwner = null;
    if ((newOwner?.id ?? null) !== (lead.owner_user_id ?? null)) changes.owner = { from: lead.owner_name || "", to: newOwner?.name || "" };
    set("owner_user_id", newOwner?.id ?? null);
  }
  if (!sets.length) throw fail(400, "Nothing to update");
  sets.push("updated_at=now()");
  params.push(lead.id, req.tenantId);
  await withTransaction(async (c) => {
    await c.query(`UPDATE leads SET ${sets.join(",")} WHERE id=$${params.length - 1} AND tenant_id=$${params.length}`, params);
    if (changes.value) await record(c, lead, req.user, "value", changes.value);
    if (changes.owner) await record(c, lead, req.user, "owner", changes.owner);
  });
  if (changes.owner) await syncChatOwner({ tenantId: req.tenantId, lead, ownerUserId: newOwner?.id ?? null, actor: req.user, io: req.app.get("io") });
  await announce(req.app.get("io"), req.tenantId, lead.id);
}

// Moves a lead to a step: to the top of it, or just above `beforeLeadId`. Ending it as won or lost closes it;
// moving it back to an open step reopens it, unless the contact already has another open lead.
export async function moveLead(req, lead, { stageId, beforeLeadId, lostReason }) {
  const target = (await query("SELECT s.* FROM pipeline_stages s WHERE s.id=$1 AND s.tenant_id=$2", [stageId, req.tenantId])).rows[0];
  if (!target || target.pipeline_id !== lead.pipeline_id) throw fail(400, "That step isn't in your pipeline");
  const reason = String(lostReason || "").trim().slice(0, 255);
  await withTransaction(async (c) => {
    let rank = await topRank(c, target.id);
    if (beforeLeadId) {
      const before = (await c.query("SELECT rank FROM leads WHERE id=$1 AND stage_id=$2 AND tenant_id=$3", [beforeLeadId, target.id, req.tenantId])).rows[0];
      if (before) {
        const prev = (await c.query("SELECT max(rank) AS r FROM leads WHERE stage_id=$1 AND rank<$2 AND id<>$3", [target.id, before.rank, lead.id])).rows[0].r;
        rank = prev === null ? Number(before.rank) - 1 : (Number(prev) + Number(before.rank)) / 2;
      }
    }
    const closing = target.kind !== "open";
    const stageChanged = target.id !== lead.stage_id;
    try {
      await c.query(
        `UPDATE leads SET stage_id=$1,status=$2,rank=$3,lost_reason=$4,closed_at=CASE WHEN $5::boolean THEN COALESCE(closed_at,now()) ELSE NULL END,
         stage_changed_at=CASE WHEN $6::boolean THEN now() ELSE stage_changed_at END,updated_at=now() WHERE id=$7 AND tenant_id=$8`,
        [target.id, target.kind, rank, target.kind === "lost" ? reason : "", closing, stageChanged, lead.id, req.tenantId],
      );
    } catch (e) {
      if (e.code === "23505") throw fail(409, "This contact already has another open lead");
      throw e;
    }
    if (stageChanged) {
      await record(c, lead, req.user, target.kind === "won" ? "won" : target.kind === "lost" ? "lost" : lead.status !== "open" ? "reopened" : "stage", {
        from: lead.stage_name,
        to: target.name,
        ...(target.kind === "lost" && reason ? { reason } : {}),
      });
    }
  });
  await announce(req.app.get("io"), req.tenantId, lead.id);
}

export async function deleteLead(tenantId, id, io) {
  const { rows } = await query("DELETE FROM leads WHERE id=$1 AND tenant_id=$2 RETURNING session_name,owner_user_id", [id, tenantId]);
  if (!rows[0]) throw fail(404, "Lead not found");
  emitForLead(io, tenantId, { id, ...rows[0] });
}

// Tells the screens that have a board open that something changed.
async function announce(io, tenantId, leadId) {
  const lead = (await query("SELECT id,session_name,owner_user_id FROM leads WHERE id=$1 AND tenant_id=$2", [leadId, tenantId])).rows[0];
  if (lead) emitForLead(io, tenantId, lead);
}

// ── Follow-ups ───────────────────────────────────────────────────────────────────────────────────
export const taskView = (r) => ({
  id: r.id,
  leadId: r.lead_id,
  title: r.title,
  dueAt: r.due_at,
  assignedUserId: r.assigned_user_id,
  assignedName: r.assigned_name || "",
  done: Boolean(r.done_at),
  doneAt: r.done_at,
  ...(r.lead_title !== undefined ? { leadTitle: r.lead_title, contactName: r.contact_name, stageName: r.stage_name, conversationId: r.conversation_id || null } : {}),
});

export async function tasksOf(leadId, tenantId) {
  const { rows } = await query(
    `SELECT t.*,u.name AS assigned_name FROM lead_tasks t LEFT JOIN users u ON u.id=t.assigned_user_id WHERE t.lead_id=$1 AND t.tenant_id=$2 ORDER BY (t.done_at IS NOT NULL),t.due_at`,
    [leadId, tenantId],
  );
  return rows.map(taskView);
}

export async function addTask(req, lead, { title, dueAt, assignedUserId }) {
  const text = String(title || "").trim().slice(0, 255);
  if (!text) throw fail(400, "Say what to follow up on");
  const due = new Date(dueAt);
  if (!Number.isFinite(due.getTime())) throw fail(400, "Choose when it is due");
  const who = assignedUserId ? await activeMember(req.tenantId, assignedUserId) : null;
  if (assignedUserId && !who) throw fail(400, "The follow-up can only go to an active teammate");
  const id = crypto.randomUUID();
  await query("INSERT INTO lead_tasks(id,tenant_id,lead_id,title,due_at,assigned_user_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, req.tenantId, lead.id, text, due.toISOString(), who?.id ?? lead.owner_user_id ?? req.user.id, req.user.id]);
  await announce(req.app.get("io"), req.tenantId, lead.id);
  return id;
}

export async function findTask(req, taskId) {
  const { rows } = await query("SELECT * FROM lead_tasks WHERE id=$1 AND tenant_id=$2", [taskId, req.tenantId]);
  if (!rows[0]) throw fail(404, "Follow-up not found");
  await findLead(req, rows[0].lead_id); // only someone who can see the lead can touch its follow-ups
  return rows[0];
}

// Follow-ups for the Today screen: mine by default, everyone's for a manager who asks.
export async function dueTasks(req, { when = "today", everyone = false, until } = {}) {
  const params = [req.tenantId];
  const where = ["t.tenant_id=$1", "t.done_at IS NULL", visibleTo(req, params)];
  if (!(everyone && isManager(req))) {
    params.push(req.user.id);
    where.push(`COALESCE(t.assigned_user_id,l.owner_user_id)=$${params.length}`);
  }
  // "today" ends when the person's own day does, which only their browser knows
  if (when === "today") {
    const end = new Date(until);
    params.push(Number.isFinite(end.getTime()) ? end.toISOString() : new Date(Date.now() + 24 * 3600_000).toISOString());
    where.push(`t.due_at <= $${params.length}`);
  } else if (when === "overdue") where.push("t.due_at < now()");
  const { rows } = await query(
    `SELECT t.*,u.name AS assigned_name,COALESCE(NULLIF(l.title,''),NULLIF(ct.name,''),l.contact_name,l.phone) AS lead_title,COALESCE(NULLIF(ct.name,''),l.contact_name,l.phone) AS contact_name,s.name AS stage_name,
       (SELECT c.id FROM conversations c WHERE c.tenant_id=l.tenant_id AND c.contact_id=l.contact_id AND (l.session_name IS NULL OR c.session_name=l.session_name) ORDER BY c.last_active_epoch DESC LIMIT 1) AS conversation_id
     FROM lead_tasks t JOIN leads l ON l.id=t.lead_id JOIN pipeline_stages s ON s.id=l.stage_id LEFT JOIN contacts ct ON ct.id=l.contact_id LEFT JOIN users u ON u.id=t.assigned_user_id
     WHERE ${where.join(" AND ")} AND l.status='open' ORDER BY t.due_at LIMIT 200`,
    params,
  );
  return rows.map(taskView);
}

// Tells the person a follow-up is for once it is due, one time.
export async function pumpLeadReminders(io) {
  const { rows } = await query(
    `SELECT t.id,t.tenant_id,t.title,t.assigned_user_id,l.owner_user_id,l.contact_id,l.session_name,COALESCE(NULLIF(ct.name,''),l.contact_name,l.phone) AS who
     FROM lead_tasks t JOIN leads l ON l.id=t.lead_id LEFT JOIN contacts ct ON ct.id=l.contact_id
     WHERE t.done_at IS NULL AND t.notified_at IS NULL AND t.due_at <= now() AND l.status='open' ORDER BY t.due_at LIMIT 50`,
  );
  for (const t of rows) {
    // claim it first, so two servers never both send it
    const claimed = await query("UPDATE lead_tasks SET notified_at=now() WHERE id=$1 AND notified_at IS NULL RETURNING id", [t.id]);
    if (!claimed.rowCount) continue;
    const recipient = t.assigned_user_id || t.owner_user_id || (await query("SELECT owner_user_id FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [t.tenant_id, t.session_name])).rows[0]?.owner_user_id;
    const chat = t.contact_id ? (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND contact_id=$2 AND ($3::varchar IS NULL OR session_name=$3::varchar) ORDER BY last_active_epoch DESC LIMIT 1", [t.tenant_id, t.contact_id, t.session_name])).rows[0] : null;
    await createNotifications({
      io, tenantId: t.tenant_id, actor: null, conversationId: chat?.id || null, dedupeKey: `task:${t.id}`,
      recipients: [{ userId: recipient, type: "lead_task" }],
      title: `Follow-up due: ${t.title}`,
      body: t.who || "",
    });
  }
}

// ── Pipeline settings ────────────────────────────────────────────────────────────────────────────
export async function settings(tenantId) {
  const pipeline = await ensurePipeline(tenantId);
  const stages = await stagesOf(pipeline.id);
  const counts = Object.fromEntries((await query("SELECT stage_id,count(*)::int AS n FROM leads WHERE pipeline_id=$1 GROUP BY stage_id", [pipeline.id])).rows.map((r) => [r.stage_id, r.n]));
  const currency = (await query("SELECT currency FROM tenants WHERE id=$1", [tenantId])).rows[0]?.currency || "AED";
  const rule = (await query("SELECT id,is_enabled FROM automations WHERE tenant_id=$1 AND template_id='new-lead' ORDER BY created_at LIMIT 1", [tenantId])).rows[0];
  return {
    pipeline: { id: pipeline.id, name: pipeline.name, preset: pipeline.preset },
    currency,
    stages: stages.map((s) => ({ ...stageView(s), leads: counts[s.id] || 0 })),
    presets: presetList(),
    autoCreate: { exists: Boolean(rule), enabled: rule?.is_enabled === true },
  };
}

// Replaces the open steps (names and order), and renames the two closing ones. A step with leads in it can't
// be removed; the screen says which one.
export async function saveStages(tenantId, { open, wonName, lostName, preset }) {
  const pipeline = await ensurePipeline(tenantId);
  const current = await stagesOf(pipeline.id);
  const wanted = Array.isArray(open) ? open : [];
  const names = (list) => list.map((n) => String(n?.name ?? "").trim());
  if (typeof wonName !== "string" || typeof lostName !== "string") throw fail(400, "Name the step for won leads and the one for lost leads");
  wonName = wonName.trim();
  lostName = lostName.trim();
  if (wanted.length < 1 || wanted.length > MAX_OPEN_STAGES) throw fail(400, `Use between 1 and ${MAX_OPEN_STAGES} steps before Won and Lost`);
  if ([...names(wanted), wonName, lostName].some((n) => !n || n.length > 60)) throw fail(400, "Every step needs a name of up to 60 characters");
  const keepIds = new Set(wanted.map((s) => s.id).filter(Boolean));
  for (const id of keepIds) if (!current.some((s) => s.id === id && s.kind === "open")) throw fail(400, "Unknown step");
  const removed = current.filter((s) => s.kind === "open" && !keepIds.has(s.id));
  const counts = Object.fromEntries((await query("SELECT stage_id,count(*)::int AS n FROM leads WHERE pipeline_id=$1 GROUP BY stage_id", [pipeline.id])).rows.map((r) => [r.stage_id, r.n]));
  const busy = removed.filter((s) => counts[s.id]);
  if (busy.length) throw fail(409, `Move the leads out of ${busy.map((s) => `“${s.name}”`).join(", ")} before removing ${busy.length === 1 ? "it" : "them"}`);
  await withTransaction(async (c) => {
    for (const s of removed) await c.query("DELETE FROM pipeline_stages WHERE id=$1", [s.id]);
    const won = current.find((s) => s.kind === "won"),
      lost = current.find((s) => s.kind === "lost");
    // positions are reassigned in one pass, so first park them out of the way
    await c.query("UPDATE pipeline_stages SET position=position+1000 WHERE pipeline_id=$1", [pipeline.id]);
    for (const [i, s] of wanted.entries()) {
      const name = String(s.name).trim();
      if (s.id) await c.query("UPDATE pipeline_stages SET name=$1,position=$2 WHERE id=$3", [name, i, s.id]);
      else await c.query("INSERT INTO pipeline_stages(id,tenant_id,pipeline_id,name,kind,position) VALUES($1,$2,$3,$4,'open',$5)", [crypto.randomUUID(), tenantId, pipeline.id, name, i]);
    }
    await c.query("UPDATE pipeline_stages SET name=$1,position=$2 WHERE id=$3", [wonName, wanted.length, won.id]);
    await c.query("UPDATE pipeline_stages SET name=$1,position=$2 WHERE id=$3", [lostName, wanted.length + 1, lost.id]);
    if (preset && PRESETS[preset]) await c.query("UPDATE pipelines SET preset=$1 WHERE id=$2", [preset, pipeline.id]);
  });
}

// Switching preset renames the steps by position, so no lead moves.
export async function applyPreset(tenantId, presetId) {
  const preset = PRESETS[presetId];
  if (!preset) throw fail(400, "Choose one of the pipeline templates");
  const pipeline = await ensurePipeline(tenantId);
  const current = await stagesOf(pipeline.id);
  const open = current.filter((s) => s.kind === "open");
  const wanted = preset.stages;
  // keep the steps the company added after the fifth; rename the first five
  const renamed = open.map((s, i) => ({ id: s.id, name: i < wanted.length ? wanted[i] : s.name }));
  while (renamed.length < wanted.length) renamed.push({ name: wanted[renamed.length] });
  await saveStages(tenantId, { open: renamed, wonName: preset.won, lostName: preset.lost, preset: presetId });
}

export async function setCurrency(tenantId, currency) {
  if (!CURRENCIES.includes(currency)) throw fail(400, `Choose ${CURRENCIES.join(" or ")}`);
  await query("UPDATE tenants SET currency=$1 WHERE id=$2", [currency, tenantId]);
}

// "Create a lead when a new person messages me" is a ready-made automation rule, switched on and off here
// so the person never has to find it.
export async function setAutoCreate(tenantId, enabled) {
  const found = (await query("SELECT id FROM automations WHERE tenant_id=$1 AND template_id='new-lead' ORDER BY created_at LIMIT 1", [tenantId])).rows[0];
  if (found) {
    await query("UPDATE automations SET is_enabled=$1,updated_at=now() WHERE id=$2", [Boolean(enabled), found.id]);
    return;
  }
  if (!enabled) return;
  await query(
    `INSERT INTO automations(id,tenant_id,name,trigger_type,trigger_condition,action_type,action_summary,config,template_id,is_enabled)
     VALUES($1,$2,'Create a lead for every new customer','first_message','','create_lead','','{}','new-lead',true)`,
    [crypto.randomUUID(), tenantId],
  );
}
