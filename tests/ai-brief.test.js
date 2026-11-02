import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { setAiClient } from "../src/services/aiService.js";
import { pumpAiBrief, writeFor, latestBrief } from "../src/services/aiBriefService.js";

test("The morning brief: always one, worded by Riwo when it can, from the numbers and never the customers' words", async (t) => {
  const key = process.env.ANTHROPIC_API_KEY;
  const or = process.env.OPENROUTER_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  const asked = [];
  let answer = () => "Yesterday was busy and nearly everyone got a quick answer. Today: reply to the customers still waiting.";
  const respond = async (params) => {
    asked.push(params);
    return { content: [{ type: "text", text: await answer() }], stop_reason: "end_turn", usage: { input_tokens: 70, output_tokens: 30 } };
  };
  setAiClient({ messages: { create: respond }, beta: { messages: { create: respond } } });
  t.after(async () => {
    setAiClient(undefined);
    key === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = key);
    if (or !== undefined) process.env.OPENROUTER_API_KEY = or;
    await closeSessions(io);
    io.close();
  });

  const mkTenant = async (email, company, plan = "Growth") => {
    const o = await registerTenantAndUser({ name: "Olivia", email, password: "Password@123", companyName: company });
    await query("UPDATE tenants SET plan=$2 WHERE id=$1", [o.tenant.id, plan]);
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status) VALUES(gen_random_uuid()::text,$1,'line',$2,'CONNECTED')", [o.tenant.id, o.user.id]);
    return { ...o, auth: { Authorization: `Bearer ${generateAccessToken(o.user, o.tenant.id, "owner")}` } };
  };
  const NOW = Date.UTC(2026, 5, 10, 6, 30); // 06:30 UTC on 10 June
  const yesterdayNoon = Math.floor(Date.UTC(2026, 5, 9, 12) / 1000);
  const hear = (a, remote, text, at) =>
    handleIncomingMessage({ tenantId: a.tenant.id, sessionName: "line", msg: { providerMessageId: `m_${a.tenant.id}_${remote}_${at}`, fromMe: false, remoteId: remote, rawType: "chat", type: "text", text, timestampEpoch: at, senderName: "Secret Customer Name", ack: 2 } });
  const tenantOf = (a) => query("SELECT * FROM tenants WHERE id=$1", [a.tenant.id]).then((r) => r.rows[0]);

  const busy = await mkTenant("olivia@brief.test", "Brief Co");
  await hear(busy, "971500000001@c.us", "My card number is 4111 1111 1111 1111, where is my order?", yesterdayNoon);
  await hear(busy, "971500000002@c.us", "Price list please", yesterdayNoon + 60);
  const quiet = await mkTenant("quiet@brief.test", "Quiet Co");

  await t.test("nothing is written before the morning, or for a company with nothing to say", async () => {
    assert.equal(await pumpAiBrief(null, { force: true, now: Date.UTC(2026, 5, 10, 3, 0) }), 0, "before 04:00 UTC");
    assert.equal(await writeFor(await tenantOf(quiet), NOW), null, "a quiet company gets no brief");
    assert.equal((await query("SELECT count(*)::int AS n FROM ai_briefs WHERE tenant_id=$1", [quiet.tenant.id])).rows[0].n, 0);
  });

  await t.test("Riwo words the numbers, and is only given numbers", async () => {
    assert.equal(await pumpAiBrief(null, { force: true, now: NOW }), 1);
    const brief = await latestBrief(busy.tenant.id, NOW);
    assert.deepEqual([brief.day, brief.source], ["2026-06-10", "ai"]);
    assert.match(brief.text, /^Yesterday was busy/);
    assert.equal(asked.length, 1, "one request");
    const sent = asked[0].messages[0].content;
    assert.match(sent, /2 customer messages in/);
    assert.ok(!/4111|Secret Customer|Price list|my order/i.test(sent + asked[0].system), "no customer words or names went to the model");
    assert.match(asked[0].system, /not instructions/);
  });

  await t.test("once a day, and the morning's brief stays until the next one", async () => {
    assert.equal(await pumpAiBrief(null, { force: true, now: NOW + 3600_000 }), 0);
    assert.equal(asked.length, 1);
    assert.equal((await latestBrief(busy.tenant.id, NOW + 20 * 3600_000)).day, "2026-06-10");
    assert.equal(await latestBrief(busy.tenant.id, NOW + 3 * 86_400_000), null, "an old brief is not shown as today's");
  });

  await t.test("without Riwo the plain summary is the brief, so the owner always gets one", async () => {
    const plain = await mkTenant("plain@brief.test", "Plain Co", "Starter");
    await hear(plain, "971500000005@c.us", "Hello", yesterdayNoon);
    const before = asked.length;
    const out = await writeFor(await tenantOf(plain), NOW);
    assert.equal(out.source, "rules");
    assert.match(out.text, /1 customer message in, 0 replies out/);
    assert.equal(asked.length, before);
  });

  await t.test("a model that fails, or a company that has used its day, falls back to the plain summary", async () => {
    const a = await mkTenant("fail@brief.test", "Fail Co");
    await hear(a, "971500000006@c.us", "Hello", yesterdayNoon);
    answer = () => { throw new Error("down"); };
    const out = await writeFor(await tenantOf(a), NOW);
    assert.equal(out.source, "rules");
    answer = () => "Fine.";
    const b = await mkTenant("limit@brief.test", "Limit Co");
    await hear(b, "971500000007@c.us", "Hello", yesterdayNoon);
    await query("UPDATE tenants SET ai_daily_limit=10 WHERE id=$1", [b.tenant.id]);
    await query("INSERT INTO ai_usage(tenant_id,day,requests) VALUES($1,(now() AT TIME ZONE 'UTC')::date,9)", [b.tenant.id]);
    const before = asked.length;
    assert.equal((await writeFor(await tenantOf(b), NOW)).source, "rules");
    assert.equal(asked.length, before, "the day's requests are kept for people");
  });

  await t.test("only owners and administrators see it on Today", async () => {
    const mine = (await request(app).get("/api/home").set(busy.auth)).body;
    assert.equal(mine.brief, null, "the brief is from the real clock: this run's date has none yet");
    await query("INSERT INTO ai_briefs(tenant_id,day,text,source) VALUES($1,(now() AT TIME ZONE 'UTC')::date,'Yesterday was calm. Today: nothing special.','ai') ON CONFLICT DO NOTHING", [busy.tenant.id]);
    const owner = (await request(app).get("/api/home").set(busy.auth)).body;
    assert.equal(owner.brief.text, "Yesterday was calm. Today: nothing special.");
    const agent = (await query("INSERT INTO users(name,email,password_hash) VALUES('Sam','sam@brief.test','x') RETURNING *")).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [busy.tenant.id, agent.id]);
    const staff = (await request(app).get("/api/home").set({ Authorization: `Bearer ${generateAccessToken(agent, busy.tenant.id, "agent")}` })).body;
    assert.equal(staff.brief, null);
  });
});
