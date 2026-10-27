import crypto from "node:crypto";
import { query, withTransaction } from "../../db/index.js";
import { fail } from "../../middleware/http.js";
import { isManager } from "../../services/access.js";
import { visibleTo } from "../../services/leadService.js";
import { createNotifications } from "../../services/notificationService.js";
import { teamResponse } from "../../services/reportService.js";
import { planAllows } from "../../services/plans.js";
import { settingsOf } from "../entitlements.js";
import { humanDateTime } from "./time.js";

// The Revenue Leak Detector. Six real conditions, each found by reading the company's own records, never estimated:
//   unassigned_lead      an open lead nobody owns
//   overdue_followup     a follow-up whose time has passed
//   response_overdue     a customer waiting longer than the company's reply target (only chats that belong to an open lead)
//   missing_next_action  an open lead with nothing planned: no follow-up and no viewing
//   stalled_lead         an open lead with no activity at all for days and nothing planned
//   failed_automation    an automation rule that failed in the last day
// One alert is open per condition. When the condition stops being true the alert closes itself; if it comes back, a new one
// opens. Money on an alert is the lead's value as recorded, and is a figure at risk, not revenue.
export const KINDS = ["unassigned_lead", "overdue_followup", "response_overdue", "missing_next_action", "stalled_lead", "failed_automation"];
export const SCAN_EVERY_MINUTES = 5;
const DISMISS_QUIET_DAYS = 7;
const NOTIFY_INDIVIDUALLY = 10; // a scan that finds more than this tells the managers once, in one notice
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const span = (ms) => (ms >= 2 * DAY ? plural(Math.floor(ms / DAY), "day") : ms >= HOUR ? plural(Math.floor(ms / HOUR), "hour") : plural(Math.max(1, Math.floor(ms / MIN)), "minute"));
const who = `COALESCE(NULLIF(ct.name,''),NULLIF(l.contact_name,''),l.phone,'a lead')`;
const conversationOf = `(SELECT c.id FROM conversations c WHERE c.tenant_id=l.tenant_id AND c.contact_id=l.contact_id AND (l.session_name IS NULL OR c.session_name=l.session_name) ORDER BY c.last_active_epoch DESC LIMIT 1)`;
const BASE = `FROM leads l LEFT JOIN contacts ct ON ct.id=l.contact_id JOIN pipeline_stages s ON s.id=l.stage_id`;

