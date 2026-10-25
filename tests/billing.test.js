import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ensureSuperAdmin } from "../src/services/adminService.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { ENV } from "../src/config/env.js";
import { closeSessions } from "../src/services/sessionService.js";
import { addCycle } from "../src/services/subscriptionService.js";
import { isLapsed } from "../src/services/plans.js";
import { settleOrder, reconcileOrders } from "../src/services/billingService.js";
import { checkoutSignature, subscriptionSignature, webhookSignature } from "../src/services/razorpay.js";
import { startFakeRazorpay } from "./helpers/fakeRazorpay.js";

const WEBHOOK_SECRET = "whsec_test_only_not_real";
const day = (offset, from = new Date().toISOString().slice(0, 10)) => {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const TODAY = day(0);
const UP = { legalName: "Acme Traders Pvt Ltd", addressLine1: "12 MG Road", city: "Lucknow", stateCode: "09", postalCode: "226001", billingEmail: "accounts@acme.test" };
const MH = { legalName: "Beta Retail LLP", addressLine1: "5 Marine Drive", city: "Mumbai", stateCode: "27", postalCode: "400001", gstin: "27AAPFU0939F1ZV" };

test("GST on a plan: CGST + SGST inside Uttar Pradesh, IGST elsewhere, and the parts add up", async () => {
  const { computeTax, validGstin, rupeesInWords, isIntraState } = await import("../src/services/gst.js");
  const up = computeTax({ amountMinor: 699900, intraState: isIntraState("09") });
  assert.deepEqual([up.taxable, up.cgst, up.sgst, up.igst, up.total], [699900, 62991, 62991, 0, 825882]);
  const mh = computeTax({ amountMinor: 699900, intraState: isIntraState("27") });
  assert.deepEqual([mh.cgst, mh.sgst, mh.igst, mh.total], [0, 0, 125982, 825882]);
  const odd = computeTax({ amountMinor: 100001, intraState: true });
  assert.equal(odd.cgst + odd.sgst, odd.tax, "an odd paisa is not lost");
  const inc = computeTax({ amountMinor: 118000, taxMode: "inclusive", intraState: false });
  assert.deepEqual([inc.taxable, inc.igst, inc.total], [100000, 18000, 118000]);
  assert.ok(validGstin("09ABICS9865M1Z8"), "the seller's own GSTIN passes the check digit");
  assert.ok(validGstin("27AAPFU0939F1ZV"));
  assert.ok(!validGstin("27AAPFU0939F1ZX"));
  assert.ok(!validGstin("99AAPFU0939F1ZV"));
  assert.equal(rupeesInWords(825882), "Eight thousand two hundred fifty eight rupees and eighty two paise only");
  assert.equal(rupeesInWords(1200000), "Twelve thousand rupees only");
});

test("Razorpay signatures: the checkout's, the subscription's and the webhook's use their own secrets and fail closed", async () => {
  const { verifyCheckoutSignature, verifyWebhookSignature, verifySubscriptionSignature } = await import("../src/services/razorpay.js");
  const sig = checkoutSignature("order_1", "pay_1", "k");
  assert.ok(verifyCheckoutSignature("order_1", "pay_1", sig, "k"));
  assert.ok(!verifyCheckoutSignature("order_2", "pay_1", sig, "k"), "another order");
  assert.ok(!verifyCheckoutSignature("order_1", "pay_1", sig, "other"), "another secret");
  assert.ok(!verifyCheckoutSignature("order_1", "pay_1", "", "k"));
  assert.ok(!verifyCheckoutSignature("order_1", "pay_1", sig, ""), "no secret configured");
  const body = Buffer.from('{"event":"payment.captured"}');
  assert.ok(verifyWebhookSignature(body, webhookSignature(body, "w"), "w"));
  assert.ok(!verifyWebhookSignature(Buffer.from('{"event":"payment.captured" }'), webhookSignature(body, "w"), "w"), "one changed byte");
  assert.ok(!verifyWebhookSignature(body, checkoutSignature("a", "b", "w"), "w"));
  assert.ok(verifySubscriptionSignature("pay_1", "sub_1", subscriptionSignature("pay_1", "sub_1", "k"), "k"));
  assert.ok(!verifySubscriptionSignature("sub_1", "pay_1", subscriptionSignature("pay_1", "sub_1", "k"), "k"), "the order of the two matters");
});

test("Paying for a plan online: orders, verified checkout, signed webhooks, reconciliation, invoices and autopay", async (t) => {
  const fake = await startFakeRazorpay();
  Object.assign(process.env, { RAZORPAY_KEY_ID: fake.keyId, RAZORPAY_KEY_SECRET: fake.keySecret, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, RAZORPAY_API_BASE: fake.base });
  t.after(async () => {
    for (const k of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_API_BASE"]) delete process.env[k];
    await fake.close();
    await closeSessions(io);
    io.close();
  });
  ENV.SUPERADMIN_EMAIL = "root@billing.test";
  ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
  await ensureSuperAdmin();
  const sa = await request(app).post("/api/auth/login").send({ email: ENV.SUPERADMIN_EMAIL, password: ENV.SUPERADMIN_PASSWORD });
  const admin = { Authorization: `Bearer ${sa.body.token}` };

  let n = 0;
  const company = async (plan = "Free", profile = UP) => {
    n++;
    const r = await registerTenantAndUser({ name: `Owner ${n}`, email: `owner${n}@billing.test`, password: "Password@123", companyName: `Bill Co ${n}` });
    const tenantId = r.tenant.id;
    await query("UPDATE tenants SET plan=$2,sessions_limit=$3 WHERE id=$1", [tenantId, plan, plan === "Free" ? 1 : 10]);
    const agent = (await query("INSERT INTO users(name,email,password_hash) VALUES('Agent','agent' || $1 || '@billing.test','x') RETURNING *", [String(n)])).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, agent.id]);
    const owner = { Authorization: `Bearer ${generateAccessToken(r.user, tenantId, "owner")}` };
    if (profile) assert.equal((await request(app).put("/api/billing/profile").set(owner).send(profile)).status, 200);
    return { tenantId, owner, agent: { Authorization: `Bearer ${generateAccessToken(agent, tenantId, "agent")}` }, user: r.user };
  };
  const tenant = async (id) => (await query("SELECT * FROM tenants WHERE id=$1", [id])).rows[0];
  const checkout = (c, body) => request(app).post("/api/billing/checkout").set(c.owner).send(body);
  const payments = async (id) => (await query("SELECT * FROM subscription_payments WHERE tenant_id=$1 ORDER BY created_at", [id])).rows;
  const invoices = async (id) => (await query("SELECT * FROM invoices WHERE tenant_id=$1 ORDER BY seq", [id])).rows;
  const orderRow = async (gatewayId) => (await query("SELECT * FROM payment_orders WHERE gateway_order_id=$1", [gatewayId])).rows[0];
  const verify = (c, orderId, paymentId, signature) =>
    request(app).post("/api/billing/verify").set(c.owner).send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature ?? checkoutSignature(orderId, paymentId, fake.keySecret) });
  let eventN = 0;
  const hook = (event, { id = `evt_${++eventN}`, secret = WEBHOOK_SECRET } = {}) => {
    const raw = JSON.stringify(event);
    return request(app).post("/api/billing/razorpay/webhook").set("Content-Type", "application/json").set("X-Razorpay-Signature", webhookSignature(raw, secret)).set("X-Razorpay-Event-Id", id).send(raw);
  };
  const captured = (payment) => ({ event: "payment.captured", payload: { payment: { entity: payment } } });

  await t.test("online payment is off until all three keys are set, and the health check says so without showing them", async () => {
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const c = await company("Free");
    const off = await checkout(c, { plan: "growth", interval: "monthly" });
    assert.equal(off.status, 503);
    assert.equal(off.body.code, "payments_off");
    assert.equal((await request(app).get("/health")).body.payments.configured, false);
    assert.equal((await request(app).post("/api/billing/razorpay/webhook").set("Content-Type", "application/json").send("{}")).status, 503);
    process.env.RAZORPAY_WEBHOOK_SECRET = saved;
    const on = (await request(app).get("/health")).body;
    assert.deepEqual(on.payments, { configured: true, mode: "test" });
    assert.ok(!JSON.stringify(on).includes(fake.keySecret) && !JSON.stringify(on).includes(WEBHOOK_SECRET));
  });

  await t.test("only the owner and administrators can pay or see invoices", async () => {
    const c = await company("Free");
    assert.equal((await request(app).get("/api/billing").set(c.agent)).status, 403);
    assert.equal((await request(app).post("/api/billing/checkout").set(c.agent).send({ plan: "growth", interval: "monthly" })).status, 403);
    assert.equal((await request(app).get("/api/billing")).status, 401);
    assert.equal((await request(app).get("/api/billing").set(c.owner)).status, 200);
  });

  await t.test("billing details are needed before paying, and are checked", async () => {
    const c = await company("Free", null);
    const missing = await checkout(c, { plan: "growth", interval: "monthly" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, "profile_required");
    const put = (body) => request(app).put("/api/billing/profile").set(c.owner).send(body);
    assert.match((await put({ ...UP, postalCode: "12" })).body.message, /6 digit PIN/);
    assert.match((await put({ ...UP, stateCode: "55" })).body.message, /state/i);
    assert.match((await put({ ...UP, gstin: "27AAPFU0939F1ZX" })).body.message, /GSTIN/);
    assert.match((await put({ ...UP, gstin: "27AAPFU0939F1ZV" })).body.message, /starts with 27/, "a GSTIN must match the state");
    assert.match((await put({ ...UP, legalName: "" })).body.message, /legal name/i);
    assert.equal((await put(MH)).status, 200);
    const got = (await request(app).get("/api/billing/profile").set(c.owner)).body.profile;
    assert.deepEqual([got.legalName, got.state, got.gstin], ["Beta Retail LLP", "Maharashtra", "27AAPFU0939F1ZV"]);
    const other = await company("Free", null);
    assert.equal((await request(app).get("/api/billing/profile").set(other.owner)).body.profile, null, "never another company's details");
  });

  let first, firstOrder, firstPayment;
  await t.test("checkout: the server works out the price and tax; the browser cannot name one", async () => {
    first = await company("Free", UP);
    const res = await checkout(first, { plan: "growth", interval: "monthly", amount: 1, total: 1, price: 1 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.checkout.amount, 825882);
    assert.equal(res.body.checkout.currency, "INR");
    assert.equal(res.body.checkout.key, fake.keyId);
    assert.deepEqual([res.body.quote.baseMinor, res.body.quote.cgstMinor, res.body.quote.sgstMinor, res.body.quote.igstMinor], [699900, 62991, 62991, 0]);
    assert.deepEqual([res.body.quote.periodStart, res.body.quote.periodEnd, res.body.quote.kind], [TODAY, addCycle(TODAY, "monthly"), "new"]);
    assert.ok(!JSON.stringify(res.body).includes(fake.keySecret) && !JSON.stringify(res.body).includes(WEBHOOK_SECRET), "no secret reaches the browser");
    const made = fake.state.orders.get(res.body.checkout.orderId);
    assert.deepEqual([made.amount, made.currency, made.notes.tenant_id, made.notes.plan], [825882, "INR", first.tenantId, "growth"]);
    firstOrder = res.body.checkout.orderId;
    assert.equal((await tenant(first.tenantId)).plan, "Free", "nothing changes until a payment is confirmed");
    const again = await checkout(first, { plan: "growth", interval: "monthly" });
    assert.equal(again.body.checkout.orderId, firstOrder, "a second click reuses the unpaid order");
    assert.equal((await query("SELECT count(*)::int n FROM payment_orders WHERE tenant_id=$1", [first.tenantId])).rows[0].n, 1);
  });

  await t.test("the same plan in another state is taxed as IGST", async () => {
    const m = await company("Free", MH);
    const res = await checkout(m, { plan: "growth", interval: "monthly" });
    assert.deepEqual([res.body.quote.cgstMinor, res.body.quote.sgstMinor, res.body.quote.igstMinor, res.body.quote.totalMinor], [0, 0, 125982, 825882]);
    const yearly = await checkout(m, { plan: "growth", interval: "annual" });
    assert.equal(yearly.body.quote.baseMinor, 6999000, "a year is ten months");
  });

  await t.test("only rupees, and only plans for sale with a price", async () => {
    const c = await company("Free");
    const aed = await checkout(c, { plan: "growth", interval: "monthly", currency: "AED" });
    assert.equal(aed.status, 400);
    assert.equal(aed.body.code, "currency_coming_soon");
    assert.match(aed.body.message, /coming soon/);
    assert.equal((await checkout(c, { plan: "free", interval: "monthly" })).status, 400);
    assert.match((await checkout(c, { plan: "enterprise", interval: "monthly" })).body.message, /no online price/);
    assert.equal((await checkout(c, { plan: "nonsense", interval: "monthly" })).status, 400);
    assert.equal((await checkout(c, { plan: "growth", interval: "weekly" })).status, 400);
  });

  await t.test("a payment the browser reports with a wrong signature activates nothing", async () => {
    firstPayment = fake.pay(firstOrder);
    const bad = await verify(first, firstOrder, firstPayment.id, "0".repeat(64));
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /could not verify/);
    assert.equal((await tenant(first.tenantId)).plan, "Free");
    // a signature made for another order does not work for this one
    const other = await verify(first, firstOrder, firstPayment.id, checkoutSignature("order_other", firstPayment.id, fake.keySecret));
    assert.equal(other.status, 400);
    assert.equal((await payments(first.tenantId)).length, 0);
    assert.equal((await query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND event_type='payment.signature_invalid'", [first.tenantId])).rows[0].n, 2);
  });

  await t.test("another company cannot use this order", async () => {
    const stranger = await company("Free");
    const res = await verify(stranger, firstOrder, firstPayment.id);
    assert.equal(res.status, 404);
    assert.equal((await tenant(stranger.tenantId)).plan, "Free");
    assert.equal((await tenant(first.tenantId)).plan, "Free");
  });

  await t.test("a verified payment, confirmed with Razorpay, activates the plan, once, with an invoice and a notice", async () => {
    const res = await verify(first, firstOrder, firstPayment.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "paid");
    const row = await tenant(first.tenantId);
    assert.deepEqual([row.plan, row.billing_cycle, row.sessions_limit], ["Growth", "monthly", 10]);
    assert.equal(String(row.period_end.getFullYear()) + "-" + String(row.period_end.getMonth() + 1).padStart(2, "0") + "-" + String(row.period_end.getDate()).padStart(2, "0"), addCycle(TODAY, "monthly"));
    const [p] = await payments(first.tenantId);
    assert.deepEqual([p.source, Number(p.amount), p.currency, p.reference], ["razorpay", 8258.82, "INR", firstPayment.id]);
    const [inv] = await invoices(first.tenantId);
    assert.match(inv.number, /^SCZ\/\d{4}-\d{2}\/00001$/);
    assert.deepEqual([Number(inv.taxable_minor), Number(inv.cgst_minor), Number(inv.sgst_minor), Number(inv.igst_minor), Number(inv.total_minor)], [699900, 62991, 62991, 0, 825882]);
    assert.equal(inv.seller.gstin, "09ABICS9865M1Z8");
    assert.equal(inv.buyer.legalName, "Acme Traders Pvt Ltd");
    assert.equal((await orderRow(firstOrder)).status, "paid");
    const notes = (await query("SELECT title,body FROM notifications WHERE tenant_id=$1 AND type='subscription'", [first.tenantId])).rows;
    assert.ok(notes.some((x) => /Payment received: ₹8,258.82/.test(x.title)), JSON.stringify(notes));
    assert.equal((await query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND event_type='payment.settled'", [first.tenantId])).rows[0].n, 1);
  });

  await t.test("the webhook for the same payment, the browser again and a repeat of the event change nothing", async () => {
    const event = captured(fake.state.payments.get(firstPayment.id));
    const a = await hook(event, { id: "evt_same" });
    assert.equal(a.status, 200);
    const b = await hook(event, { id: "evt_same" });
    assert.equal(b.body.duplicate, true, "an event id is handled once");
    const c2 = await hook(event, { id: "evt_other_delivery" });
    assert.equal(c2.status, 200, "even under a new id, the order is already paid");
    assert.equal((await verify(first, firstOrder, firstPayment.id)).body.status, "paid");
    assert.equal((await payments(first.tenantId)).length, 1);
    assert.equal((await invoices(first.tenantId)).length, 1);
    assert.equal((await query("SELECT count(*)::int n FROM notifications WHERE tenant_id=$1 AND title LIKE 'Payment received%'", [first.tenantId])).rows[0].n, 1);
    assert.equal((await query("SELECT count(*)::int n FROM gateway_webhook_receipts WHERE event_id='evt_same'")).rows[0].n, 1);
  });

  await t.test("activation works with only the webhook, only the browser, or both at the same moment", async () => {
    const hookOnly = await company("Free");
    const o1 = (await checkout(hookOnly, { plan: "starter", interval: "monthly" })).body.checkout.orderId;
    const p1 = fake.pay(o1);
    assert.equal((await hook(captured(p1))).status, 200);
    assert.equal((await tenant(hookOnly.tenantId)).plan, "Starter", "the webhook alone is enough");

    const both = await company("Free");
    const o2 = (await checkout(both, { plan: "starter", interval: "monthly" })).body.checkout.orderId;
    const p2 = fake.pay(o2);
    const results = await Promise.all([verify(both, o2, p2.id), hook(captured(p2)), hook(captured(p2)), verify(both, o2, p2.id)]);
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.body)));
    assert.equal((await payments(both.tenantId)).length, 1, "exactly one payment recorded");
    assert.equal((await invoices(both.tenantId)).length, 1, "exactly one invoice");
    assert.equal((await tenant(both.tenantId)).plan, "Starter");
  });

  await t.test("webhooks: a bad signature is refused and stores nothing; a good one from another secret too", async () => {
    const raw = JSON.stringify(captured({ id: "pay_x", order_id: "order_x", status: "captured", amount: 1, currency: "INR" }));
    const bad = await request(app).post("/api/billing/razorpay/webhook").set("Content-Type", "application/json").set("X-Razorpay-Signature", "deadbeef").set("X-Razorpay-Event-Id", "evt_bad").send(raw);
    assert.equal(bad.status, 400);
    assert.equal((await hook(JSON.parse(raw), { id: "evt_bad2", secret: "the-wrong-secret" })).status, 400);
    assert.equal((await request(app).post("/api/billing/razorpay/webhook").set("Content-Type", "application/json").send(raw)).status, 400, "no signature at all");
    assert.equal((await query("SELECT count(*)::int n FROM gateway_webhook_receipts WHERE event_id IN ('evt_bad','evt_bad2')")).rows[0].n, 0);
    // a body with a space added no longer matches the signature computed over the original bytes
    const sig = webhookSignature(raw, WEBHOOK_SECRET);
    assert.equal((await request(app).post("/api/billing/razorpay/webhook").set("Content-Type", "application/json").set("X-Razorpay-Signature", sig).send(raw + " ")).status, 400);
  });

  await t.test("a payment for the wrong amount, currency, order or company activates nothing and is flagged", async () => {
    const attempt = async (over, notes = {}) => {
      const c = await company("Free");
      const o = (await checkout(c, { plan: "starter", interval: "monthly" })).body.checkout.orderId;
      const p = fake.pay(o, over);
      const res = await hook(captured({ ...p, notes }));
      assert.equal(res.status, 200);
      return { c, o, row: await orderRow(o) };
    };
    for (const [label, over, notes] of [["amount", { amount: 100 }, {}], ["currency", { currency: "USD" }, {}], ["company", {}, { tenant_id: "someone-else" }]]) {
      const { c, row } = await attempt(over, notes);
      assert.equal(row.status, "mismatch", label);
      assert.equal((await tenant(c.tenantId)).plan, "Free", `${label}: nothing activated`);
      assert.equal((await payments(c.tenantId)).length, 0);
      assert.equal((await invoices(c.tenantId)).length, 0);
      assert.equal((await query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND event_type='payment.mismatch'", [c.tenantId])).rows[0].n, 1);
    }
    const c = await company("Free");
    const o = (await checkout(c, { plan: "starter", interval: "monthly" })).body.checkout.orderId;
    const ours = await orderRow(o);
    const res = await settleOrder({ orderId: ours.id, payment: { ...fake.pay(o), order_id: "order_different" }, source: "test" });
    assert.equal(res.status, "mismatch", "a payment that names another order");
    assert.equal((await tenant(c.tenantId)).plan, "Free");
    const seen = (await request(app).get("/api/admin/billing/payments?status=mismatch").set(admin)).body;
    assert.ok(seen.counts.mismatch >= 4);
    assert.ok(seen.orders.every((x) => x.status === "mismatch" && x.company));
    // a mismatched order is not settled by a later correct-looking event
    assert.equal((await settleOrder({ orderId: ours.id, payment: fake.pay(o), source: "test" })).status, "mismatch");
  });

  await t.test("a failed payment leaves the company alone, and the customer can try again on the same order", async () => {
    const c = await company("Free");
    const o = (await checkout(c, { plan: "starter", interval: "monthly" })).body.checkout.orderId;
    const failed = fake.pay(o, { status: "failed", error_description: "Card declined by the bank" });
    await hook({ event: "payment.failed", payload: { payment: { entity: failed } } });
    const row = await orderRow(o);
    assert.deepEqual([row.status, row.failure_reason], ["failed", "Card declined by the bank"]);
    assert.equal((await tenant(c.tenantId)).plan, "Free");
    assert.equal((await payments(c.tenantId)).length, 0);
    const retry = fake.pay(o);
    assert.equal((await verify(c, o, retry.id)).body.status, "paid");
    assert.equal((await tenant(c.tenantId)).plan, "Starter");
    const overview = (await request(app).get("/api/billing").set(c.owner)).body;
    assert.equal(overview.orders[0].status, "paid");
  });

  await t.test("a payment authorised but not yet captured is captured, then settled", async () => {
    const c = await company("Free");
    const o = (await checkout(c, { plan: "starter", interval: "monthly" })).body.checkout.orderId;
    const p = fake.pay(o, { status: "authorized" });
    assert.equal((await verify(c, o, p.id)).body.status, "paid");
    assert.ok(fake.state.calls.some((x) => x.path === `/v1/payments/${p.id}/capture`));
    assert.equal(fake.state.payments.get(p.id).status, "captured");
  });

  await t.test("Razorpay being unreachable at verify time leaves the order to the webhook and the reconciliation job", async () => {
    const c = await company("Free");
    const o = (await checkout(c, { plan: "starter", interval: "monthly" })).body.checkout.orderId;
    const p = fake.pay(o);
    fake.state.failNext = { status: 503, message: "temporarily unavailable" };
    const res = await verify(c, o, p.id);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "processing");
    assert.equal((await tenant(c.tenantId)).plan, "Free");
    assert.equal((await orderRow(o)).status, "attempted");
    await query("UPDATE payment_orders SET created_at=now()-interval '11 minutes' WHERE gateway_order_id=$1", [o]);
    assert.equal(await reconcileOrders(), 1);
    assert.equal((await tenant(c.tenantId)).plan, "Starter");
  });

  await t.test("a payment whose webhook never came and whose tab was closed is found by the reconciliation job", async () => {
    const c = await company("Free");
    const o = (await checkout(c, { plan: "starter", interval: "monthly" })).body.checkout.orderId;
    fake.pay(o);
    assert.equal(await reconcileOrders(), 0, "too recent to look at yet");
    await query("UPDATE payment_orders SET created_at=now()-interval '15 minutes' WHERE gateway_order_id=$1", [o]);
    assert.equal(await reconcileOrders(), 1);
    assert.equal((await tenant(c.tenantId)).plan, "Starter");
    assert.equal((await invoices(c.tenantId)).length, 1);
    assert.equal(await reconcileOrders(), 0, "and only once");
  });

  await t.test("an order nobody paid for is closed after a day, and a payment that still arrives is honoured", async () => {
    const c = await company("Free");
    const o = (await checkout(c, { plan: "starter", interval: "monthly" })).body.checkout.orderId;
    await query("UPDATE payment_orders SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE gateway_order_id=$1", [o]);
    await reconcileOrders();
    assert.equal((await orderRow(o)).status, "expired");
    const late = fake.pay(o);
    assert.equal((await hook(captured(late))).status, 200);
    assert.equal((await orderRow(o)).status, "paid", "the money was taken, so the plan is activated");
    assert.equal((await tenant(c.tenantId)).plan, "Starter");
  });

  await t.test("paying early never shortens a period, and paying a period that is already paid asks first", async () => {
    const end = (await tenant(first.tenantId)).period_end;
    const endIso = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
    const ask = await checkout(first, { plan: "growth", interval: "monthly" });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.code, "confirm_required");
    assert.equal(ask.body.paidUntil, endIso);
    assert.match(ask.body.message, /already paid until/);
    const ok = await checkout(first, { plan: "growth", interval: "monthly", confirm: true });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.quote.periodStart, endIso, "the new period follows the paid one");
    const p = fake.pay(ok.body.checkout.orderId);
    assert.equal((await verify(first, ok.body.checkout.orderId, p.id)).body.status, "paid");
    const after = await tenant(first.tenantId);
    const afterIso = `${after.period_end.getFullYear()}-${String(after.period_end.getMonth() + 1).padStart(2, "0")}-${String(after.period_end.getDate()).padStart(2, "0")}`;
    assert.equal(afterIso, addCycle(endIso, "monthly"));
    assert.equal((await payments(first.tenantId)).length, 2);
    assert.equal((await invoices(first.tenantId)).length, 2);
  });

  await t.test("a bigger plan mid-period credits the unused days; a smaller one waits for the period to end", async () => {
    const c = await company("Starter", UP);
    await query("UPDATE tenants SET billing_cycle='monthly',period_start=$2,period_end=$3 WHERE id=$1", [c.tenantId, day(-10), day(20)]);
    const down = await checkout(c, { plan: "starter", interval: "annual" });
    assert.equal(down.status, 201, "a different cycle on the same plan is a change");
    const up = await checkout(c, { plan: "growth", interval: "monthly" });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const q = up.body.quote;
    assert.equal(q.kind, "change");
    assert.equal(q.creditMinor, Math.floor((249900 * 20) / 30));
    assert.equal(q.taxableMinor, 699900 - q.creditMinor);
    assert.equal(q.totalMinor, q.taxableMinor + q.taxMinor);
    assert.deepEqual([q.periodStart, q.periodEnd], [TODAY, addCycle(TODAY, "monthly")], "a fresh period starts today");
    const p = fake.pay(up.body.checkout.orderId);
    assert.equal((await verify(c, up.body.checkout.orderId, p.id)).body.status, "paid");
    const row = await tenant(c.tenantId);
    assert.deepEqual([row.plan, row.sessions_limit], ["Growth", 10]);
    const [inv] = await invoices(c.tenantId);
    assert.equal(inv.lines.length, 2);
    assert.equal(inv.lines[1].amountMinor, -q.creditMinor);
    assert.equal(Number(inv.taxable_minor), q.taxableMinor);

    const smaller = await checkout(c, { plan: "starter", interval: "monthly" });
    assert.equal(smaller.status, 400);
    assert.equal(smaller.body.code, "downgrade_later");
    const sched = await request(app).post("/api/billing/downgrade").set(c.owner).send({ plan: "starter" });
    assert.equal(sched.status, 200);
    assert.equal((await tenant(c.tenantId)).scheduled_plan, "starter");
    assert.equal((await request(app).delete("/api/billing/downgrade").set(c.owner)).body.cleared, true);
    assert.equal((await tenant(c.tenantId)).scheduled_plan, null);
    assert.equal((await request(app).post("/api/billing/downgrade").set(c.owner).send({ plan: "free" })).status, 200, "cancelling is a move to Free at the end");
    assert.equal((await request(app).post("/api/billing/downgrade").set(c.owner).send({ plan: "enterprise" })).status, 400);
    const history = (await request(app).get("/api/billing").set(c.owner)).body.history.map((h) => h.type);
    assert.ok(history.includes("payment") && history.includes("cancel_scheduled") && history.includes("downgrade_scheduled"), history.join());
  });

  await t.test("a company whose paid features switched off is switched back on by paying", async () => {
    const c = await company("Growth", UP);
    await query("UPDATE tenants SET billing_cycle='monthly',period_start=$2,period_end=$3 WHERE id=$1", [c.tenantId, day(-40), day(-10)]);
    assert.equal(isLapsed(await tenant(c.tenantId)), true);
    const res = await checkout(c, { plan: "growth", interval: "monthly" });
    assert.equal(res.body.quote.kind, "new");
    assert.equal(res.body.quote.periodStart, TODAY, "the lapsed days are not billed");
    const p = fake.pay(res.body.checkout.orderId);
    assert.equal((await verify(c, res.body.checkout.orderId, p.id)).body.status, "paid");
    assert.equal(isLapsed(await tenant(c.tenantId)), false);
    const caps = (await request(app).get("/api/workspace/capabilities").set(c.owner)).body;
    assert.equal(caps.plan.lapsed, false);
  });

  await t.test("invoices: numbered in a series without gaps, downloadable as a PDF by the owner only", async () => {
    const all = (await query("SELECT seq,series,number FROM invoices ORDER BY seq")).rows;
    assert.ok(all.length >= 8);
    assert.deepEqual(all.map((i) => i.seq), all.map((_, i) => i + 1), "no number is skipped or repeated");
    assert.equal(new Set(all.map((i) => i.number)).size, all.length);
    const [inv] = await invoices(first.tenantId);
    const list = (await request(app).get("/api/billing").set(first.owner)).body.invoices;
    assert.ok(list.some((i) => i.id === inv.id && i.number === inv.number && i.totalMinor === 825882));
    const pdf = await request(app).get(`/api/billing/invoices/${inv.id}/pdf`).set(first.owner).buffer(true).parse((res, cb) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => cb(null, Buffer.concat(parts)));
    });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers["content-type"], /application\/pdf/);
    assert.match(pdf.headers["content-disposition"], /Scriwo-invoice-SCZ-/);
    assert.equal(pdf.body.subarray(0, 4).toString(), "%PDF");
    assert.ok(pdf.body.length > 1500);
    const stranger = await company("Free");
    assert.equal((await request(app).get(`/api/billing/invoices/${inv.id}/pdf`).set(stranger.owner)).status, 404);
    assert.equal((await request(app).get(`/api/billing/invoices/${inv.id}/pdf`).set(first.agent)).status, 403);
  });

  await t.test("a payment recorded by the Scriwo team gets an invoice too, when the company has its details; AED gets none", async () => {
    const withProfile = await company("Starter", MH);
    const rec = await request(app).post(`/api/admin/companies/${withProfile.tenantId}/subscription/payment`).set(admin).send({ plan: "growth", cycle: "monthly", amount: 8258.82, currency: "INR", reference: "NEFT-9912" });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    assert.ok(rec.body.invoice.number);
    const [inv] = await invoices(withProfile.tenantId);
    assert.deepEqual([Number(inv.total_minor), Number(inv.igst_minor), Number(inv.taxable_minor)], [825882, 125982, 699900]);
    assert.equal(inv.payment_ref, "NEFT-9912");
    const again = await request(app).post(`/api/admin/companies/${withProfile.tenantId}/payments/${rec.body.paymentId}/invoice`).set(admin);
    assert.equal(again.status, 201);
    assert.equal(again.body.invoice.id, inv.id, "never a second invoice for one payment");
    const listed = await request(app).get(`/api/admin/companies/${withProfile.tenantId}/payments`).set(admin);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const pay = listed.body.payments[0];
    assert.equal(pay.invoice.number, inv.number);

    const noProfile = await company("Starter", null);
    const rec2 = await request(app).post(`/api/admin/companies/${noProfile.tenantId}/subscription/payment`).set(admin).send({ plan: "growth", cycle: "monthly", amount: 8258.82, currency: "INR" });
    assert.equal(rec2.body.invoice, null);
    assert.match(rec2.body.invoiceSkipped, /billing details/);
    await request(app).put("/api/billing/profile").set(noProfile.owner).send(UP);
    assert.equal((await request(app).post(`/api/admin/companies/${noProfile.tenantId}/payments/${rec2.body.paymentId}/invoice`).set(admin)).status, 201, "issued later, once the details are saved");
    const rec3 = await request(app).post(`/api/admin/companies/${withProfile.tenantId}/subscription/payment`).set(admin).send({ cycle: "monthly", amount: 799, currency: "AED" });
    assert.equal(rec3.body.invoice, null);
    assert.match(rec3.body.invoiceSkipped, /rupees/);
  });

  await t.test("autopay: set up on purpose, one charge per Razorpay payment, a failed charge is shown, and it can be turned off", async () => {
    const c = await company("Free", UP);
    const start = await request(app).post("/api/billing/autopay").set(c.owner).send({ plan: "growth" });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    const sub = fake.state.subscriptions.get(start.body.checkout.subscriptionId);
    assert.equal([...fake.state.plans.values()].at(-1).item.amount, 825882, "the charge includes GST");
    assert.deepEqual([sub.total_count, sub.notes.tenant_id], [120, c.tenantId]);
    assert.equal(sub.start_at, undefined, "no running period, so the first charge is now");
    const same = await request(app).post("/api/billing/autopay").set(c.owner).send({ plan: "growth" });
    assert.equal(same.body.checkout.subscriptionId, sub.id, "the same unfinished setup is reused");
    assert.equal((await request(app).post("/api/billing/autopay").set(c.owner).send({ plan: "business" })).status, 409);
    assert.match((await request(app).post("/api/billing/autopay").set((await company("Free", UP)).owner).send({ plan: "growth", interval: "annual" })).status === 201 ? "ok" : "no", /ok/, "yearly is not an option for autopay: it is always monthly");

    const charge1 = { id: "pay_auto_1", order_id: "order_auto_1", status: "captured", amount: 825882, currency: "INR", method: "card", notes: {} };
    assert.equal((await request(app).post("/api/billing/autopay/verify").set(c.owner).send({ razorpay_payment_id: charge1.id, razorpay_subscription_id: sub.id, razorpay_signature: "bad" })).status, 400);
    const verified = await request(app).post("/api/billing/autopay/verify").set(c.owner).send({ razorpay_payment_id: charge1.id, razorpay_subscription_id: sub.id, razorpay_signature: subscriptionSignature(charge1.id, sub.id, fake.keySecret) });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.autopay.status, "authenticated");

    const subEvent = (event, payment, extra = {}) => ({ event, payload: { subscription: { entity: { id: sub.id, ...extra } }, ...(payment ? { payment: { entity: payment } } : {}) } });
    assert.equal((await hook(subEvent("subscription.charged", charge1))).status, 200);
    const row = await tenant(c.tenantId);
    assert.deepEqual([row.plan, row.billing_cycle], ["Growth", "monthly"]);
    assert.deepEqual((await payments(c.tenantId)).map((p) => p.source), ["autopay"]);
    assert.equal((await invoices(c.tenantId)).length, 1);
    assert.equal((await hook(subEvent("subscription.charged", charge1), { id: "evt_redelivered" })).status, 200);
    assert.equal((await payments(c.tenantId)).length, 1, "the same charge delivered again is one charge");
    const end1 = (await tenant(c.tenantId)).period_end;

    const charge2 = { ...charge1, id: "pay_auto_2", order_id: "order_auto_2" };
    await hook(subEvent("subscription.charged", charge2));
    assert.equal((await payments(c.tenantId)).length, 2);
    const end2 = (await tenant(c.tenantId)).period_end;
    assert.ok(end2 > end1, "the next month's charge extends the period");
    assert.equal((await request(app).get("/api/billing").set(c.owner)).body.autopay.status, "active");

    const wrong = { ...charge1, id: "pay_auto_3", order_id: "order_auto_3", amount: 1000 };
    await hook(subEvent("subscription.charged", wrong));
    assert.equal((await orderRow("order_auto_3")).status, "mismatch");
    assert.equal((await payments(c.tenantId)).length, 2);

    const blocked = await checkout(c, { plan: "growth", interval: "monthly", confirm: true });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "autopay_active");

    await hook(subEvent("subscription.halted"));
    const halted = (await request(app).get("/api/billing").set(c.owner)).body.autopay;
    assert.deepEqual([halted.status, halted.needsAttention], ["halted", true]);
    assert.ok((await query("SELECT 1 FROM notifications WHERE tenant_id=$1 AND title LIKE 'Autopay has stopped%'", [c.tenantId])).rowCount >= 1);

    const off = await request(app).delete("/api/billing/autopay").set(c.owner);
    assert.equal(off.status, 200);
    assert.equal(fake.state.subscriptions.get(sub.id).status, "cancelled");
    assert.equal((await request(app).get("/api/billing").set(c.owner)).body.autopay, null);
    assert.equal((await tenant(c.tenantId)).plan, "Growth", "turning autopay off keeps the paid period");
    assert.equal((await request(app).delete("/api/billing/autopay").set(c.owner)).status, 404);
  });

  await t.test("paying for a different plan by hand stops the autopay for the old one", async () => {
    const c = await company("Free", UP);
    const start = await request(app).post("/api/billing/autopay").set(c.owner).send({ plan: "starter" });
    const subId = start.body.checkout.subscriptionId;
    const res = await checkout(c, { plan: "growth", interval: "monthly" });
    assert.equal(res.status, 201, "a different plan is allowed while autopay is only half set up");
    const p = fake.pay(res.body.checkout.orderId);
    await verify(c, res.body.checkout.orderId, p.id);
    assert.equal(fake.state.subscriptions.get(subId).status, "cancelled");
    assert.equal((await request(app).get("/api/billing").set(c.owner)).body.autopay, null);
  });

  await t.test("refunds are stored for the platform admin and do not remove access", async () => {
    const [p] = (await payments(first.tenantId)).slice(0, 1);
    const before = await tenant(first.tenantId);
    const res = await hook({ event: "refund.created", payload: { refund: { entity: { id: "rfnd_1", payment_id: firstPayment.id, amount: 100000, currency: "INR" } } } });
    assert.equal(res.status, 200);
    const seen = (await request(app).get("/api/admin/billing/payments").set(admin)).body;
    assert.deepEqual([seen.refunds[0].id, seen.refunds[0].amountMinor, seen.refunds[0].status], ["rfnd_1", 100000, "created"]);
    assert.equal((await tenant(first.tenantId)).plan, before.plan);
    assert.ok(p);
  });
});
