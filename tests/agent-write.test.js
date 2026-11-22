import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { closeSessions } from "../src/services/sessionService.js";
import { sendTextMessage } from "../src/services/messageService.js";
import { verifyChain } from "../src/services/auditTrail.js";
import { personAnswered } from "../src/services/personGuard.js";
import { DISCLOSURE } from "../src/services/agents/config.js";
import { agentCompany, mcpTool, restTool } from "./helpers/agents.js";

// What an agent can change, and the limits that hold it back. WhatsApp is the only thing not real: a message is saved and queued for
// the sender, exactly as when a teammate sends it, and these tests look at what was saved and queued.
after(async () => {
  await closeSessions(io);
  io.close();
});

const eventually = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
};
const msg = async (id) => (await query("SELECT * FROM messages WHERE id=$1", [id])).rows[0];
const outbox = async (tenantId, messageId) => (await query("SELECT * FROM outbox_events WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='message.outgoing'", [tenantId, messageId])).rows;
const chatRow = async (id) => (await query("SELECT * FROM conversations WHERE id=$1", [id])).rows[0];
const WITH_LINE = (text) => `${text}\n\n${DISCLOSURE}`;

test("an agent answers a customer: it goes out as the agent, labelled as an AI, and is on every record", async () => {
  const c = await agentCompany("send1");
  const maria = await c.customer("971500020001", "Maria Lopez", { text: "Do you deliver on Friday?" });
  const agent = await c.makeAgent({ name: "Claude helper", level: "reply", disclose: true });
  assert.notEqual((await chatRow(maria.chat)).awaiting_since, null, "the customer is waiting");

  const sent = await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "Yes, we deliver on Fridays." });
  assert.deepEqual({ sent: sent.sent, duplicate: sent.duplicate, conversationId: sent.conversationId }, { sent: true, duplicate: false, conversationId: maria.chat });
  const m = await msg(sent.messageId);
  assert.equal(m.sender, "agent");
  assert.equal(m.agent_name, "Claude helper");
  assert.equal(m.sent_via, "ai_agent");
  assert.equal(m.sent_by_user_id, null, "no teammate is blamed for it");
  assert.equal(m.status, "sending");
  assert.equal(m.text, WITH_LINE("Yes, we deliver on Fridays."), "with the AI line switched on, it is added so the customer knows");
  assert.match(m.text, /Reply "human" to talk to a person\.$/);

  // queued for the number the chat is on, to the customer, as the team's own messages are
  const out = await outbox(c.tenantId, m.id);
  assert.equal(out.length, 1);
  assert.deepEqual({ session: out[0].payload.sessionName, to: out[0].payload.to, text: out[0].payload.text, conv: out[0].payload.conversationId }, { session: "main-line", to: "971500020001@c.us", text: m.text, conv: maria.chat });

  const chat = await chatRow(maria.chat);
  assert.equal(chat.awaiting_since, null, "an answer ends the customer's wait");
  assert.match(chat.last_message.text, /^Yes, we deliver on Fridays\./);

  // the AI accountability record has it, whole, and its chain is intact
  const ledger = (await query("SELECT * FROM automation_audit WHERE tenant_id=$1", [c.tenantId])).rows;
  assert.equal(ledger.length, 1);
  assert.deepEqual({ source: ledger[0].source, rule: ledger[0].rule_ref, message: ledger[0].message_id, provider: ledger[0].provider, text: ledger[0].text }, { source: "external_agent", rule: `Claude helper (${agent.id})`, message: m.id, provider: "MCP", text: m.text });
  assert.equal((await verifyChain(c.tenantId)).ok, true);

  // the activity, the usage, and what the agent itself reads back
  const events = (await request(app).get("/api/agents/activity").set(c.owner)).body.events;
  assert.deepEqual([events[0].tool, events[0].ok, events[0].chat], ["send_message", true, "Maria Lopez"]);
  assert.equal((await mcpTool(agent.key, "get_overview")).you.sentLastHour, 1);
  const seen = (await mcpTool(agent.key, "get_conversation", { conversation_id: maria.chat })).messages.at(-1);
  assert.deepEqual({ from: seen.from, by: seen.by, text: seen.text }, { from: "ai_agent", by: "Claude helper", text: m.text });

  // and the inbox the team uses can tell which messages came from an AI agent
  const inbox = await request(app).get(`/api/conversations/${maria.chat}/messages`).set(c.owner);
  assert.equal(inbox.status, 200);
  const shown = inbox.body.messages.find((x) => x.id === m.id);
  assert.equal(shown.sentVia, "ai_agent");
  assert.equal(shown.agentName, "Claude helper");
});

