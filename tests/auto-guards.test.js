import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { pumpAutomations } from "../src/services/automationService.js";
import { setAiClient } from "../src/services/aiService.js";
import { digitsOf, sameNumber } from "../src/services/personGuard.js";
import { closeSessions } from "../src/services/sessionService.js";

test("Numbers are compared the way people write them", () => {
  assert.equal(digitsOf("919971694047@c.us"), "919971694047");
  assert.equal(digitsOf("+91 99716 94047"), "919971694047");
  assert.equal(digitsOf("919971694047:12@c.us"), "919971694047", "a linked device is not part of the number");
  assert.equal(digitsOf(null), "");
  assert.ok(sameNumber("919971694047@c.us", "+91 99716 94047"));
  assert.ok(sameNumber("9971694047", "919971694047"), "with or without the country code");
  assert.ok(!sameNumber("919971694047", "919971694048"));
  assert.ok(!sameNumber("12345678", "9912345678"), "a short fragment is never taken for a number");
  assert.ok(!sameNumber("", "919971694047"));
});

test("Nothing automatic is sent after a person has answered, and your own numbers are never answered", async (t) => {
  const key = process.env.ANTHROPIC_API_KEY;
  const or = process.env.OPENROUTER_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  const asked = [];
  let whileThinking = null; // what happens in the chat while the model is still writing
  let answer = () => ({ reply: "Thanks for getting in touch. What are you looking for?", needs_person: false, ready_to_hand_off: false, collected: {} });
  const respond = async (params) => {
    asked.push(params);
    if (whileThinking) await whileThinking();
    return { content: [{ type: "text", text: JSON.stringify(answer(params)) }], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 90 } };
  };
  setAiClient({ messages: { create: respond }, beta: { messages: { create: respond } } });
  t.after(async () => {
    setAiClient(undefined);
    key === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = key);
    if (or !== undefined) process.env.OPENROUTER_API_KEY = or;
    await closeSessions(io);
    io.close();
  });

  const o = await registerTenantAndUser({ name: "Karn", email: "karn@guards.test", password: "Password@123", companyName: "Scriza" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  const sessionRow = (name, phone) => query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,phone,status) VALUES(gen_random_uuid()::text,$1,$2,$3,$4,'CONNECTED')", [tenantId, name, o.user.id, phone]);
  await sessionRow("main-line", "919971694047@c.us");
  await sessionRow("second-line", "971500000000");
  await query("INSERT INTO knowledge_profile(tenant_id,overview,products,notes) VALUES($1,$2,$3,$4)", [tenantId, "Scriza builds business software for companies in the UAE and India.", JSON.stringify([]), "Free demos are 30 minutes."]);

  let n = 0;
  const ingest = (phone, text, fromMe = false) => {
    n += 1;
    return handleIncomingMessage({ tenantId, sessionName: "main-line", msg: { providerMessageId: `g_${n}`, fromMe, remoteId: `${phone}@c.us`, rawType: "chat", type: "text", text, timestampEpoch: Math.floor(Date.now() / 1000) + n, senderName: fromMe ? "You" : "Asha", ack: fromMe ? 1 : 2 } });
  };
  const automatic = async (phone) => (await query("SELECT m.text FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.tenant_id=$1 AND c.phone=$2 AND m.agent_name IN ('Riwo','Automation') AND m.type='text' ORDER BY m.created_at", [tenantId, phone])).rows.map((r) => r.text);
  const executions = async () => (await query("SELECT e.status,e.error FROM automation_executions e WHERE e.tenant_id=$1 ORDER BY e.created_at", [tenantId])).rows;
  const reset = async () => {
    for (const table of ["automation_chats", "automation_executions", "automations"]) await query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
    asked.length = 0;
    whileThinking = null;
  };
  const makeRule = async (body) => {
    await reset();
    const res = await request(app).post("/api/automations").set(owner).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await request(app).patch(`/api/automations/${res.body.automation.id}/toggle`).set(owner);
  };
  const agentRule = () => makeRule({ name: "Riwo agent", triggerType: "first_message", actionType: "ai_chat", config: { reply: "", useKnowledge: true, knowledge: "", agent: { enabled: true, goal: "Find out what they need and book a call", playbook: "Be warm.", closeWith: "book_demo" } } });
  const welcomeRule = () => makeRule({ name: "Welcome", triggerType: "first_message", actionType: "reply_text", actionSummary: "Hello {{name}}, thanks for writing to us." });

  await t.test("a person who answers before the rule runs is not talked over (a welcome message)", async () => {
    await welcomeRule();
    await ingest("919800000001", "Hi, I paid the invoice");
    await ingest("919800000001", "Thanks, received! (typed on the phone)", true);
    await pumpAutomations();
    assert.deepEqual(await automatic("919800000001"), []);
    assert.deepEqual(await executions(), [{ status: "skipped", error: "A person had already answered this message" }]);
  });

  await t.test("the same for Riwo's agent: the model is not even asked", async () => {
    await agentRule();
    await ingest("919800000002", "Photo and reference number: 219649833567");
    await ingest("919800000002", "[Photo] forwarded receipt", true);
    await pumpAutomations();
    assert.deepEqual(await automatic("919800000002"), []);
    assert.equal(asked.length, 0, "no AI request was made");
    assert.equal((await query("SELECT count(*)::int AS n FROM automation_chats WHERE tenant_id=$1 AND status='active'", [tenantId])).rows[0].n, 0, "Riwo never took the chat");
  });

  await t.test("a person who answers while the model is still writing wins: the reply is dropped, not sent", async () => {
    await agentRule();
    await ingest("919800000003", "Hello, I need a website");
    whileThinking = async () => {
      whileThinking = null;
      await ingest("919800000003", "Hi! Karn here, calling you now", true);
    };
    await pumpAutomations();
    assert.equal(asked.length, 1, "the model was asked: nobody had answered yet");
    assert.deepEqual(await automatic("919800000003"), [], "but what it wrote was never sent");
    assert.deepEqual((await executions()).map((e) => e.status), ["skipped"]);
    // and the next thing the customer writes does not bring Riwo back: a person has the chat
    await ingest("919800000003", "Great, talk to you in a minute");
    await pumpAutomations();
    assert.deepEqual(await automatic("919800000003"), []);
    assert.equal(asked.length, 1);
  });

  await t.test("a person who answers between the customer's message and the rule starting still ends it for good", async () => {
    await agentRule();
    await ingest("919800000004", "Do you build apps?");
    await pumpAutomations(); // Riwo answers the first message normally
    assert.equal((await automatic("919800000004")).length, 1);
    await ingest("919800000004", "Yes, mostly for retail", false);
    await ingest("919800000004", "Karn here, I will take it from here", true);
    await pumpAutomations();
    assert.equal((await automatic("919800000004")).length, 1, "no second automatic reply");
  });

  await t.test("a private note is not an answer", async () => {
    await agentRule();
    await ingest("919800000005", "Hello, do you have a demo?");
    const conv = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND phone='919800000005'", [tenantId])).rows[0];
    await query("INSERT INTO messages(id,tenant_id,conversation_id,idempotency_key,sender,agent_name,text,type,status,ack,timestamp,timestamp_epoch) VALUES(gen_random_uuid()::text,$1,$2,'note-1','agent','Karn','new lead, be nice','internal_note','sent',1,now(),extract(epoch from now())::bigint+50)", [tenantId, conv.id]);
    await pumpAutomations();
    assert.equal((await automatic("919800000005")).length, 1, "Riwo still answers");
  });

  await t.test("a note to yourself and a chat with another of your numbers are never answered", async () => {
    await welcomeRule();
    await ingest("919971694047", "Remember to pay the vendor"); // this inbox's own number, arriving as if from someone else
    await ingest("971500000000", "Test from my other line"); // another number the company has connected
    await pumpAutomations();
    assert.deepEqual(await automatic("919971694047"), []);
    assert.deepEqual(await automatic("971500000000"), []);
    assert.deepEqual(await executions(), []);
    // a customer on the same rule is still welcomed
    await ingest("919800000006", "Hi there");
    await pumpAutomations();
    assert.deepEqual(await automatic("919800000006"), ["Hello Asha, thanks for writing to us."]);
  });

  await t.test("the owner's own number is recognised without the country code, and with the device suffix", async () => {
    await welcomeRule();
    await ingest("9971694047", "Local format of my own number");
    await pumpAutomations();
    assert.deepEqual(await automatic("9971694047"), []);
  });
});