// ── Finding the conditions ───────────────────────────────────────────────────────────────────────
export async function detect(tenantId, now = new Date(), settings = null) {
  const cfg = settings || (await settingsOf(tenantId, "real_estate"));
  const at = now.toISOString();
  const found = [];
  const add = (a) => found.push({ conversationId: null, leadId: null, detail: {}, value: 0, ...a });
  const lead = (r) => ({ leadId: r.lead_id, conversationId: r.conversation_id || null, value: Number(r.value) || 0 });

  // an open lead nobody owns
  for (const r of (await query(
    `SELECT l.id AS lead_id,l.value,l.created_at,${who} AS who,${conversationOf} AS conversation_id ${BASE}
     WHERE l.tenant_id=$1 AND l.status='open' AND l.owner_user_id IS NULL AND l.created_at < $2::timestamptz - make_interval(mins=>$3) ORDER BY l.created_at LIMIT 200`,
    [tenantId, at, cfg.unassignedMinutes],
  )).rows) {
    const age = now - new Date(r.created_at);
    add({ ...lead(r), kind: "unassigned_lead", dedupeKey: `unassigned:${r.lead_id}`, severity: age > DAY ? "high" : "medium",
      title: `No one owns ${r.who}`, reason: `Nobody is responsible for this lead, and it came in ${span(age)} ago. The target is ${span(cfg.unassignedMinutes * MIN)}.`, detail: { ageMinutes: Math.floor(age / MIN), targetMinutes: cfg.unassignedMinutes } });
  }

  // follow-ups that are late, one alert per lead with the oldest first
  const late = new Map();
  for (const r of (await query(
    `SELECT l.id AS lead_id,l.value,${who} AS who,${conversationOf} AS conversation_id,t.id AS task_id,t.title,t.due_at
     FROM lead_tasks t JOIN leads l ON l.id=t.lead_id LEFT JOIN contacts ct ON ct.id=l.contact_id
     WHERE t.tenant_id=$1 AND t.done_at IS NULL AND l.status='open' AND t.due_at < $2::timestamptz - make_interval(mins=>$3) ORDER BY t.due_at LIMIT 500`,
    [tenantId, at, cfg.overdueFollowupMinutes],
  )).rows) {
    const g = late.get(r.lead_id) || { row: r, tasks: [] };
    g.tasks.push({ id: r.task_id, title: r.title, dueAt: r.due_at });
    late.set(r.lead_id, g);
  }
  for (const { row: r, tasks } of late.values()) {
    const age = now - new Date(tasks[0].dueAt);
    add({ ...lead(r), kind: "overdue_followup", dedupeKey: `overdue:${r.lead_id}`, severity: age > DAY ? "high" : "medium",
      title: `Follow-up overdue for ${r.who}`, reason: `“${tasks[0].title}” was due ${span(age)} ago${tasks.length > 1 ? `, and ${plural(tasks.length - 1, "other follow-up")} ${tasks.length === 2 ? "is" : "are"} late too` : ""}.`, detail: { tasks: tasks.slice(0, 5), count: tasks.length, overdueMinutes: Math.floor(age / MIN) } });
  }

  // customers waiting longer than the reply target, in chats that belong to an open lead. The wait is the one the reports use.
  const report = await teamResponse(tenantId, { now: now.getTime() });
  const waiting = report.waiting.filter((w) => w.waitingSeconds > report.settings.slaMinutes * 60);
  if (waiting.length) {
    const rows = (await query(
      `SELECT DISTINCT ON (c.id) c.id AS conversation_id,l.id AS lead_id,l.value,${who} AS who FROM conversations c
       JOIN leads l ON l.tenant_id=c.tenant_id AND l.contact_id=c.contact_id AND l.status='open' AND (l.session_name IS NULL OR l.session_name=c.session_name)
       LEFT JOIN contacts ct ON ct.id=l.contact_id WHERE c.tenant_id=$1 AND c.id=ANY($2::varchar[]) ORDER BY c.id,l.created_at`,
      [tenantId, waiting.map((w) => w.conversationId)],
    )).rows;
    const byChat = new Map(rows.map((r) => [r.conversation_id, r]));
    for (const w of waiting) {
      const r = byChat.get(w.conversationId);
      if (!r) continue;
      const ms = w.waitingSeconds * 1000;
      add({ ...lead(r), kind: "response_overdue", dedupeKey: `response:${w.conversationId}`, severity: w.waitingSeconds > report.settings.slaMinutes * 60 * 4 ? "high" : "medium",
        title: `${r.who} has been waiting for a reply`, reason: `The customer wrote ${span(ms)} ago and has had no answer. Your reply target is ${span(report.settings.slaMinutes * MIN)}.`, detail: { waitingMinutes: Math.floor(ms / MIN), targetMinutes: report.settings.slaMinutes, assignedTo: w.assignedTo } });
    }
  }

  // open leads with nothing planned
  const stalled = (await query(
    `SELECT l.id AS lead_id,l.value,${who} AS who,${conversationOf} AS conversation_id,l.owner_user_id,
       GREATEST(l.created_at,l.stage_changed_at,
         COALESCE((SELECT max(a.created_at) FROM lead_activities a WHERE a.lead_id=l.id),'-infinity'),
         COALESCE((SELECT max(t.done_at) FROM lead_tasks t WHERE t.lead_id=l.id),'-infinity'),
         COALESCE((SELECT to_timestamp(max(c.last_active_epoch)) FROM conversations c WHERE c.tenant_id=l.tenant_id AND c.contact_id=l.contact_id),'-infinity')) AS last_touch
     ${BASE}
     WHERE l.tenant_id=$1 AND l.status='open'
       AND NOT EXISTS (SELECT 1 FROM lead_tasks t WHERE t.lead_id=l.id AND t.done_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM re_viewings v WHERE v.lead_id=l.id AND v.status IN ('scheduled','confirmed') AND v.starts_at > $2::timestamptz)
     ORDER BY l.created_at LIMIT 500`,
    [tenantId, at],
  )).rows;
  const unassigned = new Set(found.filter((f) => f.kind === "unassigned_lead").map((f) => f.leadId));
  for (const r of stalled) {
    const idle = now - new Date(r.last_touch);
    if (idle > cfg.stalledDays * DAY) {
      add({ ...lead(r), kind: "stalled_lead", dedupeKey: `stalled:${r.lead_id}`, severity: idle > 2 * cfg.stalledDays * DAY ? "high" : "medium",
        title: `${r.who} has gone quiet`, reason: `Nothing has happened on this lead for ${span(idle)} and nothing is planned. The limit is ${span(cfg.stalledDays * DAY)}.`, detail: { idleDays: Math.floor(idle / DAY), limitDays: cfg.stalledDays } });
    } else if (idle > cfg.missingNextActionHours * HOUR && !unassigned.has(r.lead_id)) {
      // an unassigned lead already has an alert for the real cause, and a stalled one has its own
      add({ ...lead(r), kind: "missing_next_action", dedupeKey: `next-action:${r.lead_id}`, severity: "medium",
        title: `No next step for ${r.who}`, reason: `This lead has no follow-up and no viewing planned, and has been like that for ${span(idle)}. Add a follow-up or book a viewing.`, detail: { idleHours: Math.floor(idle / HOUR), limitHours: cfg.missingNextActionHours } });
    }
  }

  // automation rules that failed in the last day
  for (const r of (await query(
    `SELECT e.automation_id,a.name,count(*)::int AS n,max(e.created_at) AS last_at,(array_agg(e.error ORDER BY e.created_at DESC))[1] AS last_error
     FROM automation_executions e JOIN automations a ON a.id=e.automation_id
     WHERE e.tenant_id=$1 AND e.status='failed' AND e.created_at > $2::timestamptz - interval '24 hours' GROUP BY e.automation_id,a.name`,
    [tenantId, at],
  )).rows) {
    add({ kind: "failed_automation", dedupeKey: `automation:${r.automation_id}`, severity: r.n >= 10 ? "high" : "medium",
      title: `Automation “${r.name}” is failing`, reason: `It failed ${plural(r.n, "time")} in the last day. The latest error: ${String(r.last_error || "no reason recorded").slice(0, 160)}`, detail: { automationId: r.automation_id, failures: r.n, lastAt: r.last_at } });
  }
  return found;
}

