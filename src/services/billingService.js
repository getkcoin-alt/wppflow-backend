import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { fail, failWith } from "../middleware/http.js";
import { ENV } from "../config/env.js";
import { razorpayConfig } from "../config/billing.js";
import { billingSettings, invoiceNumber, financialYearSeries } from "./billingSettings.js";
import { STATES, stateList, cleanProfile, computeTax as computeTaxAt, isIntraState as isIntraAt } from "./gst.js";

// Tax at the rate in the billing settings, and "inside the seller's state" as the settings say.
const computeTax = (args) => computeTaxAt({ rate: billingSettings().gstRate, ...args });
const isIntraState = (buyerStateCode) => isIntraAt(buyerStateCode, billingSettings().seller.stateCode);
import * as gateway from "./razorpay.js";
import { planOf, choosePlan, priceOf, planCatalogue, GRACE_DAYS } from "./plans.js";
import { recordPayment, subscriptionView, addCycle, daysBetween, dateOnly, todayUtc, rankOf, audit, tell, logEvent, showDate, SOON_DAYS, scheduleChange, clearScheduledChange } from "./subscriptionService.js";
import { sendEmail } from "./emailService.js";
import { createCompanyIn } from "./adminService.js";
import { sendOwnerSetup, sendPurchaseReceipt } from "./mailer.js";

// Paying online. The browser opens Razorpay's checkout for an order this file made, with a price this file worked
// out. What counts as paid is decided here, in settleOrder(), from what Razorpay says to the server (a signed
// webhook, the server asking Razorpay after the browser reports back, or the reconciliation job). Whichever gets
// there first records the payment; the others find it done and do nothing.

const ORDER_LIFETIME_HOURS = 24;
const money = (minor) => `₹${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const label = (interval) => (interval === "annual" ? "yearly" : "monthly");

export const paymentsStatus = () => {
  const c = razorpayConfig();
  return { configured: c.configured, mode: c.mode };
};
export const requirePayments = () => {
  if (!razorpayConfig().configured) throw failWith(503, "Online payment is not switched on yet. Message the Scriwo team and they will set you up.", { code: "payments_off" });
};

// ── Billing details ──────────────────────────────────────────────────────────────────────────────

const profileView = (p) =>
  p && {
    legalName: p.legal_name,
    addressLine1: p.address_line1,
    addressLine2: p.address_line2,
    city: p.city,
    stateCode: p.state_code,
    state: STATES[p.state_code] || "",
    postalCode: p.postal_code,
    country: p.country,
    gstin: p.gstin,
    billingEmail: p.billing_email,
  };
export async function getProfile(tenantId, client = null) {
  const { rows } = await (client || { query }).query("SELECT * FROM billing_profiles WHERE tenant_id=$1", [tenantId]);
  return profileView(rows[0]) || null;
}
export async function saveProfile(tenantId, userId, input) {
  const p = cleanProfile(input);
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO billing_profiles(tenant_id,legal_name,address_line1,address_line2,city,state_code,postal_code,country,gstin,billing_email,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(tenant_id) DO UPDATE SET legal_name=EXCLUDED.legal_name,address_line1=EXCLUDED.address_line1,address_line2=EXCLUDED.address_line2,
         city=EXCLUDED.city,state_code=EXCLUDED.state_code,postal_code=EXCLUDED.postal_code,country=EXCLUDED.country,gstin=EXCLUDED.gstin,
         billing_email=EXCLUDED.billing_email,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [tenantId, p.legalName, p.addressLine1, p.addressLine2, p.city, p.stateCode, p.postalCode, p.country, p.gstin, p.billingEmail, userId ?? null],
    );
    await audit(c, tenantId, userId, "billing.profile_saved", { legalName: p.legalName, state: STATES[p.stateCode], gstin: p.gstin });
  });
  return getProfile(tenantId);
}

// ── Working out what a payment is for, and what it costs ─────────────────────────────────────────

// Where the next period starts. A renewal follows on from the end of the current one, even when it is paid early
// (paying early never shortens a period) or up to the grace days late. A company that lapsed starts again today.
function periodFor(tenant, cycle, now) {
  const end = dateOnly(tenant.period_end);
  const current = planOf(tenant.plan);
  const follows = current.restricted && current.id !== "free" && end && daysBetween(end, now) <= GRACE_DAYS;
  const start = follows ? end : now;
  return { start, end: addCycle(start, cycle) };
}

export function quoteFor(tenant, profile, { plan: planCode, interval }, now = todayUtc()) {
  if (!["monthly", "annual"].includes(interval)) throw fail(400, "Choose monthly or yearly billing");
  const plan = choosePlan(planCode);
  const entry = planCatalogue({ all: true }).find((p) => p.id === plan.id);
  const base = priceOf(plan.id, interval, "INR");
  if (plan.id === "free" || !base) throw fail(400, `${plan.name} has no online price. Message the Scriwo team and they will agree it with you.`);

  const current = planOf(tenant.plan);
  const end = dateOnly(tenant.period_end);
  const live = current.restricted && current.id !== "free" && end && daysBetween(end, now) <= GRACE_DAYS;
  const future = live && daysBetween(now, end) > 0;
  const sameCycle = tenant.billing_cycle === interval;
  let kind = "new";
  if (live) {
    if (current.id === plan.id && sameCycle) kind = "renewal";
    else if (future && rankOf(plan.id) < rankOf(current.id))
      throw failWith(400, "A smaller plan starts when your current period ends. Use “Move to a smaller plan” and it switches over by itself on that day.", { code: "downgrade_later" });
    else if (future && current.id === plan.id && tenant.billing_cycle === "annual" && interval === "monthly")
      throw failWith(400, "Your yearly period is already paid. You can switch to monthly when it ends.", { code: "downgrade_later" });
    else kind = future ? "change" : "renewal";
  }

  // Changing plan part-way through a paid period credits the days not used, unless that is switched off.
  let credit = 0;
  if (kind === "change" && billingSettings().prorateUpgrades) {
    const start = dateOnly(tenant.period_start);
    const total = start ? daysBetween(start, end) : 0;
    const unused = daysBetween(now, end);
    const oldPrice = priceOf(current.id, tenant.billing_cycle, "INR") || 0;
    if (total > 0 && unused > 0 && oldPrice) credit = Math.min(Math.floor((oldPrice * Math.min(unused, total)) / total), base);
  }
  const tax = computeTax({ amountMinor: base - credit, taxMode: entry?.taxMode || "exclusive", intraState: isIntraState(profile.stateCode) });
  if (tax.total < 100) throw fail(400, "Your unused days already cover this plan. Message the Scriwo team to switch you over.");

  const period = kind === "change" ? { start: now, end: addCycle(now, interval) } : periodFor(tenant, interval, now);
  const requiresConfirm = kind === "renewal" && future && daysBetween(now, end) > SOON_DAYS;
  return {
    plan: { id: plan.id, name: plan.name },
    interval,
    kind,
    currency: "INR",
    baseMinor: base,
    creditMinor: credit,
    taxableMinor: tax.taxable,
    taxMinor: tax.tax,
    cgstMinor: tax.cgst,
    sgstMinor: tax.sgst,
    igstMinor: tax.igst,
    totalMinor: tax.total,
    taxMode: entry?.taxMode || "exclusive",
    gstRate: billingSettings().gstRate,
    intraState: isIntraState(profile.stateCode),
    periodStart: period.start,
    periodEnd: period.end,
    requiresConfirm,
    paidUntil: requiresConfirm ? end : null,
    previousPlan: live ? current.name : null,
  };
}

export const orderView = (o) => ({
  id: o.id,
  plan: planOf(o.plan_code).name,
  planId: o.plan_code,
  interval: o.billing_interval,
  status: o.status,
  source: o.source,
  currency: o.currency,
  baseMinor: Number(o.base_minor),
  creditMinor: Number(o.credit_minor),
  taxMinor: Number(o.tax_minor),
  totalMinor: Number(o.total_minor),
  periodStart: o.quote?.periodStart || null,
  periodEnd: o.quote?.periodEnd || null,
  failureReason: o.failure_reason,
  invoiceId: o.invoice_id,
  createdAt: o.created_at,
  paidAt: o.paid_at,
});

// ── Checkout ─────────────────────────────────────────────────────────────────────────────────────

const requireProfile = async (tenantId) => {
  const profile = await getProfile(tenantId);
  if (!profile) throw failWith(400, "Add your billing details first: the invoice needs your company's name, address and state.", { code: "profile_required" });
  return profile;
};
const tenantOf = async (tenantId, client = null) => {
  const { rows } = await (client || { query }).query("SELECT * FROM tenants WHERE id=$1", [tenantId]);
  if (!rows[0]) throw fail(404, "Company not found");
  return rows[0];
};
const liveAutopay = async (tenantId) =>
  (await query("SELECT * FROM autopay_subscriptions WHERE tenant_id=$1 AND status IN ('created','authenticated','active','pending','halted')", [tenantId])).rows[0] || null;

export async function createCheckout({ tenantId, user, plan, interval, confirm = false, now = todayUtc() }) {
  requirePayments();
  const tenant = await tenantOf(tenantId);
  const profile = await requireProfile(tenantId);
  const q = quoteFor(tenant, profile, { plan, interval }, now);
  const autopay = await liveAutopay(tenantId);
  if (autopay && ["active", "authenticated", "pending"].includes(autopay.status) && q.kind === "renewal")
    throw failWith(409, `Autopay is on and renews this plan by itself on ${showDate(q.periodStart)}. To pay now instead, turn autopay off first.`, { code: "autopay_active" });
  if (q.requiresConfirm && confirm !== true)
    throw failWith(409, `Your ${q.plan.name} plan is already paid until ${showDate(q.paidUntil)}. This adds another ${label(interval)} period after it.`, { code: "confirm_required", paidUntil: q.paidUntil });

  const buyer = { ...profile, email: profile.billingEmail || user.email || "" };
  const quote = { ...q, buyer };
  // The same unpaid order for the same thing is reused, so a double click does not make two.
  const open = (
    await query(
      `SELECT * FROM payment_orders WHERE tenant_id=$1 AND status IN ('created','attempted') AND source='checkout' AND plan_code=$2 AND billing_interval=$3
         AND total_minor=$4 AND gateway_order_id IS NOT NULL AND expires_at>now() AND quote->>'periodStart'=$5 ORDER BY created_at DESC LIMIT 1`,
      [tenantId, q.plan.id, interval, q.totalMinor, q.periodStart],
    )
  ).rows[0];
  let order = open;
  if (!order) {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO payment_orders(id,tenant_id,plan_code,billing_interval,currency,base_minor,credit_minor,tax_minor,total_minor,quote,receipt,status,expires_at,created_by)
       VALUES($1,$2,$3,$4,'INR',$5,$6,$7,$8,$9,$10,'created',now()+($11||' hours')::interval,$12)`,
      [id, tenantId, q.plan.id, interval, q.baseMinor, q.creditMinor, q.taxMinor, q.totalMinor, JSON.stringify(quote), `scw_${id.replace(/-/g, "").slice(0, 30)}`, String(ORDER_LIFETIME_HOURS), user.id ?? null],
    );
    try {
      const made = await gateway.createOrder({
        amount: q.totalMinor,
        currency: "INR",
        receipt: `scw_${id.replace(/-/g, "").slice(0, 30)}`,
        notes: { tenant_id: tenantId, order_id: id, plan: q.plan.id, interval, kind: q.kind },
      });
      order = (await query("UPDATE payment_orders SET gateway_order_id=$2,updated_at=now() WHERE id=$1 RETURNING *", [id, made.id])).rows[0];
    } catch (e) {
      await query("UPDATE payment_orders SET status='failed',failure_reason=$2,updated_at=now() WHERE id=$1", [id, `Could not start the payment: ${e.message}`.slice(0, 300)]);
      console.error("Payment order not created:", e.message);
      throw failWith(502, "We could not reach the payment service, and you have not been charged. Please try again in a minute.", { code: "gateway_unavailable" });
    }
    await query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'payment.order_created',$3)", [
      tenantId,
      user.id ?? null,
      JSON.stringify({ orderId: id, plan: q.plan.name, interval, totalMinor: q.totalMinor, kind: q.kind }),
    ]);
  }
  return {
    order: orderView(order),
    quote: q,
    // everything the browser needs to open the checkout: the public key id and the order, nothing else
    checkout: {
      key: razorpayConfig().keyId,
      orderId: order.gateway_order_id,
      amount: Number(order.total_minor),
      currency: order.currency,
      name: "Scriwo",
      description: `${q.plan.name} plan, ${label(interval)}`,
      prefill: { name: user.name || profile.legalName, email: buyer.email },
    },
  };
}

