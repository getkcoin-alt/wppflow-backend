import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { fail } from "../middleware/http.js";
import { choosePlan, planCatalogue, planOf, GRACE_DAYS } from "./plans.js";
import { dateOnly, daysBetween, todayUtc, utcDate } from "./dates.js";
import { createNotifications } from "./notificationService.js";

// A company's subscription: the plan it pays for, the period that payment covers, and what happens when the
// period ends. Payments are made online from Plans & Billing, or taken outside the product (an invoice), so the platform admin
// records each one here. Nothing in this file switches a company off for not paying: a company that is overdue
// is flagged for the team and told. After the grace days (7) the paid features switch off, never any data.
export const CYCLES = ["monthly", "annual"];
export const SOON_DAYS = 14;
const MAX_PERIOD_DAYS = 3 * 366;
export { daysBetween, dateOnly, todayUtc };

const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const d = utcDate(value);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};
// The same day next month (or next year); a month without that day ends on its last day.
export function addCycle(date, cycle) {
  const d = utcDate(date);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (cycle === "annual" ? 12 : 1), 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target.toISOString().slice(0, 10);
}
export const showDate = (date) =>
  utcDate(date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export const addDays = (date, n) => {
  const d = utcDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const rankOf = (id) => planCatalogue({ all: true }).findIndex((p) => p.id === id);

// Where the company stands, worked out from the dates every time it is asked, so it can never be left stale:
//   free         the Free plan: nothing to pay
//   legacy       a company from before plans: it keeps everything and has no billing to track
//   unrecorded   on a paid plan, but no payment has been recorded, so there is no renewal date
//   active       paid, and the renewal is more than two weeks away
//   due_soon     the renewal is within two weeks (or today)
//   overdue      the period ended and no payment has been recorded; everything still works for the grace days
//   expired      more than the grace days overdue: the paid features are off until a payment is recorded
//   changing     paid, and moving to a smaller plan when the period ends
//   cancelling   paid, and moving to Free when the period ends
export function subscriptionView(tenant, now = todayUtc()) {
  const plan = planOf(tenant.plan);
  const periodEnd = dateOnly(tenant.period_end);
  const periodStart = dateOnly(tenant.period_start);
  const scheduled = tenant.scheduled_plan ? planOf(tenant.scheduled_plan) : null;
  const daysLeft = periodEnd ? daysBetween(now, periodEnd) : null;
  let status;
  if (!plan.restricted) status = "legacy";
  else if (plan.id === "free") status = "free";
  else if (!periodEnd) status = "unrecorded";
  else if (scheduled?.id) status = scheduled.id === "free" ? "cancelling" : "changing";
  else if (daysLeft < -GRACE_DAYS) status = "expired";
  else if (daysLeft < 0) status = "overdue";
  else status = daysLeft <= SOON_DAYS ? "due_soon" : "active";
  const billed = status !== "free" && status !== "legacy";
  return {
    status,
    plan: plan.name,
    planId: plan.id,
    cycle: billed ? tenant.billing_cycle || null : null,
    periodStart: billed ? periodStart : null,
    periodEnd: billed ? periodEnd : null,
    daysLeft: billed ? daysLeft : null,
    scheduledPlan: billed && scheduled?.id ? { id: scheduled.id, name: scheduled.name } : null,
    // the last day everything still works when the payment is late, and whether the paid features are off now
    graceEndsOn: billed && periodEnd ? addDays(periodEnd, GRACE_DAYS) : null,
    lapsed: status === "expired",
  };
}

const limitOf = (value) => {
  const n = Number(value);
  if (value === null || value === "" || !Number.isInteger(n) || n < 1 || n > 500)
    throw fail(400, "Sessions limit must be a whole number from 1 to 500");
  return n;
};
export const audit = (client, tenantId, actorId, type, metadata) =>
  client.query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,$3,$4)", [
    tenantId,
    actorId ?? null,
    type,
    JSON.stringify(metadata),
  ]);
