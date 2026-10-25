import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ensureSuperAdmin } from "../src/services/adminService.js";
import { generateAccessToken } from "../src/services/authService.js";
import { ENV } from "../src/config/env.js";
import { setMailTransport } from "../src/services/mailer.js";
import { closeSessions } from "../src/services/sessionService.js";
import { addCycle, daysBetween, subscriptionView, applyDueChanges, sendReminders } from "../src/services/subscriptionService.js";

const day = (offset, from = new Date().toISOString().slice(0, 10)) => {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const TODAY = day(0);

test("Billing periods: a month or a year later, on the same day where there is one", () => {
  assert.equal(addCycle("2026-10-25", "monthly"), "2026-11-25");
  assert.equal(addCycle("2026-12-15", "monthly"), "2027-01-15");
  assert.equal(addCycle("2026-01-31", "monthly"), "2026-02-28", "a short month ends on its last day");
  assert.equal(addCycle("2028-01-31", "monthly"), "2028-02-29", "including in a leap year");
  assert.equal(addCycle("2026-10-25", "annual"), "2027-10-25");
  assert.equal(addCycle("2028-02-29", "annual"), "2029-02-28");
  assert.equal(daysBetween("2026-10-25", "2026-11-25"), 31);
});

test("Where a company stands is worked out from its dates, never stored", () => {
  const t = (over) => ({ plan: "Growth", billing_cycle: "monthly", period_start: "2026-10-01", period_end: "2026-11-01", scheduled_plan: null, ...over });
  const status = (tenant, now = "2026-10-10") => subscriptionView(tenant, now).status;
  assert.equal(status(t({ plan: "Free", period_end: null })), "free");
  assert.equal(status(t({ plan: "Workspace", period_end: null })), "legacy");
  assert.equal(status(t({ period_end: null })), "unrecorded");
  assert.equal(status(t(), "2026-10-10"), "active", "22 days to go");
  assert.equal(status(t(), "2026-10-18"), "due_soon", "14 days to go is soon");
  assert.equal(status(t(), "2026-10-17"), "active", "15 days is not");
  assert.equal(status(t(), "2026-11-01"), "due_soon", "due today");
  assert.equal(status(t(), "2026-11-02"), "overdue");
  assert.equal(status(t(), "2026-11-08"), "overdue", "seven days late is still the grace period");
  assert.equal(status(t(), "2026-11-09"), "expired", "the eighth day late: paid features are off");
  assert.equal(status(t({ scheduled_plan: "free" }), "2026-10-10"), "cancelling");
  assert.equal(status(t({ scheduled_plan: "starter" }), "2026-10-10"), "changing");
  const overdue = subscriptionView(t(), "2026-11-04");
  assert.deepEqual([overdue.daysLeft, overdue.periodEnd, overdue.cycle], [-3, "2026-11-01", "monthly"]);
  const freeView = subscriptionView(t({ plan: "Free" }));
  assert.deepEqual([freeView.periodEnd, freeView.cycle, freeView.daysLeft], [null, null, null], "a free plan shows no billing, whatever is left in the row");
  // the database hands back a DATE as a Date at local midnight
  assert.equal(subscriptionView(t({ period_end: new Date(2026, 10, 1) }), "2026-10-10").periodEnd, "2026-11-01");
});

test("The platform admin records payments; renewals, changes and reminders follow", async (t) => {
  setMailTransport({ sendMail: async () => {} });
  t.after(async () => {
    setMailTransport(undefined);
    await closeSessions(io);
    io.close();
  });
  ENV.SUPERADMIN_EMAIL = "root@subscription.test";
  ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
  await ensureSuperAdmin();
  const sa = await request(app).post("/api/auth/login").send({ email: ENV.SUPERADMIN_EMAIL, password: ENV.SUPERADMIN_PASSWORD });
  assert.equal(sa.status, 200);
  const admin = { Authorization: `Bearer ${sa.body.token}` };

  let n = 0;
  const create = async (plan, extra = {}) => {
    n++;
    const res = await request(app).post("/api/admin/companies").set(admin).send({ companyName: `Sub Co ${n}`, ownerName: "Owner", ownerEmail: `owner${n}@subscription.test`, plan, ...extra });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const owner = (await query("SELECT id,email,name FROM users WHERE email=$1", [`owner${n}@subscription.test`])).rows[0];
    return { company: res.body.company, ownerId: owner.id, auth: { Authorization: `Bearer ${generateAccessToken(owner, res.body.company.id, "owner")}` } };
  };
  const pay = (id, body) => request(app).post(`/api/admin/companies/${id}/subscription/payment`).set(admin).send(body);
  const sub = async (id) => (await request(app).get("/api/admin/companies").set(admin)).body.companies.find((c) => c.id === id).subscription;
  const notices = async (tenantId) => (await query("SELECT * FROM notifications WHERE tenant_id=$1 AND type='subscription' ORDER BY created_at", [tenantId])).rows;

  await t.test("a paid plan starts with no payment on record, and the Free plan has nothing to pay", async () => {
    const growth = await create("Growth");
    assert.equal(growth.company.subscription.status, "unrecorded");
    const free = await create("Free");
    assert.equal(free.company.subscription.status, "free");
    assert.equal((await pay(free.company.id, { cycle: "monthly" })).status, 400, "no payment on the Free plan");
  });

  await t.test("recording a payment sets the period, keeps the history, and is on the audit log", async () => {
    const { company } = await create("Growth");
    const res = await pay(company.id, { cycle: "monthly", amount: 799, currency: "AED", reference: "INV-1042" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const s = res.body.company.subscription;
    assert.deepEqual([s.status, s.cycle, s.periodStart, s.periodEnd, s.planId], ["active", "monthly", TODAY, addCycle(TODAY, "monthly"), "growth"]);
    const payments = (await request(app).get(`/api/admin/companies/${company.id}/payments`).set(admin)).body.payments;
    assert.equal(payments.length, 1);
    assert.deepEqual([payments[0].plan, payments[0].amount, payments[0].currency, payments[0].reference], ["Growth", 799, "AED", "INV-1042"]);
    assert.equal(payments[0].recordedBy, "Platform Administrator");
    const event = (await query("SELECT metadata FROM audit_events WHERE tenant_id=$1 AND event_type='subscription.payment_recorded'", [company.id])).rows[0].metadata;
    assert.deepEqual([event.reference, event.periodEnd], ["INV-1042", addCycle(TODAY, "monthly")]);
  });

  await t.test("the next payment continues from where the last period ended, and can set the renewal date", async () => {
    const { company } = await create("Starter");
    await pay(company.id, { cycle: "monthly" });
    const first = (await sub(company.id)).periodEnd;
    const again = await pay(company.id, {});
    assert.equal(again.status, 201);
    const s = again.body.company.subscription;
    assert.deepEqual([s.periodStart, s.periodEnd], [first, addCycle(first, "monthly")], "the cycle is remembered and the period continues");
    const custom = await pay(company.id, { cycle: "annual", periodStart: "2026-01-01", periodEnd: "2026-12-31" });
    assert.deepEqual([custom.body.company.subscription.cycle, custom.body.company.subscription.periodEnd], ["annual", "2026-12-31"]);
    // a payment that comes long after the last period ended starts today, not back then
    await query("UPDATE tenants SET period_end=$2 WHERE id=$1", [company.id, day(-90)]);
    assert.equal((await pay(company.id, {})).body.company.subscription.periodStart, TODAY);
  });

  await t.test("payments are checked", async () => {
    const { company } = await create("Growth");
    const bad = [
      [{}, /monthly or annual/],
      [{ cycle: "weekly" }, /monthly or annual/],
      [{ cycle: "monthly", periodStart: "next week" }, /real date/],
      [{ cycle: "monthly", periodStart: "2026-02-30" }, /real date/],
      [{ cycle: "monthly", periodStart: "2026-05-01", periodEnd: "2026-05-01" }, /after the day/],
      [{ cycle: "monthly", periodStart: "2026-05-01", periodEnd: "2031-05-01" }, /three years/],
      [{ cycle: "monthly", amount: -5 }, /zero or more/],
      [{ cycle: "monthly", amount: "lots" }, /zero or more/],
      [{ cycle: "monthly", amount: 10, currency: "USD" }, /AED or INR/],
      [{ cycle: "monthly", plan: "Gold" }, /Choose a plan/],
      [{ cycle: "monthly", plan: "free" }, /no payment/],
    ];
    for (const [body, message] of bad) {
      const res = await pay(company.id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.message, message, JSON.stringify(body));
    }
    assert.equal((await pay("tenant_missing", { cycle: "monthly" })).status, 404);
    assert.equal((await sub(company.id)).status, "unrecorded", "nothing was recorded by any of them");
    assert.equal((await request(app).post(`/api/admin/companies/${company.id}/subscription/payment`).send({ cycle: "monthly" })).status, 401);
  });

  await t.test("paying for another plan moves the company to it, with that plan's number limit", async () => {
    const { company } = await create("Starter");
    await pay(company.id, { cycle: "monthly" });
    const res = await pay(company.id, { plan: "Business" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual([res.body.company.plan, res.body.company.sessionsLimit], ["Business", 25]);
    const enterprise = await pay(company.id, { plan: "Enterprise" });
    assert.equal(enterprise.status, 400, "Enterprise needs a number agreed");
    assert.match(enterprise.body.message, /custom number limit/);
    assert.equal((await pay(company.id, { plan: "Enterprise", sessionsLimit: 80 })).body.company.sessionsLimit, 80);
    await query("INSERT INTO tenants(id,name,slug,plan,sessions_limit) VALUES('tenant_old_sub','Old Co','old-co-sub','Workspace',5)");
    assert.match((await pay("tenant_old_sub", { cycle: "monthly" })).body.message, /Choose the plan this payment is for/);
    assert.equal((await pay("tenant_old_sub", { cycle: "monthly", plan: "Growth" })).body.company.plan, "Growth");
  });

  await t.test("a smaller plan, or Free, can be scheduled for the end of the period; a bigger one cannot", async () => {
    const { company } = await create("Business");
    const schedule = (plan) => request(app).post(`/api/admin/companies/${company.id}/subscription/schedule`).set(admin).send({ plan });
    assert.match((await schedule("Starter")).body.message, /Record a payment first/);
    await pay(company.id, { cycle: "monthly" });
    assert.match((await schedule("Business")).body.message, /smaller plan/);
    assert.match((await schedule("Enterprise")).body.message, /Enterprise is agreed/);
    assert.equal((await schedule("Gold")).status, 400);
    const ok = await schedule("Starter");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.company.subscription.status, ok.body.company.subscription.scheduledPlan.name], ["changing", "Starter"]);
    assert.equal(ok.body.company.plan, "Business", "nothing changes until the period ends");
    assert.equal((await schedule("Free")).body.company.subscription.status, "cancelling");
    const cleared = await request(app).delete(`/api/admin/companies/${company.id}/subscription/schedule`).set(admin);
    assert.equal(cleared.body.company.subscription.status, "active");
    assert.equal((await query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND event_type LIKE 'subscription.change_%'", [company.id])).rows[0].n, 3);
    // a payment for the next period takes the scheduled plan unless another is named
    await schedule("Growth");
    const renewed = await pay(company.id, {});
    assert.deepEqual([renewed.body.company.plan, renewed.body.company.subscription.scheduledPlan], ["Growth", null]);
    assert.equal(renewed.body.company.sessionsLimit, 10);
    // choosing a plan directly also replaces a waiting change
    await schedule("Starter");
    const direct = await request(app).patch(`/api/admin/companies/${company.id}`).set(admin).send({ plan: "Business" });
    assert.equal(direct.body.company.subscription.scheduledPlan, null);
  });

  await t.test("when the period ends, a scheduled change happens: Free for a cancellation, and nothing is removed", async () => {
    const cancel = await create("Growth");
    const down = await create("Business");
    for (const c of [cancel, down]) await pay(c.company.id, { cycle: "monthly", periodStart: day(-30), periodEnd: day(0) });
    for (const c of [cancel, down]) await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name) VALUES(gen_random_uuid()::text,$1,'a'),(gen_random_uuid()::text,$1,'b')", [c.company.id]);
    await request(app).post(`/api/admin/companies/${cancel.company.id}/subscription/schedule`).set(admin).send({ plan: "Free" });
    await request(app).post(`/api/admin/companies/${down.company.id}/subscription/schedule`).set(admin).send({ plan: "Starter" });

    assert.equal(await applyDueChanges(io, day(-1)), 0, "not before the day");
    assert.equal((await sub(cancel.company.id)).status, "cancelling");
    const applied = await applyDueChanges(io, TODAY);
    assert.ok(applied >= 2);
    assert.equal(await applyDueChanges(io, TODAY), 0, "once only");

    const c = (await query("SELECT plan,sessions_limit,billing_cycle,period_end,scheduled_plan FROM tenants WHERE id=$1", [cancel.company.id])).rows[0];
    assert.deepEqual(c, { plan: "Free", sessions_limit: 1, billing_cycle: null, period_end: null, scheduled_plan: null });
    const d = (await query("SELECT plan,sessions_limit,scheduled_plan FROM tenants WHERE id=$1", [down.company.id])).rows[0];
    assert.deepEqual(d, { plan: "Starter", sessions_limit: 3, scheduled_plan: null });
    assert.equal((await sub(down.company.id)).status, "due_soon", "the new plan is paid for by recording the next payment");
    for (const id of [cancel.company.id, down.company.id])
      assert.equal((await query("SELECT count(*)::int AS n FROM whatsapp_sessions WHERE tenant_id=$1", [id])).rows[0].n, 2, "the numbers it had are kept");
    assert.equal((await query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND event_type='subscription.change_applied' AND actor_id IS NULL", [cancel.company.id])).rows[0].n, 1);
    const told = await notices(cancel.company.id);
    assert.equal(told.length, 1);
    assert.match(told[0].title, /Your plan is now Free/);
    assert.equal(told[0].user_id, cancel.ownerId);
  });

  await t.test("owners and administrators are reminded once before the renewal and once when it is overdue; staff are not", async () => {
    const { company, ownerId } = await create("Growth");
    await pay(company.id, { cycle: "monthly", periodStart: day(-20), periodEnd: day(10) });
    const staff = (await query("INSERT INTO users(name,email,password_hash) VALUES('Sam','sam@subscription.test','x') RETURNING id")).rows[0].id;
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [company.id, staff]);
    const mine = async () => (await notices(company.id));

    await sendReminders(io, TODAY);
    let rows = await mine();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].user_id, rows[0].title], [ownerId, "Your Growth plan renews in 10 days"]);
    assert.match(rows[0].body, new RegExp(`${new Date(`${day(10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`));
    await sendReminders(io, day(1));
    assert.equal((await mine()).length, 1, "the same period is never reminded twice");

    await sendReminders(io, day(12));
    rows = await mine();
    assert.equal(rows.length, 2);
    assert.match(rows[1].title, /Payment for your Growth plan is overdue/);
    assert.match(rows[1].body, /Everything keeps working until/);
    await sendReminders(io, day(14));
    assert.equal((await mine()).length, 2, "overdue is said once");
    await sendReminders(io, day(20));
    rows = await mine();
    assert.equal(rows.length, 3, "and the switch-off is said once, when it happens");
    assert.match(rows[2].title, /Paid features are switched off for your Growth plan/);
    await sendReminders(io, day(25));
    assert.equal((await mine()).length, 3);
    assert.ok(rows.every((r) => r.user_id !== staff), "staff never see billing");

    // a payment starts a new period, which gets its own reminders
    await pay(company.id, { cycle: "monthly", periodStart: day(10), periodEnd: day(25) });
    await sendReminders(io, day(14));
    assert.equal((await mine()).length, 4);
  });

  await t.test("a cancelling company is told what happens, and a suspended one is left alone", async () => {
    const { company } = await create("Growth");
    await pay(company.id, { cycle: "monthly", periodStart: day(-25), periodEnd: day(5) });
    await request(app).post(`/api/admin/companies/${company.id}/subscription/schedule`).set(admin).send({ plan: "Free" });
    await sendReminders(io, TODAY);
    const rows = await notices(company.id);
    assert.equal(rows[0].title, "Your Growth plan ends in 5 days");
    assert.match(rows[0].body, /moves to the Free plan/);

    const quiet = await create("Growth");
    await pay(quiet.company.id, { cycle: "monthly", periodStart: day(-40), periodEnd: day(-10) });
    await request(app).patch(`/api/admin/companies/${quiet.company.id}`).set(admin).send({ status: "suspended" });
    await sendReminders(io, TODAY);
    assert.equal((await notices(quiet.company.id)).length, 0);
  });

  await t.test("owners see their renewal in the workspace; staff do not", async () => {
    const { company, auth } = await create("Growth");
    assert.equal((await request(app).get("/api/workspace/capabilities").set(auth)).body.subscription.status, "unrecorded");
    await pay(company.id, { cycle: "annual" });
    const owned = (await request(app).get("/api/workspace/capabilities").set(auth)).body.subscription;
    assert.deepEqual([owned.status, owned.cycle, owned.periodEnd, owned.plan], ["active", "annual", addCycle(TODAY, "annual"), "Growth"]);
    assert.equal(owned.amount, undefined, "what was paid is not shown to the company");
    const sam = (await query("INSERT INTO users(name,email,password_hash) VALUES('Tina','tina@subscription.test','x') RETURNING *")).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [company.id, sam.id]);
    const staff = { Authorization: `Bearer ${generateAccessToken(sam, company.id, "agent")}` };
    assert.equal((await request(app).get("/api/workspace/capabilities").set(staff)).body.subscription, undefined);
  });

  await t.test("moving a company to Free ends its billing; the companies list tells who is due", async () => {
    const { company } = await create("Growth");
    await pay(company.id, { cycle: "monthly" });
    const free = await request(app).patch(`/api/admin/companies/${company.id}`).set(admin).send({ plan: "Free" });
    assert.deepEqual([free.body.company.subscription.status, free.body.company.subscription.periodEnd], ["free", null]);
    assert.equal((await query("SELECT period_end FROM tenants WHERE id=$1", [company.id])).rows[0].period_end, null);
    const list = (await request(app).get("/api/admin/companies").set(admin)).body.companies;
    assert.ok(list.every((c) => c.subscription && typeof c.subscription.status === "string"));
  });
});