test("sending the same thing twice sends it once; a key makes a retry safe", async () => {
  const c = await agentCompany("send2");
  const maria = await c.customer("971500020002", "Maria Lopez");
  const agent = await c.makeAgent({ level: "reply" });
  const first = await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "On its way." });
  const again = await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "On its way." });
  assert.equal(again.duplicate, true);
  assert.equal(again.messageId, first.messageId);
  assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender='agent'", [maria.chat])).rows[0].n, 1);
  assert.equal((await mcpTool(agent.key, "get_overview")).you.sentLastHour, 1, "a retry is not counted against the limits");

  const k1 = await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "Anything else?", idempotency_key: "retry-1" });
  const k2 = await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "Anything else?", idempotency_key: "retry-1" });
  assert.equal(k2.messageId, k1.messageId);
  assert.equal(k2.duplicate, true);
  const clash = await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "Something different", idempotency_key: "retry-1" });
  assert.match(clash.error, /already used for a different message/);
  assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender='agent'", [maria.chat])).rows[0].n, 2);
  assert.equal((await query("SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id=$1 AND event_type='message.outgoing'", [c.tenantId])).rows[0].n, 2);
  assert.match((await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "x", idempotency_key: "k".repeat(65) })).error, /at most 64/);
  // two agents may use the same key text without touching each other
  const other = await c.makeAgent({ name: "Another agent", level: "reply" });
  const theirs = await mcpTool(other.key, "send_message", { conversation_id: maria.chat, text: "Anything else?", idempotency_key: "retry-1" });
  assert.notEqual(theirs.messageId, k1.messageId);
});

test("nothing is added to an agent's words unless the owner switches the AI line on", async () => {
  const c = await agentCompany("send3");
  const maria = await c.customer("971500020003", "Maria Lopez");
  const on = await c.makeAgent({ name: "With line", level: "reply", disclose: true });
  const off = await c.makeAgent({ name: "Without line", level: "reply" });
  assert.equal((await mcpTool(off.key, "get_overview")).you.aiLineAddedToMessages, false);
  const sent = await mcpTool(off.key, "send_message", { conversation_id: maria.chat, text: "Plain words." });
  assert.equal((await msg(sent.messageId)).text, "Plain words.", "the customer sees exactly what the agent wrote");
  assert.equal((await msg(sent.messageId)).sent_via, "ai_agent", "the team still sees it was an agent");
  const sent2 = await mcpTool(on.key, "send_message", { conversation_id: maria.chat, text: "Plain words again." });
  assert.equal((await msg(sent2.messageId)).text, WITH_LINE("Plain words again."));
});

