import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { closeSessions } from "../src/services/sessionService.js";
import { sendTextMessage } from "../src/services/messageService.js";
import { agentCompany, mcpTool } from "./helpers/agents.js";

// What an agent can look at, and what it is not shown. Everything goes through the tools an MCP client would call.
after(async () => {
  await closeSessions(io);
  io.close();
});

const label = async (c, name, contactId = null) => {
  const id = crypto.randomUUID();
  await query("INSERT INTO labels(id,tenant_id,name,color) VALUES($1,$2,$3,'blue')", [id, c.tenantId, name]);
  if (contactId) await query("INSERT INTO contact_labels(contact_id,label_id,tenant_id) VALUES($1,$2,$3)", [contactId, id, c.tenantId]);
  return id;
};
const teamReply = (c, chat, text) => sendTextMessage({ tenantId: c.tenantId, conversationId: chat, text, idempotencyKey: `t-${crypto.randomUUID()}`, agentName: c.sam.name, sentByUserId: c.sam.id });

test("the overview says who the agent is, what it may use, and what is waiting", async () => {
  const c = await agentCompany("over1");
  const agent = await c.makeAgent({ level: "reply" });
  await c.customer("971500010001", "Maria Lopez", { text: "Do you deliver on Friday?" });
  await c.customer("971500010002", "Ravi Kumar", { line: "second-line", text: "Price of the blue one?" });
  const asked = await c.customer("971500010003", "Asha Rao", { text: "I want to talk to a human please" });
  await c.group("Staff group");
  const o = await mcpTool(agent.key, "get_overview");
  assert.equal(o.company, "over1 Stores");
  assert.ok(Math.abs(new Date(o.now) - Date.now()) < 5000);
  assert.deepEqual(o.you, {
    name: "Claude helper",
    level: "reply",
    numbers: "all",
    groupChats: false,
    customerPhoneNumbers: "hidden",
    limits: { messagesPerHour: 30, messagesPer24Hours: 200, messagesPerChatPerHour: 6 },
    sentLastHour: 0,
    sentLast24Hours: 0,
    aiLineAddedToMessages: true,
  });
  assert.deepEqual(o.numbers.map((n) => [n.name, n.connected]), [["main-line", true], ["second-line", true]]);
  assert.equal(o.inbox.openChats, 3, "the group is not counted: this agent may not use groups");
  assert.equal(o.inbox.unreadChats, 3);
  assert.equal(o.inbox.waitingForReply, 3);
  assert.equal(o.inbox.askedForAPerson, 1);
  assert.equal(o.inbox.replyTargetMinutes, 30);
  assert.ok(asked.chat);

  // a teammate answers one: it stops waiting
  const maria = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND contact_name='Maria Lopez'", [c.tenantId])).rows[0].id;
  await teamReply(c, maria, "Yes we do.");
  assert.equal((await mcpTool(agent.key, "get_overview")).inbox.waitingForReply, 2);
  // an old wait counts as longer than the target
  await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint - 3600 WHERE tenant_id=$1 AND contact_name='Ravi Kumar'", [c.tenantId]);
  assert.equal((await mcpTool(agent.key, "get_overview")).inbox.waitingLongerThanTarget, 1);
});