// The browser reports that the checkout finished. The signature proves the message came from Razorpay's checkout
// for this order, but it is not the payment: the server asks Razorpay what happened, and settles on the answer.
export async function verifyCheckout({ tenantId, userId, body, io = null }) {
  requirePayments();
  const orderId = String(body?.razorpay_order_id || ""),
    paymentId = String(body?.razorpay_payment_id || ""),
    signature = String(body?.razorpay_signature || "");
  if (!orderId || !paymentId || !signature) throw fail(400, "The payment details are incomplete");
  const { rows } = await query("SELECT * FROM payment_orders WHERE gateway_order_id=$1 AND tenant_id=$2", [orderId, tenantId]);
  const order = rows[0];
  if (!order) throw fail(404, "Order not found");
  // the order id signed is the one we stored, not the one the browser sent back
  if (!gateway.verifyCheckoutSignature(order.gateway_order_id, paymentId, signature)) {
    await query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'payment.signature_invalid',$3)", [tenantId, userId ?? null, JSON.stringify({ orderId: order.id, paymentId })]);
    throw fail(400, "We could not verify this payment, so nothing was activated. If money was taken, it will be matched automatically or refunded; message the Scriwo team.");
  }
  await query("UPDATE payment_orders SET status=CASE WHEN status IN ('created','failed') THEN 'attempted' ELSE status END,gateway_payment_id=$2,updated_at=now() WHERE id=$1", [order.id, paymentId]);
  try {
    const result = await settleFromGateway(order.id, paymentId, io);
    return { status: result.status === "paid" || result.status === "already" ? "paid" : result.status, order: orderView(result.order || (await orderById(order.id))) };
  } catch (e) {
    // Razorpay could not be asked right now: the webhook or the reconciliation job completes it
    console.error("Payment check deferred:", e.message);
    return { status: "processing", order: orderView(await orderById(order.id)) };
  }
}
export const orderById = async (id) => (await query("SELECT * FROM payment_orders WHERE id=$1", [id])).rows[0];

