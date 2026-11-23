import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { closeSessions } from "../src/services/sessionService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { agentCompany, mcpTool, restTool, rpc } from "./helpers/agents.js";

// An AI agent starting a chat with a number the company has not messaged: off unless the owner allows it, capped per day, and made with the
// same checks as the inbox's own "new chat". WhatsApp is the only thing not real.
after(async () => {
  await closeSessions(io);
  io.close();
});

const notOnWhatsApp = new Set();
provider.checkNumber = async (_t, _s, phone) => (notOnWhatsApp.has(phone) ? { checked: true, exists: false } : { checked: true, exists: true, jid: `${phone}@c.us` });

let n = 0;
const fresh = () => `97150${String(7700000 + ++n)}`; // a number nobody has written to
const allow = (c, agent, body = {}) => request(app).patch(`/api/agents/${agent.id}`).set(c.owner).send({ allowNewChats: true, ...body });
const start = (agent, args) => mcpTool(agent.key, "message_new_number", args);
const chatsOf = async (tenantId, phone) => (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND phone=$2", [tenantId, phone])).rows;
const contactsOf = async (tenantId, phone) => (await query("SELECT * FROM contacts WHERE tenant_id=$1 AND phone=$2", [tenantId, phone])).rows;

test("an agent cannot start chats with new numbers until the owner allows it, and then the tool appears", async () => {
  const c = await agentCompany("newchat1");
  const agent = await c.makeAgent({ level: "full" });
  const names = async () => (await rpc(agent.key, "tools/list")).body.result.tools.map((t) => t.name);
  assert.ok(!(await names()).includes("message_new_number"), "not even offered");
  assert.equal((await mcpTool(agent.key, "get_overview")).you.mayStartChatsWithNewNumbers, false);
  const phone = fresh();
  const refused = await start(agent, { phone, text: "Hello", number: "main-line" });
  assert.match(refused.error, /not allowed for this agent.*Do not retry/s);
  const viaRest = await restTool(agent.key, "message_new_number", { phone, text: "Hello", number: "main-line" });
  assert.deepEqual([viaRest.status, viaRest.body.code], [403, "new_chats_off"]);
  assert.deepEqual(await chatsOf(c.tenantId, phone), []);
  assert.deepEqual(await contactsOf(c.tenantId, phone), [], "nothing was made");

  const on = await allow(c, agent, { newChatsPerDay: 3 });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual([on.body.agent.allowNewChats, on.body.agent.limits.newChatsPerDay], [true, 3]);
  assert.ok((await names()).includes("message_new_number"), "offered once allowed");
  const overview = (await mcpTool(agent.key, "get_overview")).you;
  assert.deepEqual([overview.mayStartChatsWithNewNumbers, overview.limits.newChatsPer24Hours], [true, 3]);
  // a read-only agent cannot be given it: it can send nothing at all
  const reader = await c.makeAgent({ name: "Reader", level: "read" });
  await allow(c, reader);
  assert.ok(!(await rpc(reader.key, "tools/list")).body.result.tools.some((t) => t.name === "message_new_number"));
  assert.match((await mcpTool(reader.key, "message_new_number", { phone: fresh(), text: "x" })).error, /level is "read"/);
});

test("it starts a chat: a new contact, a new chat, the first message from the agent, on every record", async () => {
  const c = await agentCompany("newchat2");
  const agent = await c.makeAgent({ level: "reply", name: "Outreach helper" });
  await allow(c, agent);
  const phone = fresh();

  // two numbers are connected: it must say which to send from
  assert.match((await start(agent, { phone: `+${phone}`, text: "Hello" })).error, /Say which number to send from: main-line, second-line/);
  assert.deepEqual(await chatsOf(c.tenantId, phone), []);

  const res = await start(agent, { phone: `+${phone.slice(0, 3)} ${phone.slice(3, 5)} ${phone.slice(5)}`, text: "Hi Omar, this is Acme about your quote request.", number: "second-line", name: "Omar Farouk" });
  assert.equal(res.sent, true, JSON.stringify(res));
  assert.deepEqual([res.startedNewChat, res.contactCreated], [true, true]);
  assert.match(res.note, /may restrict a number that messages people who have not written first/);

  const [chat] = await chatsOf(c.tenantId, phone);
  assert.deepEqual([chat.session_name, chat.provider_chat_id, chat.contact_name], ["second-line", `${phone}@c.us`, "Omar Farouk"]);
  assert.equal(res.conversationId, chat.id);
  const [contact] = await contactsOf(c.tenantId, phone);
  assert.deepEqual([contact.name, contact.name_edited], ["Omar Farouk", true]);

  const m = (await query("SELECT * FROM messages WHERE id=$1", [res.messageId])).rows[0];
  assert.deepEqual([m.sender, m.agent_name, m.sent_via, m.status], ["agent", "Outreach helper", "ai_agent", "sending"]);
  assert.equal(m.text, "Hi Omar, this is Acme about your quote request.", "nothing is added to the first message unless the AI line is on");
  const out = (await query("SELECT payload FROM outbox_events WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='message.outgoing'", [c.tenantId, m.id])).rows;
  assert.deepEqual([out.length, out[0].payload.sessionName, out[0].payload.to], [1, "second-line", `${phone}@c.us`]);
  const ledger = (await query("SELECT source,text FROM automation_audit WHERE tenant_id=$1", [c.tenantId])).rows;
  assert.deepEqual([ledger.length, ledger[0].source, ledger[0].text], [1, "external_agent", m.text]);

  const events = (await request(app).get(`/api/agents/activity?agentId=${agent.id}&changes=true`).set(c.owner)).body.events;
  assert.deepEqual(events.filter((e) => e.ok).map((e) => [e.tool, e.ok]).sort(), [["message_new_number", true], ["send_message", true]]);
  assert.ok(events.some((e) => e.tool === "message_new_number" && e.ok === false), "the first try, that did not say which number, is on the record as refused");
  assert.equal(events.find((e) => e.tool === "message_new_number" && e.ok).chat, "Omar Farouk");
  // the agent can read the chat it started, and the team sees it in the inbox
  assert.equal((await mcpTool(agent.key, "get_conversation", { conversation_id: chat.id })).messages.at(-1).from, "ai_agent");
  assert.ok((await request(app).get(`/api/conversations/${chat.id}/messages`).set(c.owner)).body.messages.some((x) => x.sentVia === "ai_agent"));
});

test("with one connected number it needs no 'number'; a known contact is not made again", async () => {
  const c = await agentCompany("newchat3", { numbers: ["only-line"] });
  const agent = await c.makeAgent({ level: "full", disclose: false });
  await allow(c, agent);
  // the contact is already known from another chat, so only the chat is new
  const known = fresh();
  await query("INSERT INTO contacts(id,tenant_id,name,phone) VALUES(gen_random_uuid()::text,$1,'Known Kate',$2)", [c.tenantId, known]);
  const res = await start(agent, { phone: known, text: "Hello Kate" });
  assert.deepEqual([res.sent, res.startedNewChat, res.contactCreated], [true, true, false]);
  assert.equal((await chatsOf(c.tenantId, known))[0].contact_name, "Known Kate");
  assert.equal((await contactsOf(c.tenantId, known)).length, 1);
  assert.equal((await query("SELECT text FROM messages WHERE id=$1", [res.messageId])).rows[0].text, "Hello Kate", "the AI line is off for this agent");
});

test("a number that already has a chat gets the message in that chat, without using a new-chat allowance", async () => {
  const c = await agentCompany("newchat4");
  const agent = await c.makeAgent({ level: "reply", disclose: false });
  await allow(c, agent, { newChatsPerDay: 1 });
  const maria = await c.customer("971500044001", "Maria Lopez", { text: "Hello" });
  const res = await start(agent, { phone: "971500044001", text: "Following up on your order.", number: "main-line" });
  assert.deepEqual([res.sent, res.startedNewChat, res.conversationId], [true, false, maria.chat]);
  assert.match(res.note, /already existed/);
  assert.equal((await chatsOf(c.tenantId, "971500044001")).length, 1, "no second chat");
  // the one new chat a day is still there to use
  assert.equal((await start(agent, { phone: fresh(), text: "Hi", number: "main-line" })).startedNewChat, true);
  // the same person on the other number is a new chat
  const other = await start(agent, { phone: "971500044001", text: "Hello again", number: "second-line" });
  assert.match(other.error, /already started 1 chats with new numbers in 24 hours \(its limit is 1\)/);
});

test("it will not start a chat with a number that is not on WhatsApp, an opted-out person, the company's own number, or on a number it may not use", async () => {
  const c = await agentCompany("newchat5");
  const agent = await c.makeAgent({ level: "reply", numbers: ["second-line"] });
  await allow(c, agent);
  const errorOf = async (args) => (await start(agent, { number: "second-line", text: "Hello", ...args })).error;
  const gone = fresh();
  notOnWhatsApp.add(gone);
  assert.match(await errorOf({ phone: gone }), /is not on WhatsApp/);
  assert.deepEqual(await contactsOf(c.tenantId, gone), [], "no contact is made for a number that is not on WhatsApp");
  assert.match(await errorOf({ phone: "00000000" }), /not a phone number/);
  const opted = fresh();
  await query("INSERT INTO suppressions(tenant_id,phone) VALUES($1,$2)", [c.tenantId, opted]);
  assert.match(await errorOf({ phone: opted }), /opted out/);
  assert.deepEqual(await contactsOf(c.tenantId, opted), []);
  const own = (await query("SELECT phone FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name='main-line'", [c.tenantId])).rows[0].phone;
  assert.match(await errorOf({ phone: own }), /one of the company's own WhatsApp numbers/);
  assert.match(await errorOf({ phone: fresh(), number: "main-line" }), /may not use that number/);
  await query("UPDATE whatsapp_sessions SET status='DISCONNECTED' WHERE tenant_id=$1 AND session_name='second-line'", [c.tenantId]);
  assert.match((await start(agent, { phone: fresh(), text: "Hello" })).error, /None of the numbers this agent may use is connected/);
  assert.match(await errorOf({ phone: fresh(), number: "second-line" }), /not connected/);
  assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND sender='agent'", [c.tenantId])).rows[0].n, 0, "nothing was sent");
  // none of that used the daily allowance
  await query("UPDATE whatsapp_sessions SET status='CONNECTED' WHERE tenant_id=$1 AND session_name='second-line'", [c.tenantId]);
  assert.equal((await start(agent, { phone: fresh(), text: "Hello" })).startedNewChat, true);
});

test("the daily cap holds, also for a rush at once, and failed tries do not count", async () => {
  const c = await agentCompany("newchat6");
  const agent = await c.makeAgent({ level: "reply", disclose: false, perHour: 50, perDay: 100, perChatHour: 50 });
  await allow(c, agent, { newChatsPerDay: 2 });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => start(agent, { phone: fresh(), text: `Hello ${i}`, number: "main-line" })));
  assert.equal(results.filter((r) => r.sent).length, 2, JSON.stringify(results.map((r) => r.sent || r.error)));
  assert.equal(results.filter((r) => /limit is 2/.test(r.error || "")).length, 4);
  assert.equal((await query("SELECT count(*)::int AS n FROM conversations WHERE tenant_id=$1", [c.tenantId])).rows[0].n, 2, "only two chats were made");
  assert.equal((await query("SELECT count(*)::int AS n FROM agent_events WHERE agent_id=$1 AND tool='message_new_number' AND ok IS NULL", [agent.id])).rows[0].n, 0, "no reservation is left open");
  const limited = await restTool(agent.key, "message_new_number", { phone: fresh(), text: "One more", number: "main-line" });
  assert.deepEqual([limited.status, limited.body.code], [429, "limit_reached"]);
  assert.ok(limited.body.retryAfter > 0 && limited.body.retryAfter <= 86400);
  assert.match(limited.body.fix, /Do not look for another way to reach new people/);
  // a day later it may start more
  await query("UPDATE agent_events SET created_at=now() - interval '25 hours' WHERE agent_id=$1", [agent.id]);
  assert.equal((await start(agent, { phone: fresh(), text: "Next day", number: "main-line" })).startedNewChat, true);
});

