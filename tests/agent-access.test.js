import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { closeSessions } from "../src/services/sessionService.js";
import { agentCompany, bearer, rpc, mcpTool, restTool } from "./helpers/agents.js";

// AI agent access: who may make an agent, what the key is, and when it stops working. WhatsApp is the only thing not real.
after(async () => {
  await closeSessions(io);
  io.close();
});

const KEY = /^scr_ag_[a-f0-9]{40}$/;

test("an owner makes an agent: the key is shown once and only its hash is kept", async () => {
  const c = await agentCompany("keys1");
  const res = await request(app).post("/api/agents").set(c.owner).send({ name: "  Claude   helper ", level: "reply", numbers: ["main-line"] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const agent = res.body.agent;
  assert.match(agent.key, KEY);
  assert.equal(agent.name, "Claude helper", "spaces are tidied");
  assert.equal(agent.level, "reply");
  assert.deepEqual(agent.numbers, ["main-line"]);
  assert.deepEqual(agent.limits, { perHour: 30, perDay: 200, perChatHour: 6, newChatsPerDay: 10 });
  assert.equal(agent.allowNewChats, false, "starting chats with new numbers is off unless the owner turns it on");
  assert.equal(agent.state, "active");
  assert.equal(agent.disclose, true, "an AI agent says it is one unless the owner switches that off");
  assert.equal(agent.sharePhones, false);
  assert.equal(agent.allowGroups, false);
  assert.ok(agent.expiresAt, "a key expires after 90 days unless the owner says never");

  const stored = (await query("SELECT * FROM agent_keys WHERE id=$1", [agent.id])).rows[0];
  assert.equal(stored.key_hash, crypto.createHash("sha256").update(agent.key).digest("hex"));
  assert.ok(!JSON.stringify(stored).includes(agent.key), "the key itself is stored nowhere");
  assert.equal(stored.prefix, agent.key.slice(0, 14));

  const list = await request(app).get("/api/agents").set(c.owner);
  assert.equal(list.status, 200);
  assert.equal(list.body.allowed, true);
  assert.equal(list.body.agents.length, 1);
  assert.ok(!JSON.stringify(list.body).includes(agent.key), "the list never shows the key again");
  assert.deepEqual(list.body.agents[0].usage, { sentLastHour: 0, sentLast24h: 0, callsLast24h: 0 });
  assert.deepEqual(list.body.numbers.map((n) => n.name), ["main-line", "second-line"]);
  assert.deepEqual(list.body.levels.map((l) => l.key), ["read", "reply", "full"]);
  assert.ok(list.body.endpoints.mcp.endsWith("/mcp"));
  const audit = (await query("SELECT metadata FROM audit_events WHERE tenant_id=$1 AND event_type='agent.created'", [c.tenantId])).rows;
  assert.equal(audit.length, 1, "making an agent is written to the audit log");
  assert.ok(!JSON.stringify(audit).includes(agent.key));
});

test("what the owner may choose is checked", async () => {
  const c = await agentCompany("keys2");
  const make = (body) => request(app).post("/api/agents").set(c.owner).send(body);
  assert.equal((await make({ level: "reply" })).body.code, "invalid_name");
  assert.equal((await make({ name: "x".repeat(81), level: "reply" })).body.code, "invalid_name");
  assert.equal((await make({ name: "A" })).body.code, "invalid_level");
  assert.equal((await make({ name: "A", level: "admin" })).body.code, "invalid_level");
  assert.equal((await make({ name: "A", level: "read", numbers: ["nope-line"] })).body.code, "unknown_number");
  assert.equal((await make({ name: "A", level: "read", numbers: "main-line" })).body.code, "invalid_numbers");
  assert.equal((await make({ name: "A", level: "read", perHour: 0 })).body.code, "invalid_setting");
  assert.equal((await make({ name: "A", level: "read", perDay: 100000 })).body.code, "invalid_setting");
  assert.equal((await make({ name: "A", level: "read", allowGroups: "yes" })).body.code, "invalid_setting");
  const never = await make({ name: "Forever", level: "read", expiresInDays: null });
  assert.equal(never.status, 201);
  assert.equal(never.body.agent.expiresAt, null, "an owner may choose a key that never expires");
  const custom = await make({ name: "Custom", level: "full", allowGroups: true, sharePhones: true, disclose: false, perHour: 5, perDay: 20, perChatHour: 2, expiresInDays: 7 });
  assert.deepEqual({ g: custom.body.agent.allowGroups, p: custom.body.agent.sharePhones, d: custom.body.agent.disclose, l: custom.body.agent.limits }, { g: true, p: true, d: false, l: { perHour: 5, perDay: 20, perChatHour: 2, newChatsPerDay: 10 } });
  assert.ok(Math.abs(new Date(custom.body.agent.expiresAt) - (Date.now() + 7 * 86400_000)) < 60_000);
});

test("a company can have ten agents, and revoking one makes room", async () => {
  const c = await agentCompany("keys3");
  const made = [];
  for (let i = 0; i < 10; i++) made.push(await c.makeAgent({ name: `Agent ${i}` }));
  const eleventh = await request(app).post("/api/agents").set(c.owner).send({ name: "One too many", level: "read" });
  assert.equal(eleventh.status, 400);
  assert.equal(eleventh.body.code, "too_many_agents");
  assert.equal((await request(app).delete(`/api/agents/${made[0].id}`).set(c.owner)).status, 200);
  assert.equal((await request(app).post("/api/agents").set(c.owner).send({ name: "Room again", level: "read" })).status, 201);
});

test("only an owner or admin, signed in, may manage agents; the key is no other door", async () => {
  const c = await agentCompany("doors");
  const agent = await c.makeAgent();
  // a teammate (role agent) is refused
  assert.equal((await request(app).get("/api/agents").set(c.sam.auth)).status, 403);
  assert.equal((await request(app).post("/api/agents").set(c.sam.auth).send({ name: "Mine", level: "full" })).status, 403);
  // an API key is refused
  const apiKey = `wpp_${crypto.randomBytes(16).toString("hex")}`;
  await query("INSERT INTO api_keys(id,tenant_id,name,key_hash,prefix,scopes) VALUES(gen_random_uuid(),$1,'k',$2,'wpp_x','[\"inbox\"]')", [c.tenantId, crypto.createHash("sha256").update(apiKey).digest("hex")]);
  assert.equal((await request(app).get("/api/agents").set(bearer(apiKey))).status, 403);
  assert.equal((await request(app).post("/api/agents").set(bearer(apiKey)).send({ name: "Sneaky", level: "full" })).status, 403);
  // and an API key is not an agent key
  assert.equal((await rpc(apiKey, "ping")).status, 401);
  // an agent key cannot manage agents, and cannot use the ordinary API at all
  assert.equal((await request(app).get("/api/agents").set(bearer(agent.key))).status, 401);
  assert.equal((await request(app).post("/api/agents").set(bearer(agent.key)).send({ name: "Child", level: "full" })).status, 401);
  for (const path of ["/api/conversations", "/api/workspace/keys", "/api/sessions", "/api/contacts", "/api/billing/plans", "/api/otp-setup"])
    assert.equal((await request(app).get(path).set(bearer(agent.key))).status, 401, `${path} must not accept an agent key`);
  // nobody signed in at all
  assert.equal((await request(app).get("/api/agents")).status, 401);
});

test("another company's owner can neither see nor change this company's agents", async () => {
  const a = await agentCompany("tenantA");
  const b = await agentCompany("tenantB");
  const agent = await a.makeAgent();
  assert.deepEqual((await request(app).get("/api/agents").set(b.owner)).body.agents, []);
  assert.equal((await request(app).patch(`/api/agents/${agent.id}`).set(b.owner).send({ level: "full" })).status, 404);
  assert.equal((await request(app).delete(`/api/agents/${agent.id}`).set(b.owner)).status, 404);
  assert.equal((await request(app).get(`/api/agents/${agent.id}/prompt`).set(b.owner)).status, 404);
  assert.equal((await request(app).post(`/api/agents/${agent.id}/test`).set(b.owner)).status, 404);
  assert.equal((await rpc(agent.key, "ping")).status, 200, "and it still works for its own company");
});

test("agent access follows the plan: Growth cannot make agents, and a downgrade switches them off without deleting them", async () => {
  const c = await agentCompany("plan1", { plan: "Growth" });
  const blocked = await request(app).post("/api/agents").set(c.owner).send({ name: "Claude", level: "read" });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "plan_required");
  assert.match(blocked.body.message, /isn't included in your Growth plan/);
  const screen = await request(app).get("/api/agents").set(c.owner);
  assert.equal(screen.status, 200, "the screen still opens, so it can say why");
  assert.equal(screen.body.allowed, false);
  assert.match(screen.body.reason, /Growth/);

  await query("UPDATE tenants SET plan='Business' WHERE id=$1", [c.tenantId]);
  const agent = await c.makeAgent();
  assert.equal((await rpc(agent.key, "ping")).status, 200);
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [c.tenantId]);
  const off = await rpc(agent.key, "ping");
  assert.equal(off.status, 403);
  assert.equal(off.body.code, "plan_required");
  // the owner can still revoke it, and nothing was deleted
  assert.equal((await query("SELECT count(*)::int AS n FROM agent_keys WHERE tenant_id=$1", [c.tenantId])).rows[0].n, 1);
  assert.equal((await request(app).delete(`/api/agents/${agent.id}`).set(c.owner)).status, 200);
});

test("a key that is wrong, revoked, expired or whose company is suspended is refused, each with its own reason", async () => {
  const c = await agentCompany("states");
  const agent = await c.makeAgent();
  assert.equal((await rpc(agent.key, "ping")).status, 200);

  const none = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(none.status, 401);
  assert.equal(none.body.code, "missing_key");
  assert.match(none.headers["www-authenticate"], /^Bearer /);
  const wrong = await rpc(`scr_ag_${"0".repeat(40)}`, "ping");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, "invalid_key");
  assert.equal((await rpc("not-a-key", "ping")).body.code, "invalid_key");

  // expired, then renewed by the owner
  await query("UPDATE agent_keys SET expires_at=now() - interval '1 minute' WHERE id=$1", [agent.id]);
  const old = await rpc(agent.key, "ping");
  assert.equal(old.status, 401);
  assert.equal(old.body.code, "key_expired");
  assert.equal((await request(app).get("/api/agents").set(c.owner)).body.agents[0].state, "expired");
  const renewed = await request(app).patch(`/api/agents/${agent.id}`).set(c.owner).send({ expiresInDays: 30 });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.agent.state, "active");
  assert.equal((await rpc(agent.key, "ping")).status, 200, "the same key works again once renewed");

  // a suspended company
  await query("UPDATE tenants SET status='suspended' WHERE id=$1", [c.tenantId]);
  const suspended = await rpc(agent.key, "ping");
  assert.equal(suspended.status, 403);
  assert.equal(suspended.body.code, "workspace_inactive");
  await query("UPDATE tenants SET status='active' WHERE id=$1", [c.tenantId]);

  // revoked: at once, and for good
  assert.equal((await request(app).delete(`/api/agents/${agent.id}`).set(c.owner)).status, 200);
  const gone = await rpc(agent.key, "ping");
  assert.equal(gone.status, 401);
  assert.equal(gone.body.code, "key_revoked");
  assert.equal((await request(app).patch(`/api/agents/${agent.id}`).set(c.owner).send({ level: "full" })).body.code, "key_revoked", "a revoked agent cannot be edited back to life");
  assert.equal((await request(app).delete(`/api/agents/${agent.id}`).set(c.owner)).status, 404, "revoking twice says so");
  assert.equal((await query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND event_type='agent.revoked'", [c.tenantId])).rows[0].n, 1);
});

test("the owner can change what an agent may do, and the change counts on its next call", async () => {
  const c = await agentCompany("edit");
  const agent = await c.makeAgent({ level: "read" });
  const before = await mcpTool(agent.key, "send_message", { conversation_id: "x", text: "hi" });
  assert.match(before.error, /level is "read"/);
  const up = await request(app).patch(`/api/agents/${agent.id}`).set(c.owner).send({ level: "full", numbers: ["second-line"], perHour: 7, allowGroups: true, name: "Renamed" });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.deepEqual({ l: up.body.agent.level, n: up.body.agent.numbers, h: up.body.agent.limits.perHour, g: up.body.agent.allowGroups, name: up.body.agent.name }, { l: "full", n: ["second-line"], h: 7, g: true, name: "Renamed" });
  const overview = await mcpTool(agent.key, "get_overview");
  assert.equal(overview.you.level, "full");
  assert.deepEqual(overview.you.numbers, ["second-line"]);
  assert.equal(overview.you.name, "Renamed");
  // and it can be set back to "all numbers"
  assert.equal((await request(app).patch(`/api/agents/${agent.id}`).set(c.owner).send({ numbers: [] })).body.agent.numbers.length, 0);
  assert.equal((await request(app).patch(`/api/agents/${agent.id}`).set(c.owner).send({})).body.code, "nothing_to_change");
  assert.equal((await request(app).patch(`/api/agents/${agent.id}`).set(c.owner).send({ level: "root" })).body.code, "invalid_level");
});

test("guessing keys is slowed down for the guesser, and not for anyone else", async () => {
  const c = await agentCompany("guess");
  const agent = await c.makeAgent();
  const guesser = { "X-Forwarded-For": "203.0.113.77" };
  let blocked = 0;
  for (let i = 0; i < 46; i++) {
    const res = await rpc(`scr_ag_${crypto.randomBytes(20).toString("hex")}`, "ping", {}, { headers: guesser });
    if (res.status === 429) blocked++;
    else assert.equal(res.status, 401);
  }
  assert.ok(blocked >= 5, `after about 40 wrong keys the address is told to wait (blocked ${blocked})`);
  assert.equal((await rpc(agent.key, "ping", {}, { headers: guesser })).status, 429, "even with the right key, from that address, until the wait is over");
  assert.equal((await rpc(agent.key, "ping", {}, { headers: { "X-Forwarded-For": "203.0.113.78" } })).status, 200, "another address is not affected");
  // calls that work do not count against an address
  for (let i = 0; i < 60; i++) assert.equal((await rpc(agent.key, "ping", {}, { headers: { "X-Forwarded-For": "203.0.113.79" } })).status, 200);
});

test("what an agent did is recorded, without the words of any message, and shown to the owner", async () => {
  const c = await agentCompany("log");
  const agent = await c.makeAgent({ level: "full" });
  const maria = await c.customer("971500001001", "Maria Lopez", { text: "Do you deliver on Friday?" });
  await mcpTool(agent.key, "get_overview");
  await mcpTool(agent.key, "get_conversation", { conversation_id: maria.chat });
  await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "Yes, we deliver on Fridays." });
  await mcpTool(agent.key, "get_conversation", { conversation_id: "does-not-exist" });
  await mcpTool(agent.key, "get_conversation", { conversation_id: maria.chat, bogus: 1 });

  const all = await request(app).get("/api/agents/activity").set(c.owner);
  assert.equal(all.status, 200);
  const events = all.body.events;
  assert.deepEqual(events.map((e) => e.tool), ["get_conversation", "get_conversation", "send_message", "get_conversation", "get_overview"], "newest first");
  assert.deepEqual(events.map((e) => e.ok), [false, false, true, true, true]);
  assert.equal(events[0].errorCode, "invalid_input");
  assert.equal(events[1].errorCode, "not_found");
  assert.equal(events[1].chat, null, "a chat id that matched nothing has no name to show");
  assert.equal(events[2].chat, "Maria Lopez");
  assert.equal(events[2].agent, "Claude helper");
  assert.equal(events[2].via, "mcp");
  assert.ok(!JSON.stringify(events).includes("deliver on Fridays"), "the words of a message are not in the activity record");
  assert.ok(!JSON.stringify(events).includes("Do you deliver"));

  const changes = await request(app).get("/api/agents/activity?changes=true").set(c.owner);
  assert.deepEqual(changes.body.events.map((e) => e.tool), ["send_message"], "the owner can look at only what the agent changed");
  const mine = await request(app).get(`/api/agents/activity?agentId=${agent.id}&limit=2`).set(c.owner);
  assert.equal(mine.body.events.length, 2);
  const older = await request(app).get(`/api/agents/activity?beforeId=${mine.body.events.at(-1).id}`).set(c.owner);
  assert.ok(older.body.events.every((e) => e.id < mine.body.events.at(-1).id));
  assert.equal((await request(app).get("/api/agents/activity").set((await agentCompany("log2")).owner)).body.events.length, 0, "another company sees none of it");

  const list = (await request(app).get("/api/agents").set(c.owner)).body.agents[0];
  assert.deepEqual(list.usage, { sentLastHour: 1, sentLast24h: 1, callsLast24h: 5 });
  assert.ok(list.lastUsedAt, "last use is shown");
  // old rows are pruned, and a reservation nobody finished is closed as failed
  await query("UPDATE agent_events SET created_at=now() - interval '40 days' WHERE tool='get_overview'");
  await query("INSERT INTO agent_events(tenant_id,agent_id,tool,ok,summary,created_at) VALUES($1,$2,'send_message',NULL,'Sending a message',now() - interval '30 minutes')", [c.tenantId, agent.id]);
  const { pumpAgents } = await import("../src/services/agents/activity.js");
  await pumpAgents({ force: true });
  assert.equal((await query("SELECT count(*)::int AS n FROM agent_events WHERE tool='get_overview'")).rows[0].n, 0, "events older than 30 days are deleted");
  assert.equal((await query("SELECT ok,error_code FROM agent_events WHERE agent_id=$1 AND summary='The send did not finish'", [agent.id])).rows[0].ok, false);
});

