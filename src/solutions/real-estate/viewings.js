import crypto from "node:crypto";
import { query, withTransaction } from "../../db/index.js";
import { fail, failWith } from "../../middleware/http.js";
import { isManager } from "../../services/access.js";
import { findLead, record, visibleTo, stagesOf } from "../../services/leadService.js";
import { settingsOf } from "../entitlements.js";
import { findProperty } from "./properties.js";
import { isZone, zonedToUtc, humanDateTime, localDateTime } from "./time.js";
import { normalizeText } from "./text.js";

// Viewings. A viewing is one agent showing one property to one lead for a stretch of time. Booking checks that none of
// the three is already busy, is safe to repeat, keeps its times as exact moments, and sets up the reminder and the
// follow-up with the follow-up system the company already uses.
export const STATUSES = ["scheduled", "confirmed", "completed", "cancelled", "no_show"];
const ACTIVE = ["scheduled", "confirmed"];
// What may happen next to a viewing in each state. Completed, cancelled and no-show are final.
export const TRANSITIONS = {
  scheduled: ["confirmed", "completed", "cancelled", "no_show"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
};
const REMINDER_LEAD_MS = 60 * 60 * 1000; // the agent is reminded an hour before
const FOLLOW_UP_AFTER_MS = 2 * 60 * 60 * 1000; // and asked to follow up two hours after it ends

export const viewingView = (r) => ({
  id: r.id,
  leadId: r.lead_id,
  leadName: r.lead_name || "",
  propertyId: r.property_id,
  propertyReference: r.property_reference || "",
  propertyTitle: r.property_title || "",
  community: r.community || "",
  agentUserId: r.agent_user_id,
  agentName: r.agent_name || "",
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  timeZone: r.timezone,
  local: { ...localDateTime(new Date(r.starts_at).getTime(), r.timezone), endTime: localDateTime(new Date(r.ends_at).getTime(), r.timezone).time, text: humanDateTime(new Date(r.starts_at).getTime(), r.timezone) },
  status: r.status,
  notes: r.notes,
  cancelReason: r.cancel_reason,
  confirmedAt: r.confirmed_at,
  completedAt: r.completed_at,
  allowed: TRANSITIONS[r.status] || [],
});

const SELECT = `SELECT v.*,COALESCE(NULLIF(ct.name,''),NULLIF(l.contact_name,''),l.phone) AS lead_name,p.reference AS property_reference,p.title AS property_title,p.community,u.name AS agent_name
  FROM re_viewings v JOIN leads l ON l.id=v.lead_id JOIN re_properties p ON p.id=v.property_id JOIN users u ON u.id=v.agent_user_id LEFT JOIN contacts ct ON ct.id=l.contact_id`;

// Managers see every viewing; staff see the ones they are running and the ones for leads they can see.
function visible(req, params) {
  if (isManager(req)) return "TRUE";
  const lead = visibleTo(req, params);
  params.push(req.user.id);
  return `(v.agent_user_id=$${params.length} OR ${lead})`;
}

export async function findViewing(req, id) {
  const params = [req.tenantId, String(id)];
  const row = (await query(`${SELECT} WHERE v.tenant_id=$1 AND v.id=$2 AND ${visible(req, params)}`, params)).rows[0];
  if (!row) throw fail(404, "Viewing not found");
  return row;
}

export async function listViewings(req, f = {}) {
  const params = [req.tenantId];
  const where = ["v.tenant_id=$1", visible(req, params)];
  const when = (v) => {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  const from = when(f.from) || new Date(Date.now() - 7 * 86400000).toISOString();
  const to = when(f.to) || new Date(Date.now() + 60 * 86400000).toISOString();
  where.push(`v.starts_at >= $${params.push(from)}`, `v.starts_at < $${params.push(to)}`);
  if (f.status && STATUSES.includes(f.status)) where.push(`v.status=$${params.push(f.status)}`);
  if (f.agent) where.push(`v.agent_user_id=$${params.push(Number(f.agent) || 0)}`);
  if (f.lead) where.push(`v.lead_id=$${params.push(String(f.lead))}`);
  const { rows } = await query(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY v.starts_at LIMIT 300`, params);
  return rows.map(viewingView);
}

const activeMember = async (tenantId, userId) =>
  (await query(`SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND u.id=$2`, [tenantId, Number(userId) || 0])).rows[0];

// "Starts at" is either an exact moment with its offset ("2026-11-03T12:00:00Z") or a local date and time in a named zone
// ({ date: "2026-11-03", time: "16:00", timeZone: "Asia/Dubai" }). A time with no zone at all is refused.
export function startOf(body, defaultZone) {
  const zone = body.timeZone === undefined ? defaultZone : body.timeZone;
  if (!isZone(zone)) throw fail(400, "Choose a valid time zone, such as Asia/Dubai");
  let at;
  if (body.startsAt !== undefined) {
    const s = String(body.startsAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) throw fail(400, "Give the start as a full time with its zone, such as 2026-11-03T16:00:00+04:00");
    at = new Date(s);
  } else if (body.date !== undefined || body.time !== undefined) {
    at = zonedToUtc({ date: body.date, time: body.time, zone });
    if (!at) throw fail(400, `${body.date} ${body.time} isn't a time that exists in ${zone}. Check the date and time: clocks may change that night.`);
  } else throw fail(400, "Choose when the viewing is");
  if (Number.isNaN(at.getTime())) throw fail(400, "Choose when the viewing is");
  return { at, zone };
}

const minutesOf = (body, settings) => {
  const n = body.durationMinutes === undefined ? settings.viewingMinutes : Number(body.durationMinutes);
  if (!Number.isInteger(n) || n < 10 || n > 480) throw fail(400, "A viewing lasts from 10 minutes to 8 hours");
  return n;
};

// Everything else already booked at the same time for this agent, this property or this lead.
async function conflictsFor(c, { tenantId, agentId, propertyId, leadId, start, end, exclude = "" }) {
  const { rows } = await c.query(
    `SELECT v.id,v.agent_user_id,v.property_id,v.lead_id,v.starts_at,v.ends_at,v.timezone,p.reference
     FROM re_viewings v JOIN re_properties p ON p.id=v.property_id
     WHERE v.tenant_id=$1 AND v.status=ANY($2::text[]) AND v.id<>$3 AND tstzrange(v.starts_at,v.ends_at)&&tstzrange($4,$5)
       AND (v.agent_user_id=$6 OR v.property_id=$7 OR v.lead_id=$8) ORDER BY v.starts_at LIMIT 10`,
    [tenantId, ACTIVE, exclude, start.toISOString(), end.toISOString(), agentId, propertyId, leadId],
  );
  return rows.map((r) => ({
    with: r.agent_user_id === agentId ? "agent" : r.property_id === propertyId ? "property" : "lead",
    viewingId: r.id,
    reference: r.reference,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    local: humanDateTime(new Date(r.starts_at).getTime(), r.timezone),
  }));
}
const MESSAGE = { agent: "The agent already has a viewing at that time", property: "That property is already being shown at that time", lead: "This lead already has a viewing at that time" };

// Two people booking at once must not both succeed: the three things a viewing needs are locked, in a fixed order,
// for the length of the booking.
const lockAll = async (c, tenantId, keys) => {
  for (const k of [...new Set(keys)].sort()) await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`re:${tenantId}:${k}`]);
};