test("the limits for new numbers and for existing customers are separate: neither uses up the other", async () => {
  const c = await agentCompany("newchat10");
  const maria = await c.customer("971500090001", "Maria Lopez");
  const agent = await c.makeAgent({ level: "reply", disclose: false, perHour: 1, perDay: 100, perChatHour: 50 });
  await allow(c, agent, { newChatsPerHour: 2, newChatsPerDay: 50 });
  assert.equal((await mcpTool(agent.key, "get_overview")).you.limits.newChatsPerHour, 2);
  // one reply to an existing customer uses the whole existing-customer hour (the limit is 1) ...
  assert.equal((await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "Hello Maria" })).sent, true);
  assert.match((await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "Hello again" })).error, /limit of 1 messages an hour/);
  // ... and the new-number limit is still all there: two chats with new numbers go out, the third is refused
  assert.equal((await start(agent, { phone: fresh(), text: "a", number: "main-line" })).startedNewChat, true);
  assert.equal((await start(agent, { phone: fresh(), text: "b", number: "main-line" })).startedNewChat, true);
  const third = await restTool(agent.key, "message_new_number", { phone: fresh(), text: "c", number: "main-line" });
  assert.deepEqual([third.status, third.body.code], [429, "limit_reached"]);
  assert.match(third.body.message, /2 chats with new numbers in the last hour \(its limit is 2 an hour\)/);
  assert.ok(third.body.retryAfter > 0 && third.body.retryAfter <= 3600);
  // using up the new-number limit does not stop replies to existing customers: a fresh hour for them, the new-number cap still full
  await query("UPDATE agent_events SET created_at=now() - interval '61 minutes' WHERE agent_id=$1 AND conversation_id=$2", [agent.id, maria.chat]);
  assert.equal((await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "Hello once more" })).sent, true);
  assert.equal((await restTool(agent.key, "message_new_number", { phone: fresh(), text: "d", number: "main-line" })).status, 429);
  // the first messages did not count against the existing-customer limits; the reply did
  assert.equal((await query("SELECT count(*)::int AS n FROM agent_events WHERE agent_id=$1 AND tool='send_message' AND first_message", [agent.id])).rows[0].n, 2);
  // an hour later the new-number hour is free again
  await query("UPDATE agent_events SET created_at=now() - interval '61 minutes' WHERE agent_id=$1 AND tool='message_new_number'", [agent.id]);
  assert.equal((await start(agent, { phone: fresh(), text: "e", number: "main-line" })).startedNewChat, true);
});

