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
import { SOLUTIONS, mergeSettings } from "../src/solutions/registry.js";

test("The solution registry knows what exists and checks every setting", () => {
  assert.deepEqual(Object.keys(SOLUTIONS), ["real_estate"]);
  assert.deepEqual(SOLUTIONS.real_estate.requires, ["leads"], "real estate is built on the universal pipeline");
  const defaults = mergeSettings("real_estate");
  assert.equal(defaults.timezone, "Asia/Dubai");
  assert.equal(defaults.freshnessDays, 14);
  assert.equal(mergeSettings("real_estate", {}, { stalledDays: 10 }).stalledDays, 10);
  assert.equal(mergeSettings("real_estate", { stalledDays: 12 }, { timezone: "Europe/London" }).stalledDays, 12, "what is stored is kept");
  assert.throws(() => mergeSettings("real_estate", {}, { timezone: "Mars/Olympus" }), /valid time zone/);
  assert.throws(() => mergeSettings("real_estate", {}, { stalledDays: 0 }), /whole number from 1/);
  assert.throws(() => mergeSettings("real_estate", {}, { stalledDays: 2.5 }), /whole number/);
  assert.throws(() => mergeSettings("real_estate", {}, { colour: "red" }), /Unknown setting/);
  assert.equal(mergeSettings("real_estate", { stalledDays: -4, timezone: "Nope/Nope" }).stalledDays, 7, "a stored value that no longer passes falls back to the default");
});

