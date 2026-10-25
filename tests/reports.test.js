import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { median, percentile, parseRange, sendDailyReports, MIN_SAMPLE } from "../src/services/reportService.js";

const DAY = 86400;
const todayStart = Math.floor(Date.now() / 1000 / DAY) * DAY;
const YESTERDAY = new Date((todayStart - DAY) * 1000).toISOString().slice(0, 10);
const T0 = todayStart - DAY + 9 * 3600; // 09:00 UTC yesterday

test("medians, percentiles and date ranges", () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 10]), 3, "the middle two, averaged");
  assert.equal(median([]), null);
  assert.equal(percentile([60, 120, 180, 240, 600, 1800], 0.9), 1800);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  const r = parseRange({ from: "2026-10-01", to: "2026-10-07" });
  assert.deepEqual([r.from, r.to, r.toEpoch - r.fromEpoch], ["2026-10-01", "2026-10-07", 7 * DAY]);
  assert.throws(() => parseRange({ from: "2026-10-07", to: "2026-10-01" }), /before the start/);
  assert.throws(() => parseRange({ from: "2026-1-1", to: "2026-10-01" }), /YYYY-MM-DD/);
  assert.throws(() => parseRange({ from: "2026-01-01", to: "2026-06-01" }), /at most 92 days/);
  assert.throws(() => parseRange({ from: "2026-02-30", to: "2026-03-01" }), /YYYY-MM-DD/);
  assert.equal(MIN_SAMPLE, 5);
});

