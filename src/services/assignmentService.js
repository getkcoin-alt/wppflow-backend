import { query, withTransaction } from "../db/index.js";
import { fail } from "../middleware/http.js";
import { planAllows } from "./plans.js";
import { emitForConversation } from "./realtime.js";
import { createNotifications } from "./notificationService.js";
import { syncLeadOwner } from "./leadService.js";
import { formatConversation } from "./conversationFormat.js";

// Automatic assignment of new chats: round-robin or the least busy person, only people the company put in the
// rotation and who say they are available, only on the numbers it chose, only inside working hours, a returning
// customer back to the person who has their lead. Nothing is guessed: with nobody eligible the chat stays unassigned
// and shows up as waiting like any other.
export const MODES = ["round_robin", "least_busy"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const settingsView = (r) => ({
  enabled: Boolean(r?.enabled),
  mode: r?.mode || "round_robin",
  team: r?.team || "",
  sessionNames: r?.session_names || [],
  keepOwner: r ? Boolean(r.keep_owner) : true,
  maxOpen: r?.max_open ?? null,
  useHours: Boolean(r?.use_hours),
  timezone: r?.timezone || "Asia/Kolkata",
  workDays: r?.work_days || [1, 2, 3, 4, 5],
  workStart: r?.work_start || "09:00",
  workEnd: r?.work_end || "18:00",
});

const validZone = (tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// Is this moment inside the company's working hours, in the company's own time zone?
export function withinHours(s, now = new Date()) {
  if (!s.use_hours && !s.useHours) return true;
  const zone = s.timezone;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = DAYS.indexOf(parts.weekday);
  const time = `${parts.hour}:${parts.minute}`;
  const days = s.work_days || s.workDays || [];
  const start = s.work_start || s.workStart,
    end = s.work_end || s.workEnd;
  return days.includes(day) && time >= start && time < end;
}

export async function getSettings(tenantId) {
  const row = (await query("SELECT * FROM assignment_settings WHERE tenant_id=$1", [tenantId])).rows[0];
  const members = (
    await query(
      `SELECT u.id,u.name,m.role,m.category,m.assignable,m.available,
         (SELECT count(*)::int FROM conversations c WHERE c.tenant_id=m.tenant_id AND c.assigned_user_id=u.id AND NOT c.is_closed AND NOT c.is_group) AS open_chats
       FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' ORDER BY u.name`,
      [tenantId],
    )
  ).rows.map((m) => ({ id: m.id, name: m.name, role: m.role, team: m.category, inRotation: m.assignable, available: m.available, openChats: m.open_chats }));
  const numbers = (
    await query(
      `SELECT s.session_name,s.phone,u.name AS owner_name FROM whatsapp_sessions s LEFT JOIN users u ON u.id=s.owner_user_id WHERE s.tenant_id=$1 ORDER BY s.created_at,s.session_name`,
      [tenantId],
    )
  ).rows.map((n) => ({ sessionName: n.session_name, phone: n.phone, ownerName: n.owner_name }));
  return { ...settingsView(row), members, teams: [...new Set(members.map((m) => m.team))].sort(), numbers };
}

export async function saveSettings(tenantId, body, actor) {
  const current = (await query("SELECT * FROM assignment_settings WHERE tenant_id=$1", [tenantId])).rows[0];
  const next = { ...settingsView(current) };
  const has = (k) => body[k] !== undefined;
  if (has("enabled")) next.enabled = Boolean(body.enabled);
  if (has("mode")) {
    if (!MODES.includes(body.mode)) throw fail(400, "Choose round-robin or the least busy person");
    next.mode = body.mode;
  }
  if (has("team")) next.team = String(body.team || "").trim().slice(0, 40);
  if (has("keepOwner")) next.keepOwner = Boolean(body.keepOwner);
  if (has("useHours")) next.useHours = Boolean(body.useHours);
  if (has("maxOpen")) {
    const n = body.maxOpen === null || body.maxOpen === "" ? null : Number(body.maxOpen);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 1000)) throw fail(400, "The most chats a person can have open must be a whole number from 1 to 1000");
    next.maxOpen = n;
  }
  if (has("timezone")) {
    if (!validZone(String(body.timezone))) throw fail(400, "That time zone is not recognised. Use a name such as Asia/Kolkata or Asia/Dubai.");
    next.timezone = String(body.timezone);
  }
  if (has("workDays")) {
    const days = Array.isArray(body.workDays) ? [...new Set(body.workDays.map(Number))].sort() : null;
    if (!days || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw fail(400, "Working days must be numbers from 0 (Sunday) to 6 (Saturday)");
    next.workDays = days;
  }
  if (has("workStart")) next.workStart = String(body.workStart);
  if (has("workEnd")) next.workEnd = String(body.workEnd);
  if (!HHMM.test(next.workStart) || !HHMM.test(next.workEnd)) throw fail(400, "Working hours must be times such as 09:00 and 18:00");
  if (next.workStart >= next.workEnd) throw fail(400, "Working hours must start before they end");
  if (next.useHours && !next.workDays.length) throw fail(400, "Choose at least one working day");
  if (has("sessionNames")) {
    if (!Array.isArray(body.sessionNames)) throw fail(400, "Choose the numbers this applies to");
    const known = new Set((await query("SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1", [tenantId])).rows.map((r) => r.session_name));
    const names = [...new Set(body.sessionNames.map(String))];
    if (names.some((n) => !known.has(n))) throw fail(400, "One of those numbers does not belong to this company");
    next.sessionNames = names;
  }
  if (next.team) {
    const teamExists = await query("SELECT 1 FROM memberships WHERE tenant_id=$1 AND status='active' AND category=$2 LIMIT 1", [tenantId, next.team]);
    if (!teamExists.rowCount) throw fail(400, `Nobody is in a team called "${next.team}"`);
  }
  let rotation = null;
  if (has("rotation")) {
    if (!Array.isArray(body.rotation)) throw fail(400, "Choose who takes new chats");
    rotation = [...new Set(body.rotation.map(Number))];
    const valid = (await query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND status='active' AND user_id = ANY($2::int[])", [tenantId, rotation])).rows.map((r) => r.user_id);
    if (valid.length !== rotation.length) throw fail(400, "Everyone in the rotation must be an active teammate");
  }
  if (next.enabled) {
    const inRotation = rotation ?? (await query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND status='active' AND assignable", [tenantId])).rows.map((r) => r.user_id);
    if (!inRotation.length) throw fail(400, "Put at least one teammate in the rotation before turning this on");
    if (!next.sessionNames.length) throw fail(400, "Choose at least one number this applies to before turning this on");
  }
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO assignment_settings(tenant_id,enabled,mode,team,session_names,keep_owner,max_open,use_hours,timezone,work_days,work_start,work_end)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,mode=EXCLUDED.mode,team=EXCLUDED.team,session_names=EXCLUDED.session_names,keep_owner=EXCLUDED.keep_owner,
         max_open=EXCLUDED.max_open,use_hours=EXCLUDED.use_hours,timezone=EXCLUDED.timezone,work_days=EXCLUDED.work_days,work_start=EXCLUDED.work_start,work_end=EXCLUDED.work_end,updated_at=now()`,
      [tenantId, next.enabled, next.mode, next.team || null, JSON.stringify(next.sessionNames), next.keepOwner, next.maxOpen, next.useHours, next.timezone, next.workDays, next.workStart, next.workEnd],
    );
    if (rotation) await c.query("UPDATE memberships SET assignable=(user_id = ANY($2::int[])) WHERE tenant_id=$1", [tenantId, rotation]);
    await c.query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'assignment.settings_changed',$3)", [
      tenantId,
      actor?.id ?? null,
      JSON.stringify({ enabled: next.enabled, mode: next.mode, team: next.team, numbers: next.sessionNames.length, rotation: rotation?.length }),
    ]);
  });
  return getSettings(tenantId);
}

// A person says whether they are taking new chats right now.
export async function setAvailability(tenantId, userId, available) {
  const { rowCount } = await query("UPDATE memberships SET available=$3 WHERE tenant_id=$1 AND user_id=$2 AND status='active'", [tenantId, userId, Boolean(available)]);
  if (!rowCount) throw fail(404, "You are not a member of this company");
  return { available: Boolean(available) };
}

// Who should get this chat, given the people who can take it right now. Pure, so every rule can be tested alone.
//  - returning: the owner of this customer's open lead, when they are available (continuity beats rotation)
//  - people: [{ id, openChats }] in the rotation, available, on the team
export function pick({ mode, people, lastUserId = null, maxOpen = null, returning = null }) {
  if (returning) return { userId: returning, why: "returning customer" };
  const room = people.filter((p) => maxOpen === null || p.openChats < maxOpen).sort((a, b) => a.id - b.id);
  if (!room.length) return { userId: null, why: people.length ? "everyone is at their limit" : "nobody is available" };
  // the rotation continues after whoever got the last chat, wrapping round
  const after = [...room.filter((p) => p.id > (lastUserId ?? -1)), ...room.filter((p) => p.id <= (lastUserId ?? -1))];
  if (mode === "least_busy") {
    const fewest = Math.min(...room.map((p) => p.openChats));
    return { userId: after.find((p) => p.openChats === fewest).id, why: "least busy" };
  }
  return { userId: after[0].id, why: "round-robin" };
}

// Assigns a chat to a teammate the same way the Assign menu does: the name and the id, the lead's owner follows, the
// person is told and open browsers update.
export async function assignConversation({ tenantId, conversationId, userId, actor = null, io = null, onlyIfUnassigned = false }) {
  const who = (
    await query(
      "SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND u.id=$2",
      [tenantId, userId],
    )
  ).rows[0];
  if (!who) return null;
  const { rows } = await query(
    `UPDATE conversations SET assigned_to=$1,assigned_user_id=$2,updated_at=now() WHERE id=$3 AND tenant_id=$4 ${onlyIfUnassigned ? "AND assigned_user_id IS NULL" : ""} RETURNING *`,
    [who.name, who.id, conversationId, tenantId],
  );
  if (!rows[0]) return null;
  await createNotifications({ io, tenantId, recipients: [{ userId: who.id, type: "assignment" }], actor, conversationId, title: `${actor?.name || "Scriwo"} assigned you a chat`, body: rows[0].contact_name || "" }).catch((e) => console.error("Assignment notification failed:", e.message));
  await syncLeadOwner({ tenantId, conversation: rows[0], ownerUserId: who.id, io }).catch((e) => console.error("Lead owner sync failed:", e.message));
  emitForConversation(io, tenantId, conversationId, "conversation:updated", { conversationId, ...formatConversation(rows[0]) }, { snapshot: true });
  return { user: who, conversation: rows[0] };
}

// A customer's first message in a new chat: give it to someone if the company's rule says so.
export async function autoAssignNewChat({ tenantId, conversation, message, io = null, now = new Date() }) {
  if (!conversation || conversation.is_group || conversation.assigned_user_id) return { assigned: null, why: "not needed" };
  const tenant = (await query("SELECT plan,status,period_end,scheduled_plan FROM tenants WHERE id=$1", [tenantId])).rows[0];
  if (!tenant || tenant.status !== "active" || !planAllows(tenant, "automations")) return { assigned: null, why: "not on this plan" };
  // only the very first message of a chat starts an assignment: an old chat that comes back, or one a person started, is left alone
  const earlier = await query(
    `SELECT 1 FROM messages x WHERE x.tenant_id=$1 AND x.conversation_id=$2 AND x.id<>$3 AND (x.timestamp_epoch < $4 OR (x.timestamp_epoch = $4 AND x.id < $3)) LIMIT 1`,
    [tenantId, conversation.id, message.id, message.timestamp_epoch],
  );
  if (earlier.rowCount) return { assigned: null, why: "not a new chat" };

  const chosen = await withTransaction(async (c) => {
    const s = (await c.query("SELECT * FROM assignment_settings WHERE tenant_id=$1 FOR UPDATE", [tenantId])).rows[0];
    if (!s?.enabled) return { why: "off" };
    if (!(s.session_names || []).includes(conversation.session_name)) return { why: "number not covered" };
    if (!withinHours(s, now)) return { why: "outside working hours" };
    const people = (
      await c.query(
        `SELECT u.id,(SELECT count(*)::int FROM conversations x WHERE x.tenant_id=m.tenant_id AND x.assigned_user_id=u.id AND NOT x.is_closed AND NOT x.is_group) AS "openChats"
         FROM memberships m JOIN users u ON u.id=m.user_id
         WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND m.assignable AND m.available AND ($2::text IS NULL OR m.category=$2) ORDER BY u.id`,
        [tenantId, s.team],
      )
    ).rows;
    let returning = null;
    if (s.keep_owner && conversation.contact_id) {
      const lead = (await c.query("SELECT owner_user_id FROM leads WHERE tenant_id=$1 AND contact_id=$2 AND status='open' AND owner_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1", [tenantId, conversation.contact_id])).rows[0];
      if (lead) {
        const ok = await c.query("SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND m.available AND u.id=$2", [tenantId, lead.owner_user_id]);
        if (ok.rowCount) returning = lead.owner_user_id;
      }
    }
    const result = pick({ mode: s.mode, people, lastUserId: s.last_assigned_user_id, maxOpen: s.max_open, returning });
    if (!result.userId) return { why: result.why };
    // the rotation moves on only for chats it handed out, not for a returning customer
    if (!returning) await c.query("UPDATE assignment_settings SET last_assigned_user_id=$2 WHERE tenant_id=$1", [tenantId, result.userId]);
    return result;
  });
  if (!chosen.userId) return { assigned: null, why: chosen.why };
  const done = await assignConversation({ tenantId, conversationId: conversation.id, userId: chosen.userId, io, onlyIfUnassigned: true });
  if (!done) return { assigned: null, why: "someone assigned it first" };
  await query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,NULL,'chat.auto_assigned',$2)", [tenantId, JSON.stringify({ conversationId: conversation.id, userId: chosen.userId, why: chosen.why })]);
  return { assigned: chosen.userId, why: chosen.why };
}