test("an agent that may use one number sees nothing of the others", async () => {
  const c = await agentCompany("scope1");
  const all = await c.makeAgent({ name: "All numbers", level: "full" });
  const one = await c.makeAgent({ name: "Second only", level: "full", numbers: ["second-line"] });
  const maria = await c.customer("971500011001", "Maria Lopez", { text: "Friday delivery?" });
  const ravi = await c.customer("971500011002", "Ravi Kumar", { line: "second-line", text: "Friday price?" });
  const chats = async (key, args = {}) => (await mcpTool(key, "list_conversations", args)).chats.map((x) => x.name).sort();
  assert.deepEqual(await chats(all.key), ["Maria Lopez", "Ravi Kumar"]);
  assert.deepEqual(await chats(one.key), ["Ravi Kumar"]);
  assert.deepEqual((await mcpTool(one.key, "get_overview")).numbers.map((n) => n.name), ["second-line"]);
  assert.equal((await mcpTool(one.key, "get_overview")).inbox.openChats, 1);
  assert.deepEqual((await mcpTool(one.key, "list_numbers")).numbers.map((n) => n.name), ["second-line"]);
  // it cannot open, search, or ask for the other number
  assert.equal((await mcpTool(one.key, "get_conversation", { conversation_id: maria.chat })).error.includes("may not use the number"), true);
  assert.match((await mcpTool(one.key, "get_messages", { conversation_id: maria.chat })).error, /may not use the number/);
  assert.match((await mcpTool(one.key, "list_conversations", { number: "main-line" })).error, /may not use that number/);
  assert.match((await mcpTool(one.key, "search_messages", { query: "Friday", number: "main-line" })).error, /may not use that number/);
  const found = await mcpTool(one.key, "search_messages", { query: "Friday" });
  assert.deepEqual(found.messages.map((m) => m.chat), ["Ravi Kumar"], "words in the other number's chats are not found");
  assert.deepEqual(found.chats.length, 0);
  assert.equal((await mcpTool(all.key, "search_messages", { query: "Friday" })).messages.length, 2);
  assert.ok(ravi.chat);
});

test("group chats are hidden unless the owner allows them", async () => {
  const c = await agentCompany("groups1");
  const without = await c.makeAgent({ level: "full" });
  const withGroups = await c.makeAgent({ name: "Groups too", level: "full", allowGroups: true });
  const group = await c.group("Staff group");
  await c.customer("971500012001", "Maria Lopez");
  assert.deepEqual((await mcpTool(without.key, "list_conversations", { filter: "all" })).chats.map((x) => x.name), ["Maria Lopez"]);
  assert.match((await mcpTool(without.key, "get_conversation", { conversation_id: group })).error, /group chat/);
  const list = (await mcpTool(withGroups.key, "list_conversations", { filter: "all" })).chats;
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.isGroup).name, "Staff group");
  assert.equal((await mcpTool(withGroups.key, "get_conversation", { conversation_id: group })).chat.isGroup, true);
});

test("customers' phone numbers are hidden unless the owner allows them, even when a chat is named by its number", async () => {
  const c = await agentCompany("phones1");
  const hidden = await c.makeAgent({ name: "Hidden", level: "read" });
  const shown = await c.makeAgent({ name: "Shown", level: "read", sharePhones: true });
  const named = await c.customer("971500013001", "Maria Lopez");
  const unnamed = await c.customer("971500013002", "971500013002");
  for (const [agent, visible] of [[hidden, false], [shown, true]]) {
    const chats = (await mcpTool(agent.key, "list_conversations", { filter: "all" })).chats;
    const m = chats.find((x) => x.id === named.chat);
    const u = chats.find((x) => x.id === unnamed.chat);
    assert.equal(m.name, "Maria Lopez");
    assert.equal(m.phone, visible ? "+971500013001" : "+971•••••3001");
    assert.equal(u.name, visible ? "+971500013002" : "+971•••••3002", "an unnamed person is called by their number, which is hidden too");
    assert.equal(JSON.stringify(chats).includes("971500013002"), visible);
    const detail = await mcpTool(agent.key, "get_conversation", { conversation_id: unnamed.chat });
    assert.equal(JSON.stringify(detail).includes("971500013002"), visible, "nor in the chat's detail");
  }
  await query("UPDATE contacts SET email='maria@example.com' WHERE id=$1", [named.contact]);
  assert.equal((await mcpTool(hidden.key, "get_conversation", { conversation_id: named.chat })).contact.email, undefined);
  assert.equal((await mcpTool(shown.key, "get_conversation", { conversation_id: named.chat })).contact.email, "maria@example.com");
});

