import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage, sendTextMessage } from "../src/services/messageService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { asksForPerson, withDisclosure, DISCLOSURE, ACK } from "../src/services/handoffService.js";
import { pumpAutopilot, setRule } from "../src/services/autopilotService.js";
import { setAiClient } from "../src/services/aiService.js";

test("what counts as asking for a person", () => {
  const yes = ["Can I speak to a human?", "I want to talk to a real person", "connect me to customer service", "please transfer me to a representative", "أريد التحدث مع موظف", "mujhe insaan se baat karni hai", "Talk to someone please", "I need a human", "are you a real person?", "Let me speak with the manager", "इंसान से बात करनी है"];
  const no = ["I bought a human hair wig", "The agent in Dubai sent me the contract", "this person is rude", "I want a person to deliver the parcel on Sunday", "What time do you open?", "I spoke to your manager yesterday", "Thanks", "", "x".repeat(400)];
  for (const t of yes) assert.equal(asksForPerson(t), true, t);
  for (const t of no) assert.equal(asksForPerson(t), false, t);
  assert.equal(asksForPerson("human"), false, "on its own it could be about anything");
  assert.equal(asksForPerson("human", { machineAnswering: true }), true, "but after a machine has been answering it is clear");
  assert.equal(asksForPerson("Agent please", { machineAnswering: true }), true);
  assert.equal(withDisclosure("  Hello  "), `Hello\n\n${DISCLOSURE}`);
  assert.match(DISCLOSURE, /Automated reply from Riwo.*"human"/);
});

