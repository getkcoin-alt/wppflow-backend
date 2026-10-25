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
import { loadPlans, priceOf, planOf } from "../src/services/plans.js";

const day = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

test("The plans and their prices come from the database; a company that pays late loses the paid features after seven days", async (t) => {
  setMailTransport({ sendMail: async () => {} });
  t.after(async () => {
    setMailTransport(undefined);
    await closeSessions(io);
    io.close();
  });
  ENV.SUPERADMIN_EMAIL = "root@catalogue.test";
  ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
  await ensureSuperAdmin();
  const sa = await request(app).post("/api/auth/login").send({ email: ENV.SUPERADMIN_EMAIL, password: ENV.SUPERADMIN_PASSWORD });
  const admin = { Authorization: `Bearer ${sa.body.token}` };
  let n = 0;
  const create = async (plan) => {
    n++;
    const res = await request(app).post("/api/admin/companies").set(admin).send({ companyName: `Cat Co ${n}`, ownerName: "Owner", ownerEmail: `owner${n}@catalogue.test`, plan });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const owner = (await query("SELECT id,email,name FROM users WHERE email=$1", [`owner${n}@catalogue.test`])).rows[0];
    return { company: res.body.company, auth: { Authorization: `Bearer ${generateAccessToken(owner, res.body.company.id, "owner")}` } };
  };
  const pay = (id, body) => request(app).post(`/api/admin/companies/${id}/subscription/payment`).set(admin).send(body);
  const status = (auth, path) => request(app).get(path).set(auth).then((r) => r.status);

  await t.test("anyone can read the plans for sale and their prices, in rupees and dirhams, monthly and yearly", async () => {
    const res = await request(app).get("/api/public/plans");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.plans.map((p) => p.id), ["free", "starter", "growth", "business", "enterprise"]);
    const price = (id, interval, currency) => res.body.plans.find((p) => p.id === id).prices.find((x) => x.interval === interval && x.currency === currency)?.amountMinor;
    assert.equal(price("starter", "monthly", "INR"), 249900);
    assert.equal(price("growth", "monthly", "INR"), 699900);
    assert.equal(price("business", "monthly", "AED"), 169900);
    for (const id of ["starter", "growth", "business"])
      for (const currency of ["INR", "AED"])
        assert.equal(price(id, "annual", currency), price(id, "monthly", currency) * 10, `a year costs ten months: ${id} ${currency}`);
    assert.deepEqual(res.body.plans.find((p) => p.id === "free").prices, []);
    assert.deepEqual(res.body.plans.find((p) => p.id === "enterprise").prices, [], "Enterprise is quoted");
    assert.equal(priceOf("growth", "annual", "INR"), 6999000, "the server's checkout reads the same table");
  });

  await t.test("only the platform admin can change a plan, and every change is recorded", async () => {
    assert.equal((await request(app).put("/api/admin/plans/growth").send({ name: "Growth" })).status, 401);
    const { auth } = await create("Starter");
    assert.equal((await request(app).put("/api/admin/plans/growth").set(auth).send({ name: "Hacked" })).status, 403);
    const res = await request(app).put("/api/admin/plans/starter").set(admin).send({
      prices: [
        { interval: "monthly", currency: "INR", amountMinor: 259900 },
        { interval: "annual", currency: "INR", amountMinor: 2599000 },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const pub = (await request(app).get("/api/public/plans")).body.plans.find((p) => p.id === "starter");
    assert.deepEqual(pub.prices.map((p) => [p.interval, p.currency, p.amountMinor]), [["annual", "INR", 2599000], ["monthly", "INR", 259900]].sort((a, b) => 0).map((x) => x), "the AED prices were removed because the list replaces them");
    const change = (await query("SELECT before,after,actor_id FROM plan_changes WHERE plan_code='starter' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(change.before.prices.length, 4);
    assert.equal(change.after.prices.length, 2);
    assert.ok(change.actor_id);
    // put them back
    await request(app).put("/api/admin/plans/starter").set(admin).send({
      prices: [
        { interval: "monthly", currency: "INR", amountMinor: 249900 }, { interval: "annual", currency: "INR", amountMinor: 2499000 },
        { interval: "monthly", currency: "AED", amountMinor: 29900 }, { interval: "annual", currency: "AED", amountMinor: 299000 },
      ],
    });
  });

  await t.test("a plan change is checked", async () => {
    const put = (code, body) => request(app).put(`/api/admin/plans/${code}`).set(admin).send(body);
    assert.equal((await put("platinum", { name: "x" })).status, 404);
    for (const [body, message] of [
      [{ name: "" }, /needs a name/],
      [{ numbers: 0 }, /WhatsApp numbers/],
      [{ seats: "many" }, /People/],
      [{ features: ["broadcasts", "magic"] }, /Features must be/],
      [{ features: "all" }, /Features must be/],
      [{ prices: [{ interval: "weekly", currency: "INR", amountMinor: 1 }] }, /monthly or annual/],
      [{ prices: [{ interval: "monthly", currency: "USD", amountMinor: 1 }] }, /INR or AED/],
      [{ prices: [{ interval: "monthly", currency: "INR", amountMinor: -1 }] }, /A price/],
      [{ prices: [{ interval: "monthly", currency: "INR", amountMinor: 1 }, { interval: "monthly", currency: "INR", amountMinor: 2 }] }, /two monthly INR/],
      [{ isActive: "no" }, /true or false/],
      [{ trialDays: 400 }, /Trial days/],
    ]) {
      const res = await put("growth", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.message, message, JSON.stringify(body));
    }
    assert.match((await put("free", { isActive: false })).body.message, /Free plan can't be taken off sale/);
    assert.match((await put("free", { prices: [{ interval: "monthly", currency: "INR", amountMinor: 100 }] })).body.message, /no price/);
    assert.equal(planOf("growth").name, "Growth", "nothing changed");
  });

  await t.test("changing what a plan includes changes what its companies can use, at once", async () => {
    const { auth } = await create("Growth");
    assert.equal(await status(auth, "/api/campaigns"), 200);
    const off = await request(app).put("/api/admin/plans/growth").set(admin).send({ features: ["automations", "leads", "audit", "ai"] });
    assert.equal(off.status, 200);
    assert.equal(await status(auth, "/api/campaigns"), 403, "broadcasts are no longer in Growth");
    assert.equal(await status(auth, "/api/automations"), 200);
    const caps = (await request(app).get("/api/workspace/capabilities").set(auth)).body;
    assert.equal(caps.plan.features.broadcasts, false);
    await request(app).put("/api/admin/plans/growth").set(admin).send({ features: ["broadcasts", "automations", "leads", "audit", "ai"] });
    assert.equal(await status(auth, "/api/campaigns"), 200);
  });

  await t.test("a plan taken off sale cannot be chosen for a new company, and the companies on it keep it", async () => {
    const { company, auth } = await create("Business");
    await request(app).put("/api/admin/plans/business").set(admin).send({ isActive: false });
    assert.ok(!(await request(app).get("/api/public/plans")).body.plans.some((p) => p.id === "business"));
    const refused = await request(app).post("/api/admin/companies").set(admin).send({ companyName: "Late Co", ownerName: "O", ownerEmail: "late@catalogue.test", plan: "Business" });
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /Choose a plan: Free, Starter, Growth, Enterprise/);
    assert.equal(await status(auth, "/api/workspace/keys"), 200, "the company already on it keeps its features");
    assert.equal((await request(app).get("/api/admin/plans").set(admin)).body.plans.find((p) => p.id === "business").isActive, false, "the admin still sees it, to put it back");
    await request(app).put("/api/admin/plans/business").set(admin).send({ isActive: true });
    assert.ok((await request(app).get("/api/public/plans")).body.plans.some((p) => p.id === "business"));
    assert.ok(company);
  });

  await t.test("a late payment keeps everything for seven days, then switches the paid features off, and a payment brings them back", async () => {
    const { company, auth } = await create("Growth");
    const renewal = (d) => pay(company.id, { cycle: "monthly", periodStart: day(d - 30), periodEnd: day(d) });
    assert.equal((await renewal(-3)).status, 201);
    assert.equal(await status(auth, "/api/campaigns"), 200, "three days late: still the grace period");
    assert.equal((await request(app).get("/api/admin/companies").set(admin)).body.companies.find((c) => c.id === company.id).subscription.status, "overdue");

    await renewal(-7);
    assert.equal(await status(auth, "/api/campaigns"), 200, "seven days late is still inside it");
    await renewal(-8);
    const sub = (await request(app).get("/api/admin/companies").set(admin)).body.companies.find((c) => c.id === company.id).subscription;
    assert.deepEqual([sub.status, sub.lapsed], ["expired", true]);

    const blocked = await request(app).get("/api/campaigns").set(auth);
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.message, /switched off because payment for your Growth plan is overdue.*Nothing has been deleted/);
    for (const path of ["/api/automations", "/api/leads/board", "/api/workspace/audit", "/api/workspace/keys"]) assert.equal(await status(auth, path), 403, path);
    assert.equal(await status(auth, "/api/conversations"), 200, "the inbox keeps working");
    assert.equal(await status(auth, "/api/contacts"), 200, "and so do the contacts");
    const key = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-not-used";
    const caps = (await request(app).get("/api/workspace/capabilities").set(auth)).body;
    key === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = key);
    assert.deepEqual([caps.plan.name, caps.plan.lapsed, caps.plan.features.broadcasts, caps.ai.available, caps.ai.reason], ["Growth", true, false, false, "plan"]);

    // no new number, and no new person
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name) VALUES(gen_random_uuid()::text,$1,'kept')", [company.id]);
    const number = await request(app).post("/api/sessions/start").set(auth).send({ sessionName: "another" });
    assert.equal(number.status, 403);
    assert.match(number.body.message, /overdue, so no new number/);
    const invite = await request(app).post("/api/auth/users").set(auth).send({ name: "Sam", email: "sam@catalogue.test", role: "agent" });
    assert.equal(invite.status, 403);
    assert.match(invite.body.message, /overdue, so no new people/);
    assert.equal((await query("SELECT count(*)::int AS n FROM whatsapp_sessions WHERE tenant_id=$1", [company.id])).rows[0].n, 1, "what they had is kept");

    // one payment brings everything back at once
    assert.equal((await renewal(20)).status, 201);
    assert.equal(await status(auth, "/api/campaigns"), 200);
    assert.equal((await request(app).get("/api/workspace/capabilities").set(auth)).body.plan.lapsed, false);
  });

  await t.test("companies that never recorded a period, the Free plan, a waiting change and the old Workspace plan never lapse", async () => {
    const unrecorded = await create("Growth");
    assert.equal(await status(unrecorded.auth, "/api/campaigns"), 200, "no period recorded: nothing to be late for");
    const scheduled = await create("Business");
    await pay(scheduled.company.id, { cycle: "monthly", periodStart: day(-60), periodEnd: day(-30) });
    await request(app).post(`/api/admin/companies/${scheduled.company.id}/subscription/schedule`).set(admin).send({ plan: "Starter" });
    assert.equal(await status(scheduled.auth, "/api/workspace/keys"), 200, "a change waiting to be applied is not a lapse");
    await query("INSERT INTO tenants(id,name,slug,plan,sessions_limit,period_end) VALUES('tenant_old_cat','Old Co','old-co-cat','Workspace',5,$1)", [day(-100)]);
    const owner = (await query("INSERT INTO users(email,password_hash,name,status) VALUES('old@catalogue.test','x','Old','active') RETURNING id,email,name")).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES('tenant_old_cat',$1,'owner')", [owner.id]);
    const old = { Authorization: `Bearer ${generateAccessToken(owner, "tenant_old_cat", "owner")}` };
    assert.equal(await status(old, "/api/workspace/keys"), 200);
  });

  await t.test("a payment recorded with a date that has already passed is flagged to the admin", async () => {
    const { company } = await create("Growth");
    const res = await pay(company.id, { cycle: "monthly", periodStart: day(-60), periodEnd: day(-20) });
    assert.equal(res.status, 201);
    assert.match(res.body.warnings.join(" "), /already passed.*expired and its paid features stay off/);
    const late = await pay(company.id, { cycle: "monthly", periodStart: day(-30), periodEnd: day(-3) });
    assert.match(late.body.warnings.join(" "), /already passed.*late/);
    assert.deepEqual((await pay(company.id, { cycle: "monthly" })).body.warnings, []);
  });

  await t.test("what is in memory follows the database", async () => {
    await query("UPDATE plans SET name='Growth Plus' WHERE code='growth'");
    assert.equal(planOf("growth").name, "Growth", "until the plans are read again");
    await loadPlans();
    assert.equal(planOf("growth").name, "Growth Plus");
    await query("UPDATE plans SET name='Growth' WHERE code='growth'");
    await loadPlans();
  });
});