test("Industry solutions: off by default, switched on per company by the platform admin", async (t) => {
  setMailTransport({ sendMail: async () => {} });
  t.after(async () => {
    setMailTransport(undefined);
    await closeSessions(io);
    io.close();
  });
  ENV.SUPERADMIN_EMAIL = "root@solutions.test";
  ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
  await ensureSuperAdmin();
  const sa = await request(app).post("/api/auth/login").send({ email: ENV.SUPERADMIN_EMAIL, password: ENV.SUPERADMIN_PASSWORD });
  const admin = { Authorization: `Bearer ${sa.body.token}` };

  let n = 0;
  const company = async (name, plan) => {
    n++;
    const created = await request(app).post("/api/admin/companies").set(admin).send({ companyName: name, ownerName: `Owner ${n}`, ownerEmail: `owner${n}@solutions.test`, plan });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const tenantId = created.body.company.id;
    const owner = (await query("SELECT * FROM users WHERE email=$1", [`owner${n}@solutions.test`])).rows[0];
    const agent = (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [`Agent ${n}`, `agent${n}@solutions.test`])).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, agent.id]);
    const as = (u, role) => ({ Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` });
    return { tenantId, owner: as(owner, "owner"), ownerId: owner.id, agent: as(agent, "agent") };
  };
  const growth = await company("Brokerage One", "Growth");
  const other = await company("Brokerage Two", "Growth");
  const starter = await company("Starter Co", "Starter");
  const toggle = (c, enabled, who = admin, key = "real_estate") => request(app).put(`/api/admin/companies/${c.tenantId}/solutions/${key}`).set(who).send({ enabled });
  const caps = async (c, who = c.owner) => (await request(app).get("/api/workspace/capabilities").set(who)).body;
  const probe = (c, who = c.owner) => request(app).get("/api/solutions/real_estate/settings").set(who);
  const events = async (c) => (await query("SELECT event_type,actor_id,metadata FROM audit_events WHERE tenant_id=$1 AND event_type LIKE 'solution.%' ORDER BY id", [c.tenantId])).rows;

  await t.test("a company has no solution until one is switched on, and the universal product is unaffected", async () => {
    assert.deepEqual((await caps(growth)).solutions, []);
    const res = await probe(growth);
    assert.equal(res.status, 403);
    assert.match(res.body.message, /Scriwo Real Estate isn't switched on for your company/);
    assert.equal((await request(app).get("/api/leads/board").set(growth.owner)).status, 200, "the core pipeline still works");
    assert.equal((await request(app).get("/api/solutions").set(growth.owner)).body.solutions.length, 0);
  });

  await t.test("only the platform admin can switch a solution on", async () => {
    assert.equal((await toggle(growth, true, growth.owner)).status, 403, "a company owner cannot give themselves a solution");
    assert.equal((await toggle(growth, true, growth.agent)).status, 403);
    assert.equal((await request(app).put(`/api/admin/companies/${growth.tenantId}/solutions/real_estate`).send({ enabled: true })).status, 401);
    assert.deepEqual((await caps(growth)).solutions, []);
    assert.equal((await toggle(growth, true, admin, "dentistry")).status, 400, "an unknown solution is refused");
    assert.equal((await request(app).put(`/api/admin/companies/${growth.tenantId}/solutions/real_estate`).set(admin).send({ enabled: "yes" })).status, 400);
    assert.equal((await toggle({ tenantId: "no-such-company" }, true)).status, 404);
  });

  await t.test("switching it on reaches that company only, tells its managers, and is audited", async () => {
    const res = await toggle(growth, true);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.changed, true);
    assert.deepEqual(res.body.solutions.map((s) => [s.key, s.enabled]), [["real_estate", true]]);

    const mine = await caps(growth);
    assert.deepEqual(mine.solutions, [{ key: "real_estate", name: "Scriwo Real Estate", version: 1 }]);
    assert.deepEqual((await caps(growth, growth.agent)).solutions.map((s) => s.key), ["real_estate"], "everyone in the company sees it");
    assert.equal((await probe(growth)).status, 200);
    assert.equal((await probe(growth, growth.agent)).status, 200);

    assert.deepEqual((await caps(other)).solutions, [], "another company has nothing");
    assert.equal((await probe(other)).status, 403, "and cannot use it");

    const told = (await query("SELECT user_id,title,body FROM notifications WHERE tenant_id=$1 AND type='subscription' AND dedupe_key LIKE 'solution:%'", [growth.tenantId])).rows;
    assert.equal(told.length, 1);
    assert.equal(told[0].user_id, growth.ownerId);
    assert.equal(told[0].title, "Scriwo Real Estate is now switched on for your company");
    assert.match(told[0].body, /Everything else in Scriwo works as before/);
    assert.equal((await query("SELECT 1 FROM notifications WHERE tenant_id=$1 AND dedupe_key LIKE 'solution:%'", [other.tenantId])).rowCount, 0);

    const log = await events(growth);
    assert.equal(log.length, 1);
    assert.equal(log[0].event_type, "solution.enabled");
    assert.equal(log[0].actor_id, sa.body.user.id);
    assert.deepEqual(log[0].metadata, { solution: "real_estate", version: 1 });
  });

  await t.test("switching it on again changes nothing and tells nobody twice", async () => {
    const again = await toggle(growth, true);
    assert.equal(again.body.changed, false);
    assert.equal((await events(growth)).length, 1);
    assert.equal((await query("SELECT 1 FROM notifications WHERE tenant_id=$1 AND dedupe_key LIKE 'solution:%'", [growth.tenantId])).rowCount, 1);
  });

  await t.test("settings are the company's own, validated, and a manager's to change", async () => {
    assert.equal((await probe(growth)).body.settings.timezone, "Asia/Dubai");
    const save = (c, body, who = c.owner) => request(app).put("/api/solutions/real_estate/settings").set(who).send(body);
    assert.equal((await save(growth, { timezone: "Asia/Kolkata", stalledDays: 10 })).status, 200);
    assert.equal((await save(growth, { stalledDays: 10 }, growth.agent)).status, 403, "staff cannot change them");
    assert.equal((await save(growth, { timezone: "Mars/Olympus" })).status, 400);
    assert.equal((await save(growth, { nonsense: 1 })).status, 400);
    const now = (await probe(growth)).body.settings;
    assert.equal(now.timezone, "Asia/Kolkata");
    assert.equal(now.stalledDays, 10);
    assert.equal(now.freshnessDays, 14);
    assert.equal((await save(other, { stalledDays: 3 })).status, 403, "a company without the solution cannot save settings for it");
    await toggle(other, true);
    assert.equal((await probe(other)).body.settings.stalledDays, 7, "another company's settings are not shared");
    await toggle(other, false);
  });

  await t.test("a company on a plan without the pipeline cannot use a solution built on it", async () => {
    await toggle(starter, true);
    // the Starter plan on this server has no pipeline: remove it to make the case explicit whatever the catalogue says
    const plan = (await request(app).get("/api/admin/plans").set(admin)).body.plans.find((p) => p.id === "starter");
    const had = plan.features.filter((f) => f.included).map((f) => f.key);
    await request(app).put("/api/admin/plans/starter").set(admin).send({ features: had.filter((f) => f !== "leads") });
    const res = await probe(starter);
    assert.equal(res.status, 403);
    assert.match(res.body.message, /The sales pipeline isn't included in your Starter plan/);
    await request(app).put("/api/admin/plans/starter").set(admin).send({ features: had });
    await toggle(starter, false);
  });

  await t.test("a company that has lapsed to Free loses the solution's screens, and gets them back by paying", async () => {
    await query("UPDATE tenants SET period_end='2020-01-01' WHERE id=$1", [growth.tenantId]);
    const res = await probe(growth);
    assert.equal(res.status, 403);
    assert.match(res.body.message, /overdue/);
    await query("UPDATE tenants SET period_end=NULL WHERE id=$1", [growth.tenantId]);
    assert.equal((await probe(growth)).status, 200);
  });

  await t.test("a client cannot name another company to get at its solution", async () => {
    // other has none; growth's owner asks for other's tenant in the header: refused because they are not a member
    const res = await request(app).get("/api/solutions/real_estate/settings").set({ ...growth.owner, "X-Tenant-Id": other.tenantId });
    assert.equal(res.status, 403);
  });

  await t.test("switching it off hides it and deletes nothing; switching on again restores the settings", async () => {
    const off = await toggle(growth, false);
    assert.equal(off.body.changed, true);
    assert.deepEqual((await caps(growth)).solutions, []);
    assert.equal((await probe(growth)).status, 403);
    assert.equal((await query("SELECT settings FROM tenant_solutions WHERE tenant_id=$1", [growth.tenantId])).rows[0].settings.timezone, "Asia/Kolkata");
    const told = (await query("SELECT title FROM notifications WHERE tenant_id=$1 AND dedupe_key LIKE 'solution:%' ORDER BY created_at", [growth.tenantId])).rows;
    assert.equal(told.at(-1).title, "Scriwo Real Estate was switched off for your company");
    await toggle(growth, true);
    assert.equal((await probe(growth)).body.settings.timezone, "Asia/Kolkata", "nothing was lost");
    assert.deepEqual((await events(growth)).map((e) => e.event_type), ["solution.enabled", "solution.disabled", "solution.enabled"]);
  });

  await t.test("the platform's company list says who has what", async () => {
    const list = (await request(app).get("/api/admin/companies").set(admin)).body.companies;
    assert.deepEqual(list.find((c) => c.id === growth.tenantId).solutions, ["real_estate"]);
    assert.deepEqual(list.find((c) => c.id === other.tenantId).solutions, []);
    const catalogue = (await request(app).get("/api/admin/solutions").set(admin)).body.solutions;
    assert.deepEqual(catalogue.map((s) => s.key), ["real_estate"]);
    assert.equal((await request(app).get("/api/admin/solutions").set(growth.owner)).status, 403);
  });
});