// ── Keeping the alerts in step with reality ──────────────────────────────────────────────────────
// Opens an alert for each condition that has no open one, refreshes the ones that still hold, and closes the ones that no
// longer do. Safe to run twice at once or twice in a row: the second run changes nothing.
export async function reconcile(tenantId, candidates, now = new Date()) {
  const currency = (await query("SELECT currency FROM tenants WHERE id=$1", [tenantId])).rows[0]?.currency || "AED";
  const quiet = new Set((await query("SELECT dedupe_key FROM re_alerts WHERE tenant_id=$1 AND resolution='dismissed' AND resolved_at > $2::timestamptz - make_interval(days=>$3)", [tenantId, now.toISOString(), DISMISS_QUIET_DAYS])).rows.map((r) => r.dedupe_key));
  return withTransaction(async (c) => {
    const open = new Map((await c.query("SELECT * FROM re_alerts WHERE tenant_id=$1 AND status IN ('open','snoozed') FOR UPDATE", [tenantId])).rows.map((r) => [r.dedupe_key, r]));
    const keep = new Set();
    const stats = { opened: 0, refreshed: 0, closed: 0 };
    for (const f of candidates) {
      if (quiet.has(f.dedupeKey)) continue;
      keep.add(f.dedupeKey);
      const ex = open.get(f.dedupeKey);
      if (ex) {
        const wakes = ex.status === "snoozed" && ex.snoozed_until && new Date(ex.snoozed_until) <= now;
        await c.query(
          `UPDATE re_alerts SET severity=$2,title=$3,reason=$4,detail=$5,value_at_risk=$6,last_seen_at=$7${wakes ? ",status='open',snoozed_until=NULL" : ""} WHERE id=$1`,
          [ex.id, f.severity, f.title, f.reason, JSON.stringify(f.detail), f.value, now.toISOString()],
        );
        stats.refreshed++;
      } else {
        // an alert that was closed and came straight back has already told people: it does not tell them again within a day
        const told = (await c.query("SELECT 1 FROM re_alerts WHERE tenant_id=$1 AND dedupe_key=$2 AND notified_at > $3::timestamptz - interval '24 hours' LIMIT 1", [tenantId, f.dedupeKey, now.toISOString()])).rowCount > 0;
        const made = await c.query(
          `INSERT INTO re_alerts(id,tenant_id,kind,dedupe_key,lead_id,conversation_id,severity,title,reason,detail,value_at_risk,currency,notified_at,first_seen_at,last_seen_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) ON CONFLICT DO NOTHING`,
          [crypto.randomUUID(), tenantId, f.kind, f.dedupeKey, f.leadId, f.conversationId, f.severity, f.title, f.reason, JSON.stringify(f.detail), f.value, currency, told ? now.toISOString() : null, now.toISOString()],
        );
        if (made.rowCount) stats.opened++;
      }
    }
    for (const [key, ex] of open) {
      if (keep.has(key)) continue;
      await c.query("UPDATE re_alerts SET status='resolved',resolution='auto',resolved_at=$2 WHERE id=$1", [ex.id, now.toISOString()]);
      stats.closed++;
    }
    return stats;
  });
}