// Asks Razorpay about a payment (capturing it if it was only authorised) and settles the order on the answer.
export async function settleFromGateway(orderId, paymentId, io) {
  let payment = await gateway.fetchPayment(paymentId);
  if (payment.status === "authorized") payment = await gateway.capturePayment(paymentId, payment.amount, payment.currency).catch(() => payment);
  return settleOrder({ orderId, payment, source: "gateway-check", io });
}

// ── Settling a payment ───────────────────────────────────────────────────────────────────────────

const todayIst = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

async function issueInvoice(client, { tenantId, orderId = null, subscriptionPaymentId = null, planName, interval, periodStart, periodEnd, lines, taxable, cgst, sgst, igst, total, buyer, paymentRef, paymentMethod, gstRate = billingSettings().gstRate }) {
  const issueDate = todayIst();
  const settings = billingSettings();
  const series = financialYearSeries(issueDate);
  const counter = await client.query(
    "INSERT INTO invoice_counters(series,last_seq) VALUES($1,1) ON CONFLICT(series) DO UPDATE SET last_seq=invoice_counters.last_seq+1 RETURNING last_seq",
    [series],
  );
  const seq = counter.rows[0].last_seq;
  const number = invoiceNumber(settings.invoicePrefix, series, seq);
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO invoices(id,tenant_id,number,series,seq,issue_date,order_id,subscription_payment_id,plan_name,billing_interval,period_start,period_end,currency,lines,
       taxable_minor,cgst_minor,sgst_minor,igst_minor,total_minor,seller,buyer,sac_code,payment_ref,payment_method,gst_rate)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'INR',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [id, tenantId, number, series, seq, issueDate, orderId, subscriptionPaymentId, planName, interval, periodStart, periodEnd, JSON.stringify(lines), taxable, cgst, sgst, igst, total, JSON.stringify(settings.seller), JSON.stringify(buyer), settings.sacCode, String(paymentRef || "").slice(0, 120), String(paymentMethod || "").slice(0, 30), gstRate],
  );
  return { id, number };
}

const alertPlatform = (subject, details) => {
  console.error(`Payment alert: ${subject}`, details);
  sendEmail({ to: ENV.SUPERADMIN_EMAIL, subject: `Scriwo payment alert: ${subject}`, text: `${subject}\n\n${JSON.stringify(details, null, 2)}` }).catch(() => {});
};

async function savePayment(client, order, payment) {
  await client.query(
    `INSERT INTO payments(id,tenant_id,order_id,gateway_payment_id,status,method,amount_minor,currency,error_code,error_description,captured_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT(gateway_payment_id) DO UPDATE SET status=EXCLUDED.status,method=COALESCE(EXCLUDED.method,payments.method),
       error_code=EXCLUDED.error_code,error_description=EXCLUDED.error_description,captured_at=COALESCE(payments.captured_at,EXCLUDED.captured_at)`,
    [
      crypto.randomUUID(),
      order.tenant_id,
      order.id,
      payment.id,
      String(payment.status || "unknown").slice(0, 16),
      payment.method ? String(payment.method).slice(0, 30) : null,
      Number(payment.amount) || 0,
      String(payment.currency || order.currency),
      payment.error_code ? String(payment.error_code).slice(0, 100) : null,
      payment.error_description ? String(payment.error_description).slice(0, 500) : null,
      payment.status === "captured" ? new Date() : null,
    ],
  );
}