test("an agent cannot send where it should not: another number, a group, an offline number, an opted-out person, a bad message", async () => {
  const c = await agentCompany("send4");
  const onMain = await c.customer("971500020004", "Main Customer");
  const onSecond = await c.customer("971500020005", "Second Customer", { line: "second-line" });
  const group = await c.group("Staff group");
  const agent = await c.makeAgent({ level: "full", numbers: ["second-line"], disclose: false });
  const errorOf = async (args) => (await mcpTool(agent.key, "send_message", args)).error;
  const count = async () => (await query("SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND sender='agent'", [c.tenantId])).rows[0].n;

  assert.match(await errorOf({ conversation_id: onMain.chat, text: "hi" }), /may not use the number this chat is on/);
  const groupAgent = await c.makeAgent({ name: "No groups", level: "reply" });
  assert.match((await mcpTool(groupAgent.key, "send_message", { conversation_id: group, text: "hi" })).error, /group chat/);
  assert.match(await errorOf({ conversation_id: "nope", text: "hi" }), /was not found/);
  assert.match(await errorOf({ conversation_id: onSecond.chat, text: "   " }), /at least 1 characters|must be at least/);
  assert.match(await errorOf({ conversation_id: onSecond.chat, text: "x".repeat(4001) }), /at most 4000/);
  assert.match(await errorOf({ conversation_id: onSecond.chat, text: 5 }), /must be text/);
  assert.match(await errorOf({ conversation_id: onSecond.chat }), /"text" is required/);
  assert.match(await errorOf({ conversation_id: onSecond.chat, text: "hi", bogus: true }), /Unknown argument "bogus"/);
  assert.equal(await count(), 0, "nothing was sent by any of that");

  // an offline number
  await query("UPDATE whatsapp_sessions SET status='DISCONNECTED' WHERE tenant_id=$1 AND session_name='second-line'", [c.tenantId]);
  const offline = await restTool(agent.key, "send_message", { conversation_id: onSecond.chat, text: "hi" });
  assert.equal(offline.status, 409);
  assert.equal(offline.body.code, "number_offline");
  assert.match(offline.body.fix, /Do not retry/);
  await query("UPDATE whatsapp_sessions SET status='CONNECTED' WHERE tenant_id=$1 AND session_name='second-line'", [c.tenantId]);

  // a person who opted out
  const phone = (await chatRow(onSecond.chat)).phone;
  await query("INSERT INTO suppressions(tenant_id,phone) VALUES($1,$2)", [c.tenantId, phone]);
  const optedOut = await restTool(agent.key, "send_message", { conversation_id: onSecond.chat, text: "hi" });
  assert.equal(optedOut.status, 403);
  assert.equal(optedOut.body.code, "recipient_opted_out");
  assert.equal(await count(), 0);
  await query("DELETE FROM suppressions WHERE tenant_id=$1", [c.tenantId]);

  // none of the failures used up any of the allowance, and each is on the record as a failure
  assert.equal((await mcpTool(agent.key, "get_overview")).you.sentLastHour, 0);
  const sends = (await request(app).get(`/api/agents/activity?agentId=${agent.id}&limit=100`).set(c.owner)).body.events.filter((e) => e.tool === "send_message");
  assert.ok(sends.length >= 8 && sends.every((e) => e.ok === false), "every refused send is recorded as not sent");
  assert.ok(sends.some((e) => e.errorCode === "number_offline") && sends.some((e) => e.errorCode === "recipient_opted_out"));
  const ok = await mcpTool(agent.key, "send_message", { conversation_id: onSecond.chat, text: "Now it works." });
  assert.equal(ok.sent, true);
});

test("a quoted message must be one of the same chat", async () => {
  const c = await agentCompany("quote1");
  const a = await c.customer("971500020006", "Chat A", { text: "question in A" });
  const b = await c.customer("971500020007", "Chat B", { text: "private words of B" });
  const agent = await c.makeAgent({ level: "reply", disclose: false });
  const idIn = async (chat) => (await mcpTool(agent.key, "get_conversation", { conversation_id: chat })).messages[0].id;
  const foreign = await mcpTool(agent.key, "send_message", { conversation_id: a.chat, text: "answer", reply_to_message_id: await idIn(b.chat) });
  assert.match(foreign.error, /not a message of this chat/);
  assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender='agent'", [a.chat])).rows[0].n, 0);
  const good = await mcpTool(agent.key, "send_message", { conversation_id: a.chat, text: "answer", reply_to_message_id: await idIn(a.chat) });
  assert.equal(good.sent, true);
  assert.equal((await msg(good.messageId)).quoted_message_id, await idIn(a.chat));
  const shown = (await mcpTool(agent.key, "get_conversation", { conversation_id: a.chat })).messages.at(-1);
  assert.equal(shown.replyTo.text, "question in A");
  assert.ok(!JSON.stringify(shown).includes("private words of B"));
});