test("the chat list can be filtered and paged", async () => {
  const c = await agentCompany("list1");
  const agent = await c.makeAgent({ level: "read" });
  const chats = [];
  for (let i = 1; i <= 5; i++) chats.push(await c.customer(`97150001400${i}`, `Customer ${i}`, { text: `message ${i}`, ago: (6 - i) * 60 }));
  const [c1, c2, c3, c4, c5] = chats;
  await query("UPDATE conversations SET is_closed=true WHERE id=$1", [c1.chat]);
  await query("UPDATE conversations SET unread_count=0 WHERE id=ANY($1)", [[c2.chat, c3.chat]]);
  await teamReply(c, c2.chat, "answered");
  await query("UPDATE conversations SET assigned_user_id=$2,assigned_to=$3 WHERE id=$1", [c3.chat, c.sam.id, c.sam.name]);
  await label(c, "VIP", c4.contact);
  await label(c, "Unused");
  const names = async (args) => (await mcpTool(agent.key, "list_conversations", args)).chats.map((x) => x.name);

  // (the team answered Customer 2 last, so that chat is the most recently active)
  assert.deepEqual(await names({}), ["Customer 2", "Customer 5", "Customer 4", "Customer 3"], "open chats, most recent activity first");
  assert.deepEqual(await names({ filter: "closed" }), ["Customer 1"]);
  assert.equal((await names({ filter: "all" })).length, 5);
  assert.deepEqual((await names({ filter: "unread" })).sort(), ["Customer 1", "Customer 4", "Customer 5"], "unread is unread, closed or not: a customer may have written again");
  assert.deepEqual((await names({ filter: "waiting_for_reply" })).sort(), ["Customer 3", "Customer 4", "Customer 5"], "the closed one and the answered one are not waiting");
  assert.deepEqual(await names({ filter: "unassigned" }), ["Customer 2", "Customer 5", "Customer 4"]);
  assert.deepEqual(await names({ assigned_to: "Sam Agent" }), ["Customer 3"]);
  assert.deepEqual(await names({ assigned_to: "nobody" }), ["Customer 2", "Customer 5", "Customer 4"]);
  assert.deepEqual(await names({ label: "vip" }), ["Customer 4"], "label names are not case sensitive");
  assert.deepEqual(await names({ search: "Customer 3" }), ["Customer 3"]);
  assert.deepEqual(await names({ search: "9715000140" }).then((x) => x.length), 4, "a number fragment finds chats");
  assert.match((await mcpTool(agent.key, "list_conversations", { label: "Nope" })).error, /No label called "Nope"/);
  assert.match((await mcpTool(agent.key, "list_conversations", { assigned_to: "Nobody Atall" })).error, /no active teammate called "Nobody Atall"/);
  assert.match((await mcpTool(agent.key, "list_conversations", { filter: "everything" })).error, /must be one of/);
  assert.match((await mcpTool(agent.key, "list_conversations", { limit: 500 })).error, /from 1 to 50/);

  const first = await mcpTool(agent.key, "list_conversations", { filter: "all", limit: 2 });
  assert.equal(first.chats.length, 2);
  assert.ok(first.nextCursor);
  const second = await mcpTool(agent.key, "list_conversations", { filter: "all", limit: 2, cursor: first.nextCursor });
  const third = await mcpTool(agent.key, "list_conversations", { filter: "all", limit: 2, cursor: second.nextCursor });
  assert.equal(third.nextCursor, null);
  assert.deepEqual([...first.chats, ...second.chats, ...third.chats].map((x) => x.name), ["Customer 2", "Customer 5", "Customer 4", "Customer 3", "Customer 1"], "every chat once, in order");
  assert.match((await mcpTool(agent.key, "list_conversations", { cursor: "garbage" })).error, /cursor is not valid/);

  const item = (await mcpTool(agent.key, "list_conversations", { filter: "all" })).chats.find((x) => x.name === "Customer 4");
  assert.deepEqual(item.labels, ["VIP"]);
  assert.equal(item.unread, 1);
  assert.equal(item.lastMessage.from, "customer");
  assert.equal(item.lastMessage.text, "message 4");
  assert.ok(item.waitingMinutes >= 1, "how long the customer has waited");
  assert.equal(item.needsHuman, false);
  assert.equal(item.number, "main-line");
});