// A website purchase has no company until its payment is confirmed. This makes the company, its owner and its billing
// details in the same transaction that records the payment, so nothing exists for a payment that never arrived. If the
// owner's email has an account by now, nothing is made and the order is left for a person to sort out.
async function createWorkspaceForOrder(client, order) {
  const guest = order.guest || {};
  const email = String(guest.ownerEmail || "").trim().toLowerCase();
  if ((await client.query("SELECT 1 FROM users WHERE lower(email)=$1", [email])).rowCount)
    return { refused: `${email} has a Scriwo account already, so the workspace was not created by itself` };
  const plan = planOf(order.plan_code);
  const made = await createCompanyIn(client, { actorId: null, companyName: guest.companyName, ownerName: guest.ownerName, ownerEmail: email, sessionsLimit: plan.numbers || 1, plan: plan.name });
  const b = guest.billing || {};
  await client.query(
    `INSERT INTO billing_profiles(tenant_id,legal_name,address_line1,address_line2,city,state_code,postal_code,country,gstin,billing_email,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [made.tenant.id, b.legalName, b.addressLine1, b.addressLine2 || "", b.city, b.stateCode, b.postalCode, b.country || "IN", b.gstin || null, b.billingEmail || email, made.tenant.owner_id],
  );
  await client.query("UPDATE payment_orders SET tenant_id=$2,created_by=$3,updated_at=now() WHERE id=$1", [order.id, made.tenant.id, made.tenant.owner_id]);
  await client.query("UPDATE payments SET tenant_id=$2 WHERE order_id=$1", [order.id, made.tenant.id]);
  await audit(client, made.tenant.id, made.tenant.owner_id, "company.bought_online", { orderId: order.id, plan: plan.name, ownerEmail: email });
  return { tenant: made.tenant, link: made.link, email, name: guest.ownerName, company: guest.companyName };
}

// Records a captured payment against its order, exactly once. Safe to call again for the same payment, from the
// webhook, the browser check and the reconciliation job at the same moment: the order row is locked, and the
// second caller finds it paid.
export async function settleOrder({ orderId, payment, source = "webhook", io = null }) {
  let after = null;
  const result = await withTransaction(async (client) => {
    const found = await client.query("SELECT * FROM payment_orders WHERE id=$1 FOR UPDATE", [orderId]);
    const order = found.rows[0];
    if (!order) return { status: "unknown" };
    if (order.status === "paid") return { status: "already", order };
    if (order.status === "mismatch") return { status: "mismatch", order };
    await savePayment(client, order, payment);

    if (payment.status === "failed") {
      const reason = String(payment.error_description || payment.error_reason || "The payment did not go through").slice(0, 300);
      const updated = await client.query("UPDATE payment_orders SET status='failed',failure_reason=$2,gateway_payment_id=$3,updated_at=now() WHERE id=$1 RETURNING *", [order.id, reason, payment.id]);
      return { status: "failed", order: updated.rows[0] };
    }
    if (payment.status !== "captured") {
      const updated = await client.query("UPDATE payment_orders SET status='attempted',gateway_payment_id=$2,updated_at=now() WHERE id=$1 RETURNING *", [order.id, payment.id]);
      return { status: "pending", order: updated.rows[0] };
    }

    // Anything that does not match what we asked for activates nothing, and the platform admin is told.
    const problems = [];
    if (payment.order_id !== order.gateway_order_id) problems.push(`the payment belongs to order ${payment.order_id}, not ${order.gateway_order_id}`);
    if (Number(payment.amount) !== Number(order.total_minor)) problems.push(`amount ${payment.amount} instead of ${order.total_minor}`);
    if (payment.currency !== order.currency) problems.push(`currency ${payment.currency} instead of ${order.currency}`);
    const owner = payment.notes?.tenant_id;
    if (owner && owner !== order.tenant_id) problems.push("the payment names another company");
    const other = await client.query("SELECT order_id FROM payments WHERE gateway_payment_id=$1", [payment.id]);
    if (other.rows[0]?.order_id && other.rows[0].order_id !== order.id) problems.push("the payment was already used for another order");
    if (problems.length) {
      const reason = `Payment ${payment.id} did not match: ${problems.join("; ")}`.slice(0, 500);
      const updated = await client.query("UPDATE payment_orders SET status='mismatch',failure_reason=$2,gateway_payment_id=$3,updated_at=now() WHERE id=$1 RETURNING *", [order.id, reason, payment.id]);
      if (order.tenant_id) await audit(client, order.tenant_id, null, "payment.mismatch", { orderId: order.id, paymentId: payment.id, problems });
      after = () => alertPlatform("a payment did not match its order", { orderId: order.id, tenantId: order.tenant_id, buyer: order.guest_email, problems });
      return { status: "mismatch", order: updated.rows[0] };
    }

    // A website purchase: the money is confirmed, so the company and its owner are made now, in this transaction.
    let created = null;
    if (!order.tenant_id) {
      created = await createWorkspaceForOrder(client, order);
      if (created.refused) {
        const reason = `Payment ${payment.id} was received but ${created.refused}. Refund it or create the workspace by hand.`.slice(0, 500);
        const updated = await client.query("UPDATE payment_orders SET status='mismatch',failure_reason=$2,gateway_payment_id=$3,updated_at=now() WHERE id=$1 RETURNING *", [order.id, reason, payment.id]);
        after = () => alertPlatform("a website purchase was paid but could not create the workspace", { orderId: order.id, paymentId: payment.id, buyer: order.guest_email, reason: created.refused });
        return { status: "mismatch", order: updated.rows[0] };
      }
      order.tenant_id = created.tenant.id;
      order.created_by = created.tenant.owner_id;
    }

    const tenant = (await client.query("SELECT * FROM tenants WHERE id=$1 FOR UPDATE", [order.tenant_id])).rows[0];
    const quote = order.quote || {};
    const now = todayUtc();
    const period = quote.kind === "change" ? { start: now, end: addCycle(now, order.billing_interval) } : periodFor(tenant, order.billing_interval, now);
    const recorded = await recordPayment({
      tenantId: order.tenant_id,
      actorId: order.created_by,
      client,
      trusted: true,
      source: order.source === "autopay" ? "autopay" : "razorpay",
      orderId: order.id,
      body: {
        plan: order.plan_code,
        cycle: order.billing_interval,
        periodStart: period.start,
        periodEnd: period.end,
        amount: Number(order.total_minor) / 100,
        currency: order.currency,
        reference: payment.id,
      },
    });
    const planName = planOf(order.plan_code).name;
    const invoice = await issueInvoice(client, {
      tenantId: order.tenant_id,
      orderId: order.id,
      subscriptionPaymentId: recorded.paymentId,
      planName,
      interval: order.billing_interval,
      periodStart: period.start,
      periodEnd: period.end,
      lines: invoiceLines({ planName, interval: order.billing_interval, period, quote, order }),
      taxable: quote.taxableMinor ?? Number(order.total_minor) - Number(order.tax_minor),
      cgst: quote.cgstMinor || 0,
      sgst: quote.sgstMinor || 0,
      igst: quote.igstMinor || 0,
      total: Number(order.total_minor),
      buyer: quote.buyer,
      paymentRef: payment.id,
      paymentMethod: payment.method || "",
      gstRate: quote.gstRate ?? billingSettings().gstRate,
    });
    const updated = await client.query(
      `UPDATE payment_orders SET status='paid',paid_at=now(),gateway_payment_id=$2,subscription_payment_id=$3,invoice_id=$4,failure_reason=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
      [order.id, payment.id, recorded.paymentId, invoice.id],
    );
    await audit(client, order.tenant_id, order.created_by, "payment.settled", { orderId: order.id, paymentId: payment.id, plan: planName, totalMinor: Number(order.total_minor), invoice: invoice.number, source });
    after = async () => {
      await tell(
        io,
        order.tenant_id,
        `payment:${order.id}`,
        `Payment received: ${money(Number(order.total_minor))}`,
        `Your ${planName} plan now runs until ${showDate(period.end)}. The invoice ${invoice.number} is in Plans & Billing.`,
      ).catch((e) => console.error("Payment notice failed:", e.message));
      if (created) {
        // the buyer is not signed in anywhere: the emails are how they get in
        const setup = await sendOwnerSetup({ to: created.email, name: created.name, company: created.company, link: created.link });
        if (!setup.sent) alertPlatform("a website buyer's setup email was not delivered", { orderId: order.id, tenantId: order.tenant_id, buyer: created.email, detail: setup.detail || setup.reason });
        await sendPurchaseReceipt({ to: created.email, name: created.name, company: created.company, plan: planName, period: `${showDate(period.start)} to ${showDate(period.end)}`, total: money(Number(order.total_minor)), invoice: invoice.number }).catch(() => {});
      }
      // paying for another plan or period ends autopay for the old one, so it cannot charge twice
      await stopAutopayAfterManualPayment(order, io).catch((e) => console.error("Autopay stop failed:", e.message));
    };
    return { status: "paid", order: updated.rows[0], invoice };
  });
  if (after) await after();
  return result;
}

function invoiceLines({ planName, interval, period, quote, order }) {
  const lines = [
    {
      description: `Scriwo ${planName} plan, ${label(interval)} subscription`,
      detail: `${showDate(period.start)} to ${showDate(period.end)}`,
      amountMinor: quote.taxMode === "inclusive" ? quote.taxableMinor : Number(order.base_minor),
    },
  ];
  if (quote.taxMode !== "inclusive" && Number(order.credit_minor) > 0)
    lines.push({ description: `Credit for the unused days of your ${quote.previousPlan || "previous"} plan`, detail: "", amountMinor: -Number(order.credit_minor) });
  return lines;
}

// A manual payment (recorded by the Scriwo team) also gets an invoice, when it was in rupees and the company has
// billing details. The amount recorded is what was received, tax included.
export async function invoiceForRecordedPayment({ tenantId, paymentId }) {
  const found = await query("SELECT * FROM subscription_payments WHERE id=$1 AND tenant_id=$2", [paymentId, tenantId]);
  const p = found.rows[0];
  if (!p) throw fail(404, "Payment not found");
  const existing = await query("SELECT id,number FROM invoices WHERE subscription_payment_id=$1", [paymentId]);
  if (existing.rows[0]) return { invoice: existing.rows[0] };
  if (p.currency !== "INR" || !p.amount || Number(p.amount) <= 0) return { skipped: "Only payments in rupees get a GST invoice." };
  const profile = await getProfile(tenantId);
  if (!profile) return { skipped: "The company has not saved its billing details yet, so there is no invoice." };
  const tax = computeTax({ amountMinor: Math.round(Number(p.amount) * 100), taxMode: "inclusive", intraState: isIntraState(profile.stateCode) });
  const buyer = { ...profile, email: profile.billingEmail || "" };
  const invoice = await withTransaction((client) =>
    issueInvoice(client, {
      tenantId,
      subscriptionPaymentId: paymentId,
      planName: p.plan,
      interval: p.billing_cycle,
      periodStart: dateOnly(p.period_start),
      periodEnd: dateOnly(p.period_end),
      lines: [{ description: `Scriwo ${p.plan} plan, ${label(p.billing_cycle)} subscription`, detail: `${showDate(dateOnly(p.period_start))} to ${showDate(dateOnly(p.period_end))}`, amountMinor: tax.taxable }],
      taxable: tax.taxable,
      cgst: tax.cgst,
      sgst: tax.sgst,
      igst: tax.igst,
      total: tax.total,
      buyer,
      paymentRef: p.reference || "",
      paymentMethod: "recorded",
    }),
  );
  return { invoice };
}