test("A customer can always reach a person: Riwo stops, the team is told once, and the chat goes first", async (t) => {
  const key = process.env.ANTHROPIC_API_KEY;
  const or = process.env.OPENROUTER_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  const respond = async () => ({ content: [{ type: "text", text: JSON.stringify({ reply_id: null, confidence: "low", tone: "neutral" }) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
  setAiClient({ messages: { create: respond }, beta: { messages: { create: respond } } });
  t.after(async () => {
    setAiClient(undefined);
    key === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = key);
    if (or !== undefined) process.env.OPENROUTER_API_KEY = or;
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@hand.test", password: "Password@123", companyName: "Hand Co" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const mk = async (name, role) => {
    const u = (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [name, `${name.toLowerCase()}@hand.test`])).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)", [tenantId, u.id, role]);
    return { ...u, auth: { Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` } };
  };
  const sam = await mk("Sam", "agent"), tina = await mk("Tina", "agent");
  const owner = { auth: { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` } };
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status,phone,lease_until,last_heartbeat_at,last_heartbeat_ok_at,connected_since) VALUES(gen_random_uuid()::text,$1,'sam-line',$2,'CONNECTED','971500000100',now()+interval '1 hour',now(),now(),now()-interval '1 day')", [tenantId, sam.id]);
  let epoch = Math.floor(Date.now() / 1000) - 7200;
  const hear = (remote, text, name = "Asha Rao", extra = {}) =>
    handleIncomingMessage({ tenantId, sessionName: "sam-line", msg: { providerMessageId: `m_${remote}_${++epoch}`, fromMe: false, remoteId: remote, rawType: "chat", type: "text", text, timestampEpoch: epoch, senderName: name, ack: 2, ...extra } });
  const chat = async (phone) => (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND phone=$2", [tenantId, phone])).rows[0];
  const settle = () => new Promise((r) => setTimeout(r, 250)); // the check runs right after the message is saved
  const notices = async (title) => (await query("SELECT user_id,type,title,body FROM notifications WHERE tenant_id=$1 AND title LIKE $2 ORDER BY user_id", [tenantId, title])).rows;
  const sentTo = async (phone) => (await query("SELECT m.text,m.agent_name FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.tenant_id=$1 AND c.phone=$2 AND m.sender='agent' ORDER BY m.created_at,m.id", [tenantId, phone])).rows;
  const home = async (who) => (await request(app).get("/api/home").set(who.auth)).body;

  await t.test("after a machine has answered, 'human' is enough: the chat is marked, the team told, the customer reassured", async () => {
    await hear("971500000001@c.us", "When do you open?");
    const id = (await chat("971500000001")).id;
    await sendTextMessage({ tenantId, conversationId: id, text: withDisclosure("We open at 9."), idempotencyKey: "riwo-1", agentName: "Riwo" });
    await query("INSERT INTO automations(id,tenant_id,name,trigger_type,trigger_condition,action_type,action_summary) VALUES('a1',$1,'Chat','foreign_number','','ai_chat','x')", [tenantId]);
    await query("INSERT INTO automation_chats(tenant_id,conversation_id,automation_id,status) VALUES($1,$2,'a1','active')", [tenantId, id]);
    await hear("971500000001@c.us", "human");
    await settle();
    const c = await chat("971500000001");
    assert.ok(c.needs_human_since, "marked");
    assert.equal((await query("SELECT status,handed_off_reason FROM automation_chats WHERE conversation_id=$1", [id])).rows[0].status, "handed_off", "Riwo stops talking to them");
    const told = await notices("Asha Rao asked for a person");
    assert.deepEqual(told.map((n) => n.user_id).sort(), [o.user.id, sam.id].sort(), "the owner of the number, and the managers");
    assert.ok(told.every((n) => n.type === "handoff" && n.body === "human"));
    const out = await sentTo("971500000001");
    assert.equal(out.at(-1).text, ACK);
    assert.equal(out.at(-1).agent_name, "Automation", "an acknowledgement is not Riwo answering");
    assert.equal(out.filter((m) => m.text === ACK).length, 1);
  });

  await t.test("asking again does not tell the team again, or reassure twice", async () => {
    await hear("971500000001@c.us", "Can I speak to a human please?");
    await settle();
    assert.equal((await notices("Asha Rao asked for a person")).length, 2);
    assert.equal((await sentTo("971500000001")).filter((m) => m.text === ACK).length, 1);
  });

  await t.test("it is first on Today, with the count, for people who can see the chat", async () => {
    await hear("971500000002@c.us", "Price please", "Ben Hall");
    await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint-9000 WHERE tenant_id=$1 AND phone='971500000002'", [tenantId]); // waited longer
    await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint-120 WHERE tenant_id=$1 AND phone='971500000001'", [tenantId]);
    const h = await home(sam);
    assert.deepEqual(h.needsYou.map((i) => [i.title, i.askedForPerson]), [["Asha Rao", true], ["Ben Hall", false]], "the one who asked comes before the one who has waited longer");
    assert.equal(h.counts.askedForPerson, 1);
    const inbox = (await request(app).get("/api/conversations").set(owner.auth)).body.conversations;
    assert.equal(inbox.find((c) => c.phone === "971500000001").needsHuman, true);
    assert.equal(inbox.find((c) => c.phone === "971500000002").needsHuman, false);
    assert.deepEqual((await home(tina)).needsYou.filter((i) => i.kind === "chat"), [], "Tina cannot see Sam's number's chats");
  });

  await t.test("Autopilot does not answer a customer who asked for a person", async () => {
    await setRule(tenantId, "saved_replies", true, o.user.id);
    await query("INSERT INTO canned_replies(id,tenant_id,shortcut,title,text) VALUES(gen_random_uuid(),$1,'/hours','Opening hours','We open at 9.')", [tenantId]);
    await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint-300 WHERE tenant_id=$1 AND phone='971500000001'", [tenantId]);
    await hear("971500000001@c.us", "and on Friday?");
    await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint-300 WHERE tenant_id=$1 AND phone='971500000001'", [tenantId]);
    const before = (await sentTo("971500000001")).length;
    await pumpAutopilot(null, { force: true });
    assert.equal((await sentTo("971500000001")).length, before);
    assert.equal((await query("SELECT reason FROM autopilot_log l JOIN conversations c ON c.id=l.conversation_id WHERE c.phone='971500000001' ORDER BY l.created_at DESC LIMIT 1")).rows[0].reason, "the customer asked for a person");
  });

  await t.test("Riwo answering does not clear it, a teammate answering does", async () => {
    const id = (await chat("971500000001")).id;
    await sendTextMessage({ tenantId, conversationId: id, text: withDisclosure("More hours"), idempotencyKey: "riwo-2", agentName: "Riwo" });
    assert.ok((await chat("971500000001")).needs_human_since);
    await sendTextMessage({ tenantId, conversationId: id, text: "Hi Asha, this is Sam. How can I help?", idempotencyKey: "sam-1", agentName: "Sam", sentByUserId: sam.id });
    assert.equal((await chat("971500000001")).needs_human_since, null);
    assert.equal((await home(sam)).counts.askedForPerson, 0);
  });

  await t.test("a customer who never spoke to a machine is not sent a reassurance, but the team is still told", async () => {
    await hear("971500000003@c.us", "I'd like to speak to a manager please", "Chitra Das");
    await settle();
    assert.ok((await chat("971500000003")).needs_human_since);
    assert.equal((await notices("Chitra Das asked for a person")).length, 2);
    assert.deepEqual(await sentTo("971500000003"), [], "no machine has spoken, so none speaks now");
  });

  await t.test("groups, your own messages and imported history never trigger it, and an ordinary message does not", async () => {
    await hear("120363000000000001@g.us", "can I talk to a human", "Someone", { isGroup: true, groupName: "Buyers" });
    await handleIncomingMessage({ tenantId, sessionName: "sam-line", history: true, msg: { providerMessageId: "hist-1", fromMe: false, remoteId: "971500000005@c.us", rawType: "chat", type: "text", text: "I want to talk to a real person", timestampEpoch: epoch - 5000, senderName: "Old", ack: 2 } });
    await hear("971500000006@c.us", "What time do you close on Friday?", "Dev");
    await settle();
    const rows = (await query("SELECT phone FROM conversations WHERE tenant_id=$1 AND needs_human_since IS NOT NULL ORDER BY phone", [tenantId])).rows.map((r) => r.phone);
    assert.deepEqual(rows, ["971500000001", "971500000003"].filter((p) => rows.includes(p)));
    assert.ok(!rows.includes("971500000005") && !rows.includes("971500000006") && !rows.some((p) => p.includes("@g.us")));
  });
});