test("How fast the team answers: waits, who answered, targets, the leaderboard, the daily report", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@reports.test", password: "Password@123", companyName: "Reports Co" });
  const x = await registerTenantAndUser({ name: "Xavier", email: "xavier@reports.test", password: "Password@123", companyName: "Other Co" });
  const tenantId = o.tenant.id;
  let people = 0;
  const mk = async (name, category) => {
    const u = (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [name, `${name.toLowerCase().replace(/\W/g, "")}${++people}@reports.test`])).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role,category) VALUES($1,$2,'agent',$3)", [tenantId, u.id, category]);
    return u;
  };
  const sam = await mk("Sam", "sales"), tina = await mk("Tina", "support");
  await query("UPDATE memberships SET category='general' WHERE tenant_id=$1 AND user_id=$2", [tenantId, o.user.id]);
  await query(
    "INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,phone) VALUES(gen_random_uuid()::text,$1,'line-sam',$2,'971500000001'),(gen_random_uuid()::text,$1,'line-tina',$3,'971500000002')",
    [tenantId, sam.id, tina.id],
  );
  const auth = (u, role, tid = tenantId) => ({ Authorization: `Bearer ${generateAccessToken(u, tid, role)}` });
  const owner = auth(o.user, "owner"), samAuth = auth(sam, "agent"), stranger = auth(x.user, "owner", x.tenant.id);

  let n = 0;
  const chat = async (name, session, { group = false, closed = false, createdAt = null } = {}) => {
    const id = `c${++n}`;
    await query(
      `INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,phone,contact_name,is_group,is_closed,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,now()))`,
      [id, tenantId, session, group ? `${id}@g.us` : `9715500${String(n).padStart(5, "0")}@c.us`, `9715500${String(n).padStart(5, "0")}`, name, group, closed, createdAt],
    );
    return id;
  };
  const say = (conv, who, at, { by = null, agent = "", type = "text" } = {}) =>
    query(
      `INSERT INTO messages(id,tenant_id,conversation_id,sender,agent_name,type,timestamp_epoch,sent_by_user_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'delivered')`,
      [crypto.randomUUID(), tenantId, conv, who, agent, type, at, by],
    );
  // a customer writes, and a person answers `seconds` later
  const wait = async (conv, at, seconds, by, agent = "") => {
    await say(conv, "customer", at);
    await say(conv, "agent", at + seconds, { by, agent });
  };

  // Sam answers six chats in 1, 2, 3, 4, 10 and 30 minutes; one more was answered by name only (an older message)
  const samTimes = [60, 120, 180, 240, 600, 1800];
  for (const [i, s] of samTimes.entries()) await wait(await chat(`Sam customer ${i}`, "line-sam", { createdAt: new Date((T0 - 100) * 1000).toISOString() }), T0 + i * 100, s, sam.id, "Sam");
  // Tina answers five: one is very late
  for (const [i, s] of [30, 90, 150, 200, 4000].entries()) await wait(await chat(`Tina customer ${i}`, "line-tina"), T0 + i * 100, s, tina.id, "Tina");

  // one chat with everything that must not count
  const mixed = await chat("Asha Khan", "line-sam");
  await say(mixed, "customer", T0 + 20000);
  await say(mixed, "agent", T0 + 20010, { agent: "Automation" });
  await say(mixed, "agent", T0 + 20020, { agent: "Campaign" });
  await say(mixed, "agent", T0 + 20030, { by: sam.id, agent: "Sam", type: "internal_note" });
  await say(mixed, "customer", T0 + 20100);
  await say(mixed, "agent", T0 + 20400, { by: sam.id, agent: "Sam" }); // the wait began at 20000, not 20100: 400 seconds
  await say(mixed, "customer", T0 + 30000); // never answered
  // a burst of customer messages is one wait, from the first
  const burst = await chat("Burst", "line-sam");
  for (const s of [0, 30, 60]) await say(burst, "customer", T0 + 40000 + s);
  await say(burst, "agent", T0 + 40600, { agent: "Sam" }); // sent by name only, from before there were user ids
  // a reply typed on the phone itself belongs to the owner of that number
  const phone = await chat("From phone", "line-tina");
  await wait(phone, T0 + 50000, 45, null, "");
  // groups and resolved chats
  const group = await chat("Team group", "line-sam", { group: true });
  await wait(group, T0 + 53000, 10, sam.id, "Sam");
  const closed = await chat("Resolved", "line-sam", { closed: true });
  await say(closed, "customer", T0 + 53500);
  // a wait that began the day before the range and ended inside it does not belong to this range
  const early = await chat("Early", "line-sam");
  await wait(early, T0 - 2 * DAY, 5, sam.id, "Sam");

  const get = (who, qs) => request(app).get(`/api/reports/team-response${qs}`).set(who);
  const range = `from=${YESTERDAY}&to=${YESTERDAY}`;
  let report;

  await t.test("only owners and administrators see the figures, and only their own company's", async () => {
    assert.equal((await get(samAuth, `?${range}`)).status, 403);
    assert.equal((await request(app).get("/api/reports/team-response")).status, 401);
    const mine = await get(owner, `?${range}`);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const theirs = await get(stranger, `?${range}`);
    assert.equal(theirs.body.agents.length, 0);
    assert.equal(theirs.body.totals.answered, 0);
    report = mine.body;
  });

  await t.test("median and 90th percentile come from the waits, not the replies, with a minimum sample", async () => {
    const by = Object.fromEntries(report.agents.map((a) => [a.name, a]));
    // Sam: 60 120 180 240 600 1800, then 400 from the mixed chat and 600 from the burst
    assert.equal(by.Sam.answered, 8);
    assert.equal(by.Sam.medianSeconds, 320, "(240+400)/2");
    assert.equal(by.Sam.p90Seconds, 1800);
    assert.equal(by.Sam.meanSeconds, Math.round((60 + 120 + 180 + 240 + 600 + 1800 + 400 + 600) / 8));
    assert.equal(by.Sam.withinSlaPercent, 100, "the default target is 30 minutes");
    assert.equal(by.Sam.enoughData, true);
    // Tina: 30 90 150 200 4000, plus 45 from the reply typed on her phone
    assert.equal(by.Tina.answered, 6);
    assert.equal(by.Tina.medianSeconds, 120);
    assert.equal(by.Tina.p90Seconds, 4000);
    assert.equal(by.Tina.withinSlaPercent, 83, "5 of 6 inside 30 minutes");
    assert.deepEqual(report.agents.map((a) => a.rank), [1, 2].map((_, i) => report.agents[i].rank));
    assert.equal(report.agents[0].name, "Tina", "the faster median ranks first");
    assert.equal(report.agents[0].rank, 1);
    assert.equal(report.totals.answered, 14);
    assert.equal(report.minSample, 5);
  });

  await t.test("automatic replies, broadcasts, team notes, groups and resolved chats are left out", async () => {
    const by = Object.fromEntries(report.agents.map((a) => [a.name, a]));
    assert.equal(by.Sam.repliesSent, 6 + 1 + 1, "no automatic reply, broadcast or note is counted as a reply");
    assert.ok(!report.agents.some((a) => ["Automation", "Campaign"].includes(a.name)));
    assert.ok(!report.waiting.some((w) => ["Team group", "Resolved"].includes(w.contact)), "a group and a resolved chat are not waiting");
    assert.equal(by.Sam.chatsHandled, 8);
    assert.equal(report.totals.answered, 14, "the chat answered before the range is not in it");
  });

  await t.test("chats still waiting, longest first, say who has them", async () => {
    const w = report.waiting;
    assert.deepEqual(w.map((x) => x.contact), ["Asha Khan"]);
    assert.equal(w[0].session, "line-sam");
    assert.equal(w[0].assignedTo, "Sam", "no one is assigned, so the number's owner");
    assert.equal(report.totals.waiting, 1);
    assert.ok(w[0].waitingSeconds > 0);
  });

  await t.test("a reply is credited to who sent it, then to the one person of that name, then to the number's owner", async () => {
    const twin = await mk("Sam", "support"); // now two people are called Sam
    await say(await chat("Twin", "line-tina"), "customer", T0 + 52000);
    await say((await query("SELECT id FROM conversations WHERE tenant_id=$1 AND contact_name='Twin'", [tenantId])).rows[0].id, "agent", T0 + 52100, { agent: "Sam" });
    const again = (await get(owner, `?${range}`)).body;
    const tinaRow = again.agents.find((a) => a.name === "Tina");
    assert.equal(tinaRow.answered, 7, "a name two people share is not guessed; the number's owner gets it");
    assert.equal(again.agents.find((a) => a.userId === sam.id).answered, 8);
    assert.ok(!again.agents.some((a) => a.userId === twin.id));
    await query("DELETE FROM memberships WHERE user_id=$1", [twin.id]);
    await query("DELETE FROM messages WHERE tenant_id=$1 AND conversation_id=(SELECT id FROM conversations WHERE tenant_id=$1 AND contact_name='Twin')", [tenantId]);
  });

  await t.test("filter by team and by WhatsApp number", async () => {
    const sales = (await get(owner, `?${range}&team=sales`)).body;
    assert.deepEqual(sales.agents.map((a) => a.name), ["Sam"]);
    assert.equal(sales.totals.answered, 8);
    const support = (await get(owner, `?${range}&team=support`)).body;
    assert.deepEqual(support.agents.map((a) => a.name), ["Tina"]);
    const line = (await get(owner, `?${range}&sessionName=line-tina`)).body;
    assert.deepEqual(line.agents.map((a) => a.name), ["Tina"]);
    assert.equal(line.waiting.length, 0);
    assert.deepEqual(report.teams, ["general", "sales", "support"]);
  });

  await t.test("a person with too few answered chats shows no median, only their count", async () => {
    const few = (await get(owner, `?${range}&sessionName=line-tina&team=support`)).body;
    assert.equal(few.agents[0].answered, 6);
    // narrow to a single chat's worth
    await query("UPDATE messages SET timestamp_epoch=timestamp_epoch-3*86400 WHERE tenant_id=$1 AND conversation_id IN (SELECT id FROM conversations WHERE tenant_id=$1 AND contact_name LIKE 'Tina customer%' AND contact_name<>'Tina customer 0')", [tenantId]);
    const thin = (await get(owner, `?${range}&team=support`)).body.agents[0];
    assert.deepEqual([thin.answered, thin.enoughData, thin.medianSeconds, thin.p90Seconds, thin.withinSlaPercent, thin.rank], [2, false, null, null, null, null]);
    await query("UPDATE messages SET timestamp_epoch=timestamp_epoch+3*86400 WHERE tenant_id=$1 AND conversation_id IN (SELECT id FROM conversations WHERE tenant_id=$1 AND contact_name LIKE 'Tina customer%' AND contact_name<>'Tina customer 0')", [tenantId]);
  });

  await t.test("the reply target is the company's, with an override for a team, and bad values are refused", async () => {
    const put = (body) => request(app).put("/api/reports/settings").set(owner).send(body);
    assert.equal((await request(app).put("/api/reports/settings").set(samAuth).send({ slaMinutes: 5 })).status, 403);
    assert.equal((await put({ slaMinutes: 0 })).status, 400);
    assert.equal((await put({ slaMinutes: "soon" })).status, 400);
    assert.equal((await put({ teams: { support: 99999 } })).status, 400);
    const ok = await put({ slaMinutes: 10, teams: { support: 3 } });
    assert.deepEqual([ok.body.settings.slaMinutes, ok.body.settings.teams], [10, { support: 3 }]);
    const after = (await get(owner, `?${range}`)).body;
    const by = Object.fromEntries(after.agents.map((a) => [a.name, a]));
    assert.equal(by.Sam.withinSlaPercent, 88, "10 minutes: only the 30 minute wait is over, so 7 of 8");
    assert.equal(by.Tina.slaMinutes, 3);
    assert.equal(by.Tina.withinSlaPercent, 67, "inside 3 minutes: 30 90 150 45 of 6");
    await put({ slaMinutes: 30, teams: { support: null } });
    assert.deepEqual((await request(app).get("/api/reports/settings").set(owner)).body.settings.teams, {});
  });

  await t.test("a figure can be checked against the chats behind it, and everything exports as a spreadsheet", async () => {
    const eps = (await request(app).get(`/api/reports/team-response/episodes?${range}&userId=${tina.id}`).set(owner)).body.episodes;
    assert.equal(eps.length, 6);
    assert.deepEqual(eps.map((e) => e.seconds).sort((a, b) => a - b), [30, 45, 90, 150, 200, 4000]);
    assert.ok(eps.every((e) => e.contact && e.session));
    const csv = await request(app).get(`/api/reports/team-response?${range}&format=csv`).set(owner);
    assert.equal(csv.status, 200);
    assert.match(csv.headers["content-type"], /text\/csv/);
    assert.match(csv.headers["content-disposition"], /attachment; filename="reply-times-/);
    const lines = csv.text.replace(/^﻿/, "").trim().split("\r\n");
    assert.match(lines[0], /^Rank,Name,Team,Chats answered,Median reply \(seconds\)/);
    assert.ok(lines.some((l) => l.startsWith("1,Tina,support,6,120,")), lines.join("\n"));
    const detail = await request(app).get(`/api/reports/team-response/episodes?${range}&userId=${tina.id}&format=csv`).set(owner);
    assert.match(detail.text, /Tina customer/);
    // a name that looks like a formula is exported as text
    await query("UPDATE users SET name='=HYPERLINK(\"x\")' WHERE id=$1", [sam.id]);
    const risky = (await request(app).get(`/api/reports/team-response?${range}&format=csv`).set(owner)).text;
    assert.ok(!/(^|,)=HYPERLINK/m.test(risky) && risky.includes("'=HYPERLINK"));
    await query("UPDATE users SET name='Sam' WHERE id=$1", [sam.id]);
    assert.equal((await get(owner, "?from=2026-01-01&to=2026-12-31")).status, 400);
    assert.equal((await get(owner, "?from=nope")).status, 400);
  });

  await t.test("the daily report: by number and team, with the chats behind each figure", async () => {
    await query("UPDATE conversations SET created_at=to_timestamp($2) WHERE tenant_id=$1 AND contact_name LIKE 'Sam customer%'", [tenantId, T0]);
    const d = (await request(app).get(`/api/reports/daily?date=${YESTERDAY}`).set(owner)).body;
    assert.equal(d.date, YESTERDAY);
    assert.equal(d.newChats, 6);
    assert.ok(d.received >= 14 && d.replied >= 14, JSON.stringify([d.received, d.replied]));
    assert.equal(d.waitingNow, 1);
    assert.equal(d.topAgent.name, "Sam");
    const lineSam = d.numbers.find((x) => x.session === "line-sam");
    assert.deepEqual([lineSam.label, lineSam.team, lineSam.newChats], ["Sam", "sales", 6]);
    assert.ok(d.teams.some((tm) => tm.team === "sales" && tm.answered === 8));
    const chats = (await request(app).get(`/api/reports/daily/chats?date=${YESTERDAY}&sessionName=line-tina`).set(owner)).body.chats;
    assert.ok(chats.length >= 6 && chats.every((c) => c.session === "line-tina"));
    const bySam = (await request(app).get(`/api/reports/daily/chats?date=${YESTERDAY}&userId=${sam.id}`).set(owner)).body.chats;
    assert.ok(bySam.length >= 8 && bySam.every((c) => c.repliedBy === "Sam"));
    assert.equal((await request(app).get("/api/reports/daily?date=yesterday").set(owner)).status, 400);
    assert.equal((await request(app).get(`/api/reports/daily?date=${YESTERDAY}`).set(samAuth)).status, 403);
  });

  await t.test("each morning the owner is told how yesterday went, once, if they want it", async () => {
    const morning = todayStart * 1000 + 6 * 3600 * 1000;
    assert.equal(await sendDailyReports(io, todayStart * 1000 + 3 * 3600 * 1000), 0, "not before 05:00 UTC");
    const sent = await sendDailyReports(io, morning);
    assert.ok(sent >= 1);
    const notes = (await query("SELECT * FROM notifications WHERE tenant_id=$1 AND type='report'", [tenantId])).rows;
    assert.equal(notes.length, 1, "the owner only; Sam and Tina are agents");
    assert.equal(notes[0].user_id, o.user.id);
    assert.match(notes[0].title, /Yesterday in Reports Co/);
    assert.match(notes[0].body, /customer messages in, \d+ replies out/);
    assert.match(notes[0].body, /waiting for a reply/);
    assert.equal(await sendDailyReports(io, morning), 0, "not twice for the same day");
    assert.equal((await query("SELECT count(*)::int n FROM notifications WHERE tenant_id=$1 AND type='report'", [tenantId])).rows[0].n, 1);
    // a company that turned it off hears nothing
    await query("UPDATE report_settings SET daily_in_app=false,last_daily_for=NULL WHERE tenant_id=$1", [tenantId]);
    await sendDailyReports(io, morning);
    assert.equal((await query("SELECT count(*)::int n FROM notifications WHERE tenant_id=$1 AND type='report'", [tenantId])).rows[0].n, 1);
    // and a company with no activity yesterday is not bothered
    assert.equal((await query("SELECT count(*)::int n FROM notifications WHERE tenant_id=$1 AND type='report'", [x.tenant.id])).rows[0].n, 0);
  });
});