// ── Webhooks ─────────────────────────────────────────────────────────────────────────────────────

const hashOf = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

// Express handler for POST /api/billing/razorpay/webhook. The route gives it the raw bytes, because the signature
// covers exactly what was sent.
export function razorpayWebhook(getIo) {
  return async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const cfg = razorpayConfig();
    if (!cfg.configured) return res.status(503).json({ status: "error", message: "Online payment is not switched on" });
    if (!gateway.verifyWebhookSignature(raw, req.get("x-razorpay-signature"), cfg.webhookSecret)) {
      console.warn("Razorpay webhook rejected: the signature did not match");
      return res.status(400).json({ status: "error", message: "Invalid signature" });
    }
    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).json({ status: "error", message: "Invalid body" });
    }
    const payment = event?.payload?.payment?.entity;
    const eventId = String(req.get("x-razorpay-event-id") || `${event?.event}:${payment?.id || event?.payload?.subscription?.entity?.id || event?.payload?.refund?.entity?.id || ""}:${event?.created_at || ""}`).slice(0, 120);
    try {
      // The event id is stored first. A repeat of one that was already handled does nothing; one that crashed
      // half way is tried again.
      const claimed = await query(
        `INSERT INTO gateway_webhook_receipts(event_id,event,payload_hash) VALUES($1,$2,$3)
         ON CONFLICT(event_id) DO UPDATE SET attempts=gateway_webhook_receipts.attempts+1 WHERE gateway_webhook_receipts.processed_at IS NULL RETURNING event_id`,
        [eventId, String(event?.event || "").slice(0, 60), hashOf(raw)],
      );
      if (!claimed.rowCount) return res.json({ status: "success", duplicate: true });
      let result = "ignored";
      try {
        result = (await handleEvent(event, getIo?.())) || "ignored";
      } catch (e) {
        await query("UPDATE gateway_webhook_receipts SET result=$2 WHERE event_id=$1", [eventId, `error: ${e.message}`.slice(0, 300)]);
        console.error("Razorpay webhook failed:", e.message);
        return res.status(500).json({ status: "error", message: "Could not process the event" });
      }
      await query("UPDATE gateway_webhook_receipts SET processed_at=now(),result=$2 WHERE event_id=$1", [eventId, String(result).slice(0, 300)]);
      return res.json({ status: "success" });
    } catch (e) {
      console.error("Razorpay webhook failed:", e.message);
      return res.status(500).json({ status: "error", message: "Could not process the event" });
    }
  };
}

async function handleEvent(event, io) {
  const name = event?.event;
  const payment = event?.payload?.payment?.entity;
  const sub = event?.payload?.subscription?.entity;
  if (name?.startsWith("subscription.")) return handleSubscriptionEvent(name, sub, payment, io);
  if (name === "refund.created" || name === "refund.processed" || name === "refund.failed") return handleRefund(event.payload?.refund?.entity, name);
  if (["payment.captured", "payment.authorized", "payment.failed", "order.paid"].includes(name) && payment) {
    const order = (await query("SELECT id FROM payment_orders WHERE gateway_order_id=$1", [payment.order_id])).rows[0];
    if (!order) return "ignored: not one of our orders";
    let entity = payment;
    if (name === "payment.authorized" || payment.status === "authorized") entity = await gateway.capturePayment(payment.id, payment.amount, payment.currency).catch(() => payment);
    const r = await settleOrder({ orderId: order.id, payment: entity, source: "webhook", io });
    return r.status;
  }
  return "ignored";
}

async function handleRefund(refund, name) {
  if (!refund?.id) return "ignored";
  const order = (await query("SELECT id,tenant_id FROM payment_orders WHERE gateway_payment_id=$1", [refund.payment_id])).rows[0];
  await query(
    `INSERT INTO payment_refunds(refund_id,tenant_id,order_id,gateway_payment_id,amount_minor,currency,status) VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(refund_id) DO UPDATE SET status=EXCLUDED.status,updated_at=now()`,
    [refund.id, order?.tenant_id ?? null, order?.id ?? null, refund.payment_id ?? null, Number(refund.amount) || 0, String(refund.currency || "INR"), name.replace("refund.", "")],
  );
  if (name === "refund.created") alertPlatform("a refund was issued", { refundId: refund.id, paymentId: refund.payment_id, amountMinor: refund.amount, tenantId: order?.tenant_id });
  return `refund ${name.replace("refund.", "")}`;
}

// ── Reconciliation ───────────────────────────────────────────────────────────────────────────────

// Finds payments that happened without a webhook (a lost delivery, a customer who closed the tab) and settles them
// the same way a webhook would. Orders nobody paid for are closed after a day.
export async function reconcileOrders({ io = null } = {}) {
  if (!razorpayConfig().configured) return 0;
  const { rows } = await query(
    `SELECT * FROM payment_orders WHERE status IN ('created','attempted','failed') AND source IN ('checkout','website') AND gateway_order_id IS NOT NULL
       AND created_at < now() - interval '10 minutes' AND created_at > now() - interval '3 days'
       AND (last_checked_at IS NULL OR last_checked_at < now() - interval '5 minutes') ORDER BY created_at LIMIT 20`,
  );
  let settled = 0;
  for (const order of rows) {
    try {
      const items = await gateway.fetchOrderPayments(order.gateway_order_id);
      for (const item of items) {
        let payment = item;
        if (payment.status === "authorized") payment = await gateway.capturePayment(payment.id, payment.amount, payment.currency).catch(() => payment);
        if (payment.status !== "captured") continue;
        const r = await settleOrder({ orderId: order.id, payment, source: "reconciliation", io });
        if (r.status === "paid") settled++;
      }
      await query("UPDATE payment_orders SET last_checked_at=now() WHERE id=$1", [order.id]);
    } catch (e) {
      console.error("Payment reconciliation:", order.id, e.message);
    }
  }
  await query("UPDATE payment_orders SET status='expired',updated_at=now() WHERE status IN ('created','attempted') AND expires_at<now() AND last_checked_at IS NOT NULL AND last_checked_at>expires_at");
  return settled;
}

let lastReconcile = 0;
export async function pumpBilling(io, { force = false } = {}) {
  if (!force && Date.now() - lastReconcile < 5 * 60 * 1000) return;
  lastReconcile = Date.now();
  await reconcileOrders({ io });
}

// ── Autopay (opt-in) ─────────────────────────────────────────────────────────────────────────────

const autopayView = (a) =>
  a && {
    id: a.id,
    plan: planOf(a.plan_code).name,
    planId: a.plan_code,
    interval: a.billing_interval,
    amountMinor: Number(a.amount_minor),
    status: a.status,
    // a halted autopay means the last charge failed: the company pays by hand until it is set up again
    needsAttention: a.status === "halted" || a.status === "pending",
  };