// The readable history shown to the company: what happened to the subscription, and when.
export const logEvent = (client, tenantId, type, plan, details = {}) =>
  client.query("INSERT INTO subscription_events(tenant_id,event_type,plan,details) VALUES($1,$2,$3,$4)", [tenantId, type, plan ?? null, JSON.stringify(details)]);
const tenantRow = async (client, id) => {
  const { rows } = await client.query("SELECT * FROM tenants WHERE id=$1 FOR UPDATE", [id]);
  if (!rows[0]) throw fail(404, "Company not found");
  return rows[0];
};

// Records that a payment was received for a period, and makes that period the company's current one. The plan
// is the one named, else the one scheduled for this period, else the plan it is on; paying for a different plan
// moves the company to it. The period starts where the last one ended (or today when that was long ago), and
// ends a month or a year later unless the admin gives the renewal date.
export async function recordPayment({ tenantId, actorId, body = {}, now = todayUtc(), client: given = null, trusted = false, source = "manual", orderId = null }) {
  // `given` joins a transaction the caller already has open (an online payment is settled together with its
  // invoice); `trusted` is a payment the gateway has already taken, which is honoured even if the plan was taken
  // off sale while the customer was paying.
  const work = async (client) => {
    const t = await tenantRow(client, tenantId);
    const current = planOf(t.plan);
    let target;
    if (body.plan !== undefined && body.plan !== null && body.plan !== "") {
      target = trusted ? planOf(body.plan) : choosePlan(body.plan);
      if (!target.id) throw fail(400, "Choose the plan this payment is for");
    }
    else if (t.scheduled_plan) target = planOf(t.scheduled_plan);
    else if (current.id) target = current;
    else throw fail(400, "Choose the plan this payment is for");
    if (target.id === "free")
      throw fail(400, "The Free plan has no payment. To end a paid plan, schedule a change to Free at the end of the period.");

    const cycle = body.cycle ?? t.billing_cycle;
    if (!CYCLES.includes(cycle)) throw fail(400, "Choose monthly or annual billing");

    const lastEnd = dateOnly(t.period_end);
    const start = body.periodStart ?? (lastEnd && daysBetween(lastEnd, now) <= 31 ? lastEnd : now);
    if (!validDate(start)) throw fail(400, "The period must start on a real date (YYYY-MM-DD)");
    const end = body.periodEnd ?? addCycle(start, cycle);
    if (!validDate(end)) throw fail(400, "The renewal date must be a real date (YYYY-MM-DD)");
    if (daysBetween(start, end) < 1) throw fail(400, "The renewal date must be after the day the period starts");
    if (daysBetween(start, end) > MAX_PERIOD_DAYS) throw fail(400, "A period can be at most three years long");

    let amount = null,
      currency = null;
    if (body.amount !== undefined && body.amount !== null && body.amount !== "") {
      amount = Math.round(Number(body.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) throw fail(400, "The amount must be a number, zero or more");
      currency = body.currency || t.currency || "AED";
      if (!["AED", "INR"].includes(currency)) throw fail(400, "The currency must be AED or INR");
    }
    const reference = String(body.reference ?? "").trim().slice(0, 120);

    // Paying for another plan moves the company to it, with that plan's number limit unless one is typed.
    let sessionsLimit = t.sessions_limit;
    if (body.sessionsLimit !== undefined && body.sessionsLimit !== null && body.sessionsLimit !== "") sessionsLimit = limitOf(body.sessionsLimit);
    else if (target.id !== current.id) {
      if (!target.numbers) throw fail(400, `${target.name} has a custom number limit: enter how many WhatsApp numbers this company gets`);
      sessionsLimit = target.numbers;
    }

    await client.query(
      `UPDATE tenants SET plan=$2,sessions_limit=$3,billing_cycle=$4,period_start=$5,period_end=$6,scheduled_plan=NULL,
         reminded_soon_for=NULL,reminded_overdue_for=NULL,reminded_expired_for=NULL,updated_at=now() WHERE id=$1`,
      [tenantId, target.name, sessionsLimit, cycle, start, end],
    );
    const paymentId = crypto.randomUUID();
    await client.query(
      `INSERT INTO subscription_payments(id,tenant_id,recorded_by,plan,billing_cycle,period_start,period_end,amount,currency,reference,source,order_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [paymentId, tenantId, actorId ?? null, target.name, cycle, start, end, amount, currency, reference, source, orderId],
    );
    await logEvent(client, tenantId, "payment", target.name, { cycle, periodStart: start, periodEnd: end, amount, currency, reference, source, previousPlan: t.plan });
    await audit(client, tenantId, actorId, "subscription.payment_recorded", {
      plan: target.name,
      previousPlan: t.plan,
      cycle,
      periodStart: start,
      periodEnd: end,
      amount,
      currency,
      reference,
    });
    // a renewal date already in the past would show the company as late, or switch its paid features off
    const status = subscriptionView({ plan: target.name, billing_cycle: cycle, period_start: start, period_end: end, scheduled_plan: null }, now).status;
    const notice =
      status === "overdue" || status === "expired"
        ? `The renewal date ${showDate(end)} has already passed, so the company will show as ${status === "expired" ? "expired and its paid features stay off" : "late"}. Check the dates if that is not what you meant.`
        : null;
    return { paymentId, plan: target, planChanged: target.id !== current.id, notice, periodStart: start, periodEnd: end, cycle };
  };
  return given ? work(given) : withTransaction(work);
}

// "Moves to a smaller plan (or to Free) when the period ends". A bigger plan takes effect at once, so it is not
// scheduled: it is a plan change.
export async function scheduleChange({ tenantId, actorId, plan }) {
  return withTransaction(async (client) => {
    const t = await tenantRow(client, tenantId);
    const current = planOf(t.plan);
    if (!current.id || current.id === "free") throw fail(400, "This company is not on a paid plan");
    if (!dateOnly(t.period_end)) throw fail(400, "Record a payment first, so there is a renewal date for the change to start on");
    const target = choosePlan(plan);
    if (target.id === "enterprise") throw fail(400, "Enterprise is agreed with the company: change the plan directly");
    if (rankOf(target.id) >= rankOf(current.id))
      throw fail(400, "A change at the end of the period is for a smaller plan. A bigger plan takes effect straight away: use Change plan.");
    await client.query("UPDATE tenants SET scheduled_plan=$2,updated_at=now() WHERE id=$1", [tenantId, target.id]);
    await audit(client, tenantId, actorId, "subscription.change_scheduled", {
      from: current.name,
      to: target.name,
      on: dateOnly(t.period_end),
    });
    await logEvent(client, tenantId, target.id === "free" ? "cancel_scheduled" : "downgrade_scheduled", current.name, { to: target.name, on: dateOnly(t.period_end) });
    return target;
  });
}

export async function clearScheduledChange({ tenantId, actorId }) {
  return withTransaction(async (client) => {
    const t = await tenantRow(client, tenantId);
    if (!t.scheduled_plan) return false;
    await client.query("UPDATE tenants SET scheduled_plan=NULL,updated_at=now() WHERE id=$1", [tenantId]);
    await audit(client, tenantId, actorId, "subscription.change_cleared", { was: planOf(t.scheduled_plan).name });
    await logEvent(client, tenantId, "change_cleared", planOf(t.plan).name, { was: planOf(t.scheduled_plan).name });
    return true;
  });
}

export async function paymentsOf(tenantId) {
  const { rows } = await query(
    `SELECT p.*,u.name AS recorded_by_name,i.id AS invoice_id,i.number AS invoice_number FROM subscription_payments p
     LEFT JOIN users u ON u.id=p.recorded_by LEFT JOIN invoices i ON i.subscription_payment_id=p.id::text
     WHERE p.tenant_id=$1 ORDER BY p.created_at DESC LIMIT 100`,
    [tenantId],
  );
  return rows.map((p) => ({
    id: p.id,
    plan: p.plan,
    cycle: p.billing_cycle,
    periodStart: dateOnly(p.period_start),
    periodEnd: dateOnly(p.period_end),
    amount: p.amount === null ? null : Number(p.amount),
    currency: p.currency,
    reference: p.reference,
    recordedBy: p.recorded_by_name || (p.source === "manual" ? null : "Online payment"),
    recordedAt: p.created_at,
    source: p.source,
    invoice: p.invoice_id ? { id: p.invoice_id, number: p.invoice_number } : null,
  }));
}

// ── Changes that fall due, and reminders ─────────────────────────────────────────────────────────

const managersOf = async (tenantId) =>
  (
    await query(
      `SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND m.role IN ('owner','admin')`,
      [tenantId],
    )
  ).rows;
export const tell = async (io, tenantId, dedupeKey, title, body) =>
  createNotifications({
    io,
    tenantId,
    recipients: (await managersOf(tenantId)).map((m) => ({ userId: m.id, type: "subscription" })),
    actor: null,
    dedupeKey,
    title,
    body,
  });

// A company that was told it would move to a smaller plan (or to Free) on the day its period ends does so now.
// Nothing it has is removed: only what the smaller plan includes is available.
export async function applyDueChanges(io, now = todayUtc()) {
  const { rows } = await query(
    "SELECT id FROM tenants WHERE scheduled_plan IS NOT NULL AND period_end IS NOT NULL AND period_end<=$1::date",
    [now],
  );
  let applied = 0;
  for (const { id } of rows) {
    const result = await withTransaction(async (client) => {
      const t = (await client.query("SELECT * FROM tenants WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!t?.scheduled_plan) return null;
      const target = planOf(t.scheduled_plan);
      if (!target.id) {
        await client.query("UPDATE tenants SET scheduled_plan=NULL WHERE id=$1", [id]);
        return null;
      }
      const toFree = target.id === "free";
      await client.query(
        `UPDATE tenants SET plan=$2,sessions_limit=$3,scheduled_plan=NULL,updated_at=now()
           ${toFree ? ",billing_cycle=NULL,period_start=NULL,period_end=NULL,reminded_soon_for=NULL,reminded_overdue_for=NULL,reminded_expired_for=NULL" : ""}
         WHERE id=$1`,
        [id, target.name, target.numbers ?? t.sessions_limit],
      );
      await audit(client, id, null, "subscription.change_applied", { from: t.plan, to: target.name, dueOn: dateOnly(t.period_end) });
      await logEvent(client, id, "change_applied", target.name, { from: t.plan, dueOn: dateOnly(t.period_end) });
      return { from: t.plan, target, toFree };
    });
    if (!result) continue;
    applied++;
    await tell(
      io,
      id,
      `subscription:applied:${result.target.id}`,
      `Your plan is now ${result.target.name}`,
      result.toFree
        ? "Your subscription ended, so your company is on the Free plan: one WhatsApp number and one person. Your conversations are kept. To come back to a paid plan, message the Scriwo team."
        : `The change you asked for has started. Our team will send the invoice for the new period.`,
    ).catch((e) => console.error("Subscription notice failed:", e.message));
  }
  return applied;
}

// Each owner and administrator is told once per period that the renewal is near (or that the plan is ending or
// changing), and once if it is overdue. The period end a reminder was sent for is stored, so it is never repeated.
export async function sendReminders(io, now = todayUtc()) {
  const { rows } = await query(
    `SELECT * FROM tenants WHERE status='active' AND period_end IS NOT NULL AND period_end<=$1::date+$2::int
       AND (reminded_soon_for IS DISTINCT FROM period_end OR reminded_overdue_for IS DISTINCT FROM period_end
            OR reminded_expired_for IS DISTINCT FROM period_end)`,
    [now, SOON_DAYS],
  );
  let sent = 0;
  for (const t of rows) {
    const view = subscriptionView(t, now);
    const end = view.periodEnd;
    if (view.status === "overdue") {
      const claimed = await query(
        "UPDATE tenants SET reminded_overdue_for=period_end WHERE id=$1 AND reminded_overdue_for IS DISTINCT FROM period_end RETURNING id",
        [t.id],
      );
      if (!claimed.rowCount) continue;
      try {
        await tell(
          io,
          t.id,
          `subscription:${end}:overdue`,
          `Payment for your ${view.plan} plan is overdue`,
          `It was due on ${showDate(end)}. Everything keeps working until ${showDate(view.graceEndsOn)}; after that the paid features switch off (nothing is deleted) until payment is received. Please pay the invoice or message the Scriwo team.`,
        );
        sent++;
      } catch (error) {
        await query("UPDATE tenants SET reminded_overdue_for=NULL WHERE id=$1", [t.id]); // try again next time
        throw error;
      }
    } else if (view.status === "expired") {
      const claimed = await query(
        "UPDATE tenants SET reminded_expired_for=period_end,reminded_overdue_for=period_end WHERE id=$1 AND reminded_expired_for IS DISTINCT FROM period_end RETURNING id",
        [t.id],
      );
      if (!claimed.rowCount) continue;
      try {
        await tell(
          io,
          t.id,
          `subscription:${end}:expired`,
          `Paid features are switched off for your ${view.plan} plan`,
          `Payment was due on ${showDate(end)} and has not been received. Broadcasts, automations, the pipeline and the other paid features are off, and your numbers and conversations are untouched. Pay the invoice or message the Scriwo team and they come back at once.`,
        );
        sent++;
      } catch (error) {
        await query("UPDATE tenants SET reminded_expired_for=NULL WHERE id=$1", [t.id]); // try again next time
        throw error;
      }
    } else if (["due_soon", "cancelling", "changing"].includes(view.status)) {
      const claimed = await query(
        "UPDATE tenants SET reminded_soon_for=period_end WHERE id=$1 AND reminded_soon_for IS DISTINCT FROM period_end RETURNING id",
        [t.id],
      );
      if (!claimed.rowCount) continue;
      const days = view.daysLeft === 0 ? "today" : `in ${view.daysLeft} day${view.daysLeft === 1 ? "" : "s"}`;
      const [title, body] =
        view.status === "cancelling"
          ? [`Your ${view.plan} plan ends ${days}`, `On ${showDate(end)} your company moves to the Free plan: one WhatsApp number and one person. Your conversations are kept.`]
          : view.status === "changing"
            ? [`Your plan moves to ${view.scheduledPlan.name} ${days}`, `On ${showDate(end)} your company moves from ${view.plan} to ${view.scheduledPlan.name}. Nothing you have is deleted.`]
            : [`Your ${view.plan} plan renews ${days}`, `The renewal date is ${showDate(end)}. Renew from Plans & Billing in the app, or wait for the invoice from our team; message them if you want to change anything.`];
      try {
        await tell(io, t.id, `subscription:${end}:soon`, title, body);
        sent++;
      } catch (error) {
        await query("UPDATE tenants SET reminded_soon_for=NULL WHERE id=$1", [t.id]); // try again next time
        throw error;
      }
    }
  }
  return sent;
}

// Run from the background jobs. The work is cheap, but it only needs doing a few times an hour.
let lastRun = 0;
export async function pumpSubscriptions(io, { now, force = false } = {}) {
  if (!force && Date.now() - lastRun < 10 * 60 * 1000) return;
  lastRun = Date.now();
  await applyDueChanges(io, now);
  await sendReminders(io, now);
}