test("limits hold: to one chat, an hour, a day; failures cost nothing; a rush cannot slip past", async () => {
  const c = await agentCompany("limits1");
  const chats = [];
  for (let i = 1; i <= 8; i++) chats.push(await c.customer(`97150002100${i}`, `Customer ${i}`));
  const say = (agent, chat, text) => mcpTool(agent.key, "send_message", { conversation_id: chat.chat, text });

  // to one chat
  const perChat = await c.makeAgent({ name: "Per chat", level: "reply", perChatHour: 2, perHour: 50, disclose: false });
  assert.equal((await say(perChat, chats[0], "one")).sent, true);
  assert.equal((await say(perChat, chats[0], "two")).sent, true);
  const third = await restTool(perChat.key, "send_message", { conversation_id: chats[0].chat, text: "three" });
  assert.equal(third.status, 429);
  assert.equal(third.body.code, "limit_reached");
  assert.match(third.body.message, /already sent 2 messages to this chat in the last hour \(its limit is 2\)/);
  assert.ok(third.body.retryAfter > 0 && third.body.retryAfter <= 3600);
  assert.equal(third.headers["retry-after"], String(third.body.retryAfter));
  assert.match(third.body.fix, /Do not keep messaging the same customer/);
  assert.equal((await say(perChat, chats[1], "another chat is fine")).sent, true);
  assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender='agent'", [chats[0].chat])).rows[0].n, 2);

  // an hour, across chats
  const perHour = await c.makeAgent({ name: "Per hour", level: "reply", perHour: 3, perChatHour: 10, disclose: false });
  for (let i = 0; i < 3; i++) assert.equal((await say(perHour, chats[i], `hello ${i}`)).sent, true);
  assert.match((await say(perHour, chats[3], "too many")).error, /limit of 3 messages an hour/);

  // a day
  const perDay = await c.makeAgent({ name: "Per day", level: "reply", perDay: 2, perHour: 10, perChatHour: 10, disclose: false });
  await say(perDay, chats[4], "a");
  await say(perDay, chats[5], "b");
  assert.match((await say(perDay, chats[6], "c")).error, /limit of 2 messages in 24 hours/);
  // the hour window moves on: sends older than an hour no longer count against the hour, but still against the day
  await query("UPDATE agent_events SET created_at=now() - interval '2 hours' WHERE agent_id=$1", [perDay.id]);
  assert.match((await say(perDay, chats[6], "c")).error, /24 hours/);
  await query("UPDATE agent_events SET created_at=now() - interval '25 hours' WHERE agent_id=$1", [perDay.id]);
  assert.equal((await say(perDay, chats[6], "c")).sent, true, "a day later it may send again");

  // a rush of eight at once, with room for three
  const rush = await c.makeAgent({ name: "Rush", level: "reply", perHour: 3, perChatHour: 10, disclose: false });
  const results = await Promise.all(chats.map((chat, i) => say(rush, chat, `rush ${i}`)));
  assert.equal(results.filter((r) => r.sent).length, 3, JSON.stringify(results.map((r) => r.sent || r.error)));
  assert.equal(results.filter((r) => /limit of 3 messages an hour/.test(r.error || "")).length, 5);
  assert.equal((await query("SELECT count(*)::int AS n FROM agent_events WHERE agent_id=$1 AND tool='send_message' AND ok IS TRUE", [rush.id])).rows[0].n, 3);
  assert.equal((await query("SELECT count(*)::int AS n FROM agent_events WHERE agent_id=$1 AND tool='send_message' AND ok IS NULL", [rush.id])).rows[0].n, 0, "no reservation is left open");
  assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE sent_via='ai_agent' AND agent_name='Rush'")).rows[0].n, 3);

  // a send that fails is given back
  const care = await c.makeAgent({ name: "Careful", level: "reply", perHour: 1, disclose: false });
  await query("UPDATE whatsapp_sessions SET status='DISCONNECTED' WHERE tenant_id=$1", [c.tenantId]);
  assert.match((await say(care, chats[0], "offline")).error, /not connected/);
  await query("UPDATE whatsapp_sessions SET status='CONNECTED' WHERE tenant_id=$1", [c.tenantId]);
  assert.equal((await say(care, chats[0], "online")).sent, true, "the failed try did not use the one message it had");
  // each agent has its own allowance
  assert.equal((await mcpTool(perHour.key, "get_overview")).you.sentLastHour, 3);
  assert.equal((await mcpTool(care.key, "get_overview")).you.sentLastHour, 1);
});