test("'what will this agent see' runs its overview with its own rules and sends nothing", async () => {
  const c = await agentCompany("probe");
  const agent = await c.makeAgent({ level: "read", numbers: ["second-line"] });
  const res = await request(app).post(`/api/agents/${agent.id}/test`).set(c.owner);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.overview.numbers.map((n) => n.name), ["second-line"]);
  assert.equal(res.body.overview.you.level, "read");
  const ev = (await request(app).get("/api/agents/activity").set(c.owner)).body.events[0];
  assert.equal(ev.via, "test", "a test is marked as one in the activity");
  assert.equal((await query("SELECT last_used_at FROM agent_keys WHERE id=$1", [agent.id])).rows[0].last_used_at, null, "and it is not mistaken for the agent connecting");
  await request(app).delete(`/api/agents/${agent.id}`).set(c.owner);
  assert.equal((await request(app).post(`/api/agents/${agent.id}/test`).set(c.owner)).status, 409);
});

test("deleting a company takes its agents with it", async () => {
  const c = await agentCompany("gone");
  const agent = await c.makeAgent();
  await mcpTool(agent.key, "get_overview");
  await query("DELETE FROM tenants WHERE id=$1", [c.tenantId]);
  assert.equal((await query("SELECT count(*)::int AS n FROM agent_keys WHERE id=$1", [agent.id])).rows[0].n, 0);
  assert.equal((await query("SELECT count(*)::int AS n FROM agent_events WHERE agent_id=$1", [agent.id])).rows[0].n, 0);
  assert.equal((await restTool(agent.key, "get_overview")).status, 401);
});
