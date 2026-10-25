import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { fail, failWith } from "../middleware/http.js";
import { planOf } from "./plans.js";
import { subscriptionView } from "./subscriptionService.js";
import { numberHealth, numberHealthView } from "./numberHealth.js";
import { createNotifications } from "./notificationService.js";

// What the platform administrator sees across every company: counts and health, never a chat, a contact or a file.

const mask = (phone) => (phone ? `…${String(phone).replace(/\D/g, "").slice(-4)}` : null);

let cached = null;
// The totals read every company's recent messages, so they are worked out at most once a minute.
export async function platformOverview({ nowMs = Date.now(), fresh = false } = {}) {
  if (!fresh && cached && nowMs - cached.at < 60_000) return cached.value;
  const epoch = Math.floor(nowMs / 1000);
  const [tenants, people, numbers, messages, ai, takings] = await Promise.all([
    query("SELECT id,plan,status,period_start,period_end,billing_cycle,scheduled_plan,created_at FROM tenants"),
    query("SELECT count(DISTINCT m.user_id)::int AS n FROM memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.status='active' AND u.status='active' AND NOT COALESCE(u.is_superadmin,false)"),
    query(
      `SELECT count(*) FILTER (WHERE phone IS NOT NULL)::int AS linked,
              count(*) FILTER (WHERE phone IS NOT NULL AND status='CONNECTED' AND lease_until>now())::int AS connected
       FROM whatsapp_sessions`,
    ),
    query(
      `SELECT count(*) FILTER (WHERE sender='agent' AND type<>'internal_note' AND status IN ('sent','delivered','read') AND timestamp_epoch > $1::bigint-86400)::int AS sent_24h,
              count(*) FILTER (WHERE sender='agent' AND type<>'internal_note' AND status IN ('sent','delivered','read') AND timestamp_epoch > $1::bigint-7*86400)::int AS sent_7d,
              count(*) FILTER (WHERE sender='agent' AND type<>'internal_note' AND status IN ('sent','delivered','read'))::int AS sent_30d,
              count(*) FILTER (WHERE sender='customer' AND timestamp_epoch > $1::bigint-7*86400)::int AS received_7d,
              count(*) FILTER (WHERE sender='agent' AND type<>'internal_note' AND status IN ('failed','uncertain') AND timestamp_epoch > $1::bigint-7*86400)::int AS failed_7d,
              count(DISTINCT tenant_id) FILTER (WHERE timestamp_epoch > $1::bigint-7*86400)::int AS active_companies_7d
       FROM messages WHERE timestamp_epoch > $1::bigint-30*86400`,
      [epoch],
    ),
    query(
      `SELECT COALESCE(sum(requests),0)::int AS requests,COALESCE(sum(input_tokens+output_tokens),0)::bigint AS tokens,count(DISTINCT tenant_id)::int AS companies
       FROM ai_usage WHERE day>=date_trunc('month',(now() AT TIME ZONE 'UTC')::date)::date`,
    ),
    query(
      `SELECT currency,count(*)::int AS payments,COALESCE(sum(amount),0)::numeric AS amount FROM subscription_payments
       WHERE created_at > now()-interval '30 days' AND currency IS NOT NULL GROUP BY currency ORDER BY currency`,
    ),
  ]);
  const bySubscription = {},
    byPlan = {};
  const today = new Date(nowMs).toISOString().slice(0, 10);
  for (const t of tenants.rows) {
    const s = subscriptionView(t, today).status;
    bySubscription[s] = (bySubscription[s] || 0) + 1;
    const plan = planOf(t.plan).name;
    byPlan[plan] = (byPlan[plan] || 0) + 1;
  }
  const m = messages.rows[0];
  const value = {
    generatedAt: new Date(nowMs).toISOString(),
    companies: {
      total: tenants.rowCount,
      active: tenants.rows.filter((t) => t.status === "active").length,
      suspended: tenants.rows.filter((t) => t.status !== "active").length,
      newLast30Days: tenants.rows.filter((t) => new Date(t.created_at).getTime() > nowMs - 30 * 86400_000).length,
      byPlan,
      bySubscription,
    },
    people: { active: people.rows[0].n },
    numbers: { linked: numbers.rows[0].linked, connected: numbers.rows[0].connected, notConnected: numbers.rows[0].linked - numbers.rows[0].connected },
    messages: { sentLast24h: m.sent_24h, sentLast7Days: m.sent_7d, sentLast30Days: m.sent_30d, receivedLast7Days: m.received_7d, failedLast7Days: m.failed_7d, activeCompaniesLast7Days: m.active_companies_7d },
    ai: { requestsThisMonth: ai.rows[0].requests, tokensThisMonth: Number(ai.rows[0].tokens), companiesUsing: ai.rows[0].companies },
    payments: { last30Days: takings.rows.map((r) => ({ currency: r.currency, payments: r.payments, amount: Number(r.amount) })) },
  };
  cached = { at: nowMs, value };
  return value;
}