test("a note is for the team only, notifies them, and can be repeated safely; marking read clears the badge", async () => {
  const c = await agentCompany("note1");
  const maria = await c.customer("971500022001", "Maria Lopez", { text: "Please call me" });
  await query("UPDATE conversations SET assigned_user_id=$2,assigned_to=$3 WHERE id=$1", [maria.chat, c.sam.id, c.sam.name]);
  const agent = await c.makeAgent({ level: "reply" });
  const read = await c.makeAgent({ name: "Reader", level: "read" });
  assert.match((await mcpTool(read.key, "add_note", { conversation_id: maria.chat, text: "x" })).error, /needs "reply"/);
  assert.match((await mcpTool(read.key, "mark_read", { conversation_id: maria.chat })).error, /needs "reply"/);

  const note = await mcpTool(agent.key, "add_note", { conversation_id: maria.chat, text: "Customer wants a call back this evening. @Sam Agent" });
  assert.equal(note.noted, true);
  const m = await msg(note.messageId);
  assert.deepEqual({ type: m.type, status: m.status, via: m.sent_via, by: m.agent_name, user: m.sent_by_user_id }, { type: "internal_note", status: "sent", via: "ai_agent", by: "Claude helper", user: null });
  assert.equal((await outbox(c.tenantId, m.id)).length, 0, "a note is never sent to WhatsApp");
  assert.equal((await query("SELECT count(*)::int AS n FROM automation_audit WHERE tenant_id=$1", [c.tenantId])).rows[0].n, 0, "and is not an automated message to a customer");
  const told = await eventually(async () => (await query("SELECT * FROM notifications WHERE tenant_id=$1 AND user_id=$2", [c.tenantId, c.sam.id])).rows[0]);
  assert.ok(told, "the teammate named in the note is told");
  assert.match(told.title, /Claude helper left a team note/);
  const shown = (await mcpTool(agent.key, "get_conversation", { conversation_id: maria.chat })).messages.at(-1);
  assert.deepEqual([shown.from, shown.by], ["note", "Claude helper"]);
  assert.equal((await mcpTool(agent.key, "add_note", { conversation_id: maria.chat, text: "Customer wants a call back this evening. @Sam Agent" })).duplicate, true);
  assert.match((await mcpTool(agent.key, "add_note", { conversation_id: maria.chat, text: "x".repeat(2001) })).error, /at most 2000/);

  assert.equal((await chatRow(maria.chat)).unread_count, 1);
  assert.equal((await mcpTool(agent.key, "mark_read", { conversation_id: maria.chat })).read, true);
  assert.equal((await chatRow(maria.chat)).unread_count, 0);
});

