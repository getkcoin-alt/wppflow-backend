import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io as serverIo } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ENV } from "../src/config/env.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { withDeadline } from "../src/services/deadline.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000, what = "condition") => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error(`not reached: ${what}`);
};

test("A call that waits on WhatsApp's browser never waits for ever", async (t) => {
  await t.test("withDeadline: the answer if it comes in time, a DEADLINE error if not, and nothing is left running", async () => {
    assert.equal(await withDeadline(Promise.resolve(7), 500), 7);
    await assert.rejects(withDeadline(new Promise(() => {}), 40, "Reading the chats"), (e) => e.code === "DEADLINE" && /Reading the chats took longer than/.test(e.message));
    await assert.rejects(withDeadline(Promise.reject(new Error("boom")), 500), /boom/);
    // work that finishes after the deadline neither crashes the process nor is reported twice
    let finish;
    const late = new Promise((r) => (finish = r));
    await assert.rejects(withDeadline(late, 20), (e) => e.code === "DEADLINE");
    finish("late");
    await sleep(20);
  });
});

test("The inbox sync button starts the sync and answers at once; opening a chat does not hang either", async (t) => {
  void provider;
  const original = { ...provider };
  const saved = { ...ENV };
  const events = [];
  const recorder = {
    to() {
      const chain = { to: () => chain, emit: (event, payload) => events.push({ event, payload }) };
      return chain;
    },
  };
  app.set("io", recorder);
  t.after(async () => {
    app.set("io", serverIo);
    Object.assign(provider, original);
    Object.assign(ENV, saved);
    await closeSessions(serverIo);
    serverIo.close();
  });
  const o = await registerTenantAndUser({ name: "Sana", email: "sana@syncbg.test", password: "Password@123", companyName: "SyncBg Co" });
  const tenantId = o.tenant.id;
  const auth = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,status,phone,owner_user_id) VALUES(gen_random_uuid()::text,$1,'line-1','CONNECTED','971500000001',$2)", [tenantId, o.user.id]);
  const chats = [
    { id: "15551110001@c.us", phone: "15551110001@c.us", contactName: "Alice", unreadCount: 1, isGroup: false, lastActiveEpoch: 1700000100, lastMessage: { text: "hi", fromMe: false } },
    { id: "15551110002@c.us", phone: "15551110002@c.us", contactName: "Bob", unreadCount: 0, isGroup: false, lastActiveEpoch: 1700000200, lastMessage: { text: "yo", fromMe: false } },
  ];
  provider.syncConversations = async () => chats;
  const press = () => request(app).post("/api/sessions/line-1/sync-inbox").set(auth).timeout({ response: 8000 }).send({});
  const progress = (phase) => events.some((e) => e.event === "sync:progress" && e.payload.phase === phase);

  await t.test("it answers at once while the work goes on, and pressing it again meanwhile does nothing", async () => {
    let release;
    provider.getContacts = () => new Promise((resolve) => (release = () => resolve([{ id: { _serialized: "15551110001@c.us" }, name: "Alice A" }])));
    const began = Date.now();
    const first = await press();
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.deepEqual(first.body, { status: "success", started: true });
    assert.ok(Date.now() - began < 1500, "answered before the work was done");
    await until(() => progress("chats"), 3000, "progress started");
    assert.equal(progress("done"), false, "WhatsApp has not answered yet");

    const second = await press();
    assert.deepEqual(second.body, { status: "success", started: false, alreadyRunning: true });

    release(); // WhatsApp answers; the work finishes by itself
    await until(() => progress("done"), 5000, "progress done");
    assert.ok(events.some((e) => e.event === "inbox:synced"), "the screen is told to refresh");
    assert.equal((await query("SELECT count(*)::int AS n FROM conversations WHERE tenant_id=$1 AND session_name='line-1'", [tenantId])).rows[0].n, 2);
    assert.equal((await query("SELECT name FROM contacts WHERE tenant_id=$1 AND phone='15551110001'", [tenantId])).rows[0]?.name, "Alice A");
  });

  await t.test("a WhatsApp call that never answers is given up on, the screen is told, and the next press works", async () => {
    ENV.SYNC_STEP_TIMEOUT_MS = 150;
    provider.getContacts = () => new Promise(() => {});
    events.length = 0;
    const stuck = await press();
    assert.equal(stuck.body.started, true);
    await until(() => progress("failed"), 4000, "failed reported");
    // not left "syncing" until the server is restarted
    provider.getContacts = async () => [];
    const again = await press();
    assert.equal(again.body.started, true, "the guard was released");
    await until(() => progress("done"), 4000, "second sync done");
    ENV.SYNC_STEP_TIMEOUT_MS = saved.SYNC_STEP_TIMEOUT_MS;
  });

  await t.test("opening a chat while WhatsApp is slow shows what is saved at once, and keeps the messages when they arrive", async () => {
    await query(
      `INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,phone,contact_name,last_message,last_active_epoch)
       VALUES('conv-slow',$1,'line-1','15551110005@c.us','15551110005@c.us','Slow Sam',$2,1700000100)`,
      [tenantId, JSON.stringify({ text: "older", timestamp: new Date(1700000100000).toISOString(), status: "delivered" })],
    );
    ENV.HISTORY_ON_OPEN_TIMEOUT_MS = 150;
    let arrive;
    provider.getHistory = () => new Promise((resolve) => (arrive = resolve));
    const began = Date.now();
    const res = await request(app).get("/api/conversations/conv-slow/messages?sync=true").set(auth).timeout({ response: 8000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Date.now() - began < 3000, `opened after ${Date.now() - began} ms although WhatsApp never answered`);
    assert.match(res.body.historySync.error, /WhatsApp took longer than/);
    assert.equal(res.body.messages.length, 0);
    // WhatsApp answers afterwards: nothing is lost
    arrive([{ providerMessageId: "late-1", remoteId: "15551110005@c.us", fromMe: false, ack: 0, senderName: "Slow Sam", text: "I was slow", type: "text", timestampEpoch: 1700000300 }]);
    await until(async () => (await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id='conv-slow'")).rows[0].n === 1, 4000, "late messages kept");
    ENV.HISTORY_ON_OPEN_TIMEOUT_MS = saved.HISTORY_ON_OPEN_TIMEOUT_MS;
    const second = await request(app).get("/api/conversations/conv-slow/messages").set(auth);
    assert.deepEqual(second.body.messages.map((m) => m.text), ["I was slow"]);
  });
});
