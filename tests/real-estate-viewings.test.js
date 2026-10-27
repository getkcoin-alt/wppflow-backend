import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { closeSessions } from "../src/services/sessionService.js";
import { pumpLeadReminders } from "../src/services/leadService.js";
import { company, property, BUYER } from "./helpers/realEstate.js";

// A day in the future, as a calendar date, so tests do not depend on today's date.
const day = (plus) => new Date(Date.now() + plus * 86400000).toISOString().slice(0, 10);

test("Real estate: viewings", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const A = await company("Marina Brokers");
  const B = await company("Desert Homes");
  const a = (who = A.owner) => A.re(who);
  const mk = async (ref, o = {}) => (await a().post("/properties", property({ reference: ref, ...o }))).body.property.id;
  const p1 = await mk("DM-101");
  const p2 = await mk("DM-102", { price: 1_300_000 });
  const pSold = await mk("DM-SOLD", { status: "sold" });
  const pDraft = await mk("DM-DRAFT", { status: "draft", price: null, bedrooms: null });
  const people = {};
  const lead = async (name, phone, line = "sam-line", owner = A.sam) => {
    const c = await A.customer(phone, name, { line });
    const id = await A.lead(c, { owner });
    people[name] = { id, ...c };
    return id;
  };
  const asha = await lead("Asha", "971500000101");
  const bilal = await lead("Bilal", "971500000102");
  const chitra = await lead("Chitra", "971500000103");
  const book = (who, body) => A.re(who).post("/viewings", { timeZone: "Asia/Dubai", time: "16:00", date: day(5), ...body });
  const tasksOf = async (leadId) => (await query("SELECT * FROM lead_tasks WHERE lead_id=$1 ORDER BY due_at", [leadId])).rows;
  const rows = async () => (await query("SELECT * FROM re_viewings WHERE tenant_id=$1 ORDER BY starts_at", [A.tenantId])).rows;

  let first;
  await t.test("a viewing is booked in the place's own time and kept as an exact moment", async () => {
    const res = await book(A.sam, { leadId: asha, propertyId: p1, idempotencyKey: "book-1" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    first = res.body.viewing;
    assert.equal(first.status, "scheduled");
    assert.equal(first.timeZone, "Asia/Dubai");
    assert.equal(new Date(first.startsAt).toISOString(), `${day(5)}T12:00:00.000Z`, "16:00 in Dubai is 12:00 UTC");
    assert.equal(new Date(first.endsAt).toISOString(), `${day(5)}T12:45:00.000Z`, "the company's default length is 45 minutes");
    assert.equal(first.local.time, "16:00");
    assert.equal(first.local.endTime, "16:45");
    assert.match(first.local.text, /^\w{3} \d{1,2} \w{3} \d{4}, 16:00$/);
    assert.equal(first.agentName, "Sam Agent", "the lead's owner runs it unless someone else is named");
    assert.equal(first.propertyReference, "DM-101");
    assert.equal(first.leadName, "Asha");
    assert.match(res.body.confirmationText, /^Hello Asha, this is to confirm your viewing of DM-101 in Dubai Marina on .*16:00 \(Asia\/Dubai time\)\./);
    assert.deepEqual(first.allowed, ["confirmed", "completed", "cancelled", "no_show"]);
  });

  await t.test("a reminder and a follow-up are made with the follow-up system the company already uses", async () => {
    const tasks = await tasksOf(asha);
    assert.equal(tasks.length, 2);
    const [reminder, followUp] = tasks;
    assert.match(reminder.title, /^Viewing .*16:00: DM-101 with Asha$/);
    assert.equal(new Date(reminder.due_at).toISOString(), `${day(5)}T11:00:00.000Z`, "an hour before");
    assert.equal(reminder.assigned_user_id, A.sam.id);
    assert.equal(followUp.title, "After the viewing of DM-101: ask Asha what they thought");
    assert.equal(new Date(followUp.due_at).toISOString(), `${day(5)}T14:45:00.000Z`, "two hours after it ends");
    const row = (await rows())[0];
    assert.equal(row.reminder_task_id, reminder.id);
    assert.equal(row.followup_task_id, followUp.id);
    const timeline = (await A.core(A.owner).get(`/${asha}`)).body.timeline.filter((e) => e.type === "viewing");
    assert.equal(timeline[0].detail.action, "booked");
    assert.equal(timeline[0].detail.reference, "DM-101");
  });

  await t.test("asking again with the same key returns the same viewing, not a second", async () => {
    const again = await book(A.sam, { leadId: asha, propertyId: p1, idempotencyKey: "book-1" });
    assert.equal(again.status, 200);
    assert.equal(again.body.existing, true);
    assert.equal(again.body.viewing.id, first.id);
    assert.equal((await rows()).length, 1);
    assert.equal((await tasksOf(asha)).length, 2, "and no second reminder");
    const other = await book(A.sam, { leadId: bilal, propertyId: p1, idempotencyKey: "book-1", time: "10:00" });
    assert.equal(other.status, 409, "the key belongs to a different viewing");
    assert.match(other.body.message, /already used for a different viewing/);
    assert.equal((await book(A.sam, { leadId: asha, propertyId: p1, idempotencyKey: "bad key with spaces" })).status, 400);
  });

  await t.test("the same agent cannot be in two places, the same property cannot be shown twice, the same lead cannot be at two viewings", async () => {
    const overlap = { time: "16:30" };
    const agent = await book(A.sam, { leadId: bilal, propertyId: p2, ...overlap });
    assert.equal(agent.status, 409);
    assert.equal(agent.body.conflicts[0].with, "agent");
    assert.match(agent.body.message, /The agent already has a viewing at that time: .*16:00\./);
    const prop = await book(A.admin, { leadId: bilal, propertyId: p1, agentUserId: A.admin.id, ...overlap });
    assert.equal(prop.status, 409, "a manager may book for themselves, and the property is still busy");
    assert.equal(prop.body.conflicts[0].with, "property");
    const prop2 = await book(A.owner, { leadId: bilal, propertyId: p1, agentUserId: A.tina.id, ...overlap });
    assert.equal(prop2.status, 409);
    assert.equal(prop2.body.conflicts[0].with, "property");
    const same = await book(A.owner, { leadId: asha, propertyId: p2, agentUserId: A.tina.id, ...overlap });
    assert.equal(same.status, 409);
    assert.equal(same.body.conflicts[0].with, "lead");
    assert.equal((await rows()).length, 1, "none of them was kept");
  });

  await t.test("viewings that meet end to end are not a clash, and a cancelled viewing frees its slot", async () => {
    const next = await book(A.owner, { leadId: bilal, propertyId: p1, agentUserId: A.tina.id, time: "16:45" });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    const cancelled = await a(A.sam).post(`/viewings/${next.body.viewing.id}/cancel`, { reason: "Client unwell" });
    assert.equal(cancelled.status, 403, "Sam is not running it");
    assert.equal((await a(A.tina).post(`/viewings/${next.body.viewing.id}/cancel`, { reason: "Client unwell" })).status, 200);
    const reused = await book(A.owner, { leadId: chitra, propertyId: p1, agentUserId: A.tina.id, time: "16:45" });
    assert.equal(reused.status, 201, "the slot is free again");
    await a(A.tina).post(`/viewings/${reused.body.viewing.id}/cancel`);
  });

  await t.test("a time that has passed, a bad zone, a time that does not exist and a closed or unavailable thing are refused", async () => {
    const send = (body) => book(A.sam, { leadId: bilal, propertyId: p2, ...body });
    assert.match((await send({ date: day(-1) })).body.message, /time in the future/);
    assert.match((await send({ timeZone: "Mars/Olympus" })).body.message, /valid time zone/);
    assert.match((await send({ timeZone: "Europe/London", date: "2099-03-29", time: "01:30" })).body.message, /isn't a time that exists in Europe\/London/);
    assert.match((await send({ date: "tomorrow" })).body.message, /isn't a time that exists/);
    assert.match((await send({ date: undefined, time: undefined, startsAt: "2099-01-01T10:00:00" })).body.message, /with its zone/);
    assert.match((await send({ date: undefined, time: undefined })).body.message, /Choose when/);
    assert.match((await send({ durationMinutes: 5 })).body.message, /10 minutes to 8 hours/);
    assert.match((await book(A.sam, { leadId: bilal, propertyId: pSold })).body.message, /property is sold/);
    assert.match((await book(A.sam, { leadId: bilal, propertyId: pDraft })).body.message, /property is draft/);
    assert.equal((await book(A.sam, { leadId: bilal, propertyId: "no-such-property" })).status, 404);
    assert.equal((await book(A.sam, { leadId: "no-such-lead", propertyId: p2 })).status, 404);
    await A.core(A.owner).post(`/${chitra}/move`, { stageId: (await A.core(A.owner).get("/settings")).body.stages.find((s) => s.kind === "lost").id, lostReason: "x" });
    assert.match((await book(A.sam, { leadId: chitra, propertyId: p2 })).body.message, /lead is closed/);
    assert.equal((await rows()).filter((r) => r.status !== "cancelled").length, 1);
  });

  await t.test("a time given as an exact moment is kept as given, in the zone it was booked for", async () => {
    const res = await book(A.sam, { leadId: bilal, propertyId: p2, date: undefined, time: undefined, startsAt: `${day(6)}T10:00:00+05:30`, timeZone: "Asia/Kolkata", durationMinutes: 30 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(new Date(res.body.viewing.startsAt).toISOString(), `${day(6)}T04:30:00.000Z`);
    assert.equal(res.body.viewing.local.time, "10:00");
    assert.equal(res.body.viewing.local.endTime, "10:30");
    await a(A.sam).post(`/viewings/${res.body.viewing.id}/cancel`);
  });

  await t.test("staff book for themselves; an owner or administrator books for anyone, but only active teammates", async () => {
    assert.equal((await book(A.sam, { leadId: bilal, propertyId: p2, agentUserId: A.tina.id, time: "09:00" })).status, 403);
    assert.equal((await book(A.owner, { leadId: bilal, propertyId: p2, agentUserId: 99999999, time: "09:00" })).status, 400);
    const foreign = await B.re(B.owner).get("/viewings");
    assert.equal(foreign.status, 200);
    assert.equal((await book(A.owner, { leadId: bilal, propertyId: p2, agentUserId: B.owner.id, time: "09:00" })).status, 400, "another company's person cannot be the agent");
  });

  await t.test("two people booking the same slot at once: exactly one wins", async () => {
    const leads = [];
    for (let i = 0; i < 5; i++) leads.push(await lead(`Racer ${i}`, `97150000020${i}`));
    const results = await Promise.all(leads.map((id, i) => book(A.owner, { leadId: id, propertyId: p2, agentUserId: A.tina.id, date: day(9), time: "11:00", idempotencyKey: `race-${i}` })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
    assert.equal((await query("SELECT count(*)::int AS n FROM re_viewings WHERE tenant_id=$1 AND starts_at=$2", [A.tenantId, `${day(9)}T07:00:00Z`])).rows[0].n, 1);
  });

  await t.test("the same request sent many times at once makes one viewing", async () => {
    const id = await lead("Dup", "971500000300");
    const results = await Promise.all([1, 2, 3, 4].map(() => book(A.owner, { leadId: id, propertyId: p2, agentUserId: A.sam.id, date: day(10), time: "12:00", idempotencyKey: "same-click" })));
    assert.ok(results.every((r) => [200, 201].includes(r.status)), JSON.stringify(results.map((r) => r.status)));
    assert.equal(new Set(results.map((r) => r.body.viewing.id)).size, 1);
    assert.equal((await query("SELECT count(*)::int AS n FROM re_viewings WHERE lead_id=$1", [id])).rows[0].n, 1);
  });

  await t.test("confirming, and the rules about what can happen next", async () => {
    assert.equal((await a(A.tina).post(`/viewings/${first.id}/confirm`)).status, 404, "staff do not even see a teammate's viewing of a teammate's lead");
    const done = await a(A.sam).post(`/viewings/${first.id}/confirm`);
    assert.equal(done.body.viewing.status, "confirmed");
    assert.ok(done.body.viewing.confirmedAt);
    assert.deepEqual(done.body.viewing.allowed, ["completed", "cancelled", "no_show"]);
    assert.equal((await a(A.sam).post(`/viewings/${first.id}/confirm`)).status, 409, "it is already confirmed");
    assert.equal((await a(A.sam).post(`/viewings/${first.id}/complete`)).status, 409, "it hasn't started");
    assert.match((await a(A.sam).post(`/viewings/${first.id}/no-show`)).body.message, /hasn't started yet/);
    const clicks = await Promise.all([a(A.owner).post(`/viewings/${first.id}/cancel`), a(A.sam).post(`/viewings/${first.id}/cancel`)]);
    assert.deepEqual(clicks.map((r) => r.status).sort(), [200, 409], "two people pressing cancel at once: one wins");
    assert.equal((await a(A.owner).post(`/viewings/${first.id}/confirm`)).status, 409, "a cancelled viewing is final");
    assert.equal((await a(A.owner).post(`/viewings/${first.id}/reschedule`, { date: day(7), time: "10:00" })).status, 409);
  });

  await t.test("cancelling stops the reminder and the follow-up", async () => {
    const tasks = await tasksOf(asha);
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((x) => x.done_at), "both are closed, so nobody is reminded of a viewing that is off");
    const cancel = (await A.core(A.owner).get(`/${asha}`)).body.timeline.filter((e) => e.type === "viewing")[0];
    assert.equal(cancel.detail.action, "cancelled");
  });

  let second;
  await t.test("rescheduling moves the viewing, its reminder and its follow-up, and asks for confirmation again", async () => {
    const booked = await book(A.sam, { leadId: asha, propertyId: p2, date: day(12), time: "15:00" });
    second = booked.body.viewing;
    await a(A.sam).post(`/viewings/${second.id}/confirm`);
    await query("UPDATE lead_tasks SET notified_at=now() WHERE id=(SELECT reminder_task_id FROM re_viewings WHERE id=$1)", [second.id]);
    const moved = await a(A.sam).post(`/viewings/${second.id}/reschedule`, { date: day(13), time: "11:30" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.viewing.status, "scheduled", "the new time has not been confirmed with anyone");
    assert.equal(moved.body.viewing.confirmedAt, null);
    assert.equal(new Date(moved.body.viewing.startsAt).toISOString(), `${day(13)}T07:30:00.000Z`);
    assert.equal(moved.body.viewing.local.endTime, "12:15", "the length is kept");
    const row = (await query("SELECT v.*,r.due_at AS reminder_due,r.notified_at,r.title AS reminder_title,f.due_at AS follow_due FROM re_viewings v JOIN lead_tasks r ON r.id=v.reminder_task_id JOIN lead_tasks f ON f.id=v.followup_task_id WHERE v.id=$1", [second.id])).rows[0];
    assert.equal(new Date(row.reminder_due).toISOString(), `${day(13)}T06:30:00.000Z`);
    assert.equal(row.notified_at, null, "it will remind again");
    assert.match(row.reminder_title, /11:30: DM-102 with Asha/);
    assert.equal(new Date(row.follow_due).toISOString(), `${day(13)}T10:15:00.000Z`);
    const clash = await book(A.owner, { leadId: bilal, propertyId: p2, agentUserId: A.tina.id, date: day(13), time: "12:00" });
    assert.equal(clash.status, 409, "the old slot is free, the new one is taken");
    assert.equal((await book(A.owner, { leadId: bilal, propertyId: p2, agentUserId: A.tina.id, date: day(12), time: "15:00" })).status, 201);
    assert.equal((await a(A.sam).post(`/viewings/${second.id}/reschedule`, { date: day(12), time: "15:00" })).status, 409, "and it cannot move back onto it");
  });

  await t.test("the reminder arrives once, through the existing reminder job", async () => {
    await query("UPDATE lead_tasks SET due_at=now()-interval '1 minute',notified_at=NULL WHERE id=(SELECT reminder_task_id FROM re_viewings WHERE id=$1)", [second.id]);
    const count = async () => (await query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND title LIKE 'Follow-up due: Viewing%'", [A.tenantId, A.sam.id])).rows[0].n;
    const before = await count();
    await pumpLeadReminders(io);
    await pumpLeadReminders(io);
    assert.equal(await count() - before, 1, "told once, however often the job runs");
  });

  await t.test("after it has started, a viewing can be completed or marked as a no-show, and completing closes its reminder", async () => {
    await query("UPDATE re_viewings SET starts_at=now()-interval '2 hours',ends_at=now()-interval '75 minutes' WHERE id=$1", [second.id]);
    assert.equal((await a(A.sam).post(`/viewings/${second.id}/complete`)).body.viewing.status, "completed");
    const [reminder, follow] = await query("SELECT t.done_at FROM re_viewings v JOIN lead_tasks t ON t.id IN (v.reminder_task_id,v.followup_task_id) WHERE v.id=$1 ORDER BY t.due_at", [second.id]).then((r) => r.rows);
    assert.ok(reminder.done_at, "the reminder is done");
    assert.equal(follow.done_at, null, "the follow-up is still to do");
    assert.equal((await a(A.sam).post(`/viewings/${second.id}/no-show`)).status, 409);
    const missed = (await book(A.owner, { leadId: chitra, propertyId: p1, agentUserId: A.tina.id, date: day(14), time: "09:00" }));
    assert.equal(missed.status, 409, "chitra's lead is closed");
    const bil = await book(A.owner, { leadId: bilal, propertyId: p1, agentUserId: A.tina.id, date: day(14), time: "09:00" });
    await query("UPDATE re_viewings SET starts_at=now()-interval '2 hours',ends_at=now()-interval '75 minutes' WHERE id=$1", [bil.body.viewing.id]);
    assert.equal((await a(A.tina).post(`/viewings/${bil.body.viewing.id}/no-show`)).body.viewing.status, "no_show");
  });

  await t.test("a calendar file can be downloaded for any viewing the person can see", async () => {
    const live = await book(A.sam, { leadId: asha, propertyId: p1, date: day(20), time: "09:30" });
    const res = await request(app).get(`/api/solutions/real_estate/viewings/${live.body.viewing.id}/calendar.ics`).set(A.sam.auth);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/calendar/);
    assert.match(res.headers["content-disposition"], /viewing-DM-101\.ics/);
    const ics = res.text;
    assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
    assert.match(ics, new RegExp(`UID:${live.body.viewing.id}@scriwo\r\n`));
    assert.match(ics, new RegExp(`DTSTART:${day(20).replace(/-/g, "")}T053000Z\r\n`));
    assert.match(ics, /DTEND:\d{8}T061500Z\r\n/);
    assert.match(ics, /SUMMARY:Viewing: DM-101 with Asha\r\n/);
    assert.match(ics, /STATUS:TENTATIVE\r\n/);
    assert.match(ics, /DESCRIPTION:Agent: Sam Agent\\nhttps:\/\/listings\.example\.test\/dm-101\r\n/);
    assert.equal((await request(app).get(`/api/solutions/real_estate/viewings/${live.body.viewing.id}/calendar.ics`).set(A.tina.auth)).status, 404, "Tina cannot see Sam's viewing of Sam's lead");
    assert.equal((await request(app).get(`/api/solutions/real_estate/viewings/${live.body.viewing.id}/calendar.ics`).set(B.owner.auth)).status, 404);
  });

  await t.test("staff see their own viewings, managers see all, and another company sees none", async () => {
    const list = async (who, qs = "") => (await A.re(who).get(`/viewings?from=${day(-30)}&to=${day(40)}${qs}`)).body.viewings;
    const tess = await lead("Tess", "971500000500", "tina-line", A.tina);
    assert.equal((await book(A.owner, { leadId: tess, propertyId: p2, agentUserId: A.tina.id, date: day(25), time: "09:00" })).status, 201);
    const mine = await list(A.sam);
    assert.ok(mine.length >= 2);
    assert.ok(!mine.some((v) => v.leadName === "Tess"), "Sam cannot see Tina's lead's viewing");
    assert.ok((await list(A.tina)).some((v) => v.leadName === "Tess"));
    assert.ok(!(await list(A.tina)).some((v) => v.leadName === "Asha" && v.agentUserId === A.sam.id), "and Tina cannot see Sam's");
    const all = await list(A.owner);
    assert.ok(all.length > mine.length);
    assert.ok(all.some((v) => v.agentUserId === A.tina.id));
    assert.deepEqual((await list(A.owner, "&status=confirmed")).map((v) => v.status), [...new Set((await list(A.owner, "&status=confirmed")).map((v) => v.status))]);
    assert.deepEqual(await list(B.owner), []);
    assert.equal((await A.re(A.owner).get(`/leads/${asha}/viewings`)).body.viewings.length >= 2, true);
    assert.equal((await B.re(B.owner).get(`/leads/${asha}/viewings`)).status, 404);
    assert.equal((await B.re(B.owner).get(`/viewings/${second.id}`)).status, 404);
    assert.equal((await B.re(B.owner).post(`/viewings/${second.id}/cancel`)).status, 404);
    assert.equal((await B.re(B.owner).post("/viewings", { leadId: asha, propertyId: p1, date: day(5), time: "08:00", timeZone: "Asia/Dubai" })).status, 404, "another company's lead cannot be booked");
  });

  await t.test("a property with viewings on record cannot be deleted, only withdrawn", async () => {
    const res = await a().del(`/properties/${p1}`);
    assert.equal(res.status, 409);
    assert.match(res.body.message, /Withdraw it instead/);
    assert.equal((await a().patch(`/properties/${p1}`, { status: "withdrawn" })).body.property.status, "withdrawn");
    assert.match((await book(A.sam, { leadId: bilal, propertyId: p1, date: day(30), time: "09:00" })).body.message, /property is withdrawn/);
  });

  await t.test("the pipeline step for viewings is suggested, never moved by itself", async () => {
    await A.core(A.owner).post("/settings/preset", { preset: "real_estate" });
    const id = await lead("Pia", "971500000400");
    const res = await book(A.owner, { leadId: id, propertyId: p2, agentUserId: A.tina.id, date: day(21), time: "09:00" });
    assert.equal(res.body.suggestedStage.name, "Viewing booked");
    const stage = (await A.core(A.owner).get(`/${id}`)).body.lead.stageName;
    assert.equal(stage, "New enquiry", "the lead stays where it was until a person moves it");
    const key = { leadId: id, propertyId: p2, agentUserId: A.tina.id, date: day(22), time: "09:00", idempotencyKey: "pia" };
    assert.equal((await book(A.owner, key)).status, 201);
    const repeat = await book(A.owner, key);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.suggestedStage, null, "a repeated request suggests nothing new");
  });
});
