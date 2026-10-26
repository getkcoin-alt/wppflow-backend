import crypto from "node:crypto";
import { query } from "../db/index.js";
import { ENV } from "../config/env.js";
import { fail, failWith } from "../middleware/http.js";
import { razorpayConfig } from "../config/billing.js";
import * as gateway from "./razorpay.js";
import { planCatalogue, choosePlan } from "./plans.js";
import { STATES, stateList, cleanProfile } from "./gst.js";
import { billingSettings } from "./billingSettings.js";
import { mailEnabled } from "./mailer.js";
import { quoteFor, requirePayments, orderView, orderById, settleFromGateway } from "./billingService.js";

// Buying a plan on the website, before there is a company or an account. The price and the tax are worked out here
// from the same plan prices and billing settings as inside the app. Nothing is created for the buyer until Razorpay
// has confirmed the payment: settleOrder() then makes the company and its owner in the same transaction that records
// the payment, and the emails go out after it. Because nothing is mailed to an address until its owner has paid, the
// form cannot be used to send mail to strangers.

const ORDER_LIFETIME_HOURS = 24;
// A buyer with no company: the plan is new, from today.
const NEW_BUYER = { plan: "Free", period_start: null, period_end: null, billing_cycle: null };
const label = (interval) => (interval === "annual" ? "yearly" : "monthly");
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

// What the website needs to offer a Buy button: whether buying works at all, the plans that can be bought in rupees,
// and the states and tax rate for the invoice. The Razorpay key id is only given with an order.
export function websiteCheckoutOptions() {
  const cfg = razorpayConfig();
  const plans = planCatalogue()
    .filter((p) => p.id !== "free" && p.prices.some((x) => x.currency === "INR" && x.amountMinor > 0))
    .map((p) => ({ id: p.id, name: p.name, numbers: p.numbers, taxMode: p.taxMode, prices: p.prices.filter((x) => x.currency === "INR") }));
  return {
    enabled: Boolean(cfg.configured && mailEnabled() && plans.length),
    gstRate: billingSettings().gstRate,
    sellerStateCode: billingSettings().seller.stateCode,
    states: stateList(),
    plans,
  };
}

// The exact price for a plan, billing period and buyer's state: the same quote the order will be made with.
export function websiteQuote({ plan, interval, stateCode }) {
  const code = String(stateCode ?? "").padStart(2, "0");
  if (!STATES[code]) throw fail(400, "Choose the state your company is in");
  return quoteFor(NEW_BUYER, { stateCode: code }, { plan, interval });
}

const text = (value, label, min, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (s.length < min) throw fail(400, `${label} is required`);
  if (s.length > max) throw fail(400, `${label} can be up to ${max} characters`);
  return s;
};

function cleanBuyer(body) {
  const companyName = text(body.companyName, "Company name", 2, 100);
  const ownerName = text(body.ownerName, "Your name", 2, 100);
  const ownerEmail = text(body.ownerEmail, "Email", 5, 255).toLowerCase();
  if (!EMAIL.test(ownerEmail)) throw fail(400, "Please enter a valid email address");
  const phone = String(body.phone ?? "").trim();
  if (phone && !/^[+\d][\d\s()-]{5,}$/.test(phone)) throw fail(400, "Please enter a valid phone number, with country code");
  if (body.acceptedTerms !== true) throw fail(400, "Please accept the Terms of Service and the Refund policy to continue");
  const b = body.billing || {};
  const billing = cleanProfile({ ...b, legalName: b.legalName || companyName, billingEmail: ownerEmail });
  return { companyName, ownerName, ownerEmail, phone: phone.slice(0, 40), billing };
}