export async function startAutopay({ tenantId, user, plan: planCode }) {
  requirePayments();
  const tenant = await tenantOf(tenantId);
  const profile = await requireProfile(tenantId);
  const plan = choosePlan(planCode);
  // autopay is for monthly plans: a yearly payment is one charge and has nothing to repeat
  const base = priceOf(plan.id, "monthly", "INR");
  if (plan.id === "free" || !base) throw fail(400, `${plan.name} has no monthly price to charge automatically.`);
  const entry = planCatalogue({ all: true }).find((p) => p.id === plan.id);
  const tax = computeTax({ amountMinor: base, taxMode: entry?.taxMode || "exclusive", intraState: isIntraState(profile.stateCode) });
  const live = await liveAutopay(tenantId);
  if (live) {
    if (live.status === "created" && live.plan_code === plan.id && Number(live.amount_minor) === tax.total && live.gateway_subscription_id)
      return { autopay: autopayView(live), checkout: autopayCheckout(live, user, profile) };
    throw failWith(409, "Autopay is already set up for this company. Turn it off first to change it.", { code: "autopay_exists" });
  }
  let planRow = (await query("SELECT gateway_plan_id FROM razorpay_plans WHERE plan_code=$1 AND billing_interval='monthly' AND amount_minor=$2", [plan.id, tax.total])).rows[0];
  if (!planRow) {
    try {
      const made = await gateway.createPlan({ period: "monthly", name: `Scriwo ${plan.name} monthly`, amount: tax.total, currency: "INR", notes: { plan: plan.id } });
      await query("INSERT INTO razorpay_plans(plan_code,billing_interval,amount_minor,gateway_plan_id) VALUES($1,'monthly',$2,$3) ON CONFLICT DO NOTHING", [plan.id, tax.total, made.id]);
      planRow = { gateway_plan_id: made.id };
    } catch (e) {
      throw failWith(502, "We could not reach the payment service. Nothing was set up. Please try again in a minute.", { code: "gateway_unavailable" });
    }
  }
  const id = crypto.randomUUID();
  const end = dateOnly(tenant.period_end);
  const startsLater = end && daysBetween(todayUtc(), end) > 1 && planOf(tenant.plan).id !== "free";
  try {
    const made = await gateway.createSubscription({
      plan_id: planRow.gateway_plan_id,
      total_count: 120,
      quantity: 1,
      customer_notify: 1,
      // when a paid period is still running, the first charge is on the day it ends
      ...(startsLater ? { start_at: Math.floor(Date.parse(`${end}T06:30:00Z`) / 1000) } : {}),
      notes: { tenant_id: tenantId, autopay_id: id, plan: plan.id },
    });
    await query(
      `INSERT INTO autopay_subscriptions(id,tenant_id,plan_code,billing_interval,amount_minor,gateway_plan_id,gateway_subscription_id,status,created_by)
       VALUES($1,$2,$3,'monthly',$4,$5,$6,'created',$7)`,
      [id, tenantId, plan.id, tax.total, planRow.gateway_plan_id, made.id, user.id ?? null],
    );
  } catch (e) {
    if (e.code === "23505") throw failWith(409, "Autopay is already set up for this company.", { code: "autopay_exists" });
    console.error("Autopay not created:", e.message);
    throw failWith(502, "We could not set up autopay. Nothing was charged. Please try again in a minute.", { code: "gateway_unavailable" });
  }
  await query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'autopay.started',$3)", [tenantId, user.id ?? null, JSON.stringify({ autopayId: id, plan: plan.name, amountMinor: tax.total })]);
  const row = (await query("SELECT * FROM autopay_subscriptions WHERE id=$1", [id])).rows[0];
  return { autopay: autopayView(row), checkout: autopayCheckout(row, user, profile) };
}
const autopayCheckout = (a, user, profile) => ({
  key: razorpayConfig().keyId,
  subscriptionId: a.gateway_subscription_id,
  name: "Scriwo",
  description: `${planOf(a.plan_code).name} plan, charged monthly`,
  prefill: { name: user.name || profile.legalName, email: profile.billingEmail || user.email || "" },
});

export async function verifyAutopay({ tenantId, body, io = null }) {
  requirePayments();
  const paymentId = String(body?.razorpay_payment_id || ""),
    subscriptionId = String(body?.razorpay_subscription_id || ""),
    signature = String(body?.razorpay_signature || "");
  if (!paymentId || !subscriptionId || !signature) throw fail(400, "The payment details are incomplete");
  const autopay = (await query("SELECT * FROM autopay_subscriptions WHERE gateway_subscription_id=$1 AND tenant_id=$2", [subscriptionId, tenantId])).rows[0];
  if (!autopay) throw fail(404, "Autopay not found");
  if (!gateway.verifySubscriptionSignature(paymentId, autopay.gateway_subscription_id, signature)) throw fail(400, "We could not verify this payment, so autopay was not switched on.");
  await query("UPDATE autopay_subscriptions SET status=CASE WHEN status='created' THEN 'authenticated' ELSE status END,updated_at=now() WHERE id=$1", [autopay.id]);
  try {
    const payment = await gateway.fetchPayment(paymentId);
    if (payment.status === "captured") await settleCharge(autopay, payment, io);
  } catch (e) {
    console.error("Autopay first charge check deferred:", e.message);
  }
  return { autopay: autopayView((await query("SELECT * FROM autopay_subscriptions WHERE id=$1", [autopay.id])).rows[0]) };
}

export async function cancelAutopay({ tenantId, userId }) {
  const live = await liveAutopay(tenantId);
  if (!live) throw fail(404, "Autopay is not on");
  if (live.gateway_subscription_id && razorpayConfig().configured)
    await gateway.cancelSubscription(live.gateway_subscription_id, true).catch((e) => {
      // already cancelled on Razorpay's side is fine; anything else stops us so the owner is not told it is off when it is not
      if (!/already|cancel/i.test(e.message)) throw failWith(502, "We could not reach the payment service, so autopay is still on. Please try again.", { code: "gateway_unavailable" });
    });
  await withTransaction(async (c) => {
    await c.query("UPDATE autopay_subscriptions SET status='cancelled',cancelled_at=now(),updated_at=now() WHERE id=$1", [live.id]);
    await audit(c, tenantId, userId, "autopay.cancelled", { autopayId: live.id });
    await logEvent(c, tenantId, "autopay_cancelled", planOf(live.plan_code).name, {});
  });
  return true;
}

async function stopAutopayAfterManualPayment(order, io) {
  if (order.source === "autopay") return;
  const live = await liveAutopay(order.tenant_id);
  if (!live || (live.plan_code === order.plan_code && live.billing_interval === order.billing_interval)) return;
  await cancelAutopay({ tenantId: order.tenant_id, userId: order.created_by }).catch(() => {});
  await tell(io, order.tenant_id, `autopay:stopped:${order.id}`, "Autopay was switched off", "You changed your plan, so the automatic monthly charge for the old one was stopped. Set autopay up again for the new plan if you want it.");
}