test("a full agent runs the inbox: assigns, closes, labels and makes follow-ups, each told to the right person", async () => {
  const c = await agentCompany("full1");
  const maria = await c.customer("971500023001", "Maria Lopez");
  const agent = await c.makeAgent({ level: "full" });
  const labelId = crypto.randomUUID();
  await query("INSERT INTO labels(id,tenant_id,name,color) VALUES($1,$2,'VIP','blue'),($3,$2,'Wholesale','green')", [labelId, c.tenantId, crypto.randomUUID()]);

  // assigning
  const assigned = await mcpTool(agent.key, "assign_conversation", { conversation_id: maria.chat, assignee: "sam agent" });
  assert.deepEqual(assigned, { assignedTo: "Sam Agent", conversationId: maria.chat });
  const row = await chatRow(maria.chat);
  assert.deepEqual([row.assigned_user_id, row.assigned_to], [c.sam.id, "Sam Agent"]);
  assert.ok(await eventually(async () => (await query("SELECT * FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND type='assignment'", [c.tenantId, c.sam.id])).rows[0]), "Sam is told");
  const unknown = await mcpTool(agent.key, "assign_conversation", { conversation_id: maria.chat, assignee: "Nobody Atall" });
  assert.match(unknown.error, /no active teammate called "Nobody Atall"/);
  assert.match(unknown.error, /Sam Agent/, "and it says who there is");
  assert.deepEqual(await mcpTool(agent.key, "assign_conversation", { conversation_id: maria.chat, assignee: "nobody" }), { assignedTo: null, conversationId: maria.chat });
  assert.deepEqual([(await chatRow(maria.chat)).assigned_user_id, (await chatRow(maria.chat)).assigned_to], [null, ""]);

  // closing and reopening
  assert.equal((await mcpTool(agent.key, "set_status", { conversation_id: maria.chat, status: "closed" })).status, "closed");
  assert.equal((await chatRow(maria.chat)).is_closed, true);
  await mcpTool(agent.key, "set_status", { conversation_id: maria.chat, status: "open" });
  assert.equal((await chatRow(maria.chat)).is_closed, false);
  assert.match((await mcpTool(agent.key, "set_status", { conversation_id: maria.chat, status: "deleted" })).error, /must be one of: closed, open/);

  // labels: only those that exist
  const added = await mcpTool(agent.key, "update_labels", { conversation_id: maria.chat, add: ["vip", "Wholesale"] });
  assert.deepEqual(added.added.sort(), ["VIP", "Wholesale"]);
  assert.deepEqual((await mcpTool(agent.key, "list_conversations", { filter: "all" })).chats[0].labels, ["VIP", "Wholesale"]);
  const removed = await mcpTool(agent.key, "update_labels", { conversation_id: maria.chat, remove: ["VIP"] });
  assert.deepEqual(removed.removed, ["VIP"]);
  assert.deepEqual((await mcpTool(agent.key, "list_conversations", { filter: "all" })).chats[0].labels, ["Wholesale"]);
  const made = await mcpTool(agent.key, "update_labels", { conversation_id: maria.chat, add: ["Brand new label"] });
  assert.match(made.error, /No label called "Brand new label"/);
  assert.match(made.error, /cannot make new labels/);
  assert.equal((await query("SELECT count(*)::int AS n FROM labels WHERE tenant_id=$1", [c.tenantId])).rows[0].n, 2, "an agent cannot make labels");
  assert.match((await mcpTool(agent.key, "update_labels", { conversation_id: maria.chat })).error, /Say which labels/);

  // follow-ups
  await query("UPDATE conversations SET assigned_user_id=$2,assigned_to=$3 WHERE id=$1", [maria.chat, c.sam.id, c.sam.name]);
  const task = await mcpTool(agent.key, "create_task", { conversation_id: maria.chat, title: "Send the price list", due_in_hours: 24 });
  assert.equal(task.created, true);
  const t = (await query("SELECT * FROM lead_tasks WHERE id=$1", [task.taskId])).rows[0];
  assert.deepEqual({ conv: t.conversation_id, lead: t.lead_id, user: t.assigned_user_id, by: t.created_by, done: t.done_at }, { conv: maria.chat, lead: null, user: c.sam.id, by: null, done: null }, "it goes to whoever has the chat");
  assert.ok(Math.abs(new Date(t.due_at) - (Date.now() + 24 * 3600_000)) < 60_000);
  assert.ok(await eventually(async () => (await query("SELECT * FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND type='lead_task'", [c.tenantId, c.sam.id])).rows[0]), "Sam is told of the follow-up");
  const dated = await mcpTool(agent.key, "create_task", { conversation_id: maria.chat, title: "Renewal call", due_at: "2030-01-02T10:00:00+04:00", assignee: "Sam Agent" });
  assert.equal(dated.dueAt, "2030-01-02T06:00:00.000Z");
  assert.match((await mcpTool(agent.key, "create_task", { conversation_id: maria.chat, title: "No time" })).error, /Say when it is due/);
  assert.match((await mcpTool(agent.key, "create_task", { conversation_id: maria.chat, title: "Bad", due_at: "someday" })).error, /Say when it is due/);
  assert.deepEqual((await mcpTool(agent.key, "list_tasks")).tasks.map((x) => x.title), ["Send the price list", "Renewal call"]);
  assert.equal((await mcpTool(agent.key, "complete_task", { task_id: task.taskId })).done, true);
  assert.notEqual((await query("SELECT done_at FROM lead_tasks WHERE id=$1", [task.taskId])).rows[0].done_at, null);
  assert.deepEqual((await mcpTool(agent.key, "list_tasks")).tasks.map((x) => x.title), ["Renewal call"]);
  assert.match((await mcpTool(agent.key, "complete_task", { task_id: task.taskId })).error, /not found, or it is already done/);

  // not for groups, and not outside its numbers
  const groupAgent = await c.makeAgent({ name: "Groups", level: "full", allowGroups: true });
  const group = await c.group("Staff group");
  assert.match((await mcpTool(groupAgent.key, "create_task", { conversation_id: group, title: "x", due_in_hours: 2 })).error, /not a group/);
  const second = await c.makeAgent({ name: "Second only", level: "full", numbers: ["second-line"] });
  assert.match((await mcpTool(second.key, "complete_task", { task_id: dated.taskId })).error, /not found/, "a follow-up on a chat it may not use is out of reach");
  assert.match((await mcpTool(second.key, "set_status", { conversation_id: maria.chat, status: "closed" })).error, /may not use the number/);

  // each change is on the record
  const changes = (await request(app).get(`/api/agents/activity?agentId=${agent.id}&changes=true&limit=100`).set(c.owner)).body.events;
  assert.ok(["assign_conversation", "set_status", "update_labels", "create_task", "complete_task"].every((tool) => changes.some((e) => e.tool === tool && e.ok)));
});