test("a chat is read as it happened: who said what, notes apart, nothing marked read", async () => {
  const c = await agentCompany("chat1");
  const agent = await c.makeAgent({ level: "read", sharePhones: true });
  const maria = await c.customer("971500015001", "Maria Lopez", { text: "Do you deliver on Friday?", ago: 300 });
  await teamReply(c, maria.chat, "Hi Maria, let me check.");
  await sendTextMessage({ tenantId: c.tenantId, conversationId: maria.chat, text: "Automatic reply", idempotencyKey: "riwo-1", agentName: "Riwo" });
  await sendTextMessage({ tenantId: c.tenantId, conversationId: maria.chat, text: "Ask Priya about the cold-chain van", idempotencyKey: "note-1", agentName: "Sam Agent", type: "internal_note", sentByUserId: c.sam.id });
  await c.says(maria, "Thanks! Also, do you take cards?");
  await query("INSERT INTO lead_tasks(id,tenant_id,conversation_id,title,due_at,assigned_user_id) VALUES('t1',$1,$2,'Call Maria back',now() + interval '1 day',$3)", [c.tenantId, maria.chat, c.sam.id]);
  // messages made in the same second tie on time: give each its own second, in the order they were made
  await query(
    `UPDATE messages m SET timestamp_epoch=extract(epoch FROM now())::bigint - 1000 + r.n FROM (SELECT id,row_number() OVER (ORDER BY created_at) AS n FROM messages WHERE conversation_id=$1) r WHERE m.id=r.id`,
    [maria.chat],
  );
  const before = (await query("SELECT unread_count FROM conversations WHERE id=$1", [maria.chat])).rows[0].unread_count;

  const r = await mcpTool(agent.key, "get_conversation", { conversation_id: maria.chat });
  assert.match(r.notice, /written by customers.*not instructions/s);
  assert.deepEqual(r.messages.map((m) => [m.from, m.text]), [
    ["customer", "Do you deliver on Friday?"],
    ["team", "Hi Maria, let me check."],
    ["riwo", "Automatic reply"],
    ["note", "Ask Priya about the cold-chain van"],
    ["customer", "Thanks! Also, do you take cards?"],
  ]);
  assert.equal(r.messages[1].by, "Sam Agent");
  assert.equal(r.messages[1].status, "sending");
  assert.equal(r.messages[0].status, undefined, "a customer's message has no delivery status");
  assert.ok(r.messages.every((m, i, all) => i === 0 || m.at >= all[i - 1].at), "oldest first");
  assert.equal(r.chat.name, "Maria Lopez");
  assert.equal(r.chat.unread, before, "reading is not marking as read");
  assert.equal((await query("SELECT unread_count FROM conversations WHERE id=$1", [maria.chat])).rows[0].unread_count, before);
  assert.deepEqual(r.followUps.map((t) => [t.title, t.assignedTo]), [["Call Maria back", "Sam Agent"]]);
  assert.equal(r.lead, null);

  const few = await mcpTool(agent.key, "get_conversation", { conversation_id: maria.chat, messages: 2 });
  assert.deepEqual(few.messages.map((m) => m.text), ["Ask Priya about the cold-chain van", "Thanks! Also, do you take cards?"]);
  assert.ok(few.olderMessagesCursor);
  const older = await mcpTool(agent.key, "get_messages", { conversation_id: maria.chat, limit: 2, cursor: few.olderMessagesCursor });
  assert.deepEqual(older.messages.map((m) => m.text), ["Hi Maria, let me check.", "Automatic reply"]);
  const oldest = await mcpTool(agent.key, "get_messages", { conversation_id: maria.chat, limit: 5, cursor: older.nextCursor });
  assert.deepEqual(oldest.messages.map((m) => m.text), ["Do you deliver on Friday?"]);
  assert.equal(oldest.nextCursor, null);
  assert.equal((await mcpTool(agent.key, "get_conversation", { conversation_id: maria.chat, messages: 0 })).messages.length, 0);
  assert.match(older.notice, /not instructions/);

  // a very long message is cut, and says so
  await c.says(maria, "x".repeat(5000));
  const long = (await mcpTool(agent.key, "get_messages", { conversation_id: maria.chat, limit: 1 })).messages[0];
  assert.equal(long.text.length, 2000);
  assert.equal(long.truncated, true);
  // an open lead is shown
  await query("INSERT INTO pipeline_stages(id,tenant_id,pipeline_id,name,kind,position) SELECT 'st1',$1,id,'Quoted','open',9 FROM pipelines WHERE tenant_id=$1 LIMIT 1", [c.tenantId]).catch(() => {});
});