test("a chat that already exists is an existing customer: the message uses the existing-customer limits, not the new-number ones", async () => {
  const c = await agentCompany("newchat11");
  const maria = await c.customer("971500090002", "Maria Lopez");
  const agent = await c.makeAgent({ level: "reply", disclose: false, perHour: 50, perDay: 100, perChatHour: 50 });
  await allow(c, agent, { newChatsPerHour: 1, newChatsPerDay: 1 });
  for (const text of ["one", "two", "three"]) assert.equal((await start(agent, { phone: "971500090002", text, number: "main-line" })).startedNewChat, false, text);
  assert.equal((await query("SELECT count(*)::int AS n FROM agent_events WHERE agent_id=$1 AND tool='message_new_number'", [agent.id])).rows[0].n, 0, "no new-chat allowance used");
  assert.equal((await start(agent, { phone: fresh(), text: "new", number: "main-line" })).startedNewChat, true, "and the new-number limit is untouched");
});

test("trying again with the same number and words sends once, and uses one new-chat allowance", async () => {
  const c = await agentCompany("newchat7");
  const agent = await c.makeAgent({ level: "reply", disclose: false });
  await allow(c, agent, { newChatsPerDay: 5 });
  const phone = fresh();
  const first = await start(agent, { phone, text: "Hello there", number: "main-line" });
  const again = await start(agent, { phone, text: "Hello there", number: "main-line" });
  assert.deepEqual([first.startedNewChat, again.startedNewChat, again.duplicate], [true, false, true]);
  assert.equal(again.messageId, first.messageId);
  assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND sender='agent'", [c.tenantId])).rows[0].n, 1);
  assert.equal((await query("SELECT count(*)::int AS n FROM agent_events WHERE agent_id=$1 AND tool='message_new_number' AND ok IS TRUE", [agent.id])).rows[0].n, 1);
});