test("an agent can only do what its level says, whatever it asks for", async () => {
  const c = await agentCompany("levels1");
  const maria = await c.customer("971500024001", "Maria Lopez");
  const read = await c.makeAgent({ name: "Reader", level: "read" });
  const reply = await c.makeAgent({ name: "Replier", level: "reply" });
  const base = { conversation_id: maria.chat };
  const needsReply = [["send_message", { ...base, text: "hi" }], ["add_note", { ...base, text: "n" }], ["mark_read", base]];
  const needsFull = [["assign_conversation", { ...base, assignee: "nobody" }], ["set_status", { ...base, status: "closed" }], ["update_labels", { ...base, add: ["x"] }], ["create_task", { ...base, title: "t", due_in_hours: 1 }], ["complete_task", { task_id: "t" }]];
  for (const [tool, args] of [...needsReply, ...needsFull]) {
    assert.match((await mcpTool(read.key, tool, args)).error, /level is "read"/, `${tool} must be refused to a read-only agent`);
    const viaRest = await restTool(read.key, tool, args);
    assert.equal(viaRest.status, 403);
    assert.equal(viaRest.body.code, "level_too_low");
  }
  for (const [tool, args] of needsFull) assert.match((await mcpTool(reply.key, tool, args)).error, /level is "reply"/, `${tool} must be refused to a reply-level agent`);
  assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender='agent'", [maria.chat])).rows[0].n, 0);
  const row = await chatRow(maria.chat);
  assert.deepEqual([row.is_closed, row.assigned_user_id, row.unread_count], [false, null, 1], "nothing changed");
  assert.equal((await mcpTool(read.key, "list_conversations", {})).chats.length, 1, "but it can look");
});

test("a customer who answers an AI agent with 'human' is handed to a person, and only a person ends that", async () => {
  const c = await agentCompany("human1");
  const agent = await c.makeAgent({ level: "reply", disclose: false });
  // the control: when only a teammate has answered, a lone "human" is not a request (it could be about anything)
  const control = await c.customer("971500025002", "Control Customer", { text: "hello" });
  await sendTextMessage({ tenantId: c.tenantId, conversationId: control.chat, text: "Hi", idempotencyKey: "ctl-1", agentName: c.sam.name, sentByUserId: c.sam.id });
  await c.says(control, "human");
  assert.equal((await chatRow(control.chat)).needs_human_since, null);

  const maria = await c.customer("971500025001", "Maria Lopez", { text: "Where is my order?" });
  await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "Let me check that for you." });
  const asked = await eventually(async () => {
    await c.says(maria, "human");
    return (await chatRow(maria.chat)).needs_human_since;
  }, 500);
  assert.ok(asked, "an AI agent counts as a machine answering, so one word is enough");
  const overview = await mcpTool(agent.key, "get_overview");
  assert.equal(overview.inbox.askedForAPerson, 1);
  const item = (await mcpTool(agent.key, "list_conversations", { filter: "needs_human" })).chats[0];
  assert.deepEqual([item.name, item.needsHuman], ["Maria Lopez", true]);
  assert.ok(await eventually(async () => (await query("SELECT * FROM notifications WHERE tenant_id=$1 AND type='handoff'", [c.tenantId])).rows[0]), "the team is told");

  // the agent answering again does not end the request; a teammate's answer does
  await mcpTool(agent.key, "send_message", { conversation_id: maria.chat, text: "A person will be with you soon." });
  assert.ok((await chatRow(maria.chat)).needs_human_since, "an AI agent cannot clear a request for a person");
  await sendTextMessage({ tenantId: c.tenantId, conversationId: maria.chat, text: "Hi Maria, Sam here.", idempotencyKey: "sam-1", agentName: c.sam.name, sentByUserId: c.sam.id });
  assert.equal((await chatRow(maria.chat)).needs_human_since, null);

  // and Riwo and the automations keep out of a chat an agent has answered, as they do after a teammate
  const inbound = (await query("SELECT * FROM messages WHERE conversation_id=$1 AND sender<>'agent' ORDER BY timestamp_epoch,id LIMIT 1", [maria.chat])).rows[0];
  assert.equal(await personAnswered(inbound), true);
});