const managersOf = async (tenantId) =>
  (await query(`SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND m.role IN ('owner','admin')`, [tenantId])).rows.map((r) => r.id);

// Tells the people who can act, once per alert. The first few get their own notice; a bigger batch is one notice to the managers.
export async function notifyNew(tenantId, io = null) {
  const { rows } = await query(
    `SELECT a.*,l.owner_user_id FROM re_alerts a LEFT JOIN leads l ON l.id=a.lead_id WHERE a.tenant_id=$1 AND a.status='open' AND a.notified_at IS NULL ORDER BY (a.severity='high') DESC,a.first_seen_at LIMIT 200`,
    [tenantId],
  );
  if (!rows.length) return 0;
  const managers = await managersOf(tenantId);
  let told = 0;
  const singles = rows.slice(0, NOTIFY_INDIVIDUALLY);
  for (const a of singles) {
    // claim first, so two servers never both send it
    const claimed = await query("UPDATE re_alerts SET notified_at=now() WHERE id=$1 AND notified_at IS NULL RETURNING id", [a.id]);
    if (!claimed.rowCount) continue;
    await createNotifications({
      io, tenantId, actor: null, conversationId: a.conversation_id || null, dedupeKey: `re-alert:${a.id}`,
      recipients: [...new Set([a.owner_user_id, ...managers])].filter(Boolean).map((userId) => ({ userId, type: "lead" })),
      title: a.title, body: a.reason.slice(0, 240),
    }).catch((e) => console.error("Revenue leak notice failed:", e.message));
    told++;
  }
  const rest = rows.slice(NOTIFY_INDIVIDUALLY);
  if (rest.length) {
    const claimed = await query("UPDATE re_alerts SET notified_at=now() WHERE id=ANY($1::varchar[]) AND notified_at IS NULL RETURNING id", [rest.map((a) => a.id)]);
    if (claimed.rowCount)
      await createNotifications({
        io, tenantId, actor: null, dedupeKey: `re-alerts:${Date.now()}`, recipients: managers.map((userId) => ({ userId, type: "lead" })),
        title: `${plural(claimed.rowCount, "more revenue leak")} found`, body: "Open Real estate, Revenue to see them.",
      }).catch((e) => console.error("Revenue leak notice failed:", e.message));
    told += claimed.rowCount;
  }
  return told;
}

export async function scanTenant(tenantId, { io = null, now = new Date() } = {}) {
  const found = await detect(tenantId, now);
  const stats = await reconcile(tenantId, found, now);
  const told = await notifyNew(tenantId, io);
  return { ...stats, told, conditions: found.length };
}