test("the rules the agent is given say whether it may start chats, and the copied prompt lists the tool only when allowed", async () => {
  const c = await agentCompany("newchat8");
  const agent = await c.makeAgent({ level: "reply" });
  const prompt = async () => (await request(app).get(`/api/agents/${agent.id}/prompt?mode=rest`).set(c.owner)).body.prompt;
  const rules = async () => (await request(app).get("/api/agent/v1/prompt?format=text").set({ Authorization: `Bearer ${agent.key}` })).text;
  assert.match(await rules(), /You cannot start a chat with a new number/);
  assert.ok(!(await prompt()).includes("message_new_number("));
  await allow(c, agent, { newChatsPerDay: 4 });
  const on = await rules();
  assert.match(on, /You may start a chat with a number that has not been messaged before, with message_new_number: only a number the user gave you/);
  assert.match(on, /at most 5 new chats in an hour and 4 in 24 hours/);
  assert.match(on, /send nothing more unless the person answers/);
  assert.match(await prompt(), /- message_new_number\(phone, text, number\?, name\?, idempotency_key\?\)/);
  const reader = await c.makeAgent({ name: "Reader", level: "read" });
  const readerRules = (await request(app).get("/api/agent/v1/prompt?format=text").set({ Authorization: `Bearer ${reader.key}` })).text;
  assert.ok(!/new number/.test(readerRules), "a read-only agent is told nothing about it");
});