const statusToken = (orderId) => crypto.createHmac("sha256", ENV.JWT_SECRET).update(`website-checkout:${orderId}`).digest("hex").slice(0, 32);
const sameToken = (a, b) => {
  const x = Buffer.from(String(a || "")),
    y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

export async function createWebsiteOrder({ body = {}, ip = "" }) {
  requirePayments();
  if (!mailEnabled()) throw failWith(503, "Online purchase is not available right now. Message the Scriwo team and we will set you up.", { code: "payments_off" });
  const buyer = cleanBuyer(body);
  const plan = choosePlan(body.plan);
  const q = quoteFor(NEW_BUYER, { stateCode: buyer.billing.stateCode }, { plan: plan.id, interval: body.interval });
  if ((await query("SELECT 1 FROM users WHERE lower(email)=$1", [buyer.ownerEmail])).rowCount)
    throw failWith(409, "This email already has a Scriwo account. Sign in at app.scriwo.com to change your plan, or use a different email for a new company.", { code: "account_exists" });

  const quote = { ...q, buyer: { ...buyer.billing, state: STATES[buyer.billing.stateCode], email: buyer.ownerEmail } };
  const guest = { companyName: buyer.companyName, ownerName: buyer.ownerName, ownerEmail: buyer.ownerEmail, phone: buyer.phone, billing: buyer.billing, acceptedTermsAt: new Date().toISOString(), ip: String(ip).slice(0, 64) };
  // The same unpaid order for the same buyer and the same thing is reused, so a double click or a retry after a declined
  // card does not make a second one.
  let order = (
    await query(
      `SELECT * FROM payment_orders WHERE source='website' AND guest_email=$1 AND status IN ('created','attempted') AND plan_code=$2 AND billing_interval=$3
         AND total_minor=$4 AND gateway_order_id IS NOT NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,
      [buyer.ownerEmail, q.plan.id, q.interval, q.totalMinor],
    )
  ).rows[0];
  if (order) {
    if (order.status === "created") order = (await query("UPDATE payment_orders SET guest=$2,quote=$3,updated_at=now() WHERE id=$1 RETURNING *", [order.id, JSON.stringify(guest), JSON.stringify(quote)])).rows[0];
  } else {
    const id = crypto.randomUUID();
    const receipt = `scw_${id.replace(/-/g, "").slice(0, 30)}`;
    await query(
      `INSERT INTO payment_orders(id,tenant_id,plan_code,billing_interval,source,currency,base_minor,credit_minor,tax_minor,total_minor,quote,receipt,status,expires_at,guest,guest_email)
       VALUES($1,NULL,$2,$3,'website','INR',$4,0,$5,$6,$7,$8,'created',now()+($9||' hours')::interval,$10,$11)`,
      [id, q.plan.id, q.interval, q.baseMinor, q.taxMinor, q.totalMinor, JSON.stringify(quote), receipt, String(ORDER_LIFETIME_HOURS), JSON.stringify(guest), buyer.ownerEmail],
    );
    try {
      const made = await gateway.createOrder({ amount: q.totalMinor, currency: "INR", receipt, notes: { order_id: id, kind: "website", plan: q.plan.id, interval: q.interval } });
      order = (await query("UPDATE payment_orders SET gateway_order_id=$2,updated_at=now() WHERE id=$1 RETURNING *", [id, made.id])).rows[0];
    } catch (e) {
      await query("UPDATE payment_orders SET status='failed',failure_reason=$2,updated_at=now() WHERE id=$1", [id, `Could not start the payment: ${e.message}`.slice(0, 300)]);
      console.error("Website payment order not created:", e.message);
      throw failWith(502, "We could not reach the payment service, and you have not been charged. Please try again in a minute.", { code: "gateway_unavailable" });
    }
  }
  return {
    orderRef: order.id,
    statusToken: statusToken(order.id),
    quote: q,
    // everything the browser needs to open the checkout: the public key id and the order, nothing else
    checkout: {
      key: razorpayConfig().keyId,
      orderId: order.gateway_order_id,
      amount: Number(order.total_minor),
      currency: order.currency,
      name: "Scriwo",
      description: `${q.plan.name} plan, ${label(q.interval)}`,
      prefill: { name: buyer.ownerName, email: buyer.ownerEmail, ...(buyer.phone ? { contact: buyer.phone } : {}) },
    },
  };
}

// The checkout finished in the browser. The signature proves the message came from Razorpay's checkout for this order,
// but it is not the payment: the server asks Razorpay what happened and settles on the answer. If Razorpay cannot be
// asked now, the webhook or the reconciliation job completes it.
export async function verifyWebsiteCheckout({ body = {}, io = null }) {
  requirePayments();
  const gatewayOrderId = String(body.razorpay_order_id || ""),
    paymentId = String(body.razorpay_payment_id || ""),
    signature = String(body.razorpay_signature || "");
  if (!gatewayOrderId || !paymentId || !signature) throw fail(400, "The payment details are incomplete");
  const order = (await query("SELECT * FROM payment_orders WHERE gateway_order_id=$1 AND source='website'", [gatewayOrderId])).rows[0];
  if (!order) throw fail(404, "Order not found");
  if (!gateway.verifyCheckoutSignature(order.gateway_order_id, paymentId, signature)) {
    console.warn("Website checkout: signature did not match for order", order.id);
    throw fail(400, "We could not verify this payment, so nothing was set up. If money was taken it is matched automatically or refunded; message the Scriwo team.");
  }
  await query("UPDATE payment_orders SET status=CASE WHEN status IN ('created','failed') THEN 'attempted' ELSE status END,gateway_payment_id=$2,updated_at=now() WHERE id=$1", [order.id, paymentId]);
  let status = "processing";
  try {
    const result = await settleFromGateway(order.id, paymentId, io);
    status = result.status === "paid" || result.status === "already" ? "paid" : result.status === "mismatch" ? "review" : result.status;
  } catch (e) {
    console.error("Website payment check deferred:", e.message);
  }
  return { status, orderRef: order.id, statusToken: statusToken(order.id) };
}

const mask = (email) => String(email || "").replace(/^(.).*(@.*)$/, "$1***$2");
// What the success page asks while it waits: has the payment been confirmed and the workspace made? The token is made
// from the order id and the server's secret, so only the browser that started the order can ask.
export async function websiteCheckoutStatus({ orderRef, token }) {
  if (!sameToken(token, statusToken(String(orderRef || "")))) throw fail(404, "Order not found");
  const order = await orderById(String(orderRef));
  if (!order || order.source !== "website") throw fail(404, "Order not found");
  const state = { paid: "paid", created: "processing", attempted: "processing", failed: "failed", expired: "expired", mismatch: "review" }[order.status] || "processing";
  return { status: state, company: order.guest?.companyName || "", email: mask(order.guest_email), plan: orderView(order).plan, reason: state === "failed" ? order.failure_reason : null };
}