// The background job: every few minutes, each company that has the solution and whose plan still includes the pipeline.
export async function pumpRealEstate(io, { now = new Date() } = {}) {
  const { rows } = await query(
    `SELECT t.* FROM tenant_solutions s JOIN tenants t ON t.id=s.tenant_id WHERE s.solution_key='real_estate' AND s.enabled AND t.status='active' ORDER BY t.id LIMIT 200`,
  );
  let scanned = 0;
  for (const t of rows) {
    if (!planAllows(t, "leads")) continue;
    // claim the scan: only one server takes a company in any five minutes
    const claim = await query(
      `INSERT INTO re_scan_state(tenant_id,scanned_at) VALUES($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET scanned_at=$2 WHERE re_scan_state.scanned_at <= $2::timestamptz - make_interval(mins=>$3) RETURNING tenant_id`,
      [t.id, now.toISOString(), SCAN_EVERY_MINUTES],
    );
    if (!claim.rowCount) continue;
    try {
      await scanTenant(t.id, { io, now });
      scanned++;
    } catch (e) {
      console.error(`Revenue leak scan failed for ${t.id}:`, e.message);
    }
  }
  return scanned;
}

// ── What people see ──────────────────────────────────────────────────────────────────────────────
export const alertView = (r) => ({
  id: r.id,
  kind: r.kind,
  severity: r.severity,
  status: r.status,
  title: r.title,
  reason: r.reason,
  detail: r.detail,
  leadId: r.lead_id,
  conversationId: r.conversation_id,
  leadName: r.lead_name || "",
  stageName: r.stage_name || "",
  ownerName: r.owner_name || "",
  valueAtRisk: Number(r.value_at_risk),
  currency: r.currency,
  snoozedUntil: r.snoozed_until,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  resolvedAt: r.resolved_at,
  resolution: r.resolution,
});
const ALERT_SELECT = `SELECT a.*,${who} AS lead_name,s.name AS stage_name,u.name AS owner_name FROM re_alerts a
  LEFT JOIN leads l ON l.id=a.lead_id LEFT JOIN contacts ct ON ct.id=l.contact_id LEFT JOIN pipeline_stages s ON s.id=l.stage_id LEFT JOIN users u ON u.id=l.owner_user_id`;

// Managers see every alert; staff see those on leads they can see. An alert about an automation rule is for managers only.
function alertVisible(req, params) {
  if (isManager(req)) return "TRUE";
  return `(a.lead_id IS NOT NULL AND ${visibleTo(req, params)})`;
}

export async function listAlerts(req, f = {}) {
  const params = [req.tenantId];
  const where = ["a.tenant_id=$1", alertVisible(req, params)];
  const status = ["open", "snoozed", "resolved"].includes(f.status) ? f.status : "open";
  where.push(`a.status=$${params.push(status)}`);
  if (f.kind && KINDS.includes(f.kind)) where.push(`a.kind=$${params.push(f.kind)}`);
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 200);
  const { rows } = await query(`${ALERT_SELECT} WHERE ${where.join(" AND ")} ORDER BY (a.severity='high') DESC,a.value_at_risk DESC,a.first_seen_at LIMIT ${limit}`, params);
  return rows.map(alertView);
}

async function findAlert(req, id) {
  const params = [req.tenantId, String(id)];
  const row = (await query(`${ALERT_SELECT} WHERE a.tenant_id=$1 AND a.id=$2 AND ${alertVisible(req, params)}`, params)).rows[0];
  if (!row) throw fail(404, "Alert not found");
  return row;
}
async function close(req, id, resolution) {
  const a = await findAlert(req, id);
  if (a.status === "resolved") throw fail(409, "This alert is already closed");
  await query("UPDATE re_alerts SET status='resolved',resolution=$3,resolved_at=now(),resolved_by=$4 WHERE id=$1 AND tenant_id=$2", [a.id, req.tenantId, resolution, req.user.id]);
  return alertView((await query(`${ALERT_SELECT} WHERE a.id=$1`, [a.id])).rows[0]);
}
// "I have dealt with it". If it is still true at the next scan it opens again, without telling anyone twice.
export const resolveAlert = (req, id) => close(req, id, "fixed");
// "This is not a problem": the same condition stays quiet for a week.
export const dismissAlert = (req, id) => close(req, id, "dismissed");
export async function snoozeAlert(req, id, hours) {
  const n = Number(hours);
  if (!Number.isInteger(n) || n < 1 || n > 168) throw fail(400, "Snooze for 1 to 168 hours");
  const a = await findAlert(req, id);
  if (a.status === "resolved") throw fail(409, "This alert is already closed");
  await query("UPDATE re_alerts SET status='snoozed',snoozed_until=now()+make_interval(hours=>$3) WHERE id=$1 AND tenant_id=$2", [a.id, req.tenantId, n]);
  return alertView((await query(`${ALERT_SELECT} WHERE a.id=$1`, [a.id])).rows[0]);
}

