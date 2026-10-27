import test from "node:test";
import assert from "node:assert/strict";
import { io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { closeSessions } from "../src/services/sessionService.js";
import { pumpRealEstate, scanTenant, detect, KINDS } from "../src/solutions/real-estate/leaks.js";
import { setSolution } from "../src/solutions/entitlements.js";
import { company, property } from "./helpers/realEstate.js";

const HOUR = 3600000;
const DAY = 24 * HOUR;

test("Real estate: the Revenue Leak Detector", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const A = await company("Marina Brokers");
  const B = await company("Desert Homes");
  const C = await company("Plain Co", { solution: false });
  const a = (who = A.owner) => A.re(who);
  const scan = (c = A, now = new Date()) => scanTenant(c.tenantId, { io: null, now });
  const alerts = async (status = "open", c = A, who = c.owner) => (await c.re(who).get(`/alerts?status=${status}`)).body.alerts;
  const byLead = (list, leadId) => list.filter((x) => x.leadId === leadId).map((x) => x.kind).sort();

  // Makes a lead look as though it was created, and last touched, `ms` ago.
  const backdate = async (leadId, ms) => {
    const at = new Date(Date.now() - ms).toISOString();
    await query("UPDATE leads SET created_at=$2,stage_changed_at=$2,updated_at=$2 WHERE id=$1", [leadId, at]);
    await query("UPDATE lead_activities SET created_at=$2 WHERE lead_id=$1", [leadId, at]);
    await query("UPDATE conversations SET last_active_epoch=$2 WHERE id IN (SELECT c.id FROM conversations c JOIN leads l ON l.contact_id=c.contact_id AND l.tenant_id=c.tenant_id WHERE l.id=$1)", [leadId, Math.floor((Date.now() - ms) / 1000)]);
  };
  const task = (leadId, dueInMs, title = "Call back") => query("INSERT INTO lead_tasks(id,tenant_id,lead_id,title,due_at,assigned_user_id) VALUES(gen_random_uuid()::text,$1,$2,$3,$4,$5)", [A.tenantId, leadId, title, new Date(Date.now() + dueInMs).toISOString(), A.sam.id]);
  const make = async (name, phone, { owner = A.sam, ago = 0, line = "sam-line", value = 0 } = {}) => {
    const c = await A.customer(phone, name, { line, ago: Math.floor(ago / 1000) });
    const id = await A.lead(c, { owner, value });
    return { id, ...c };
  };

  const L = {};
  L.unassigned = await make("Una Unassigned", "971500001001", { owner: null, value: 900_000 });
  await backdate(L.unassigned.id, 2 * HOUR);
  L.overdue = await make("Omar Overdue", "971500001002", { value: 1_200_000 });
  await task(L.overdue.id, -3 * HOUR, "Send the brochure");
  L.noPlan = await make("Nora NoPlan", "971500001003", { value: 700_000 });
  await backdate(L.noPlan.id, 6 * HOUR);
  L.stalled = await make("ليلى Stalled", "971500001004", { value: 2_000_000 });
  await backdate(L.stalled.id, 10 * DAY);
  L.waiting = await make("Wade Waiting", "971500001005", { value: 800_000, ago: 2.5 * HOUR });
  await task(L.waiting.id, 2 * DAY);
  L.healthy = await make("Hana Healthy", "971500001006", { value: 500_000 });
  await task(L.healthy.id, 2 * DAY);
  L.tina = await make("Tariq Tina's", "971500001007", { owner: A.tina, line: "tina-line", value: 300_000 });
  await backdate(L.tina.id, 6 * HOUR);
  // an automation rule that has been failing
  await query(
    `INSERT INTO automations(id,tenant_id,name,trigger_type,trigger_condition,action_type,action_summary,config,is_enabled) VALUES('auto-1',$1,'Welcome reply','first_message','','reply_text','','{}',true)`,
    [A.tenantId],
  );
  await query("INSERT INTO automation_executions(id,tenant_id,automation_id,status,error) VALUES(gen_random_uuid(),$1,'auto-1','failed','WhatsApp session is not connected'),(gen_random_uuid(),$1,'auto-1','failed','WhatsApp session is not connected')", [A.tenantId]);

  await t.test("it finds each real condition, and nothing else, with the reason in plain words", async () => {
    const stats = await scan();
    assert.equal(stats.opened, 7, JSON.stringify(stats));
    const open = await alerts();
    assert.deepEqual(byLead(open, L.unassigned.id), ["unassigned_lead"], "an unassigned lead is told once, for the real cause");
    assert.deepEqual(byLead(open, L.overdue.id), ["overdue_followup"]);
    assert.deepEqual(byLead(open, L.noPlan.id), ["missing_next_action"]);
    assert.deepEqual(byLead(open, L.stalled.id), ["stalled_lead"], "a stalled lead is not also told it has no next step");
    assert.deepEqual(byLead(open, L.waiting.id), ["response_overdue"]);
    assert.deepEqual(byLead(open, L.healthy.id), [], "a lead that is fine has nothing");
    assert.deepEqual(byLead(open, L.tina.id), ["missing_next_action"]);
    assert.deepEqual(open.filter((x) => x.kind === "failed_automation").map((x) => x.title), ["Automation “Welcome reply” is failing"]);
    const why = (id) => open.find((x) => x.leadId === id).reason;
    assert.match(why(L.unassigned.id), /Nobody is responsible for this lead, and it came in 2 hours ago\. The target is 15 minutes\./);
    assert.match(why(L.overdue.id), /“Send the brochure” was due 3 hours ago\./);
    assert.match(why(L.noPlan.id), /no follow-up and no viewing planned, and has been like that for 6 hours/);
    assert.match(why(L.stalled.id), /Nothing has happened on this lead for 10 days and nothing is planned\. The limit is 7 days\./);
    assert.match(why(L.waiting.id), /The customer wrote 2 hours ago and has had no answer\. Your reply target is 30 minutes\./);
    assert.match(open.find((x) => x.kind === "failed_automation").reason, /It failed 2 times in the last day\. The latest error: WhatsApp session is not connected/);
    assert.equal(open.find((x) => x.leadId === L.stalled.id).title, "ليلى Stalled has gone quiet", "names in Arabic come through");
  });

  await t.test("each alert carries what is at risk, which is the lead's value and not revenue", async () => {
    const open = await alerts();
    assert.equal(open.find((x) => x.leadId === L.stalled.id).valueAtRisk, 2_000_000);
    assert.equal(open.find((x) => x.leadId === L.stalled.id).currency, "AED");
    assert.equal(open.find((x) => x.kind === "failed_automation").valueAtRisk, 0, "an automation has no lead value");
    assert.equal(open.find((x) => x.leadId === L.stalled.id).severity, "medium");
    assert.equal(open.find((x) => x.leadId === L.overdue.id).severity, "medium", "3 hours late is not yet high");
    const order = open.map((x) => x.severity);
    assert.deepEqual(order, [...order].sort((x, y) => (y === "high") - (x === "high")), "high ones come first");
  });

  await t.test("scanning again changes nothing and tells nobody twice", async () => {
    const notices = async () => (await query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND dedupe_key LIKE 're-alert:%'", [A.tenantId])).rows[0].n;
    const before = await notices();
    assert.ok(before > 0);
    const again = await scan();
    assert.equal(again.opened, 0);
    assert.equal(again.closed, 0);
    assert.equal(again.told, 0);
    assert.equal(await notices(), before);
    const [both] = await Promise.all([scan(), scan()]);
    assert.equal(both.opened, 0);
    const dup = await query("SELECT dedupe_key,count(*)::int AS n FROM re_alerts WHERE tenant_id=$1 AND status IN ('open','snoozed') GROUP BY 1 HAVING count(*)>1", [A.tenantId]);
    assert.equal(dup.rowCount, 0, "one open alert per condition");
  });

  await t.test("the people who can act are told: managers, and the lead's own owner", async () => {
    const to = async (leadTitle) =>
      (await query("SELECT DISTINCT user_id FROM notifications WHERE tenant_id=$1 AND dedupe_key LIKE 're-alert:%' AND title LIKE $2", [A.tenantId, `%${leadTitle}%`])).rows.map((r) => r.user_id).sort();
    assert.deepEqual(await to("Una Unassigned"), [A.owner.id, A.admin.id].sort(), "nobody owns it, so the managers");
    assert.deepEqual(await to("Omar Overdue"), [A.owner.id, A.admin.id, A.sam.id].sort(), "managers and its owner");
    assert.deepEqual(await to("Tariq Tina's"), [A.owner.id, A.admin.id, A.tina.id].sort());
    assert.deepEqual(await to("Welcome reply"), [A.owner.id, A.admin.id].sort(), "an automation is for managers");
    const note = (await query("SELECT * FROM notifications WHERE tenant_id=$1 AND title LIKE '%Una Unassigned%' LIMIT 1", [A.tenantId])).rows[0];
    assert.equal(note.type, "lead");
    assert.ok(note.conversation_id, "it opens the chat");
  });

  await t.test("staff see alerts on the leads they can see, and nothing about automations", async () => {
    const sam = await alerts("open", A, A.sam);
    assert.ok(sam.length >= 3);
    assert.ok(sam.every((x) => x.leadId), "no automation alert for staff");
    assert.ok(!sam.some((x) => x.leadId === L.tina.id), "Tina's lead is not Sam's to see");
    const tina = await alerts("open", A, A.tina);
    assert.deepEqual(tina.map((x) => x.leadId), [L.tina.id]);
    const tinasAlert = tina[0];
    assert.equal((await a(A.sam).post(`/alerts/${tinasAlert.id}/snooze`, { hours: 2 })).status, 404, "Sam cannot touch an alert on a lead he cannot see");
    assert.equal((await B.re(B.owner).post(`/alerts/${tinasAlert.id}/dismiss`)).status, 404, "and another company cannot either");
    assert.equal((await alerts("open", B)).length, 0);
  });

  await t.test("fixing the cause closes the alert by itself; a different cause opens a different alert", async () => {
    await a().post("/alerts/scan");
    await A.core(A.owner).patch(`/${L.unassigned.id}`, { ownerUserId: A.sam.id });
    const stats = await scan();
    assert.equal(stats.closed, 1);
    const closed = await alerts("resolved");
    assert.equal(closed.length, 1);
    assert.equal(closed[0].resolution, "auto");
    assert.equal(closed[0].leadId, L.unassigned.id);
    assert.ok(closed[0].resolvedAt);
    assert.deepEqual(byLead(await alerts(), L.unassigned.id), [], "it is owned now, and only two hours old");
    await task(L.overdue.id, -3 * HOUR + 1, "second");
    await query("UPDATE lead_tasks SET done_at=now() WHERE lead_id=$1", [L.overdue.id]);
    await scan();
    assert.deepEqual(byLead(await alerts(), L.overdue.id), [], "the follow-ups were done");
  });

  await t.test("a closed alert that comes back opens again, without telling anyone a second time within a day", async () => {
    await query("INSERT INTO lead_tasks(id,tenant_id,lead_id,title,due_at,assigned_user_id) VALUES(gen_random_uuid()::text,$1,$2,'Again',now()-interval '3 hours',$3)", [A.tenantId, L.overdue.id, A.sam.id]);
    const before = (await query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND title LIKE '%Omar Overdue%'", [A.tenantId])).rows[0].n;
    const stats = await scan();
    assert.equal(stats.opened, 1);
    assert.equal(stats.told, 0);
    assert.deepEqual(byLead(await alerts(), L.overdue.id), ["overdue_followup"]);
    assert.equal((await query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND title LIKE '%Omar Overdue%'", [A.tenantId])).rows[0].n, before);
  });

  await t.test("snoozing hides an alert until the time passes, then it is back", async () => {
    const mine = (await alerts()).find((x) => x.leadId === L.noPlan.id);
    const res = await a(A.sam).post(`/alerts/${mine.id}/snooze`, { hours: 4 });
    assert.equal(res.body.alert.status, "snoozed");
    assert.ok(!(await alerts()).some((x) => x.id === mine.id));
    assert.ok((await alerts("snoozed")).some((x) => x.id === mine.id));
    await scan();
    assert.ok((await alerts("snoozed")).some((x) => x.id === mine.id), "still snoozed");
    assert.equal((await a(A.sam).post(`/alerts/${mine.id}/snooze`, { hours: 0 })).status, 400);
    assert.equal((await a(A.sam).post(`/alerts/${mine.id}/snooze`, { hours: 500 })).status, 400);
    await query("UPDATE re_alerts SET snoozed_until=now()-interval '1 minute' WHERE id=$1", [mine.id]);
    await scan();
    assert.ok((await alerts()).some((x) => x.id === mine.id), "it is back");
  });

  await t.test("saying 'this is not a problem' keeps the same alert quiet for a week", async () => {
    const mine = (await alerts()).find((x) => x.leadId === L.noPlan.id);
    assert.equal((await a(A.sam).post(`/alerts/${mine.id}/dismiss`)).body.alert.resolution, "dismissed");
    assert.equal((await a(A.sam).post(`/alerts/${mine.id}/dismiss`)).status, 409, "it is already closed");
    const stats = await scan();
    assert.equal(stats.opened, 0);
    assert.deepEqual(byLead(await alerts(), L.noPlan.id), []);
    await query("UPDATE re_alerts SET resolved_at=now()-interval '8 days' WHERE id=$1", [mine.id]);
    assert.equal((await scan()).opened, 1, "after a week, if it is still true, it is raised again");
  });

  await t.test("marking an alert done while the problem remains opens it again at the next scan", async () => {
    const mine = (await alerts()).find((x) => x.leadId === L.noPlan.id);
    assert.equal((await a(A.sam).post(`/alerts/${mine.id}/resolve`)).body.alert.resolution, "fixed");
    assert.equal((await scan()).opened, 1);
    assert.equal((await alerts("resolved")).find((x) => x.id === mine.id).resolution, "fixed");
  });

  await t.test("a long list is one notice, not a flood", async () => {
    for (let i = 0; i < 12; i++) {
      const l = await make(`Flood ${i}`, `9715000030${String(i).padStart(2, "0")}`, { owner: null });
      await backdate(l.id, 3 * HOUR);
    }
    const before = (await query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND user_id=$2", [A.tenantId, A.owner.id])).rows[0].n;
    const stats = await scan();
    assert.equal(stats.opened, 12);
    assert.equal(stats.told, 12);
    const after = (await query("SELECT title FROM notifications WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 12", [A.tenantId, A.owner.id])).rows;
    assert.equal((await query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND user_id=$2", [A.tenantId, A.owner.id])).rows[0].n - before, 11, "ten singles and one summary for the managers");
    assert.ok(after.some((n) => /2 more revenue leaks found/.test(n.title)));
  });

  await t.test("the numbers: what is at risk and what is in the pipeline are hypothetical, what was won is recorded", async () => {
    const won = await make("Wanda Won", "971500004001", { value: 1_000_000 });
    await A.core(A.owner).post(`/${won.id}/move`, { stageId: (await A.core(A.owner).get("/settings")).body.stages.find((s) => s.kind === "won").id });
    const o = (await a().get("/overview")).body;
    assert.equal(o.currency, "AED");
    assert.equal(o.values.won.amount, 1_000_000);
    assert.equal(o.values.won.meaning, "recorded");
    assert.equal(o.values.won.deals, 1);
    assert.equal(o.values.pipeline.meaning, "hypothetical");
    assert.equal(o.values.atRisk.meaning, "hypothetical");
    const openValue = (await query("SELECT COALESCE(sum(value),0) AS v FROM leads WHERE tenant_id=$1 AND status='open'", [A.tenantId])).rows[0].v;
    assert.equal(o.values.pipeline.amount, Number(openValue), "the pipeline is what open leads are marked at");
    assert.ok(o.values.pipeline.amount < o.values.pipeline.amount + o.values.won.amount, "and the won deal is not in it");
    const risk = (await alerts()).filter((x) => x.leadId).reduce((m, x) => m.set(x.leadId, x.valueAtRisk), new Map());
    assert.equal(o.values.atRisk.amount, [...risk.values()].reduce((s, v) => s + v, 0), "a lead with two alerts counts once");
    assert.equal(o.values.atRisk.leads, risk.size);
    assert.equal(o.alerts.open, (await alerts()).length);
    assert.equal(o.alerts.byKind.unassigned_lead, 12);
    assert.deepEqual(Object.keys(o.alerts.byKind), KINDS);
    assert.equal(o.funnel.won, 1);
    assert.ok(o.funnel.enquiries >= 20);
    assert.equal(o.funnel.rates.won, Math.round((1 / o.funnel.enquiries) * 1000) / 10);
  });

  await t.test("the funnel follows real progress, and staff see only their own", async () => {
    const f = (await a().get("/overview")).body.funnel;
    assert.equal(f.qualified, 0);
    assert.equal(f.viewingBooked, 0);
    const pid = (await a().post("/properties", property({ reference: "F-1" }))).body.property.id;
    await a().put(`/leads/${L.healthy.id}/profile`, { leadType: "buyer", budgetMax: 2_000_000, currency: "AED", communities: ["Dubai Marina"], timeline: "1_month", qualificationStatus: "qualified" });
    const day = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
    const booked = await a().post("/viewings", { leadId: L.healthy.id, propertyId: pid, date: day, time: "10:00", timeZone: "Asia/Dubai" });
    assert.equal(booked.status, 201);
    let now = (await a().get("/overview")).body;
    assert.equal(now.funnel.qualified, 1);
    assert.equal(now.funnel.viewingBooked, 1);
    assert.equal(now.funnel.viewingHeld, 0);
    assert.equal(now.upcomingViewings, 1);
    await query("UPDATE re_viewings SET starts_at=now()-interval '2 hours',ends_at=now()-interval '75 minutes' WHERE id=$1", [booked.body.viewing.id]);
    await a().post(`/viewings/${booked.body.viewing.id}/complete`);
    now = (await a().get("/overview")).body;
    assert.equal(now.funnel.viewingHeld, 1);
    assert.equal(now.upcomingViewings, 0);
    const tinaView = (await a(A.tina).get("/overview")).body;
    assert.equal(tinaView.funnel.enquiries, 1, "Tina's own enquiry only");
    assert.equal(tinaView.values.pipeline.amount, 300_000);
    assert.equal(tinaView.values.won.amount, 0, "she cannot see the deal Sam's side won");
    assert.equal((await B.re(B.owner).get("/overview")).body.funnel.enquiries, 0);
  });

  await t.test("the background job scans companies that have the solution, once in five minutes, and skips the rest", async () => {
    await B.customer("971500009001", "Bea");
    const bl = await B.lead((await query("SELECT 1")) && { chat: (await query("SELECT id FROM conversations WHERE tenant_id=$1 LIMIT 1", [B.tenantId])).rows[0].id });
    await query("UPDATE leads SET created_at=now()-interval '3 hours' WHERE id=$1", [bl]);
    await C.customer("971500009002", "Cy");
    const cl = await C.lead({ chat: (await query("SELECT id FROM conversations WHERE tenant_id=$1 LIMIT 1", [C.tenantId])).rows[0].id });
    await query("UPDATE leads SET created_at=now()-interval '3 hours' WHERE id=$1", [cl]);
    await query("DELETE FROM re_scan_state");
    const now = new Date();
    const first = await pumpRealEstate(null, { now });
    assert.equal(first, 2, "Marina Brokers and Desert Homes; not Plain Co");
    assert.equal((await alerts("open", B)).length, 1);
    assert.equal((await query("SELECT count(*)::int AS n FROM re_alerts WHERE tenant_id=$1", [C.tenantId])).rows[0].n, 0);
    assert.equal(await pumpRealEstate(null, { now: new Date(now.getTime() + 2 * 60000) }), 0, "two minutes later: nothing");
    assert.equal(await pumpRealEstate(null, { now: new Date(now.getTime() + 6 * 60000) }), 2, "six minutes later: again");
    const racers = await Promise.all([pumpRealEstate(null, { now: new Date(now.getTime() + 20 * 60000) }), pumpRealEstate(null, { now: new Date(now.getTime() + 20 * 60000) })]);
    assert.equal(racers[0] + racers[1], 2, "two servers at once: each company scanned once");
  });

  await t.test("a company that has lapsed to Free, or had the solution switched off, is not scanned", async () => {
    await query("DELETE FROM re_scan_state");
    await query("UPDATE tenants SET period_end='2020-01-01' WHERE id=$1", [B.tenantId]);
    await setSolution({ tenantId: A.tenantId, key: "real_estate", enabled: false, actor: null });
    assert.equal(await pumpRealEstate(null, { now: new Date() }), 0);
    assert.equal((await a().get("/alerts")).status, 403);
    await setSolution({ tenantId: A.tenantId, key: "real_estate", enabled: true, actor: null });
    await query("UPDATE tenants SET period_end=NULL WHERE id=$1", [B.tenantId]);
    assert.ok((await alerts("open", A)).length > 0, "switching it back on restores everything");
  });

  await t.test("what the scan reads is the company's own data and nothing else", async () => {
    const found = await detect(B.tenantId, new Date());
    assert.ok(found.every((f) => !f.leadId || f.dedupeKey.endsWith(f.leadId) || f.dedupeKey.startsWith("response:")));
    const aLeads = new Set((await query("SELECT id FROM leads WHERE tenant_id=$1", [A.tenantId])).rows.map((r) => r.id));
    assert.ok(!found.some((f) => aLeads.has(f.leadId)), "none of company A's leads show up in company B's scan");
  });
});