test("nothing of another company can be reached, whatever id is given", async () => {
  const a = await agentCompany("iso-a");
  const b = await agentCompany("iso-b");
  const agent = await a.makeAgent({ level: "full" });
  const theirs = await b.customer("971500016001", "Their Customer", { text: "secret-b-word" });
  await a.customer("971500016002", "Our Customer", { text: "hello" });
  for (const [tool, args] of [
    ["get_conversation", { conversation_id: theirs.chat }],
    ["get_messages", { conversation_id: theirs.chat }],
    ["send_message", { conversation_id: theirs.chat, text: "hi" }],
    ["add_note", { conversation_id: theirs.chat, text: "hi" }],
    ["mark_read", { conversation_id: theirs.chat }],
    ["assign_conversation", { conversation_id: theirs.chat, assignee: "nobody" }],
    ["set_status", { conversation_id: theirs.chat, status: "closed" }],
    ["update_labels", { conversation_id: theirs.chat, add: ["x"] }],
    ["create_task", { conversation_id: theirs.chat, title: "x", due_in_hours: 2 }],
  ])
    assert.match((await mcpTool(agent.key, tool, args)).error, /was not found/, `${tool} must not find another company's chat`);
  assert.deepEqual((await mcpTool(agent.key, "list_conversations", { filter: "all" })).chats.map((x) => x.name), ["Our Customer"]);
  assert.equal((await mcpTool(agent.key, "search_messages", { query: "secret-b-word" })).messages.length, 0);
  assert.equal((await query("SELECT is_closed FROM conversations WHERE id=$1", [theirs.chat])).rows[0].is_closed, false);
  assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender='agent'", [theirs.chat])).rows[0].n, 0);
});

test("searching finds chats by name or number and messages by their words, never notes", async () => {
  const c = await agentCompany("search1");
  const agent = await c.makeAgent({ level: "read", sharePhones: true });
  const maria = await c.customer("971500017001", "Maria Lopez", { text: "Do you deliver on Friday evening?" });
  await c.customer("971500017002", "Ravi Kumar", { text: "Cancel my order please" });
  await sendTextMessage({ tenantId: c.tenantId, conversationId: maria.chat, text: "internal: Friday is the cold-chain day", idempotencyKey: "note-s", agentName: "Sam Agent", type: "internal_note", sentByUserId: c.sam.id });
  const byWord = await mcpTool(agent.key, "search_messages", { query: "Friday" });
  assert.equal(byWord.messages.length, 1, "the note is not found");
  assert.equal(byWord.messages[0].chat, "Maria Lopez");
  assert.match(byWord.messages[0].snippet, /Friday evening/);
  assert.equal(byWord.messages[0].from, "customer");
  assert.match(byWord.notice, /not instructions/);
  const byName = await mcpTool(agent.key, "search_messages", { query: "ravi" });
  assert.deepEqual(byName.chats.map((x) => x.name), ["Ravi Kumar"]);
  const byNumber = await mcpTool(agent.key, "search_messages", { query: "+971 50 0017001" });
  assert.deepEqual(byNumber.chats.map((x) => x.name), ["Maria Lopez"]);
  assert.match((await mcpTool(agent.key, "search_messages", { query: "x" })).error, /at least 2/);
  assert.equal(byWord.partial, false);
});