// A charge Razorpay made for an autopay: it becomes an order of ours (so it is settled, invoiced and counted the
// same way as any other), keyed by Razorpay's own order for the charge so a repeated event makes one.
async function settleCharge(autopay, payment, io) {
  const gatewayOrderId = payment.order_id || `charge_${payment.id}`;
  let order = (await query("SELECT * FROM payment_orders WHERE gateway_order_id=$1", [gatewayOrderId])).rows[0];
  if (!order) {
    const profile = await getProfile(autopay.tenant_id);
    if (!profile) throw new Error("Autopay charged a company with no billing details");
    const tax = computeTax({ amountMinor: Number(autopay.amount_minor), taxMode: "inclusive", intraState: isIntraState(profile.stateCode) });
    const tenant = await tenantOf(autopay.tenant_id);
    const period = periodFor(tenant, "monthly", todayUtc());
    const quote = {
      kind: "renewal",
      plan: { id: autopay.plan_code, name: planOf(autopay.plan_code).name },
      interval: "monthly",
      taxMode: "inclusive",
      taxableMinor: tax.taxable,
      cgstMinor: tax.cgst,
      sgstMinor: tax.sgst,
      igstMinor: tax.igst,
      periodStart: period.start,
      periodEnd: period.end,
      buyer: { ...profile, email: profile.billingEmail || "" },
    };
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO payment_orders(id,tenant_id,plan_code,billing_interval,source,currency,base_minor,credit_minor,tax_minor,total_minor,quote,gateway_order_id,status,expires_at,created_by)
       VALUES($1,$2,$3,'monthly','autopay','INR',$4,0,$5,$6,$7,$8,'attempted',now()+interval '1 hour',$9) ON CONFLICT(gateway_order_id) DO NOTHING`,
      [id, autopay.tenant_id, autopay.plan_code, tax.taxable, tax.tax, Number(autopay.amount_minor), JSON.stringify(quote), gatewayOrderId, autopay.created_by],
    );
    order = (await query("SELECT * FROM payment_orders WHERE gateway_order_id=$1", [gatewayOrderId])).rows[0];
  }
  return settleOrder({ orderId: order.id, payment: { ...payment, order_id: gatewayOrderId }, source: "autopay", io });
}

async function handleSubscriptionEvent(name, sub, payment, io) {
  if (!sub?.id) return "ignored";
  const autopay = (await query("SELECT * FROM autopay_subscriptions WHERE gateway_subscription_id=$1", [sub.id])).rows[0];
  if (!autopay) return "ignored: not one of our subscriptions";
  const set = (status) => query("UPDATE autopay_subscriptions SET status=$2,updated_at=now() WHERE id=$1", [autopay.id, status]);
  switch (name) {
    case "subscription.authenticated":
      if (autopay.status === "created") await set("authenticated");
      return "authenticated";
    case "subscription.activated":
      await set("active");
      return "active";
    case "subscription.charged": {
      if (payment?.status === "captured") {
        const r = await settleCharge(autopay, payment, io);
        if (autopay.status !== "cancelled") await set("active");
        return `charged: ${r.status}`;
      }
      return "charged: not captured";
    }
    case "subscription.pending":
      await set("pending");
      await tell(io, autopay.tenant_id, `autopay:pending:${sub.id}:${sub.paid_count ?? ""}`, "Your automatic payment did not go through", "Razorpay will try again. If it keeps failing, pay from Plans & Billing so your plan does not lapse.");
      return "pending";
    case "subscription.halted":
      await set("halted");
      await tell(io, autopay.tenant_id, `autopay:halted:${sub.id}`, "Autopay has stopped: payment failed", "The automatic charge failed several times, so autopay stopped. Pay now from Plans & Billing to keep your plan, and set autopay up again if you want it.");
      return "halted";
    case "subscription.cancelled":
      await query("UPDATE autopay_subscriptions SET status='cancelled',cancelled_at=COALESCE(cancelled_at,now()),updated_at=now() WHERE id=$1", [autopay.id]);
      return "cancelled";
    case "subscription.completed":
      await set("completed");
      return "completed";
    default:
      return "ignored";
  }
}

// ── What the screens read ────────────────────────────────────────────────────────────────────────

const invoiceSummary = (i) => ({
  id: i.id,
  number: i.number,
  issueDate: dateOnly(i.issue_date),
  plan: i.plan_name,
  interval: i.billing_interval,
  periodStart: dateOnly(i.period_start),
  periodEnd: dateOnly(i.period_end),
  totalMinor: Number(i.total_minor),
  currency: i.currency,
});

export async function billingOverview(tenantId) {
  const tenant = await tenantOf(tenantId);
  const [profile, orders, invoices, history, autopay] = await Promise.all([
    getProfile(tenantId),
    query("SELECT * FROM payment_orders WHERE tenant_id=$1 AND source IN ('checkout','autopay') AND NOT (status='created' AND gateway_order_id IS NULL) ORDER BY created_at DESC LIMIT 20", [tenantId]),
    query("SELECT * FROM invoices WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50", [tenantId]),
    query("SELECT * FROM subscription_events WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30", [tenantId]),
    liveAutopay(tenantId),
  ]);
  return {
    payments: paymentsStatus(),
    currency: "INR",
    gstRate: billingSettings().gstRate,
    prorateUpgrades: billingSettings().prorateUpgrades,
    subscription: subscriptionView(tenant),
    profile,
    states: stateList(),
    orders: orders.rows.map(orderView),
    invoices: invoices.rows.map(invoiceSummary),
    history: history.rows.map((e) => ({ id: e.id, type: e.event_type, plan: e.plan, details: e.details, at: e.created_at })),
    autopay: autopayView(autopay),
  };
}

export async function quoteOnly({ tenantId, plan, interval }) {
  const tenant = await tenantOf(tenantId);
  const profile = await getProfile(tenantId);
  // without billing details the state is unknown: show the tax as if it were IGST, the common case, so the owner sees the total
  const q = quoteFor(tenant, profile || { stateCode: "00" }, { plan, interval });
  const live = await liveAutopay(tenantId);
  return { quote: q, profileMissing: !profile, autopayActive: Boolean(live && ["active", "authenticated", "pending"].includes(live.status)) };
}

export async function getInvoice(tenantId, id) {
  const { rows } = await query("SELECT * FROM invoices WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
  if (!rows[0]) throw fail(404, "Invoice not found");
  return rows[0];
}

// Owner-facing changes to a subscription that need no payment.
export const moveToSmallerPlan = ({ tenantId, userId, plan }) => scheduleChange({ tenantId, actorId: userId, plan });
export const endSubscriptionAtPeriodEnd = ({ tenantId, userId }) => scheduleChange({ tenantId, actorId: userId, plan: "free" });
export const keepSubscription = ({ tenantId, userId }) => clearScheduledChange({ tenantId, actorId: userId });

// The platform admin's view of online payments, including what needs a look.
export async function adminPayments({ status = "" } = {}) {
  const { rows } = await query(
    `SELECT o.*,COALESCE(t.name,o.guest->>'companyName') AS company FROM payment_orders o LEFT JOIN tenants t ON t.id=o.tenant_id
     WHERE o.source IN ('checkout','autopay','website') AND NOT (o.status='created' AND o.gateway_order_id IS NULL) AND ($1='' OR o.status=$1)
     ORDER BY o.created_at DESC LIMIT 100`,
    [status],
  );
  const refunds = await query("SELECT r.*,t.name AS company FROM payment_refunds r LEFT JOIN tenants t ON t.id=r.tenant_id ORDER BY r.created_at DESC LIMIT 50");
  const counts = (await query("SELECT status,count(*)::int AS n FROM payment_orders WHERE source IN ('checkout','autopay','website') GROUP BY status")).rows;
  return {
    payments: paymentsStatus(),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    orders: rows.map((o) => ({ ...orderView(o), company: o.company, companyId: o.tenant_id, paymentId: o.gateway_payment_id })),
    refunds: refunds.rows.map((r) => ({ id: r.refund_id, company: r.company, paymentId: r.gateway_payment_id, amountMinor: Number(r.amount_minor), currency: r.currency, status: r.status, at: r.created_at })),
  };
}

// What an accountant or the platform owner checks: money that came in against the invoices issued, and everything that
// does not add up. "Exceptions" are things a person should look at; an empty list is the good answer.
export async function billingAudit({ days = 30, nowMs = Date.now() } = {}) {
  const span = Math.min(Math.max(Number(days) || 30, 1), 366);
  const since = new Date(nowMs - span * 86400_000).toISOString();
  const [taken, issued, orders, refunds] = await Promise.all([
    query(
      `SELECT currency,source,count(*)::int AS payments,COALESCE(sum(amount),0)::numeric AS amount FROM subscription_payments
       WHERE created_at >= $1 AND currency IS NOT NULL GROUP BY currency,source ORDER BY currency,source`,
      [since],
    ),
    query(
      `SELECT currency,count(*)::int AS invoices,COALESCE(sum(taxable_minor),0)::bigint AS taxable,COALESCE(sum(cgst_minor+sgst_minor+igst_minor),0)::bigint AS tax,COALESCE(sum(total_minor),0)::bigint AS total
       FROM invoices WHERE created_at >= $1 GROUP BY currency ORDER BY currency`,
      [since],
    ),
    query("SELECT status,count(*)::int AS n FROM payment_orders WHERE source IN ('checkout','autopay','website') AND created_at >= $1 GROUP BY status", [since]),
    query("SELECT currency,count(*)::int AS n,COALESCE(sum(amount_minor),0)::bigint AS amount FROM payment_refunds WHERE created_at >= $1 GROUP BY currency", [since]),
  ]);
  const company = (alias = "t") => `${alias}.name AS company`;
  // an order from the website may have no company yet: it is shown under the name the buyer gave
  const orderCompany = "COALESCE(t.name,o.guest->>'companyName') AS company";
  const [mismatch, unsettled, paidNoPayment, noInvoice, stuckHooks, gaps, badSignatures] = await Promise.all([
    query(`SELECT o.id,o.tenant_id,${orderCompany},o.total_minor,o.currency,o.gateway_payment_id,o.failure_reason,o.updated_at FROM payment_orders o LEFT JOIN tenants t ON t.id=o.tenant_id WHERE o.status='mismatch' ORDER BY o.updated_at DESC LIMIT 50`),
    query(
      `SELECT o.id,o.tenant_id,${orderCompany},o.total_minor,o.currency,o.gateway_payment_id,o.status,o.updated_at FROM payment_orders o LEFT JOIN tenants t ON t.id=o.tenant_id
       WHERE o.gateway_payment_id IS NOT NULL AND o.status IN ('created','attempted') AND o.updated_at < now()-interval '1 hour' ORDER BY o.updated_at DESC LIMIT 50`,
    ),
    query(
      `SELECT o.id,o.tenant_id,${orderCompany},o.total_minor,o.currency,o.gateway_payment_id,o.paid_at FROM payment_orders o LEFT JOIN tenants t ON t.id=o.tenant_id
       WHERE o.status='paid' AND o.subscription_payment_id IS NULL ORDER BY o.paid_at DESC LIMIT 50`,
    ),
    query(
      `SELECT p.id,p.tenant_id,${company()},p.plan,p.amount,p.currency,p.source,p.created_at FROM subscription_payments p JOIN tenants t ON t.id=p.tenant_id
       WHERE p.amount > 0 AND p.created_at >= $1 AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.subscription_payment_id=p.id::text) ORDER BY p.created_at DESC LIMIT 50`,
      [since],
    ),
    query(`SELECT event_id,event,received_at,attempts,result FROM gateway_webhook_receipts WHERE processed_at IS NULL AND received_at < now()-interval '10 minutes' ORDER BY received_at DESC LIMIT 50`),
    // an invoice number that was skipped in a series is a compliance question, not a rounding matter
    query(
      `SELECT i.series,g.n AS missing FROM (SELECT series,max(seq) AS top FROM invoices GROUP BY series) i
       CROSS JOIN LATERAL generate_series(1,i.top) AS g(n) WHERE NOT EXISTS (SELECT 1 FROM invoices x WHERE x.series=i.series AND x.seq=g.n) ORDER BY i.series,g.n LIMIT 100`,
    ),
    query(
      `SELECT a.id,a.tenant_id,${company("t")},a.metadata,a.created_at FROM audit_events a JOIN tenants t ON t.id=a.tenant_id WHERE a.event_type='payment.signature_invalid' AND a.created_at >= $1 ORDER BY a.id DESC LIMIT 50`,
      [since],
    ),
  ]);
  const events = (
    await query(
      `SELECT a.id,a.event_type,a.metadata,a.created_at,t.name AS company,u.name AS actor FROM audit_events a JOIN tenants t ON t.id=a.tenant_id LEFT JOIN users u ON u.id=a.actor_id
       WHERE a.event_type ~ '^(payment|subscription|autopay|invoice|plan)\\.' AND a.created_at >= $1 ORDER BY a.id DESC LIMIT 100`,
      [since],
    )
  ).rows.map((e) => ({ id: e.id, type: e.event_type, company: e.company, actor: e.actor, at: e.created_at, details: e.metadata }));
  const money = (r) => ({ currency: r.currency, amount: Number(r.amount) });
  const exceptions = {
    amountMismatch: mismatch.rows.map((o) => ({ orderId: o.id, companyId: o.tenant_id, company: o.company, totalMinor: Number(o.total_minor), currency: o.currency, paymentId: o.gateway_payment_id, reason: o.failure_reason, at: o.updated_at })),
    notSettled: unsettled.rows.map((o) => ({ orderId: o.id, companyId: o.tenant_id, company: o.company, totalMinor: Number(o.total_minor), currency: o.currency, paymentId: o.gateway_payment_id, status: o.status, at: o.updated_at })),
    paidButNoSubscriptionRecord: paidNoPayment.rows.map((o) => ({ orderId: o.id, companyId: o.tenant_id, company: o.company, totalMinor: Number(o.total_minor), currency: o.currency, paymentId: o.gateway_payment_id, at: o.paid_at })),
    paymentWithoutInvoice: noInvoice.rows.map((p) => ({ paymentId: p.id, companyId: p.tenant_id, company: p.company, plan: p.plan, amount: Number(p.amount), currency: p.currency, source: p.source, at: p.created_at })),
    webhooksNotProcessed: stuckHooks.rows.map((w) => ({ eventId: w.event_id, event: w.event, receivedAt: w.received_at, attempts: w.attempts, result: w.result })),
    invoiceNumberGaps: gaps.rows.map((g) => ({ series: g.series, missing: Number(g.missing) })),
    invalidSignatures: badSignatures.rows.map((a) => ({ companyId: a.tenant_id, company: a.company, details: a.metadata, at: a.created_at })),
  };
  return {
    range: { days: span, since },
    payments: { configured: paymentsStatus(), takings: taken.rows.map((r) => ({ ...money(r), source: r.source, payments: r.payments })) },
    invoices: issued.rows.map((r) => ({ currency: r.currency, invoices: r.invoices, taxableMinor: Number(r.taxable), taxMinor: Number(r.tax), totalMinor: Number(r.total) })),
    orders: Object.fromEntries(orders.rows.map((o) => [o.status, o.n])),
    refunds: refunds.rows.map((r) => ({ currency: r.currency, refunds: r.n, amountMinor: Number(r.amount) })),
    exceptions,
    exceptionCount: Object.values(exceptions).reduce((n, list) => n + list.length, 0),
    events,
  };
}