// Every company's numbers that need attention first. Phone numbers are shortened to their last four digits.
export async function platformNumberHealth({ problemsOnly = false, nowMs = Date.now() } = {}) {
  const tenants = (
    await query(`SELECT DISTINCT t.id,t.name,t.status FROM tenants t JOIN whatsapp_sessions s ON s.tenant_id=t.id ORDER BY t.name LIMIT 500`)
  ).rows;
  const rank = { down: 0, warn: 1, ok: 2, unpaired: 3 };
  const companies = [];
  for (const t of tenants) {
    const numbers = (await numberHealth(t.id, { nowMs })).map(numberHealthView).map((n) => ({ ...n, phone: mask(n.phone) }));
    const visible = problemsOnly ? numbers.filter((n) => n.level === "down" || n.level === "warn") : numbers;
    if (!visible.length) continue;
    const counts = { down: 0, warn: 0, ok: 0, unpaired: 0 };
    for (const n of numbers) counts[n.level]++;
    companies.push({ id: t.id, name: t.name, status: t.status, counts, numbers: visible.sort((a, b) => rank[a.level] - rank[b.level]) });
  }
  const worst = (c) => (c.counts.down ? 0 : c.counts.warn ? 1 : 2);
  companies.sort((a, b) => worst(a) - worst(b) || a.name.localeCompare(b.name));
  const total = { down: 0, warn: 0, ok: 0, unpaired: 0 };
  for (const c of companies) for (const k of Object.keys(total)) total[k] += c.counts[k];
  return { generatedAt: new Date(nowMs).toISOString(), totals: total, companies };
}

// ── Support access ─────────────────────────────────────────────────────────────────────────────────────────
export const SUPPORT_SECTIONS = ["team", "numbers", "activity"];
const sessionView = (r, actions = []) => ({
  id: r.id,
  adminName: r.admin_name,
  reason: r.reason,
  startedAt: r.started_at,
  expiresAt: r.expires_at,
  endedAt: r.ended_at,
  active: !r.ended_at && new Date(r.expires_at) > new Date(),
  actions,
});

