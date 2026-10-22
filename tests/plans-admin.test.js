import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ensureSuperAdmin } from "../src/services/adminService.js";
import { generateAccessToken } from "../src/services/authService.js";
import { ENV } from "../src/config/env.js";
import { authRateLimiter } from "../src/middleware/rateLimiter.js";
import { setMailTransport } from "../src/services/mailer.js";
import { closeSessions } from "../src/services/sessionService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";

const freshLimit = () => ["::ffff:127.0.0.1", "127.0.0.1", "::1"].forEach((ip) => authRateLimiter.resetKey(ip));

test("The platform admin chooses a company's plan, and the plan decides what it gets", async (t) => {
  setMailTransport({ sendMail: async () => {} });
  const original = { startSession: provider.startSession, getSession: provider.getSession, closeSession: provider.closeSession };
  provider.startSession = async () => {};
  provider.getSession = () => null;
  provider.closeSession = async () => {};
  t.after(async () => {
    Object.assign(provider, original);
    setMailTransport(undefined);
    await closeSessions(io);
    io.close();
  });

  ENV.SUPERADMIN_EMAIL = "root@plans-admin.test";
  ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
  await ensureSuperAdmin();
  const sa = await request(app).post("/api/auth/login").send({ email: ENV.SUPERADMIN_EMAIL, password: ENV.SUPERADMIN_PASSWORD });
  assert.equal(sa.status, 200);
  const admin = { Authorization: `Bearer ${sa.body.token}` };

  let n = 0;
  const add = (body) => request(app).post("/api/admin/companies").set(admin).send({ companyName: `Co ${++n}`, ownerName: "Owner", ownerEmail: `owner${n}@plans-admin.test`, ...body });
  const ownerOf = async (company) => {
    const { rows } = await query("SELECT id,email,name FROM users WHERE email=$1", [`owner${n}@plans-admin.test`]);
    return { Authorization: `Bearer ${generateAccessToken(rows[0], company.id, "owner")}` };
  };
  const outcomes = async (auth) => {
    const get = (path) => request(app).get(path).set(auth).then((r) => r.status);
    return { broadcasts: await get("/api/campaigns"), automations: await get("/api/automations"), audit: await get("/api/workspace/audit"), api: await get("/api/workspace/keys") };
  };

  await t.test("the plans are listed for the platform admin only", async () => {
    assert.equal((await request(app).get("/api/admin/plans")).status, 401);
    const res = await request(app).get("/api/admin/plans").set(admin);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.plans.map((p) => [p.id, p.numbers, p.seats]), [
      ["free", 1, 1],
      ["starter", 3, null],
      ["growth", 10, null],
      ["business", 25, null],
      ["enterprise", null, null],
    ]);
    const growth = res.body.plans.find((p) => p.id === "growth");
    assert.deepEqual(growth.features.filter((f) => f.included).map((f) => f.key), ["broadcasts", "automations", "audit", "ai"]);
    assert.deepEqual(res.body.plans.find((p) => p.id === "business").features.filter((f) => !f.included), []);
  });

  await t.test("a company needs one of the five plans", async () => {
    for (const plan of [undefined, "", "Gold", "Workspace", "Platform"]) {
      const res = await add({ plan });
      assert.equal(res.status, 400, String(plan));
      assert.match(res.body.message, /Choose a plan: Free, Starter, Growth, Business, Enterprise/);
    }
    assert.equal((await query("SELECT count(*)::int AS n FROM tenants WHERE name LIKE 'Co %'")).rows[0].n, 0, "nothing is created when the plan is wrong");
  });

  await t.test("each plan starts with the number limit on the pricing page, in any spelling", async () => {
    const expected = [["Free", "Free", 1], ["starter", "Starter", 3], [" GROWTH ", "Growth", 10], ["Business", "Business", 25]];
    for (const [typed, name, limit] of expected) {
      const res = await add({ plan: typed });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.deepEqual([res.body.company.plan, res.body.company.planId, res.body.company.sessionsLimit], [name, name.toLowerCase(), limit], typed);
    }
  });

  await t.test("a number limit typed by the admin wins; Enterprise has none until one is typed", async () => {
    const custom = await add({ plan: "Growth", sessionsLimit: 12 });
    assert.equal(custom.body.company.sessionsLimit, 12);
    const none = await add({ plan: "Enterprise" });
    assert.equal(none.status, 400);
    assert.match(none.body.message, /Enterprise has a custom number limit/);
    const ent = await add({ plan: "Enterprise", sessionsLimit: 60 });
    assert.deepEqual([ent.status, ent.body.company.plan, ent.body.company.sessionsLimit], [201, "Enterprise", 60]);
    for (const bad of [0, 501, 2.5, "many"]) assert.equal((await add({ plan: "Starter", sessionsLimit: bad })).status, 400, String(bad));
  });

  await t.test("what a company can use follows the plan it was given", async () => {
    const free = (await add({ plan: "Free" })).body.company;
    const freeAuth = await ownerOf(free);
    assert.deepEqual(await outcomes(freeAuth), { broadcasts: 403, automations: 403, audit: 403, api: 403 });
    const growth = (await add({ plan: "Growth" })).body.company;
    assert.deepEqual(await outcomes(await ownerOf(growth)), { broadcasts: 200, automations: 200, audit: 200, api: 403 });
    const business = (await add({ plan: "Business" })).body.company;
    const businessAuth = await ownerOf(business);
    assert.deepEqual(await outcomes(businessAuth), { broadcasts: 200, automations: 200, audit: 200, api: 200 });
    const caps = (await request(app).get("/api/workspace/capabilities").set(businessAuth)).body;
    assert.deepEqual([caps.plan.name, caps.plan.numbers, caps.numbersLimit], ["Business", 25, 25]);
  });

  await t.test("the number limit is enforced, and the company's own people limit on Free", async () => {
    const company = (await add({ plan: "Free" })).body.company;
    const auth = await ownerOf(company);
    const first = await request(app).post("/api/sessions/start").set(auth).send({ sessionName: "one" });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    const second = await request(app).post("/api/sessions/start").set(auth).send({ sessionName: "two" });
    assert.equal(second.status, 403, "Free includes one number");
    const invite = await request(app).post("/api/auth/users").set(auth).send({ name: "Sam", email: "sam@plans-admin.test", role: "agent" });
    assert.equal(invite.status, 403);
    assert.match(invite.body.message, /Free plan is for one person/);
  });

  await t.test("moving a company to another plan changes what it gets straight away", async () => {
    const company = (await add({ plan: "Starter" })).body.company;
    const auth = await ownerOf(company);
    assert.equal((await request(app).get("/api/campaigns").set(auth)).status, 403);
    const up = await request(app).patch(`/api/admin/companies/${company.id}`).set(admin).send({ plan: "Growth" });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.deepEqual([up.body.company.plan, up.body.company.sessionsLimit, up.body.warnings], ["Growth", 10, []]);
    assert.equal((await request(app).get("/api/campaigns").set(auth)).status, 200);
    const audit = (await query("SELECT metadata FROM audit_events WHERE tenant_id=$1 AND event_type='company.updated'", [company.id])).rows[0].metadata;
    assert.deepEqual([audit.plan, audit.previousPlan], ["Growth", "Starter"], "who moved it from what is on record");
    const typed = await request(app).patch(`/api/admin/companies/${company.id}`).set(admin).send({ plan: "Business", sessionsLimit: 30 });
    assert.deepEqual([typed.body.company.plan, typed.body.company.sessionsLimit], ["Business", 30]);
    const bad = await request(app).patch(`/api/admin/companies/${company.id}`).set(admin).send({ plan: "Gold" });
    assert.equal(bad.status, 400);
    const plain = await request(app).patch(`/api/admin/companies/${company.id}`).set(admin).send({ name: "Renamed" });
    assert.deepEqual([plain.body.company.plan, plain.body.company.sessionsLimit], ["Business", 30], "other changes leave the plan alone");
    assert.equal((await request(app).patch("/api/admin/companies/tenant_missing").set(admin).send({ plan: "Free" })).status, 404);
  });

  await t.test("moving to a smaller plan removes nothing, and says what is beyond it", async () => {
    const company = (await add({ plan: "Growth" })).body.company;
    const auth = await ownerOf(company);
    for (const name of ["a", "b", "c", "d"]) await request(app).post("/api/sessions/start").set(auth).send({ sessionName: name });
    await query("INSERT INTO users(email,password_hash,name,status) VALUES('team@plans-admin.test','x','Team','active') ON CONFLICT DO NOTHING");
    const teammate = (await query("SELECT id FROM users WHERE email='team@plans-admin.test'")).rows[0].id;
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [company.id, teammate]);
    const down = await request(app).patch(`/api/admin/companies/${company.id}`).set(admin).send({ plan: "Free" });
    assert.equal(down.status, 200);
    assert.equal(down.body.warnings.length, 2);
    assert.match(down.body.warnings[0], /Free is for one person, but Co \d+ has 2\. They keep their access/);
    assert.match(down.body.warnings[1], /has 4 numbers linked, above the new limit of 1/);
    assert.equal((await query("SELECT count(*)::int AS n FROM whatsapp_sessions WHERE tenant_id=$1", [company.id])).rows[0].n, 4);
    assert.equal((await request(app).post("/api/sessions/start").set(auth).send({ sessionName: "e" })).status, 403, "and no new number can be linked");
  });

  freshLimit();
  await t.test("someone who signs up on their own starts on the Free plan, not on everything", async () => {
    const res = await request(app).post("/api/auth/signup").send({ name: "Self Serve", email: "self@plans-admin.test", password: "Password@12345", companyName: "Self Serve Co" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const tenant = (await query("SELECT plan,sessions_limit FROM tenants WHERE name='Self Serve Co'")).rows[0];
    assert.deepEqual(tenant, { plan: "Free", sessions_limit: 1 });
    const auth = { Authorization: `Bearer ${res.body.token}` };
    assert.equal((await request(app).get("/api/campaigns").set(auth)).status, 403);
  });

  await t.test("companies that were already on the original Workspace plan keep everything", async () => {
    await query("INSERT INTO tenants(id,name,slug,plan,sessions_limit) VALUES('tenant_legacy','Legacy Co','legacy-co','Workspace',5)");
    await query("INSERT INTO users(email,password_hash,name,status) VALUES('legacy@plans-admin.test','x','Legacy','active') ON CONFLICT DO NOTHING");
    const user = (await query("SELECT id,email,name FROM users WHERE email='legacy@plans-admin.test'")).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES('tenant_legacy',$1,'owner')", [user.id]);
    const auth = { Authorization: `Bearer ${generateAccessToken(user, "tenant_legacy", "owner")}` };
    assert.deepEqual(await outcomes(auth), { broadcasts: 200, automations: 200, audit: 200, api: 200 });
    const list = (await request(app).get("/api/admin/companies").set(admin)).body.companies.find((c) => c.id === "tenant_legacy");
    assert.deepEqual([list.plan, list.planId], ["Workspace", null]);
  });
});