// The numbers behind the screen. Money is kept in three separate lines because they mean different things.
export async function overview(req, { days = 30, now = new Date() } = {}) {
  const span_ = Math.min(Math.max(Number(days) || 30, 1), 365);
  const since = new Date(now.getTime() - span_ * DAY).toISOString();
  const currency = (await query("SELECT currency FROM tenants WHERE id=$1", [req.tenantId])).rows[0]?.currency || "AED";
  const p = [req.tenantId];
  const vis = visibleTo(req, p);
  const one = async (sql, extra = []) => (await query(sql, [...p, ...extra])).rows[0];
  const open = await one(`SELECT count(*)::int AS n,COALESCE(sum(l.value),0) AS total FROM leads l WHERE l.tenant_id=$1 AND l.status='open' AND ${vis}`);
  const won = await one(`SELECT count(*)::int AS n,COALESCE(sum(l.value),0) AS total FROM leads l WHERE l.tenant_id=$1 AND l.status='won' AND l.closed_at >= $${p.length + 1} AND ${vis}`, [since]);
  const lost = await one(`SELECT count(*)::int AS n FROM leads l WHERE l.tenant_id=$1 AND l.status='lost' AND l.closed_at >= $${p.length + 1} AND ${vis}`, [since]);
  const cohort = await one(
    `SELECT count(*)::int AS enquiries,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM re_lead_profiles r WHERE r.lead_id=l.id AND r.qualification_status='qualified'))::int AS qualified,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM re_viewings v WHERE v.lead_id=l.id AND v.status IN ('scheduled','confirmed','completed','no_show')))::int AS viewing_booked,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM re_viewings v WHERE v.lead_id=l.id AND v.status='completed'))::int AS viewing_held,
       count(*) FILTER (WHERE l.status='won')::int AS won
     FROM leads l WHERE l.tenant_id=$1 AND l.created_at >= $${p.length + 1} AND ${vis}`,
    [since],
  );
  const alerts = await listAlerts(req, { status: "open", limit: 200 });
  const byKind = Object.fromEntries(KINDS.map((k) => [k, alerts.filter((a) => a.kind === k).length]));
  const atRiskLeads = new Map(alerts.filter((a) => a.leadId).map((a) => [a.leadId, a.valueAtRisk]));
  const upcoming = await one(`SELECT count(*)::int AS n FROM re_viewings v JOIN leads l ON l.id=v.lead_id WHERE v.tenant_id=$1 AND v.status IN ('scheduled','confirmed') AND v.starts_at >= now() AND v.starts_at < now() + interval '7 days' AND ${vis}`);
  const rate = (n) => (cohort.enquiries ? Math.round((n / cohort.enquiries) * 1000) / 10 : null);
  return {
    windowDays: span_,
    currency,
    // three different things, kept apart on purpose
    values: {
      pipeline: { amount: Number(open.total), leads: open.n, meaning: "hypothetical", note: "What open leads are worth if they all close. Not revenue." },
      atRisk: { amount: [...atRiskLeads.values()].reduce((s, v) => s + v, 0), leads: atRiskLeads.size, meaning: "hypothetical", note: "The value of open leads that have a revenue leak. Not revenue." },
      won: { amount: Number(won.total), deals: won.n, meaning: "recorded", note: `The value recorded on leads marked won in the last ${span_} days.` },
    },
    lost: lost.n,
    alerts: { open: alerts.length, high: alerts.filter((a) => a.severity === "high").length, byKind },
    funnel: {
      note: `Leads that came in during the last ${span_} days, and how far they have got since.`,
      enquiries: cohort.enquiries,
      qualified: cohort.qualified,
      viewingBooked: cohort.viewing_booked,
      viewingHeld: cohort.viewing_held,
      won: cohort.won,
      rates: { qualified: rate(cohort.qualified), viewingBooked: rate(cohort.viewing_booked), viewingHeld: rate(cohort.viewing_held), won: rate(cohort.won) },
    },
    upcomingViewings: upcoming.n,
    generatedAt: humanDateTime(now.getTime(), "UTC") + " UTC",
  };
}
