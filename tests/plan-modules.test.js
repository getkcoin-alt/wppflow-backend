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
import { announceFeatureChange, noticeFor, featureChanges } from "../src/services/planNotices.js";

test("What a company is told when a module on its plan changes", () => {
  assert.deepEqual(featureChanges(["broadcasts", "ai"], ["ai", "api"]), { added: ["api"], removed: ["broadcasts"] });
  assert.deepEqual(featureChanges(["ai"], ["ai"]), { added: [], removed: [] });
  const on = noticeFor({ planName: "Growth", added: ["broadcasts"], removed: [] });
  assert.equal(on.title, "Broadcasts is now included in your Growth plan");
  assert.equal(on.body, "It is switched on for your company now.");
  const several = noticeFor({ planName: "Growth", added: ["broadcasts", "leads", "audit"], removed: [] });
  assert.equal(several.title, "Broadcasts, Sales pipeline and Audit log are now included in your Growth plan");
  assert.equal(several.body, "They are switched on for your company now.");
  const off = noticeFor({ planName: "Starter", added: [], removed: ["automations"] });
  assert.equal(off.title, "Automations is no longer included in your Starter plan");
  assert.match(off.body, /^It is locked now\. Nothing has been deleted\. /);
  const both = noticeFor({ planName: "Growth", added: ["api"], removed: ["ai"] });
  assert.equal(both.title, "Your Growth plan changed");
  assert.match(both.body, /^Now included: Developers \(API keys, webhooks, API tester\)\. No longer included: Riwo, the AI assistant, locked now, and nothing has been deleted\./);
});