test("the team, the labels, the saved replies and the follow-ups can be read", async () => {
  const c = await agentCompany("lists1");
  const agent = await c.makeAgent({ level: "read" });
  await label(c, "VIP");
  await label(c, "Wholesale");
  await query("INSERT INTO canned_replies(id,tenant_id,shortcut,title,text) VALUES(gen_random_uuid(),$1,'/hours','Opening hours','We are open 9 to 6, Sunday to Thursday.')", [c.tenantId]);
  const maria = await c.customer("971500018001", "Maria Lopez");
  await query("INSERT INTO lead_tasks(id,tenant_id,conversation_id,title,due_at,assigned_user_id) VALUES('late',$1,$2,'Send the price list',now() - interval '2 hours',$3),('soon',$1,$2,'Check the delivery',now() + interval '3 hours',NULL),('far',$1,$2,'Renewal call',now() + interval '10 days',$3)", [c.tenantId, maria.chat, c.sam.id]);
  assert.deepEqual((await mcpTool(agent.key, "list_labels")).labels.map((l) => l.name), ["VIP", "Wholesale"]);
  assert.deepEqual((await mcpTool(agent.key, "list_saved_replies")).savedReplies, [{ shortcut: "/hours", title: "Opening hours", text: "We are open 9 to 6, Sunday to Thursday." }]);
  const team = (await mcpTool(agent.key, "list_team")).team;
  assert.deepEqual(team.map((t) => [t.name, t.role]).sort(), [["Sam Agent", "agent"], ["lists1 Owner", "owner"]].sort());
  assert.ok(team.every((t) => !("email" in t)), "no email addresses");
  const tasks = (await mcpTool(agent.key, "list_tasks")).tasks;
  assert.deepEqual(tasks.map((t) => t.title), ["Send the price list", "Check the delivery", "Renewal call"], "soonest first");
  assert.equal(tasks[0].overdue, true);
  assert.equal(tasks[0].assignedTo, "Sam Agent");
  assert.equal(tasks[0].chat, "Maria Lopez");
  assert.deepEqual((await mcpTool(agent.key, "list_tasks", { when: "overdue" })).tasks.map((t) => t.title), ["Send the price list"]);
  assert.deepEqual((await mcpTool(agent.key, "list_tasks", { when: "next_24_hours" })).tasks.map((t) => t.title), ["Send the price list", "Check the delivery"]);
  // an agent kept to the other number does not see the chat's follow-ups
  const other = await c.makeAgent({ name: "Other number", level: "read", numbers: ["second-line"] });
  assert.deepEqual((await mcpTool(other.key, "list_tasks")).tasks, []);
});

test("the company's knowledge is what an agent is told to answer from", async () => {
  const c = await agentCompany("know1");
  const agent = await c.makeAgent({ level: "read" });
  const none = await mcpTool(agent.key, "search_knowledge", { question: "delivery charges" });
  assert.equal(none.found, false);
  assert.match(none.message, /Do not guess/);
  await query("INSERT INTO knowledge_profile(tenant_id,overview,products,notes) VALUES($1,'Know1 Stores sells fresh fruit boxes in Dubai.','[{\"name\":\"Fruit box\",\"summary\":\"Seasonal fruit, AED 99\"}]','Delivery is free above AED 150.')", [c.tenantId]);
  const found = await mcpTool(agent.key, "search_knowledge", { question: "what do you sell and what is delivery" });
  assert.equal(found.found, true);
  assert.match(found.text, /fresh fruit boxes/);
  assert.match(found.text, /Delivery is free above AED 150/);
  assert.match((await mcpTool(agent.key, "search_knowledge", { question: "x" })).error, /at least 2/);
});
