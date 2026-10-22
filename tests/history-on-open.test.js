import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";

test("Opening a chat loads its WhatsApp history into that very chat", async (t) => {
  const original = { getSession: provider.getSession };
  t.after(async () => {
    Object.assign(provider, original);
    await closeSessions(io);
    io.close();
  });

  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@history.test", password: "Password@123", companyName: "History Co" });
  const tenantId = o.tenant.id;
  const auth = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  const LID = "25916335988980@lid";
  await query(
    `INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,phone,contact_name,last_message,last_active_epoch)
     VALUES('conv-lid',$1,'line-1',$2,$2,'Scriza My Private Limited',$3,1700000100)`,
    [tenantId, LID, JSON.stringify({ text: "Dear Team, Greetings", timestamp: new Date(1700000100000).toISOString(), status: "delivered" })],
  );

  const raw = (id, fields) => ({ id: { _serialized: id }, type: "chat", ack: 2, ...fields });
  // WhatsApp's own sender/recipient ids do not match the chat id: a phone number, and an object.
  const history = [
    raw("m1", { fromMe: false, from: "919876543210@c.us", body: "Hello, interested in your service", timestamp: 1700000000, notifyName: "Scriza" }),
    raw("m2", { fromMe: true, to: "919876543210@c.us", body: "Sure, sending details", timestamp: 1700000050 }),
    raw("m3", { fromMe: false, from: { server: "lid", user: "25916335988980" }, body: "Dear Team, Greetings", timestamp: 1700000100 }),
  ];
  provider.getSession = () => ({ client: { getMessages: async (chatId) => (chatId === LID ? history : []) } });

  const open = (extra = "") => request(app).get(`/api/conversations/conv-lid/messages?${extra}`).set(auth);

  await t.test("a chat that was never backfilled opens empty without a sync", async () => {
    const res = await open();
    assert.equal(res.status, 200);
    assert.equal(res.body.messages.length, 0);
    assert.equal(res.body.historySync, undefined);
  });

  await t.test("syncing files every message under the chat that was asked for, whatever ids WhatsApp reports", async () => {
    // An earlier sync had filed the first message under a phone-number chat instead.
    await handleIncomingMessage({
      tenantId,
      sessionName: "line-1",
      history: true,
      msg: { providerMessageId: "m1", fromMe: false, remoteId: "919876543210@c.us", rawType: "chat", type: "text", text: "Hello, interested in your service", timestampEpoch: 1700000000, senderName: "Scriza", ack: 2 },
    });
    const stray = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND provider_chat_id='919876543210@c.us'", [tenantId])).rows[0].id;
    assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1", [stray])).rows[0].n, 1);

    const res = await open("sync=true");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.historySync, { fetched: 3, stored: 3 }, "one adopted, two new");
    assert.deepEqual(res.body.messages.map((m) => m.text), ["Hello, interested in your service", "Sure, sending details", "Dear Team, Greetings"]);
    assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1", [stray])).rows[0].n, 0, "nothing is left behind in the wrong chat");
  });

  await t.test("syncing again adds nothing twice", async () => {
    const res = await open("sync=true");
    assert.deepEqual(res.body.historySync, { fetched: 3, stored: 0 });
    assert.equal(res.body.messages.length, 3);
  });

  await t.test("when WhatsApp is unreachable the chat still opens and says why", async () => {
    provider.getSession = () => null;
    const res = await open("sync=true");
    assert.equal(res.status, 200);
    assert.equal(res.body.historySync.fetched, 0);
    assert.match(res.body.historySync.error, /offline/);
    assert.equal(res.body.messages.length, 3, "what is already saved is still shown");
  });
});
