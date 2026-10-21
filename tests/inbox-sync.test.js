import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io as serverIo } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { syncSession } from "../src/services/syncService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";

const settle = () => new Promise((r) => setTimeout(r, 120));
const recorder = () => {
  const events = [];
  const io = {
    to() {
      const t = { to: () => t, emit: (event, payload) => events.push({ event, payload }) };
      return t;
    },
  };
  return { io, events };
};
const wire = (id, text, epoch, fromMe = false) => ({
  providerMessageId: id,
  remoteId: "15551110001@c.us",
  fromMe,
  ack: fromMe ? 2 : 0,
  senderName: "Alice",
  text,
  type: "text",
  timestampEpoch: epoch,
});

test("Inbox sync: catch-up, first-time backfill, change-only reconcile, data-carrying events", async (t) => {
  const original = { ...provider };
  t.after(() => {
    Object.assign(provider, original);
    serverIo.close();
  });
  const o = await registerTenantAndUser({ name: "Owner", email: "sync@test.invalid", password: "Password@123", companyName: "Sync Co" });
  const tenantId = o.tenant.id;
  const auth = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };

  let remote = [
    { id: "15551110001@c.us", phone: "15551110001@c.us", contactName: "Alice", unreadCount: 2, isGroup: false, lastActiveEpoch: 1700000100, lastMessage: { text: "hi", fromMe: false } },
    { id: "15551110002@c.us", phone: "15551110002@c.us", contactName: "Bob", unreadCount: 0, isGroup: false, lastActiveEpoch: 1700000200, lastMessage: { text: "yo", fromMe: false } },
  ];
  const histories = {
    "15551110001@c.us": [wire("A2", "second", 1700000100), wire("A1", "first", 1700000050)],
    "15551110002@c.us": [{ ...wire("B1", "hello bob", 1700000200), remoteId: "15551110002@c.us" }],
  };
  const fetched = [];
  provider.syncConversations = async () => remote;
  provider.getContacts = async () => [{ id: { _serialized: "15551110001@c.us" }, name: "Alice A" }, { id: "15551110001@c.us", name: "Alice A" }, { id: "15551110009@c.us", pushname: "Zed" }];
  provider.getHistory = async (tenant, session, chatId) => {
    fetched.push(chatId);
    return histories[chatId] || [];
  };

  await t.test("a new session backfills chats, contacts and recent messages by itself", async () => {
    const { io, events } = recorder();
    const result = await syncSession({ tenantId, sessionName: "line-1", io });
    assert.equal(result.kind, "initial");
    assert.equal(result.backfilled, 2);
    const msgs = (await query("SELECT provider_message_id,sender FROM messages WHERE tenant_id=$1 ORDER BY timestamp_epoch", [tenantId])).rows;
    assert.deepEqual(msgs.map((m) => m.provider_message_id), ["A1", "A2", "B1"]);
    assert.equal((await query("SELECT count(*)::int n FROM contacts WHERE tenant_id=$1 AND phone IN ('15551110001','15551110009')", [tenantId])).rows[0].n, 2, "contacts imported in batch, duplicates collapsed");
    const conv = (await query("SELECT unread_count,last_message FROM conversations WHERE tenant_id=$1 AND provider_chat_id='15551110001@c.us'", [tenantId])).rows[0];
    assert.equal(conv.unread_count, 2, "history import never inflates unread counts");
    await settle();
    const phases = events.filter((e) => e.event === "sync:progress").map((e) => e.payload.phase);
    assert.deepEqual([phases[0], phases.at(-1)], ["chats", "done"]);
    assert.ok(phases.includes("messages"));
  });

  await t.test("the next pass fetches nothing when nothing changed", async () => {
    fetched.length = 0;
    const result = await syncSession({ tenantId, sessionName: "line-1", io: null });
    assert.equal(result.kind, "reconcile");
    assert.equal(result.backfilled, 0);
    assert.equal(fetched.length, 0);
  });

  await t.test("only the chat with newer activity is refreshed, and repeats are ignored", async () => {
    remote = remote.map((c) => (c.id === "15551110001@c.us" ? { ...c, lastActiveEpoch: 1700000999, unreadCount: 3 } : c));
    histories["15551110001@c.us"] = [wire("A3", "missed while offline", 1700000999), wire("A2", "second", 1700000100)];
    fetched.length = 0;
    const result = await syncSession({ tenantId, sessionName: "line-1", io: null });
    assert.deepEqual(fetched, ["15551110001@c.us"]);
    assert.equal(result.backfilled, 1);
    const n = (await query("SELECT count(*)::int n FROM messages WHERE tenant_id=$1 AND provider_message_id IN ('A2','A3')", [tenantId])).rows[0].n;
    assert.equal(n, 2, "A2 was not duplicated");
    const conv = (await query("SELECT unread_count FROM conversations WHERE tenant_id=$1 AND provider_chat_id='15551110001@c.us'", [tenantId])).rows[0];
    assert.equal(conv.unread_count, 3, "WhatsApp's own unread count wins");
  });

  await t.test("a failing WhatsApp call reports and recovers instead of throwing", async () => {
    provider.syncConversations = async () => {
      throw new Error("browser gone");
    };
    const { io, events } = recorder();
    const result = await syncSession({ tenantId, sessionName: "line-1", io });
    assert.equal(result.failed, true);
    await settle();
    assert.equal(events.at(-1).payload.phase, "failed");
    // the lock is released, so the next attempt runs
    provider.syncConversations = async () => remote;
    assert.ok(!(await syncSession({ tenantId, sessionName: "line-1", io: null })).skipped);
  });

  await t.test("live message events carry the updated conversation so lists update in place", async () => {
    const { io, events } = recorder();
    await handleIncomingMessage({ tenantId, sessionName: "line-1", io, msg: wire("LIVE1", "brand new", 1800000000) });
    await settle();
    const received = events.find((e) => e.event === "message:received").payload;
    assert.equal(received.message.text, "brand new");
    assert.equal(received.conversation.id, received.conversationId);
    assert.equal(received.conversation.unreadCount, 4);
    assert.equal(received.conversation.lastMessage.text, "brand new");
    assert.ok(events.find((e) => e.event === "conversation:updated").payload.conversation);
  });

  await t.test("catch-up returns only what changed, and agents only see their own chats", async () => {
    const t0 = (await request(app).get("/api/conversations/changes").query({ since: "2000-01-01" }).set(auth));
    assert.equal(t0.status, 200);
    assert.equal(t0.body.conversations.length, 2);
    assert.equal(t0.body.hasMore, false);
    const mark = t0.body.serverTime;
    assert.equal((await request(app).get("/api/conversations/changes").query({ since: mark }).set(auth)).body.conversations.length, 0);
    await handleIncomingMessage({ tenantId, sessionName: "line-1", io: null, msg: { ...wire("LIVE2", "another", 1800000100), remoteId: "15551110002@c.us" } });
    const delta = await request(app).get("/api/conversations/changes").query({ since: mark }).set(auth);
    assert.deepEqual(delta.body.conversations.map((c) => c.contactName), ["Bob"]);
    assert.equal((await request(app).get("/api/conversations/changes").query({ since: "garbage" }).set(auth)).status, 400);

    // an agent who owns no session sees nothing; once they own line-1 they see its chats
    const agent = (await query("INSERT INTO users(name,email,password_hash) VALUES('Agent','agent@sync.invalid','x') RETURNING *")).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, agent.id]);
    const agentAuth = { Authorization: `Bearer ${generateAccessToken(agent, tenantId, "agent")}` };
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id) VALUES(gen_random_uuid()::text,$1,'line-1',$2) ON CONFLICT(tenant_id,session_name) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id", [tenantId, o.user.id]);
    assert.equal((await request(app).get("/api/conversations/changes").query({ since: "2000-01-01" }).set(agentAuth)).body.conversations.length, 0);
    await query("UPDATE whatsapp_sessions SET owner_user_id=$2 WHERE tenant_id=$1 AND session_name='line-1'", [tenantId, agent.id]);
    assert.equal((await request(app).get("/api/conversations/changes").query({ since: "2000-01-01" }).set(agentAuth)).body.conversations.length, 2);
  });
});