export async function startSupportSession({ tenantId, admin, reason, minutes = 60, io = null }) {
  const why = String(reason || "").trim();
  if (why.length < 10) throw fail(400, "Say why you need to look at this account (at least 10 characters). The company can read it.");
  if (why.length > 500) throw fail(400, "Keep the reason under 500 characters");
  const mins = Number(minutes);
  if (!Number.isInteger(mins) || mins < 5 || mins > 240) throw fail(400, "A support session lasts from 5 to 240 minutes");
  const tenant = (await query("SELECT id,name FROM tenants WHERE id=$1", [tenantId])).rows[0];
  if (!tenant) throw fail(404, "Company not found");
  const id = crypto.randomUUID();
  await withTransaction(async (c) => {
    await c.query("UPDATE support_access SET ended_at=now() WHERE tenant_id=$1 AND admin_user_id=$2 AND ended_at IS NULL", [tenantId, admin.id]);
    await c.query(
      `INSERT INTO support_access(id,tenant_id,admin_user_id,admin_name,admin_email,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(mins => $7))`,
      [id, tenantId, admin.id, admin.name || "", admin.email || "", why, mins],
    );
    await c.query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'support.session_started',$3)", [tenantId, admin.id, JSON.stringify({ accessId: id, minutes: mins, reason: why })]);
  });
  const managers = (
    await query(
      `SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND m.role IN ('owner','admin')`,
      [tenantId],
    )
  ).rows;
  await createNotifications({
    io,
    tenantId,
    recipients: managers.map((m) => ({ userId: m.id, type: "support" })),
    actor: null,
    title: "Scriwo support opened a support session on your account",
    body: `${admin.name || "A Scriwo administrator"}: ${why} It lasts ${mins} minutes and shows your team list, the health of your numbers and your account activity. It never shows chats, contacts or files.`,
  }).catch((e) => console.error("Support notification failed:", e.message));
  return (await supportSessions(tenantId, { id })).find((s) => s.id === id);
}

export async function endSupportSession({ tenantId, admin }) {
  const { rowCount } = await query("UPDATE support_access SET ended_at=now() WHERE tenant_id=$1 AND admin_user_id=$2 AND ended_at IS NULL AND expires_at>now()", [tenantId, admin.id]);
  return { ended: rowCount > 0 };
}

async function openSession(tenantId, adminId) {
  const s = (await query("SELECT * FROM support_access WHERE tenant_id=$1 AND admin_user_id=$2 AND ended_at IS NULL AND expires_at>now() ORDER BY started_at DESC LIMIT 1", [tenantId, adminId])).rows[0];
  if (!s) {
    throw failWith(403, "Open a support session first, with the reason you need to look at this account.", { code: "support_session_required" });
  }
  return s;
}
const note = (access, action, detail = {}) => query("INSERT INTO support_access_log(access_id,tenant_id,action,detail) VALUES($1,$2,$3,$4)", [access.id, access.tenant_id, action, JSON.stringify(detail)]);

// One thing the session allows looking at. Each look is written to the log the company can read.
export async function supportLook({ tenantId, admin, section }) {
  if (!SUPPORT_SECTIONS.includes(section)) throw fail(404, "Unknown section");
  const access = await openSession(tenantId, admin.id);
  let data;
  if (section === "team") {
    data = (
      await query(
        `SELECT u.id,u.name,u.email,m.role,m.category,m.status,m.created_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY m.role,u.name`,
        [tenantId],
      )
    ).rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, team: r.category, status: r.status, joinedAt: r.created_at }));
  } else if (section === "numbers") {
    data = (await numberHealth(tenantId)).map(numberHealthView).map((n) => ({ ...n, phone: mask(n.phone) }));
  } else {
    data = (
      await query(
        `SELECT a.id,a.event_type,a.metadata,a.created_at,u.name AS actor FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE a.tenant_id=$1 ORDER BY a.id DESC LIMIT 50`,
        [tenantId],
      )
    ).rows.map((e) => ({ id: e.id, type: e.event_type, actor: e.actor, at: e.created_at, details: e.metadata }));
  }
  await note(access, `viewed_${section}`, { items: data.length });
  return { session: sessionView(access), section, data };
}

// The sessions on one company, with what was looked at in each. This is what the company reads.
export async function supportSessions(tenantId, { id = null, limit = 50 } = {}) {
  const { rows } = await query(`SELECT * FROM support_access WHERE tenant_id=$1 ${id ? "AND id=$3" : ""} ORDER BY started_at DESC LIMIT $2`, id ? [tenantId, limit, id] : [tenantId, limit]);
  if (!rows.length) return [];
  const log = (await query("SELECT access_id,action,detail,at FROM support_access_log WHERE access_id = ANY($1::text[]) ORDER BY at", [rows.map((r) => r.id)])).rows;
  return rows.map((r) => sessionView(r, log.filter((l) => l.access_id === r.id).map((l) => ({ action: l.action, at: l.at, detail: l.detail }))));
}