test("the settings are checked: the caps are whole numbers (1 to 200 a day, 1 to 100 an hour), and the switch is true or false", async () => {
  const c = await agentCompany("newchat9");
  const make = (body) => request(app).post("/api/agents").set(c.owner).send({ name: "A", level: "reply", ...body });
  assert.equal((await make({ newChatsPerDay: 0 })).body.code, "invalid_setting");
  assert.equal((await make({ newChatsPerDay: 201 })).body.code, "invalid_setting");
  assert.equal((await make({ newChatsPerHour: 0 })).body.code, "invalid_setting");
  assert.equal((await make({ newChatsPerHour: 101 })).body.code, "invalid_setting");
  assert.equal((await make({ allowNewChats: "yes" })).body.code, "invalid_setting");
  const ok = await make({ allowNewChats: true, newChatsPerDay: 25, newChatsPerHour: 7 });
  assert.deepEqual([ok.status, ok.body.agent.allowNewChats, ok.body.agent.limits.newChatsPerDay, ok.body.agent.limits.newChatsPerHour], [201, true, 25, 7]);
  const edited = await request(app).patch(`/api/agents/${ok.body.agent.id}`).set(c.owner).send({ newChatsPerHour: 3 });
  assert.deepEqual([edited.body.agent.limits.newChatsPerHour, edited.body.agent.limits.newChatsPerDay], [3, 25], "changing one leaves the other");
});