test("Plan modules: ticking or unticking one reaches the companies on the plan", async (t) => {
  setMailTransport({ sendMail: async () => {} });
  t.after(async () => {
    setMailTransport(undefined);
    await closeSessions(io);
    io.close();
  });
  ENV.SUPERADMIN_EMAIL = "root@modules.test";
  ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
  await ensureSuperAdmin();
  const sa = await request(app).post("/api/auth/login").send({ email: ENV.SUPERADMIN_EMAIL, password: ENV.SUPERADMIN_PASSWORD });
  const admin = { Authorization: `Bearer ${sa.body.token}` };
  const setFeatures = (code, features) => request(app).put(`/api/admin/plans/${code}`).set(admin).send({ features });
  const featuresOf = async (code) => (await request(app).get("/api/admin/plans").set(admin)).body.plans.find((p) => p.id === code).features.filter((f) => f.included).map((f) => f.key);
  const GROWTH = ["broadcasts", "automations", "leads", "audit", "ai"];

  let n = 0;
  const company = async (name, plan, extra = "") => {
    n++;
    const created = await request(app).post("/api/admin/companies").set(admin).send({ companyName: name, ownerName: `Owner ${n}`, ownerEmail: `owner${n}@modules.test`, plan });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const tenantId = created.body.company.id;
    const ownerRow = (await query("SELECT * FROM users WHERE email=$1", [`owner${n}@modules.test`])).rows[0];
    const person = async (label, role) => {
      const u = (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [`${label} ${n}`, `${label.toLowerCase()}${n}@modules.test`])).rows[0];
      await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)", [tenantId, u.id, role]);
      return u;
    };
    const sam = await person("Sam", "admin"),
      tina = await person("Tina", "agent");
    if (extra) await query(extra, [tenantId]);
    const as = (u, role) => ({ Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` });
    return { tenantId, owner: as(ownerRow, "owner"), ownerId: ownerRow.id, samId: sam.id, tinaId: tina.id, agent: as(tina, "agent") };
  };
  const growth = await company("Growth Co", "Growth");
  const lapsed = await company("Late Co", "Growth", "UPDATE tenants SET period_end='2020-01-01' WHERE id=$1");
  const starter = await company("Starter Co", "Starter");
  const notes = async (c) => (await query("SELECT user_id,type,title,body FROM notifications WHERE tenant_id=$1 AND type='subscription' AND dedupe_key LIKE 'plan-modules:%' ORDER BY created_at,title", [c.tenantId])).rows;
  const caps = async (c, who = c.owner) => (await request(app).get("/api/workspace/capabilities").set(who)).body.plan;
  const campaigns = (c) => request(app).get("/api/campaigns").set(c.owner);
  const automations = (c) => request(app).get("/api/automations").set(c.owner);

  await t.test("before anything is changed, nobody has been told anything", async () => {
    assert.deepEqual(await featuresOf("growth"), GROWTH);
    assert.equal((await caps(growth)).features.automations, true);
    assert.equal((await automations(growth)).status, 200);
    assert.deepEqual(await notes(growth), []);
  });

  await t.test("unticking a module locks it at once for the company, and its owner and administrator are told", async () => {
    const res = await setFeatures("growth", GROWTH.filter((f) => f !== "automations"));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.notified, { companies: 1, told: 2, added: [], removed: ["Automations"] }, "only the one company that is paying for Growth, and its two managers");

    // the server refuses it, and the screens are told to show the lock
    assert.equal((await caps(growth)).features.automations, false);
    assert.equal((await caps(growth)).features.broadcasts, true, "the other modules are untouched");
    const refused = await automations(growth);
    assert.equal(refused.status, 403);
    assert.match(refused.body.message, /Automations isn't included in your Growth plan/);
    assert.equal((await campaigns(growth)).status, 200);

    const told = await notes(growth);
    assert.equal(told.length, 2);
    assert.deepEqual(told.map((x) => x.user_id).sort(), [growth.ownerId, growth.samId].sort(), "the owner and the administrator; the agent is not told");
    for (const x of told) {
      assert.equal(x.title, "Automations is no longer included in your Growth plan");
      assert.match(x.body, /It is locked now\. Nothing has been deleted\. Choose Business or above to use it again\./);
    }
    assert.equal((await query("SELECT 1 FROM notifications WHERE user_id=$1", [growth.tinaId])).rowCount, 0);
  });

  await t.test("a company that is not on the plan, or whose late payment already put it on Free, is not told", async () => {
    assert.deepEqual(await notes(starter), []);
    assert.deepEqual(await notes(lapsed), []);
    assert.equal((await caps(lapsed)).lapsed, true);
    assert.equal((await caps(lapsed)).features.automations, false, "it had no access to change");
    assert.equal((await caps(starter)).features.automations, false);
  });

  await t.test("ticking it again unlocks it at once and says so", async () => {
    const res = await setFeatures("growth", GROWTH);
    assert.deepEqual(res.body.notified, { companies: 1, told: 2, added: ["Automations"], removed: [] });
    assert.equal((await caps(growth)).features.automations, true);
    assert.equal((await automations(growth)).status, 200);
    const told = (await notes(growth)).filter((x) => /now included/.test(x.title));
    assert.equal(told.length, 2);
    assert.equal(told[0].title, "Automations is now included in your Growth plan");
    assert.equal(told[0].body, "It is switched on for your company now.");
  });

  await t.test("a mixed change is one notification, and a change to another plan reaches that plan's companies only", async () => {
    await setFeatures("growth", [...GROWTH.filter((f) => f !== "ai"), "api"]);
    const mixed = (await notes(growth)).filter((x) => x.title === "Your Growth plan changed");
    assert.equal(mixed.length, 2);
    assert.match(mixed[0].body, /Now included: Developers \(API keys, webhooks, API tester\)\. No longer included: Riwo, the AI assistant, locked now/);
    assert.equal((await caps(growth)).features.api, true);
    assert.equal((await caps(growth)).features.ai, false);
    await setFeatures("growth", GROWTH);

    const before = (await notes(growth)).length;
    const res = await setFeatures("starter", ["broadcasts"]);
    assert.deepEqual(res.body.notified, { companies: 1, told: 2, added: ["Broadcasts"], removed: [] }, "the Starter company, and its owner and administrator");
    assert.equal((await notes(growth)).length, before, "Growth's companies hear nothing about Starter");
    assert.equal((await caps(starter)).features.broadcasts, true);
    assert.equal((await campaigns(starter)).status, 200);
    assert.equal((await notes(starter))[0].title, "Broadcasts is now included in your Starter plan");
    await setFeatures("starter", []);
  });

  await t.test("a change that is not about modules tells nobody", async () => {
    const before = (await query("SELECT count(*)::int n FROM notifications WHERE type='subscription' AND dedupe_key LIKE 'plan-modules:%'")).rows[0].n;
    const res = await request(app).put("/api/admin/plans/growth").set(admin).send({ name: "Growth", maxContacts: 5000, prices: [{ interval: "monthly", currency: "INR", amountMinor: 599900 }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.notified, { companies: 0, told: 0, added: [], removed: [] });
    assert.equal((await query("SELECT count(*)::int n FROM notifications WHERE type='subscription' AND dedupe_key LIKE 'plan-modules:%'")).rows[0].n, before);
    // and saving the same modules again is not a change either
    const same = await setFeatures("growth", GROWTH);
    assert.deepEqual(same.body.notified, { companies: 0, told: 0, added: [], removed: [] });
  });

  await t.test("every open browser of the company is told to look again, managers or not; other companies' are not", async () => {
    const sent = [];
    const fake = { to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) };
    const result = await announceFeatureChange({ io: fake, planId: "growth", planName: "Growth", before: GROWTH, after: GROWTH.filter((f) => f !== "audit") });
    assert.equal(result.companies, 1);
    const looked = sent.filter((s) => s.event === "plan:changed");
    assert.deepEqual(looked.map((s) => s.room), [`tenant:${growth.tenantId}`], "the company's whole room, not only its managers, and not the late or Starter company");
    assert.deepEqual(looked[0].payload, { plan: "growth", added: [], removed: ["audit"] });
    // and each manager's own notification is pushed to them as it is stored
    const pushed = sent.filter((s) => s.event === "notification:new");
    assert.deepEqual(pushed.map((s) => s.room).sort(), [`user:${growth.ownerId}`, `user:${growth.samId}`].sort());
    assert.equal(pushed[0].payload.notification.title, "Audit log is no longer included in your Growth plan");
    // it was only announced, not saved
    assert.deepEqual(await featuresOf("growth"), GROWTH);
  });

  await t.test("only the platform admin can change a plan's modules", async () => {
    const res = await request(app).put("/api/admin/plans/growth").set(growth.owner).send({ features: [] });
    assert.equal(res.status, 403);
    assert.deepEqual(await featuresOf("growth"), GROWTH);
  });
});
