import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser } from "../src/services/authService.js";
import { applyVertical, brandingOf, verticalKey, verticalOfHost, TRIAL_DAYS } from "../src/services/vertical.js";
import { isLapsed, entitledPlan } from "../src/services/plans.js";
import { cleanRule } from "../src/services/automationRules.js";
import { AUTOMATION_TEMPLATES } from "../src/services/automationTemplates.js";
import { closeSessions } from "../src/services/sessionService.js";

test("Which address is which vertical, and what it is called", () => {
  assert.equal(verticalOfHost("homes.scriwo.com"), "homes");
  assert.equal(verticalOfHost("HOMES.scriwo.com:443"), "homes");
  assert.equal(verticalOfHost("homes.localhost:5173"), "homes");
  for (const none of ["app.scriwo.com", "www.scriwo.com", "scriwo.com", "", null, undefined, "homesteading.example", "evil.com/homes"]) assert.equal(verticalOfHost(none), null, String(none));
  assert.equal(verticalKey("Homes"), "homes");
  assert.equal(verticalKey("__proto__"), null);
  assert.equal(verticalKey("constructor"), null);
  assert.equal(brandingOf("homes").name, "Scriwo Homes");
  assert.deepEqual(brandingOf("nothing"), { vertical: null, name: "Scriwo", tagline: "", intro: "", trialDays: 0 });
});

test("The property assistant is a valid ready-made rule, with a property pipeline step to move to", async () => {
  const t = AUTOMATION_TEMPLATES.find((x) => x.id === "real-estate-sales-assistant");
  const rule = { ...t.rule, config: { ...t.rule.config, knowledge: "We are a property brokerage in Dubai Marina. We help people buy, rent and sell apartments." } };
  const clean = await cleanRule({ name: t.name, templateId: t.id, ...rule }, { teammate: async () => true });
  assert.deepEqual(clean.config.sales.questions.length, 5);
  assert.equal(clean.config.sales.stageName, "Offer made");
  assert.match(clean.config.sales.formal, /property consultant \{\{executive\}\}/);
  assert.equal(clean.config.maxReplies, 8);
});

test("Scriwo Homes: signing up on the homes address gives a property workspace with a 14-day trial; elsewhere nothing changes", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const day = 86400000;
  const post = (body) => request(app).post("/api/auth/signup").send({ password: "Password@1234", ...body });

  await t.test("the sign-up page learns its name from the address", async () => {
    const homes = await request(app).get("/api/auth/branding?host=homes.scriwo.com");
    assert.deepEqual([homes.status, homes.body.vertical, homes.body.name, homes.body.trialDays], [200, "homes", "Scriwo Homes", TRIAL_DAYS]);
    assert.equal((await request(app).get("/api/auth/branding?host=app.scriwo.com")).body.vertical, null);
    assert.equal((await request(app).get("/api/auth/branding")).body.name, "Scriwo");
  });

  await t.test("an agency that signs up on the homes address gets Growth for 14 days, real estate on and the property pipeline", async () => {
    const res = await post({ name: "Hana Broker", email: "hana@homes.test", companyName: "Marina Homes Realty", vertical: "homes" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const tenantId = res.body.tenant.id;
    assert.equal(res.body.tenant.plan, "Growth", "the page shows the trial straight away");
    const row = (await query("SELECT plan,sessions_limit,period_start,period_end FROM tenants WHERE id=$1", [tenantId])).rows[0];
    assert.deepEqual([row.plan, row.sessions_limit], ["Growth", 3]);
    const days = Math.round((new Date(row.period_end).getTime() - new Date(row.period_start).getTime()) / day);
    assert.equal(days, TRIAL_DAYS);
    const sol = (await query("SELECT solution_key,enabled FROM tenant_solutions WHERE tenant_id=$1", [tenantId])).rows;
    assert.deepEqual(sol.map((s) => [s.solution_key, s.enabled]), [["real_estate", true]]);
    const stages = (await query("SELECT s.name FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE s.tenant_id=$1 ORDER BY s.position", [tenantId])).rows.map((r) => r.name);
    assert.deepEqual(stages, ["New enquiry", "Contacted", "Viewing booked", "Offer made", "Negotiation", "Deal closed", "Lost"]);
    assert.equal((await query("SELECT preset FROM pipelines WHERE tenant_id=$1", [tenantId])).rows[0].preset, "real_estate");
    const ev = (await query("SELECT metadata FROM audit_events WHERE tenant_id=$1 AND event_type='vertical.applied'", [tenantId])).rows;
    assert.equal(ev.length, 1);
    // the trial ends by itself: a week after it, as for any company that has not paid, the paid features go and nothing is deleted
    const tenant = (await query("SELECT * FROM tenants WHERE id=$1", [tenantId])).rows[0];
    assert.equal(isLapsed(tenant), false);
    await query("UPDATE tenants SET period_end=CURRENT_DATE - 8 WHERE id=$1", [tenantId]);
    const later = (await query("SELECT * FROM tenants WHERE id=$1", [tenantId])).rows[0];
    assert.equal(isLapsed(later), true);
    assert.equal(entitledPlan(later).id, "free");
    assert.equal((await query("SELECT count(*)::int AS n FROM pipeline_stages WHERE tenant_id=$1", [tenantId])).rows[0].n, 7, "nothing was removed");
  });

  await t.test("signing up anywhere else is the ordinary free workspace, and a made-up vertical is ignored", async () => {
    for (const [email, vertical] of [["plain@homes.test", undefined], ["odd@homes.test", "__proto__"], ["odd2@homes.test", "banks"]]) {
      const res = await post({ name: "Plain", email, companyName: `Plain ${email}`, vertical });
      assert.equal(res.status, 201);
      const row = (await query("SELECT plan,sessions_limit,period_end FROM tenants WHERE id=$1", [res.body.tenant.id])).rows[0];
      assert.deepEqual([row.plan, row.sessions_limit, row.period_end], ["Free", 1, null], email);
      assert.equal((await query("SELECT count(*)::int AS n FROM tenant_solutions WHERE tenant_id=$1", [res.body.tenant.id])).rows[0].n, 0);
    }
  });

  await t.test("applying it twice changes nothing more, and a company that already pays is not touched", async () => {
    const o = await registerTenantAndUser({ name: "Paying Pat", email: "pat@homes.test", password: "Password@123", companyName: "Paying Co", plan: "Business" });
    assert.equal(await applyVertical({ tenantId: o.tenant.id, user: o.user, key: "homes" }), true);
    const row = (await query("SELECT plan,sessions_limit,period_end FROM tenants WHERE id=$1", [o.tenant.id])).rows[0];
    assert.deepEqual([row.plan, row.period_end], ["Business", null], "no trial for a company that already has a plan");
    await applyVertical({ tenantId: o.tenant.id, user: o.user, key: "homes" });
    assert.equal((await query("SELECT count(*)::int AS n FROM tenant_solutions WHERE tenant_id=$1", [o.tenant.id])).rows[0].n, 1);
    assert.equal(await applyVertical({ tenantId: o.tenant.id, user: o.user, key: "nonsense" }), false);
  });
});
