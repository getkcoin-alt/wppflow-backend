import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ensureSuperAdmin } from "../src/services/adminService.js";
import { ENV } from "../src/config/env.js";
import { setMailTransport } from "../src/services/mailer.js";
import { closeSessions } from "../src/services/sessionService.js";
import { reconcileOrders } from "../src/services/billingService.js";
import { checkoutSignature, webhookSignature } from "../src/services/razorpay.js";
import { planOf } from "../src/services/plans.js";
import { startFakeRazorpay } from "./helpers/fakeRazorpay.js";

const WEBHOOK_SECRET = "whsec_test_only_not_real";
const UP = { addressLine1: "12 MG Road", city: "Lucknow", stateCode: "09", postalCode: "226001" };
const MH = { legalName: "Beta Retail LLP", addressLine1: "5 Marine Drive", city: "Mumbai", stateCode: "27", postalCode: "400001", gstin: "27AAPFU0939F1ZV" };

test("Buying from the website: pay first, and the workspace is made only when the payment is confirmed", async (t) => {
  const fake = await startFakeRazorpay();
  Object.assign(process.env, { RAZORPAY_KEY_ID: fake.keyId, RAZORPAY_KEY_SECRET: fake.keySecret, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, RAZORPAY_API_BASE: fake.base });
  const mails = [];
  setMailTransport({ sendMail: async (m) => void mails.push(m) });
  t.after(async () => {
    for (const k of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_API_BASE"]) delete process.env[k];
    setMailTransport(undefined);
    await fake.close();
    await closeSessions(io);
    io.close();
  });
  ENV.SUPERADMIN_EMAIL = "root@website.test";
  ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
  await ensureSuperAdmin();
  const sa = await request(app).post("/api/auth/login").send({ email: ENV.SUPERADMIN_EMAIL, password: ENV.SUPERADMIN_PASSWORD });
  const admin = { Authorization: `Bearer ${sa.body.token}` };

  // each call comes from its own visitor, so the per-visitor limit is only met where a test means to meet it
  let visitor = 0;
  const from = () => `203.0.113.${(++visitor % 250) + 1}`;
  const post = (path, body, ip = from()) => request(app).post(`/api/public/checkout/${path}`).set("X-Forwarded-For", ip).send(body);
  let n = 0;
  const buyer = (over = {}) => {
    n++;
    return { companyName: `Web Co ${n}`, ownerName: `Buyer ${n}`, ownerEmail: `Buyer${n}@Web.Test`, phone: "+91 98100 00000", plan: "growth", interval: "monthly", acceptedTerms: true, billing: { ...UP }, ...over };
  };
  const order = (over, ip) => post("order", buyer(over), ip);
  const tenantsFor = async (email) => (await query("SELECT t.* FROM tenants t JOIN memberships m ON m.tenant_id=t.id JOIN users u ON u.id=m.user_id WHERE lower(u.email)=lower($1)", [email])).rows;
  const orderRow = async (gatewayId) => (await query("SELECT * FROM payment_orders WHERE gateway_order_id=$1", [gatewayId])).rows[0];
  const counts = async () => ({
    tenants: (await query("SELECT count(*)::int n FROM tenants")).rows[0].n,
    users: (await query("SELECT count(*)::int n FROM users")).rows[0].n,
    invoices: (await query("SELECT count(*)::int n FROM invoices")).rows[0].n,
  });
  const verify = (o, payment, signature) =>
    post("verify", { razorpay_order_id: o.body.checkout.orderId, razorpay_payment_id: payment.id, razorpay_signature: signature ?? checkoutSignature(o.body.checkout.orderId, payment.id, fake.keySecret) });
  let eventN = 0;
  const hook = (event, secret = WEBHOOK_SECRET) => {
    const raw = JSON.stringify(event);
    return request(app).post("/api/billing/razorpay/webhook").set("Content-Type", "application/json").set("X-Razorpay-Signature", webhookSignature(raw, secret)).set("X-Razorpay-Event-Id", `evt_web_${++eventN}`).send(raw);
  };
  const captured = (payment) => ({ event: "payment.captured", payload: { payment: { entity: payment } } });

  await t.test("the page is told what can be bought, in rupees only, and whether buying is switched on", async () => {
    const res = await request(app).get("/api/public/checkout/options");
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.deepEqual(res.body.plans.map((p) => p.id), ["starter", "growth", "business"], "not Free, and not Enterprise (agreed with sales)");
    assert.ok(res.body.plans.every((p) => p.prices.length && p.prices.every((x) => x.currency === "INR")));
    assert.equal(res.body.gstRate, 18);
    assert.ok(res.body.states.some((s) => s.code === "09" && s.name === "Uttar Pradesh"));
    assert.ok(!JSON.stringify(res.body).includes(fake.keySecret) && !JSON.stringify(res.body).includes(fake.keyId), "no key at all until an order is made");
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    assert.equal((await request(app).get("/api/public/checkout/options")).body.enabled, false, "off without the keys");
    assert.equal((await order()).status, 503);
    process.env.RAZORPAY_WEBHOOK_SECRET = saved;
    setMailTransport(undefined);
    const savedKey = ENV.RESEND_API_KEY;
    ENV.RESEND_API_KEY = "";
    assert.equal((await request(app).get("/api/public/checkout/options")).body.enabled, false, "and off while the owner could not be emailed");
    ENV.RESEND_API_KEY = savedKey;
    setMailTransport({ sendMail: async (m) => void mails.push(m) });
    assert.equal((await request(app).get("/api/public/checkout/options")).body.enabled, true);
  });

  await t.test("the price and the tax are worked out on the server for the buyer's state", async () => {
    const up = (await post("quote", { plan: "growth", interval: "monthly", stateCode: "09" })).body.quote;
    assert.deepEqual([up.baseMinor, up.cgstMinor, up.sgstMinor, up.igstMinor, up.totalMinor, up.kind], [699900, 62991, 62991, 0, 825882, "new"]);
    const mh = (await post("quote", { plan: "growth", interval: "monthly", stateCode: "27" })).body.quote;
    assert.deepEqual([mh.cgstMinor, mh.sgstMinor, mh.igstMinor, mh.totalMinor], [0, 0, 125982, 825882]);
    assert.equal((await post("quote", { plan: "growth", interval: "annual", stateCode: "09" })).body.quote.baseMinor, 6999000, "a year is ten months");
    assert.equal((await post("quote", { plan: "growth", interval: "monthly", stateCode: "55" })).status, 400);
    assert.equal((await post("quote", { plan: "free", interval: "monthly", stateCode: "09" })).status, 400);
    assert.match((await post("quote", { plan: "enterprise", interval: "monthly", stateCode: "09" })).body.message, /no online price/);
    assert.equal((await post("quote", { plan: "growth", interval: "weekly", stateCode: "09" })).status, 400);
  });

  await t.test("what is wrong with an order is said, and nothing is made", async () => {
    const before = await counts();
    const bad = async (over, pattern) => {
      const res = await order(over);
      assert.equal(res.status, 400, JSON.stringify(over));
      assert.match(res.body.message, pattern);
    };
    await bad({ acceptedTerms: false }, /accept the Terms/);
    await bad({ acceptedTerms: "yes" }, /accept the Terms/);
    await bad({ companyName: "" }, /Company name is required/);
    await bad({ ownerName: " " }, /Your name is required/);
    await bad({ ownerEmail: "nobody" }, /valid email/);
    await bad({ phone: "call me" }, /phone number/);
    await bad({ billing: { ...UP, postalCode: "12" } }, /6 digit PIN/);
    await bad({ billing: { ...UP, stateCode: "55" } }, /state/i);
    await bad({ billing: { ...UP, addressLine1: "" } }, /Address is required/);
    await bad({ billing: { ...UP, gstin: "27AAPFU0939F1ZV" } }, /starts with 27/);
    await bad({ billing: { ...UP, gstin: "27AAPFU0939F1ZX" } }, /GSTIN/);
    await bad({ plan: "free" }, /no online price/);
    await bad({ plan: "nonsense" }, /Choose a plan/);
    await bad({ interval: "weekly" }, /monthly or yearly/);
    await bad({ website: "http://spam.test" }, /could not start/);
    assert.deepEqual(await counts(), before);
    assert.equal((await query("SELECT count(*)::int n FROM payment_orders WHERE source='website'")).rows[0].n, 0, "no order, so no unpaid rows");
    assert.equal(fake.state.orders.size, 0, "and Razorpay was never asked for one");
  });

  let first, firstPay;
  await t.test("an order is for the price the server worked out, and nothing exists for the buyer yet", async () => {
    const before = await counts();
    first = await order({ companyName: "Web Co 1", ownerName: "Buyer 1", ownerEmail: "Buyer1@Web.Test", amount: 1, total: 1, price: 1 });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.checkout.amount, 825882, "the browser cannot name a price");
    assert.equal(first.body.checkout.currency, "INR");
    assert.equal(first.body.checkout.key, fake.keyId);
    assert.ok(!JSON.stringify(first.body).includes(fake.keySecret) && !JSON.stringify(first.body).includes(WEBHOOK_SECRET));
    assert.deepEqual(first.body.checkout.prefill, { name: "Buyer 1", email: "buyer1@web.test", contact: "+91 98100 00000" });
    const made = fake.state.orders.get(first.body.checkout.orderId);
    assert.deepEqual([made.amount, made.currency, made.notes.kind, made.notes.plan], [825882, "INR", "website", "growth"]);
    const row = await orderRow(first.body.checkout.orderId);
    assert.deepEqual([row.source, row.tenant_id, row.status, row.guest_email, row.plan_code], ["website", null, "created", "buyer1@web.test", "growth"]);
    assert.equal(row.guest.companyName, "Web Co 1");
    assert.ok(row.guest.acceptedTermsAt, "that the terms were accepted is recorded");
    assert.deepEqual(await counts(), before, "no company, no user and no invoice until the money is confirmed");
    assert.equal(mails.length, 0, "and nothing is emailed to an address nobody has paid for");
    assert.deepEqual(await tenantsFor("buyer1@web.test"), []);
  });

  await t.test("trying again reuses the unpaid order and keeps the latest details", async () => {
    const again = await order({ companyName: "Web Co 1 Renamed", ownerName: "Buyer 1", ownerEmail: "buyer1@web.test" });
    assert.equal(again.body.checkout.orderId, first.body.checkout.orderId);
    assert.equal(again.body.orderRef, first.body.orderRef);
    assert.equal(fake.state.orders.size, 1);
    assert.equal((await orderRow(first.body.checkout.orderId)).guest.companyName, "Web Co 1 Renamed");
  });

  await t.test("an email that already has an account is turned away before any money is taken", async () => {
    const before = fake.state.orders.size;
    const res = await order({ ownerEmail: ENV.SUPERADMIN_EMAIL });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "account_exists");
    assert.match(res.body.message, /Sign in/);
    assert.equal(fake.state.orders.size, before);
  });

  await t.test("a payment reported with a wrong signature sets nothing up", async () => {
    firstPay = fake.pay(first.body.checkout.orderId);
    const before = await counts();
    assert.equal((await verify(first, firstPay, "0".repeat(64))).status, 400);
    assert.equal((await verify(first, firstPay, checkoutSignature("order_other", firstPay.id, fake.keySecret))).status, 400);
    assert.equal((await post("verify", { razorpay_order_id: "order_unknown", razorpay_payment_id: firstPay.id, razorpay_signature: "x" })).status, 404);
    assert.equal((await post("verify", { razorpay_order_id: first.body.checkout.orderId })).status, 400);
    assert.deepEqual(await counts(), before);
    assert.equal((await orderRow(first.body.checkout.orderId)).tenant_id, null);
  });

  let workspace;
  await t.test("a confirmed payment makes the company, its owner, the billing details, the invoice and the emails, once", async () => {
    const res = await verify(first, firstPay);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "paid");
    const [tenant] = await tenantsFor("buyer1@web.test");
    workspace = tenant;
    assert.deepEqual([tenant.name, tenant.plan, tenant.sessions_limit, tenant.billing_cycle], ["Web Co 1 Renamed", "Growth", 10, "monthly"]);
    assert.ok(tenant.period_start && tenant.period_end);
    const owner = (await query("SELECT u.*,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=$1", [tenant.id])).rows;
    assert.deepEqual(owner.map((o) => [o.email, o.role, o.must_change_password]), [["buyer1@web.test", "owner", true]], "an owner who has not chosen a password yet");

    const profile = (await query("SELECT * FROM billing_profiles WHERE tenant_id=$1", [tenant.id])).rows[0];
    assert.deepEqual([profile.legal_name, profile.city, profile.state_code, profile.billing_email], ["Web Co 1 Renamed", "Lucknow", "09", "buyer1@web.test"]);

    const inv = (await query("SELECT * FROM invoices WHERE tenant_id=$1", [tenant.id])).rows;
    assert.equal(inv.length, 1);
    assert.match(inv[0].number, /^SCZ\/\d{2}-\d{2}\/\d{5}$/);
    assert.deepEqual([Number(inv[0].total_minor), Number(inv[0].cgst_minor), Number(inv[0].sgst_minor), Number(inv[0].igst_minor)], [825882, 62991, 62991, 0]);
    assert.equal(inv[0].buyer.legalName, "Web Co 1 Renamed");
    assert.equal(inv[0].buyer.state, "Uttar Pradesh");

    const row = await orderRow(first.body.checkout.orderId);
    assert.deepEqual([row.status, row.tenant_id, row.invoice_id], ["paid", tenant.id, inv[0].id]);
    assert.equal((await query("SELECT tenant_id FROM payments WHERE gateway_payment_id=$1", [firstPay.id])).rows[0].tenant_id, tenant.id, "the payment record follows the company");
    assert.equal((await query("SELECT count(*)::int n FROM subscription_payments WHERE tenant_id=$1", [tenant.id])).rows[0].n, 1);
    assert.equal((await query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND event_type='company.bought_online'", [tenant.id])).rows[0].n, 1);

    const setup = mails.find((m) => /Set up Web Co 1 Renamed on Scriwo/.test(m.subject));
    assert.equal(setup.to, "buyer1@web.test");
    assert.match(setup.text, /invite=[a-f0-9]+/);
    const receipt = mails.find((m) => /Your Scriwo receipt/.test(m.subject));
    assert.equal(receipt.to, "buyer1@web.test");
    assert.match(receipt.text, /Growth plan/);
    assert.match(receipt.text, /₹8,258\.82/);
    assert.ok(receipt.text.includes(inv[0].number));
    assert.equal(mails.length, 2);

    const note = (await query("SELECT title FROM notifications WHERE tenant_id=$1 AND type='subscription'", [tenant.id])).rows;
    assert.deepEqual(note.map((x) => x.title), ["Payment received: ₹8,258.82"]);
  });

  await t.test("the buyer follows the emailed link, chooses a password and is in their own company", async () => {
    const setup = mails.find((m) => /Set up Web Co 1 Renamed on Scriwo/.test(m.subject));
    const token = /invite=([a-f0-9]+)/.exec(setup.text)[1];
    const info = await request(app).get("/api/auth/invite-info").query({ token });
    assert.deepEqual([info.body.email, info.body.company, info.body.setPassword], ["buyer1@web.test", "Web Co 1 Renamed", true]);
    assert.equal((await request(app).post("/api/auth/accept-invite").send({ token, password: "Buyer-chosen-pass-1" })).status, 200);
    const login = await request(app).post("/api/auth/login").send({ email: "buyer1@web.test", password: "Buyer-chosen-pass-1" });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.membershipRole, "owner");
    const caps = await request(app).get("/api/workspace/capabilities").set({ Authorization: `Bearer ${login.body.token}`, "X-Tenant-Id": workspace.id });
    assert.equal(caps.body.plan.name, "Growth");
    assert.equal(caps.body.plan.features.broadcasts, true, "the plan they bought is on, straight away");
    assert.equal(caps.body.plan.features.api, false);
  });

  await t.test("the success page can ask how it went, with the token it was given and nobody else's", async () => {
    const ok = await request(app).get("/api/public/checkout/status").query({ order: first.body.orderRef, token: first.body.statusToken });
    assert.deepEqual([ok.body.status, ok.body.company, ok.body.email, ok.body.plan], ["paid", "Web Co 1 Renamed", "b***@web.test", "Growth"]);
    assert.equal(ok.headers["cache-control"], "no-store");
    assert.equal((await request(app).get("/api/public/checkout/status").query({ order: first.body.orderRef, token: "0".repeat(32) })).status, 404);
    assert.equal((await request(app).get("/api/public/checkout/status").query({ order: first.body.orderRef })).status, 404);
    const other = await order();
    assert.equal((await request(app).get("/api/public/checkout/status").query({ order: first.body.orderRef, token: other.body.statusToken })).status, 404, "another order's token does not open this one");
    const waiting = await request(app).get("/api/public/checkout/status").query({ order: other.body.orderRef, token: other.body.statusToken });
    assert.equal(waiting.body.status, "processing");
  });

  await t.test("the same payment reported again, by the browser or the webhook, changes nothing", async () => {
    const before = await counts();
    const mailsBefore = mails.length;
    assert.equal((await verify(first, firstPay)).body.status, "paid");
    const h1 = await hook(captured(firstPay));
    assert.equal(h1.status, 200);
    assert.equal((await hook(captured(firstPay))).status, 200);
    assert.deepEqual(await counts(), before);
    assert.equal(mails.length, mailsBefore, "nothing is emailed twice");
    assert.equal((await query("SELECT count(*)::int n FROM payments WHERE gateway_payment_id=$1", [firstPay.id])).rows[0].n, 1);
  });

  await t.test("if the webhook arrives first, the company is made then, and the browser finds it done", async () => {
    const o = await order({ billing: MH, interval: "annual", plan: "business", ownerEmail: "hook@web.test" });
    assert.equal(o.body.checkout.amount, Math.round(14999000 * 1.18), "yearly business, IGST for Maharashtra");
    const pay = fake.pay(o.body.checkout.orderId);
    assert.equal((await hook(captured(pay))).status, 200);
    const [tenant] = await tenantsFor("hook@web.test");
    assert.deepEqual([tenant.plan, tenant.sessions_limit, tenant.billing_cycle], ["Business", 25, "annual"]);
    const inv = (await query("SELECT * FROM invoices WHERE tenant_id=$1", [tenant.id])).rows[0];
    assert.deepEqual([Number(inv.cgst_minor), Number(inv.sgst_minor), Number(inv.igst_minor)], [0, 0, 2699820], "IGST outside Uttar Pradesh");
    assert.equal(inv.buyer.gstin, "27AAPFU0939F1ZV");
    const mailsBefore = mails.length;
    assert.equal((await verify(o, pay)).body.status, "paid");
    assert.equal(mails.length, mailsBefore);
    assert.equal((await tenantsFor("hook@web.test")).length, 1);
  });

  await t.test("a buyer who closed the tab and a webhook that never came are caught by the reconciliation job", async () => {
    const o = await order({ ownerEmail: "lost@web.test" });
    fake.pay(o.body.checkout.orderId);
    assert.deepEqual(await tenantsFor("lost@web.test"), []);
    await query("UPDATE payment_orders SET created_at=now()-interval '20 minutes' WHERE gateway_order_id=$1", [o.body.checkout.orderId]);
    assert.ok((await reconcileOrders({ io })) >= 1);
    const [tenant] = await tenantsFor("lost@web.test");
    assert.equal(tenant.plan, "Growth");
    assert.ok(mails.some((m) => m.to === "lost@web.test" && /Set up/.test(m.subject)));
  });

  await t.test("a payment for a different amount sets nothing up, and shows to the platform admin under the buyer's name", async () => {
    const before = await counts();
    const o = await order({ companyName: "Cheat Co", ownerEmail: "cheat@web.test" });
    const pay = fake.pay(o.body.checkout.orderId, { amount: 100 });
    assert.equal((await hook(captured(pay))).status, 200);
    assert.deepEqual(await counts(), before);
    const row = await orderRow(o.body.checkout.orderId);
    assert.equal(row.status, "mismatch");
    assert.match(row.failure_reason, /amount 100 instead of 825882/);
    assert.equal(row.tenant_id, null);
    const list = (await request(app).get("/api/admin/billing/payments").set(admin)).body;
    const seen = list.orders.find((x) => x.id === row.id);
    assert.deepEqual([seen.company, seen.status, seen.companyId], ["Cheat Co", "mismatch", null]);
    assert.ok(list.counts.mismatch >= 1);
    const audit = (await request(app).get("/api/admin/billing/audit").set(admin)).body.audit;
    assert.ok(audit.exceptions.amountMismatch.some((x) => x.orderId === row.id && x.company === "Cheat Co" && x.companyId === null));
    assert.equal((await tenantsFor("cheat@web.test")).length, 0);
    const status = await request(app).get("/api/public/checkout/status").query({ order: o.body.orderRef, token: o.body.statusToken });
    assert.equal(status.body.status, "review", "the buyer is told a person is looking, not that it worked");
  });

  await t.test("if the email got an account while the buyer was paying, the money is flagged and no second company is made", async () => {
    const o = await order({ ownerEmail: "race@web.test", companyName: "Race Co" });
    await query("INSERT INTO users(name,email,password_hash) VALUES('Someone','race@web.test','x')");
    const before = await counts();
    const pay = fake.pay(o.body.checkout.orderId);
    assert.equal((await verify(o, pay)).body.status, "review");
    assert.deepEqual(await counts(), before);
    const row = await orderRow(o.body.checkout.orderId);
    assert.equal(row.status, "mismatch");
    assert.match(row.failure_reason, /received but race@web\.test has a Scriwo account already/);
    assert.equal((await tenantsFor("race@web.test")).length, 0, "no company was attached to the stranger's account");
    assert.ok(!mails.some((m) => m.to === "race@web.test"), "and nothing was emailed to them");
  });

  await t.test("a payment that failed sets nothing up", async () => {
    const before = await counts();
    const o = await order({ ownerEmail: "declined@web.test" });
    const pay = fake.pay(o.body.checkout.orderId, { status: "failed", error_description: "Card declined" });
    assert.equal((await hook({ event: "payment.failed", payload: { payment: { entity: pay } } })).status, 200);
    assert.deepEqual(await counts(), before);
    assert.equal((await orderRow(o.body.checkout.orderId)).status, "failed");
    const status = await request(app).get("/api/public/checkout/status").query({ order: o.body.orderRef, token: o.body.statusToken });
    assert.deepEqual([status.body.status, status.body.reason], ["failed", "Card declined"]);
  });

  await t.test("if Razorpay cannot be reached, nothing is taken and the buyer is told so", async () => {
    fake.state.failNext = { status: 500, message: "Razorpay is down" };
    const res = await order({ ownerEmail: "down@web.test" });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, "gateway_unavailable");
    assert.match(res.body.message, /you have not been charged/);
    assert.equal((await query("SELECT status FROM payment_orders WHERE guest_email='down@web.test'")).rows[0].status, "failed");
  });

  await t.test("a visitor can only start so many orders in a short time", async () => {
    const ip = "198.51.100.77";
    const statuses = [];
    for (let i = 0; i < 14; i++) statuses.push((await order({ ownerEmail: `spam${i}@web.test` }, ip)).status);
    assert.equal(statuses.filter((s) => s === 201).length, 12);
    assert.deepEqual(statuses.slice(12), [429, 429]);
    assert.equal((await order({ ownerEmail: "fine@web.test" })).status, 201, "another visitor is not affected");
  });

  await t.test("a plan that was renamed is still the plan a company has, and two plans cannot share a name", async () => {
    const rename = (code, name) => request(app).put(`/api/admin/plans/${code}`).set(admin).send({ name });
    assert.equal((await rename("starter", "Growth Plus")).status, 200);
    assert.equal((await rename("growth", "growth plus")).status, 400, "another plan is already called that");
    assert.equal((await rename("growth", "Pro")).status, 200);
    assert.equal((await rename("business", "growth")).status, 400, "a name that is another plan's code is refused too");
    // companies hold the plan by name: the old name and the new one both find it
    assert.equal(planOf("Growth Plus").id, "starter");
    assert.equal(planOf("starter").id, "starter");
    assert.equal(planOf("Growth").id, "growth", "the code still finds the plan whatever it is called now");
    // and a purchase of a renamed plan is a restricted plan, not an unrestricted legacy one
    const o = await order({ plan: "starter", ownerEmail: "renamed@web.test" });
    assert.equal((await verify(o, fake.pay(o.body.checkout.orderId))).body.status, "paid");
    const [tenant] = await tenantsFor("renamed@web.test");
    assert.equal(tenant.plan, "Growth Plus");
    const owner = (await query("SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=$1", [tenant.id])).rows[0];
    const { generateAccessToken } = await import("../src/services/authService.js");
    const caps = await request(app).get("/api/workspace/capabilities").set({ Authorization: `Bearer ${generateAccessToken(owner, tenant.id, "owner")}` });
    assert.equal(caps.body.plan.restricted, true);
    assert.equal(caps.body.plan.features.broadcasts, false, "Starter has no broadcasts: it is not treated as an unrestricted plan");
    await rename("growth", "Growth");
    await rename("starter", "Starter");
  });
});