const taskTitle = (kind, row) => (kind === "reminder" ? `Viewing ${row.when}: ${row.reference} with ${row.who}` : `After the viewing of ${row.reference}: ask ${row.who} what they thought`);

async function chooseAgent(req, lead, requested) {
  let agentId = requested === undefined || requested === null || requested === "" ? lead.owner_user_id || req.user.id : Number(requested);
  if (!isManager(req) && agentId !== req.user.id) throw fail(403, "You can book viewings for yourself. An owner or administrator can book them for a teammate.");
  const member = await activeMember(req.tenantId, agentId);
  if (!member) throw fail(400, "The agent isn't an active teammate");
  return member;
}

// Books a viewing. Asking again with the same idempotency key returns the viewing that was made, not a second one.
export async function createViewing(req, body) {
  if (!body || typeof body !== "object") throw fail(400, "Send the viewing to book");
  const settings = await settingsOf(req.tenantId, "real_estate");
  const key = body.idempotencyKey === undefined || body.idempotencyKey === null || body.idempotencyKey === "" ? null : String(body.idempotencyKey);
  if (key && !/^[\w:.-]{1,80}$/.test(key)) throw fail(400, "The idempotency key is up to 80 letters, numbers or : . _ -");
  const lead = await findLead(req, body.leadId);
  if (lead.status !== "open") throw fail(409, "This lead is closed. Reopen it before booking a viewing.");
  const property = await findProperty(req, body.propertyId);
  if (!["available", "reserved"].includes(property.status)) throw fail(409, `This property is ${property.status}. A viewing can be booked only for an available or reserved property.`);
  const agent = await chooseAgent(req, lead, body.agentUserId);
  const { at, zone } = startOf(body, settings.timezone);
  const end = new Date(at.getTime() + minutesOf(body, settings) * 60000);
  if (at.getTime() <= Date.now()) throw fail(400, "Choose a time in the future");
  const notes = String(body.notes ?? "").trim().slice(0, 500);
  const who = lead.display_name || lead.phone || "the lead";
  const id = crypto.randomUUID();

  const made = await withTransaction(async (c) => {
    await lockAll(c, req.tenantId, [`agent:${agent.id}`, `property:${property.id}`, `lead:${lead.id}`]);
    if (key) {
      const prior = (await c.query("SELECT id,lead_id,property_id FROM re_viewings WHERE tenant_id=$1 AND idempotency_key=$2", [req.tenantId, key])).rows[0];
      if (prior) {
        if (prior.lead_id !== lead.id || prior.property_id !== property.id) throw fail(409, "That idempotency key was already used for a different viewing");
        return { id: prior.id, existing: true };
      }
    }
    const conflicts = await conflictsFor(c, { tenantId: req.tenantId, agentId: agent.id, propertyId: property.id, leadId: lead.id, start: at, end });
    if (conflicts.length) throw failWith(409, `${MESSAGE[conflicts[0].with]}: ${conflicts[0].local}.`, { conflicts });
    const when = humanDateTime(at.getTime(), zone);
    const remindAt = new Date(Math.max(at.getTime() - REMINDER_LEAD_MS, Date.now() + 60000));
    const reminder = crypto.randomUUID();
    const followUp = crypto.randomUUID();
    await c.query("INSERT INTO lead_tasks(id,tenant_id,lead_id,title,due_at,assigned_user_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [reminder, req.tenantId, lead.id, taskTitle("reminder", { when, reference: property.reference, who }), remindAt.toISOString(), agent.id, req.user.id]);
    await c.query("INSERT INTO lead_tasks(id,tenant_id,lead_id,title,due_at,assigned_user_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [followUp, req.tenantId, lead.id, taskTitle("followup", { reference: property.reference, who }), new Date(end.getTime() + FOLLOW_UP_AFTER_MS).toISOString(), agent.id, req.user.id]);
    await c.query(
      `INSERT INTO re_viewings(id,tenant_id,lead_id,property_id,agent_user_id,starts_at,ends_at,timezone,notes,idempotency_key,reminder_task_id,followup_task_id,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, req.tenantId, lead.id, property.id, agent.id, at.toISOString(), end.toISOString(), zone, notes, key, reminder, followUp, req.user.id],
    );
    await record(c, lead, req.user, "viewing", { action: "booked", reference: property.reference, startsAt: at.toISOString(), agent: agent.name });
    return { id, existing: false };
  });
  const viewing = viewingView(await findViewing(req, made.id));
  return { viewing, existing: made.existing, suggestedStage: made.existing ? null : await suggestedStage(lead) };
}

// The pipeline step this lead would naturally move to once a viewing is booked: the first open step called something like
// "viewing" after the one it is in. The person decides; nothing moves by itself.
async function suggestedStage(lead) {
  const stages = await stagesOf(lead.pipeline_id);
  const here = stages.find((s) => s.id === lead.stage_id);
  const next = stages.find((s) => s.kind === "open" && s.position > (here?.position ?? -1) && normalizeText(s.name).includes("viewing"));
  return next ? { id: next.id, name: next.name } : null;
}

const claimTasks = (c, row, sql) => c.query(`UPDATE lead_tasks SET ${sql} WHERE id=ANY($1::varchar[]) AND tenant_id=$2`, [[row.reminder_task_id, row.followup_task_id].filter(Boolean), row.tenant_id]);

async function change(req, id, action, body = {}) {
  const row = await findViewing(req, id);
  // the agent running a viewing may not be able to open the lead itself; the history is written to it all the same
  const lead = { id: row.lead_id, tenant_id: req.tenantId };
  const canRun = isManager(req) || row.agent_user_id === req.user.id;
  if (!canRun) throw fail(403, "Only the agent running this viewing, an owner or an administrator can change it");
  const target = { confirm: "confirmed", complete: "completed", cancel: "cancelled", "no-show": "no_show" }[action];
  if (!TRANSITIONS[row.status].includes(target)) throw fail(409, `A ${row.status.replace("_", "-")} viewing can't be ${target.replace("_", "-")}.`);
  if ((target === "completed" || target === "no_show") && new Date(row.starts_at).getTime() > Date.now()) throw fail(409, "This viewing hasn't started yet.");
  const reason = String(body.reason ?? "").trim().slice(0, 255);
  await withTransaction(async (c) => {
    await c.query("SELECT 1 FROM re_viewings WHERE id=$1 FOR UPDATE", [row.id]);
    const sets = ["status=$3", "updated_at=now()"];
    const params = [row.id, req.tenantId, target];
    if (target === "confirmed") sets.push("confirmed_at=now()");
    if (target === "completed") sets.push("completed_at=now()");
    if (target === "cancelled") sets.push(`cancel_reason=$${params.push(reason)}`);
    // the status is checked again inside the lock, so two people pressing at once cannot both win
    const done = await c.query(`UPDATE re_viewings SET ${sets.join(",")} WHERE id=$1 AND tenant_id=$2 AND status=ANY($${params.push(Object.keys(TRANSITIONS).filter((s) => TRANSITIONS[s].includes(target)))}::text[]) RETURNING id`, params);
    if (!done.rowCount) throw fail(409, "Someone else just changed this viewing. Reload to see it.");
    if (target === "cancelled") await claimTasks(c, row, "done_at=COALESCE(done_at,now())");
    if (target === "completed" || target === "no_show") await c.query("UPDATE lead_tasks SET done_at=COALESCE(done_at,now()) WHERE id=$1 AND tenant_id=$2", [row.reminder_task_id, req.tenantId]);
    await record(c, lead, req.user, "viewing", { action: target, reference: row.property_reference, startsAt: new Date(row.starts_at).toISOString(), ...(reason ? { reason } : {}) });
  });
  return viewingView(await findViewing(req, row.id));
}
export const confirmViewing = (req, id) => change(req, id, "confirm");
export const completeViewing = (req, id) => change(req, id, "complete");
export const cancelViewing = (req, id, body) => change(req, id, "cancel", body);
export const noShowViewing = (req, id) => change(req, id, "no-show");

// Moving a viewing to another time. It goes back to "scheduled" because the new time has not been confirmed with anyone, and
// its reminder and follow-up move with it.
export async function rescheduleViewing(req, id, body) {
  const row = await findViewing(req, id);
  const lead = { id: row.lead_id, tenant_id: req.tenantId };
  if (!(isManager(req) || row.agent_user_id === req.user.id)) throw fail(403, "Only the agent running this viewing, an owner or an administrator can change it");
  if (!ACTIVE.includes(row.status)) throw fail(409, `A ${row.status.replace("_", "-")} viewing can't be moved. Book a new one.`);
  const settings = await settingsOf(req.tenantId, "real_estate");
  const { at, zone } = startOf(body, row.timezone);
  const minutes = body.durationMinutes === undefined ? Math.round((new Date(row.ends_at) - new Date(row.starts_at)) / 60000) : minutesOf(body, settings);
  const end = new Date(at.getTime() + minutes * 60000);
  if (at.getTime() <= Date.now()) throw fail(400, "Choose a time in the future");
  await withTransaction(async (c) => {
    await lockAll(c, req.tenantId, [`agent:${row.agent_user_id}`, `property:${row.property_id}`, `lead:${row.lead_id}`]);
    const fresh = (await c.query("SELECT status FROM re_viewings WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
    if (!ACTIVE.includes(fresh.status)) throw fail(409, "Someone else just changed this viewing. Reload to see it.");
    const conflicts = await conflictsFor(c, { tenantId: req.tenantId, agentId: row.agent_user_id, propertyId: row.property_id, leadId: row.lead_id, start: at, end, exclude: row.id });
    if (conflicts.length) throw failWith(409, `${MESSAGE[conflicts[0].with]}: ${conflicts[0].local}.`, { conflicts });
    await c.query("UPDATE re_viewings SET starts_at=$3,ends_at=$4,timezone=$5,status='scheduled',confirmed_at=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2", [row.id, req.tenantId, at.toISOString(), end.toISOString(), zone]);
    const who = row.lead_name || "the lead";
    const remindAt = new Date(Math.max(at.getTime() - REMINDER_LEAD_MS, Date.now() + 60000));
    // the reminder is asked for again from scratch: not yet told, not yet escalated, not done
    await c.query("UPDATE lead_tasks SET title=$3,due_at=$4,notified_at=NULL,escalated_at=NULL,done_at=NULL WHERE id=$1 AND tenant_id=$2", [row.reminder_task_id, req.tenantId, taskTitle("reminder", { when: humanDateTime(at.getTime(), zone), reference: row.property_reference, who }), remindAt.toISOString()]);
    await c.query("UPDATE lead_tasks SET due_at=$3,notified_at=NULL,escalated_at=NULL,done_at=NULL WHERE id=$1 AND tenant_id=$2", [row.followup_task_id, req.tenantId, new Date(end.getTime() + FOLLOW_UP_AFTER_MS).toISOString()]);
    await record(c, lead, req.user, "viewing", { action: "rescheduled", reference: row.property_reference, from: new Date(row.starts_at).toISOString(), startsAt: at.toISOString() });
  });
  return viewingView(await findViewing(req, row.id));
}

// ── Things to send or save, built from the record and nothing else ──────────────────────────────
export function confirmationText(v) {
  const first = (v.leadName || "").split(/\s+/)[0] || "there";
  return `Hello ${first}, this is to confirm your viewing of ${v.propertyReference}${v.community ? ` in ${v.community}` : ""} on ${v.local.text} (${v.timeZone} time). Please reply to confirm, or tell us if another time suits you better.`;
}

const icsText = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const fold = (line) => (line.length <= 73 ? line : line.match(/.{1,73}/gu).join("\r\n "));
export function viewingIcs(v, { listingUrl = "" } = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Scriwo//Real Estate//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${v.id}@scriwo`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(v.startsAt)}`,
    `DTEND:${icsDate(v.endsAt)}`,
    `SUMMARY:${icsText(`Viewing: ${v.propertyReference}${v.leadName ? ` with ${v.leadName}` : ""}`)}`,
    ...(v.community ? [`LOCATION:${icsText(v.community)}`] : []),
    `DESCRIPTION:${icsText([`Agent: ${v.agentName}`, listingUrl].filter(Boolean).join("\n"))}`,
    `STATUS:${v.status === "cancelled" ? "CANCELLED" : v.status === "confirmed" ? "CONFIRMED" : "TENTATIVE"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
