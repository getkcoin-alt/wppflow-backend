import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query, getPool } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { WhatsAppProvider, defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { up as cleanUp } from "../src/db/migrations/009_clean_group_and_status_data.js";

const BLOB = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsbGxscGx4hIR4qLSgtKj04MzM4PV1CR0JHQl2NWGdYWGdYjXF1cXF1cY+Ci4uCj5iamZ+vqrKyr7u7u8nJyf/CABEIAAEAAQMBIgACEQEDEQH/xAAUAAEAAAAAAAAAAAAAAAAAAAAB";
const wire = (over) => ({
  providerMessageId: "m-" + Math.random().toString(36).slice(2),
  remoteId: "15551110001@c.us",
  fromMe: false,
  ack: 0,
  senderName: "Alice",
  text: "hello",
  type: "text",
  rawType: "chat",
  isGroup: false,
  groupName: "",
  timestampEpoch: 1700000000,
  ...over,
});

test("Groups, WhatsApp Status and media thumbnails", async (t) => {
  const original = { ...provider };
  t.after(() => {
    Object.assign(provider, original);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Owner", email: "grp@test.invalid", password: "Password@123", companyName: "Grp Co" });
  const tenantId = o.tenant.id;
  const auth = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  const conv = async (chat) => (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND provider_chat_id=$2", [tenantId, chat])).rows[0];

  await t.test("the provider reads group subject, real text and media labels from WhatsApp messages", () => {
    const p = new WhatsAppProvider();
    const group = p.normalizeMessage({
      id: { _serialized: "g1" }, from: "120363000001@g.us", author: "15557770001@c.us", fromMe: false,
      isGroupMsg: true, type: "chat", body: "see you at 5", timestamp: 1700000000,
      sender: { pushname: "Devanjali singh" }, chat: { formattedTitle: "Sales Team" },
    });
    assert.equal(group.isGroup, true);
    assert.equal(group.groupName, "Sales Team");
    assert.equal(group.senderName, "Devanjali singh");
    assert.equal(group.remoteId, "120363000001@g.us");
    const photo = p.normalizeMessage({ id: "i1", from: "15551110001@c.us", type: "image", body: BLOB, timestamp: 1700000000 });
    assert.equal(photo.text, "📷 Photo", "a base64 thumbnail is never shown as text");
    assert.equal(p.normalizeMessage({ id: "i2", from: "x@c.us", type: "image", body: BLOB, caption: "Our new shop", timestamp: 1 }).text, "Our new shop");
    assert.equal(p.normalizeMessage({ id: "i3", from: "x@c.us", type: "ptt", body: BLOB, timestamp: 1 }).text, "🎵 Voice message");
    assert.equal(p.normalizeMessage({ id: "i4", from: "x@c.us", type: "chat", body: "plain", timestamp: 1 }).text, "plain");
  });

  await t.test("a group conversation is named after the group, never a member, and has no contact", async () => {
    const chat = "120363000001@g.us";
    await handleIncomingMessage({ tenantId, sessionName: "s1", msg: wire({ remoteId: chat, isGroup: true, groupName: "Sales Team", senderName: "Devanjali singh" }) });
    await handleIncomingMessage({ tenantId, sessionName: "s1", msg: wire({ remoteId: chat, isGroup: true, groupName: "", senderName: "Hnwt kakosa" }) });
    const c = await conv(chat);
    assert.equal(c.contact_name, "Sales Team");
    assert.equal(c.is_group, true);
    assert.equal(c.contact_id, null);
    assert.equal((await query("SELECT count(*)::int n FROM contacts WHERE tenant_id=$1 AND phone LIKE '%@g.us'", [tenantId])).rows[0].n, 0);
    const senders = (await query("SELECT agent_name FROM messages WHERE conversation_id=$1 ORDER BY created_at", [c.id])).rows.map((r) => r.agent_name);
    assert.deepEqual(senders, ["Devanjali singh", "Hnwt kakosa"], "each message still shows who posted it");
    await handleIncomingMessage({ tenantId, sessionName: "s1", msg: wire({ remoteId: chat, isGroup: true, groupName: "Sales Team 2025", senderName: "Devanjali singh" }) });
    assert.equal((await conv(chat)).contact_name, "Sales Team 2025", "renaming the group in WhatsApp is followed");
  });

  await t.test("a group with no known subject gets a neutral title instead of a member's name", async () => {
    const chat = "120363000002@g.us";
    await handleIncomingMessage({ tenantId, sessionName: "s1", msg: wire({ remoteId: chat, isGroup: true, senderName: "Someone" }) });
    assert.equal((await conv(chat)).contact_name, "WhatsApp Group");
  });

  await t.test("a first outgoing message names the chat after the number, not 'You'", async () => {
    await handleIncomingMessage({ tenantId, sessionName: "s1", msg: wire({ remoteId: "15559990000@c.us", fromMe: true, senderName: "You", ack: 1 }) });
    assert.equal((await conv("15559990000@c.us")).contact_name, "15559990000");
  });

  await t.test("Status updates and WhatsApp system notices are ignored", async () => {
    assert.equal(await handleIncomingMessage({ tenantId, sessionName: "s1", msg: wire({ remoteId: "status@broadcast", type: "image", text: BLOB }) }), null);
    assert.equal(await handleIncomingMessage({ tenantId, sessionName: "s1", msg: wire({ rawType: "e2e_notification", text: "" }) }), null);
    assert.equal(await conv("status@broadcast"), undefined);
  });

  await t.test("cleanup removes group/status junk contacts and base64 text but keeps real data", async () => {
    await query("INSERT INTO contacts(id,tenant_id,name,phone) VALUES('junk1',$1,'Devanjali singh','120363000009@g.us'),('real1',$1,'Real Person','15551110077')", [tenantId]);
    await query("INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,phone,contact_name,contact_id,unread_count,last_message) VALUES('cv-status',$1,'s1','status@broadcast','status@broadcast','Hnwt kakosa','junk1',7,$2),('cv-real',$1,'s1','15551110077@c.us','15551110077','Real Person','real1',0,'{}')", [tenantId, JSON.stringify({ text: BLOB })]);
    await query("INSERT INTO messages(id,tenant_id,conversation_id,provider_message_id,sender,text,type,timestamp_epoch) VALUES('mm1',$1,'cv-status','pm1','customer',$2,'image',1),('mm2',$1,'cv-real','pm2','customer','real words here','text',2)", [tenantId, BLOB]);
    const client = await getPool().connect();
    try { await cleanUp(client); await cleanUp(client); } finally { client.release(); } // safe to run twice
    assert.equal((await query("SELECT count(*)::int n FROM contacts WHERE id='junk1'")).rows[0].n, 0);
    assert.equal((await query("SELECT count(*)::int n FROM contacts WHERE id='real1'")).rows[0].n, 1);
    const st = (await query("SELECT is_archived,unread_count,contact_id,last_message FROM conversations WHERE id='cv-status'")).rows[0];
    assert.deepEqual([st.is_archived, st.unread_count, st.contact_id, st.last_message.text], [true, 0, null, "📷 Photo"]);
    assert.equal((await query("SELECT text FROM messages WHERE id='mm1'")).rows[0].text, "📷 Photo");
    assert.equal((await query("SELECT text FROM messages WHERE id='mm2'")).rows[0].text, "real words here");
  });

  await t.test("Status feeds never appear in the inbox lists", async () => {
    const list = await request(app).get("/api/conversations").set(auth);
    const names = list.body.conversations.map((c) => c.providerChatId);
    assert.ok(!names.some((n) => n.endsWith("@broadcast")));
    assert.ok(names.includes("120363000001@g.us"));
    const delta = await request(app).get("/api/conversations/changes").query({ since: "2000-01-01" }).set(auth);
    assert.ok(!delta.body.conversations.some((c) => c.providerChatId.endsWith("@broadcast")));
  });

  await t.test("opening a chat never shows an error just because WhatsApp is unreachable", async () => {
    const c = await conv("15559990000@c.us");
    await query("UPDATE conversations SET unread_count=3 WHERE id=$1", [c.id]);
    provider.markRead = async () => { throw new Error("WhatsApp session is offline"); };
    provider.getHistory = async () => { throw new Error("WhatsApp session is offline"); };
    const read = await request(app).post(`/api/conversations/${c.id}/read`).set(auth).send({});
    assert.equal(read.status, 200);
    assert.equal((await conv("15559990000@c.us")).unread_count, 0);
    const msgs = await request(app).get(`/api/conversations/${c.id}/messages`).query({ sync: "true" }).set(auth);
    assert.equal(msgs.status, 200);
    assert.equal((await request(app).post("/api/conversations/does-not-exist/read").set(auth).send({})).status, 404);
  });
});
