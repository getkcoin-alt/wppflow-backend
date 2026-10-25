import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { app, io as serverIo } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { pumpLeadReminders, escalateOverdueTasks } from "../src/services/leadService.js";
import { relayCompose } from "../src/services/realtime.js";
import { closeSessions } from "../src/services/sessionService.js";

test("Inbox: waiting and overdue chats, pinning, who else is typing, and follow-ups with no lead", async (t) => {
  t.after(async () => {
    await closeSessions(serverIo);
    serverIo.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@followups.test", password: "Password@123", companyName: "Followups Co" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const mk = async (name, role, category = "general") => {
    const u = (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [name, `${name.toLowerCase()}@followups.test`])).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role,category) VALUES($1,$2,$3,$4)", [tenantId, u.id, role, category]);
    return { ...u, auth: { Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` } };
  };
  const sam = await mk("Sam", "agent", "sales"), tina = await mk("Tina", "agent", "support"), ada = await mk("Ada", "admin");
  const owner = { ...o.user, auth: { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` } };
  await query(
    "INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status) VALUES(gen_random_uuid()::text,$1,'sam-line',$2,'CONNECTED'),(gen_random_uuid()::text,$1,'tina-line',$3,'CONNECTED')",
    [tenantId, sam.id, tina.id],
  );

  let epoch = Math.floor(Date.now() / 1000) - 5 * 3600;
  const say = (line, remote, { fromMe = false, text = "hi", name = "Customer", history = false, group = false } = {}) =>
    handleIncomingMessage({
      tenantId,
      sessionName: line,
      history,
      msg: { providerMessageId: `msg_${remote}_${++epoch}`, fromMe, remoteId: remote, isGroup: group, groupName: group ? "A group" : undefined, rawType: "chat", type: "text", text, timestampEpoch: epoch, senderName: name, ack: 2 },
    });
  const chatOf = async (phone) => (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND phone=$2", [tenantId, phone])).rows[0];
  const list = async (who, qs = "") => (await request(app).get(`/api/conversations${qs}`).set(who.auth)).body;
  const names = async (who, qs = "") => (await list(who, qs)).conversations.map((c) => c.contactName);

  await t.test("a wait starts with the customer's first unanswered message and ends when a person answers", async () => {
    await say("sam-line", "971500000001@c.us", { name: "Asha", text: "first" });
    const first = (await chatOf("971500000001")).awaiting_since;
    assert.ok(first, "the wait begins");
    await say("sam-line", "971500000001@c.us", { name: "Asha", text: "second" });
    assert.equal((await chatOf("971500000001")).awaiting_since, first, "a second message does not restart it");

    // an automatic reply, a broadcast and a team note do not end it
    const c = await chatOf("971500000001");
    for (const [agentName, type] of [["Automation", "text"], ["Campaign", "text"], ["Sam", "internal_note"]]) {
      await query("INSERT INTO messages(id,tenant_id,conversation_id,sender,agent_name,type,timestamp_epoch,status) VALUES($1,$2,$3,'agent',$4,$5,$6,'sent')", [crypto.randomUUID(), tenantId, c.id, agentName, type, epoch + 1]);
    }
    const note = await request(app).post(`/api/conversations/${c.id}/notes`).set(sam.auth).send({ text: "remember the discount", idempotencyKey: "note-1" });
    assert.equal(note.status, 201);
    assert.equal((await chatOf("971500000001")).awaiting_since, first);
    const auto = await request(app).post(`/api/conversations/${c.id}/messages`).set(sam.auth).send({ text: "hello!", idempotencyKey: "reply-1" });
    assert.equal(auto.status, 201, JSON.stringify(auto.body));
    assert.equal((await chatOf("971500000001")).awaiting_since, null, "a reply from a person ends it");
    await say("sam-line", "971500000001@c.us", { name: "Asha", text: "thanks, one more thing" });
    assert.ok((await chatOf("971500000001")).awaiting_since > first, "the next message starts a new wait");
  });

  await t.test("a reply typed on the phone ends it, and imported history, groups and your own first message do not start one", async () => {
    await say("sam-line", "971500000002@c.us", { name: "Bala" });
    assert.ok((await chatOf("971500000002")).awaiting_since);
    await say("sam-line", "971500000002@c.us", { fromMe: true, text: "typed on the phone" });
    assert.equal((await chatOf("971500000002")).awaiting_since, null);

    await say("sam-line", "971500000003@c.us", { name: "Old", history: true, text: "from last year" });
    assert.equal((await chatOf("971500000003")).awaiting_since, null, "history is not a wait");
    await say("sam-line", "120363000001@g.us", { name: "Someone", group: true, text: "hi group" });
    assert.equal((await chatOf("120363000001@g.us")).awaiting_since, null, "a group is not a person to answer");
    await say("sam-line", "971500000004@c.us", { fromMe: true, text: "we wrote first" });
    assert.equal((await chatOf("971500000004")).awaiting_since, null);
  });

  await t.test("filter the list by chats waiting, chats overdue against the reply target, and by team", async () => {
    await say("tina-line", "971500000005@c.us", { name: "Chitra" });
    await say("sam-line", "971500000006@c.us", { name: "Dev" });
    // Dev has waited three hours; the company's reply target is 30 minutes
    await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint-3*3600 WHERE tenant_id=$1 AND phone='971500000006'", [tenantId]);
    await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint-60 WHERE tenant_id=$1 AND phone='971500000005'", [tenantId]);
    const waiting = await names(owner, "?awaiting=1");
    assert.deepEqual(waiting.sort(), ["Asha", "Chitra", "Dev"], "everyone who wrote last and is still unanswered");
    const overdue = await names(owner, "?overdue=1");
    assert.ok(overdue.includes("Dev") && !overdue.includes("Chitra"), "Chitra only wrote a minute ago");
    await request(app).put("/api/reports/settings").set(owner.auth).send({ slaMinutes: 1 });
    await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint-300 WHERE tenant_id=$1 AND phone='971500000005'", [tenantId]);
    assert.ok((await names(owner, "?overdue=1")).includes("Chitra"), "a one minute target makes her overdue");
    await request(app).put("/api/reports/settings").set(owner.auth).send({ slaMinutes: 30 });

    // team: the chats on a number a team member owns (nobody assigned), or assigned to one
    assert.deepEqual((await names(owner, "?team=support")).sort(), ["Chitra"]);
    const salesChats = await names(owner, "?team=sales");
    assert.ok(salesChats.includes("Dev") && salesChats.includes("Asha") && !salesChats.includes("Chitra"));
    const chitra = await chatOf("971500000005");
    await request(app).patch(`/api/conversations/${chitra.id}`).set(owner.auth).send({ assignedUserId: sam.id });
    assert.ok((await names(owner, "?team=sales")).includes("Chitra"), "assigned to a sales person");
    assert.ok(!(await names(owner, "?team=support")).includes("Chitra"));
    assert.deepEqual(await names(owner, "?team=nobody"), []);
    // staff see only their own, even when they ask for more
    assert.ok(!(await names(tina, "?awaiting=1")).includes("Dev"));
    // combined with a number and unread
    assert.deepEqual(await names(owner, "?awaiting=1&sessionName=tina-line"), ["Chitra"], "Tina's number has one chat waiting");
    assert.deepEqual((await names(owner, "?awaiting=1&sessionName=sam-line&overdue=1")).sort(), ["Asha", "Dev"], "one number, waiting and overdue together");
  });

  await t.test("a pinned chat stays at the top of the first page, once, and pinning needs access to the chat", async () => {
    const old = await chatOf("971500000001");
    await query("UPDATE conversations SET last_active_epoch=1700000000 WHERE id=$1", [old.id]);
    const pin = await request(app).patch(`/api/conversations/${old.id}`).set(owner.auth).send({ isPinned: true });
    assert.equal(pin.status, 200);
    assert.equal(pin.body.conversation.isPinned, true);
    const page1 = await list(owner, "?limit=2");
    assert.equal(page1.conversations[0].contactName, "Asha", "pinned first even though it is the oldest");
    assert.equal(page1.conversations.length, 3, "the pinned chat comes on top of the page");
    const page2 = await request(app).get(`/api/conversations?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`).set(owner.auth);
    assert.ok(!page2.body.conversations.some((c) => c.contactName === "Asha"), "and is not repeated on the next page");
    assert.ok(!(await names(owner, "?sessionName=tina-line")).includes("Asha"), "a filter still applies to pinned chats");
    assert.equal((await request(app).patch(`/api/conversations/${old.id}`).set(tina.auth).send({ isPinned: false })).status, 404, "Tina cannot touch Sam's chat");
    assert.equal((await request(app).patch(`/api/conversations/${old.id}`).set(sam.auth).send({ isPinned: false })).status, 200);
    assert.ok((await list(owner)).conversations.find((c) => c.contactName === "Asha").isPinned === false);
  });

  await t.test("typing a reply is passed only to the people who can open that chat", async () => {
    const sent = [];
    const recorder = { to(room) { const rooms = [room]; const chain = { to: (r) => (rooms.push(r), chain), emit: (event, payload) => sent.push({ rooms, event, payload }) }; return chain; } };
    const chat = await chatOf("971500000006"); // on Sam's number
    const send = (who, extra = {}) => relayCompose({ io: recorder, tenantId, userId: who.id, name: who.name, isManager: ["owner", "admin"].includes(who.role), conversationId: chat.id, typing: true, ...extra });
    assert.equal(await send({ id: sam.id, name: "Sam" }), true, "the number's owner");
    assert.deepEqual(sent.at(-1).payload, { conversationId: chat.id, userId: sam.id, name: "Sam", typing: true });
    assert.equal(sent.at(-1).event, "compose:update");
    assert.ok(sent.at(-1).rooms.includes(`tenant:${tenantId}:managers`) && sent.at(-1).rooms.includes(`user:${sam.id}`));
    assert.ok(!sent.at(-1).rooms.includes(`user:${tina.id}`), "not Tina, who cannot open it");
    assert.equal(await send({ id: ada.id, name: "Ada", role: "admin" }), true, "a manager");
    assert.equal(await send({ id: tina.id, name: "Tina" }), false, "someone with no access cannot even say they are typing there");
    const before = sent.length;
    await query("UPDATE conversations SET assigned_user_id=$2 WHERE id=$1", [chat.id, tina.id]);
    assert.equal(await send({ id: tina.id, name: "Tina" }), true, "whoever the chat is assigned to");
    assert.ok(sent.at(-1).rooms.includes(`user:${tina.id}`) && sent.length === before + 1);
    assert.equal(await send({ id: sam.id, name: "Sam" }, { typing: false }), true);
    assert.equal(sent.at(-1).payload.typing, false);
    assert.equal(await send({ id: sam.id, name: "Sam" }, { conversationId: "nope" }), false);
    assert.equal(await send({ id: sam.id, name: "Sam" }, { conversationId: "x".repeat(80) }), false);
    assert.equal(await relayCompose({ io: null, tenantId, userId: 1, conversationId: chat.id }), false);
    await query("UPDATE conversations SET assigned_user_id=NULL WHERE id=$1", [chat.id]);
    // a chat from another company is unknown here
    const other = await registerTenantAndUser({ name: "Zed", email: "zed@followups.test", password: "Password@123", companyName: "Zed Co" });
    assert.equal(await relayCompose({ io: recorder, tenantId: other.tenant.id, userId: other.user.id, isManager: true, conversationId: chat.id, typing: true }), false);
  });

  let task;
  await t.test("a follow-up from a chat with no lead, shown on Today and on the chat", async () => {
    const dev = await chatOf("971500000006");
    const due = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const made = await request(app).post(`/api/leads/chat/${dev.id}/tasks`).set(sam.auth).send({ title: "Call Dev back about the quote", dueAt: due });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    task = made.body.tasks[0];
    assert.deepEqual([task.title, task.leadId, task.chatId, task.assignedUserId], ["Call Dev back about the quote", null, dev.id, sam.id]);
    assert.equal((await query("SELECT count(*)::int n FROM leads WHERE tenant_id=$1", [tenantId])).rows[0].n, 0, "no lead was made");

    const today = (await request(app).get(`/api/leads/tasks?when=all`).set(sam.auth)).body.tasks;
    const mine = today.find((x) => x.id === task.id);
    assert.ok(mine, JSON.stringify(today));
    assert.deepEqual([mine.contactName, mine.conversationId], ["Dev", dev.id]);
    assert.ok(!(await request(app).get(`/api/leads/tasks?when=all`).set(tina.auth)).body.tasks.some((x) => x.id === task.id), "not on Tina's list");
    assert.ok((await request(app).get(`/api/leads/tasks?when=all&everyone=1`).set(owner.auth)).body.tasks.some((x) => x.id === task.id), "a manager can see everyone's");
    assert.equal((await request(app).get(`/api/leads/chat/${dev.id}/tasks`).set(tina.auth)).status, 404, "Tina cannot read a chat she cannot open");
    assert.equal((await request(app).get(`/api/leads/chat/${dev.id}/tasks`).set(sam.auth)).body.tasks.length, 1);
    assert.equal((await request(app).patch(`/api/leads/tasks/${task.id}`).set(tina.auth).send({ done: true })).status, 404);

    const group = await chatOf("120363000001@g.us");
    assert.equal((await request(app).post(`/api/leads/chat/${group.id}/tasks`).set(owner.auth).send({ title: "x", dueAt: due })).status, 400, "not for a group");
    assert.equal((await request(app).post(`/api/leads/chat/${dev.id}/tasks`).set(sam.auth).send({ title: "", dueAt: due })).status, 400);
    assert.equal((await request(app).post(`/api/leads/chat/${dev.id}/tasks`).set(sam.auth).send({ title: "x", dueAt: "soon" })).status, 400);
    assert.equal((await request(app).post(`/api/leads/chat/${dev.id}/tasks`).set(sam.auth).send({ title: "x", dueAt: due, assignedUserId: 999999 })).status, 400);
  });

  await t.test("a lead's follow-ups show on its chat too, and the chat's own with them", async () => {
    const asha = await chatOf("971500000001");
    const lead = await request(app).post("/api/leads").set(sam.auth).send({ conversationId: asha.id });
    assert.equal(lead.status, 201, JSON.stringify(lead.body));
    await request(app).post(`/api/leads/${lead.body.lead.id}/tasks`).set(sam.auth).send({ title: "Send the brochure", dueAt: new Date(Date.now() + 3600e3).toISOString() });
    await request(app).post(`/api/leads/chat/${asha.id}/tasks`).set(sam.auth).send({ title: "Also ring the shop", dueAt: new Date(Date.now() + 7200e3).toISOString() });
    const both = (await request(app).get(`/api/leads/chat/${asha.id}/tasks`).set(sam.auth)).body.tasks.map((x) => x.title);
    assert.deepEqual(both, ["Send the brochure", "Also ring the shop"]);
  });

  await t.test("moving a follow-up to someone else is written to the audit log and they are told", async () => {
    const res = await request(app).patch(`/api/leads/tasks/${task.id}`).set(owner.auth).send({ assignedUserId: tina.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.task.assignedUserId, tina.id);
    const audit = (await query("SELECT metadata,actor_id FROM audit_events WHERE tenant_id=$1 AND event_type='task.reassigned'", [tenantId])).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].metadata.from, audit[0].metadata.to, audit[0].actor_id], [sam.id, tina.id, o.user.id]);
    const told = (await query("SELECT * FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND type='lead_task'", [tenantId, tina.id])).rows;
    assert.ok(told.some((n) => /given to you: Call Dev back/.test(n.title)));
    // same person again: nothing to record
    await request(app).patch(`/api/leads/tasks/${task.id}`).set(owner.auth).send({ assignedUserId: tina.id, title: "Call Dev back about the quote" });
    assert.equal((await query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND event_type='task.reassigned'", [tenantId])).rows[0].n, 1);
    assert.equal((await request(app).patch(`/api/leads/tasks/${task.id}`).set(owner.auth).send({ assignedUserId: 999999 })).status, 400);
    // Tina cannot open Sam's chat, but the follow-up is hers now, so it is on her list and she can finish it
    assert.ok((await request(app).get(`/api/leads/tasks?when=all`).set(tina.auth)).body.tasks.some((x) => x.id === task.id));
    await request(app).patch(`/api/leads/tasks/${task.id}`).set(owner.auth).send({ assignedUserId: sam.id });
  });

  await t.test("a follow-up from a chat reminds when due, and an overdue one is escalated to the owner and administrators once", async () => {
    const made = await request(app).post(`/api/leads/chat/${(await chatOf("971500000006")).id}/tasks`).set(sam.auth).send({ title: "Chase the deposit", dueAt: new Date(Date.now() - 26 * 3600e3).toISOString() });
    const overdue = made.body.tasks.find((x) => x.title === "Chase the deposit");
    await pumpLeadReminders(null);
    const reminded = (await query("SELECT * FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND title LIKE 'Follow-up due: Chase the deposit'", [tenantId, sam.id])).rows;
    assert.equal(reminded.length, 1, "the assignee is reminded once");
    assert.ok(reminded[0].conversation_id, "and the reminder opens the chat");
    const escalated = (await query("SELECT user_id,title,body FROM notifications WHERE tenant_id=$1 AND title LIKE 'Overdue follow-up: Chase the deposit'", [tenantId])).rows;
    assert.deepEqual(escalated.map((n) => n.user_id).sort(), [o.user.id, ada.id].sort(), "the owner and the administrator, not Sam, not Tina");
    assert.match(escalated[0].body, /With Sam/);
    assert.equal((await query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND event_type='task.escalated'", [tenantId])).rows[0].n, 1);
    assert.equal(await escalateOverdueTasks(null), 0, "never twice");
    const view = (await request(app).get(`/api/leads/chat/${(await chatOf("971500000006")).id}/tasks`).set(sam.auth)).body.tasks.find((x) => x.id === overdue.id);
    assert.equal(view.escalated, true);

    // moving it to a new time or a new person starts the clock again
    await request(app).patch(`/api/leads/tasks/${overdue.id}`).set(sam.auth).send({ dueAt: new Date(Date.now() - 30 * 3600e3).toISOString() });
    assert.equal(await escalateOverdueTasks(null), 1);
    // done tasks are left alone
    await request(app).patch(`/api/leads/tasks/${overdue.id}`).set(sam.auth).send({ done: true });
    assert.equal(await escalateOverdueTasks(null), 0);
  });

  await t.test("the escalation time is the company's to set, and 0 switches it off", async () => {
    const put = (body) => request(app).put("/api/reports/settings").set(owner.auth).send(body);
    assert.equal((await put({ taskEscalationHours: -1 })).status, 400);
    assert.equal((await put({ taskEscalationHours: "soon" })).status, 400);
    assert.equal((await put({ taskEscalationHours: 721 })).status, 400);
    const dev = await chatOf("971500000006");
    const make = (title, hoursAgo) => request(app).post(`/api/leads/chat/${dev.id}/tasks`).set(sam.auth).send({ title, dueAt: new Date(Date.now() - hoursAgo * 3600e3).toISOString() });
    await make("Eight hours late", 8);
    assert.equal(await escalateOverdueTasks(null), 0, "24 hours is the default");
    assert.equal((await put({ taskEscalationHours: 6 })).body.settings.taskEscalationHours, 6);
    assert.equal(await escalateOverdueTasks(null), 1);
    await put({ taskEscalationHours: 0 });
    await make("Two days late", 48);
    assert.equal(await escalateOverdueTasks(null), 0, "switched off");
    await put({ taskEscalationHours: 24 });
    assert.equal(await escalateOverdueTasks(null), 1);
  });
  await t.test("the workspace tells the browser the reply target and the teams, to flag late chats and offer the team filter", async () => {
    const caps = async () => (await request(app).get("/api/workspace/capabilities").set(sam.auth)).body;
    let body = await caps();
    assert.equal(body.replyTargetMinutes, 30, "the default target");
    assert.ok(body.teams.includes("sales") && body.teams.includes("support"), "each team that has someone on it");
    assert.deepEqual([...body.teams].sort(), body.teams, "listed in a steady order");
    assert.equal((await request(app).put("/api/reports/settings").set(owner.auth).send({ slaMinutes: 12 })).status, 200);
    assert.equal((await caps()).replyTargetMinutes, 12);
    // someone who left is not a team
    await query("UPDATE memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2", [tenantId, tina.id]);
    body = await caps();
    assert.ok(!body.teams.includes("support"));
  });
});
