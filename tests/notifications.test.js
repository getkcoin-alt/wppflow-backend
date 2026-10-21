import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io as serverIo } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not reached");
};
const settle = () => new Promise((r) => setTimeout(r, 150));

test("Team notifications: notes, mentions, assignments, lost phones", async (t) => {
  const original = { ...provider };
  const emitted = [];
  const recorder = {
    to(room) {
      const rooms = [room];
      const chain = { to: (r) => (rooms.push(r), chain), emit: (event, payload) => emitted.push({ rooms, event, payload }) };
      return chain;
    },
  };
  app.set("io", recorder);
  t.after(async () => {
    app.set("io", serverIo);
    Object.assign(provider, original);
    await closeSessions(serverIo);
    serverIo.close();
  });

  const o = await registerTenantAndUser({ name: "Olivia Owner", email: "olivia@notif.test", password: "Password@123", companyName: "Notif Co" });
  const tenantId = o.tenant.id;
  const mkUser = async (name, role) => {
    const u = (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [name, `${name.split(" ")[0].toLowerCase()}@notif.test`])).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)", [tenantId, u.id, role]);
    return { row: u, id: u.id, auth: { Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` } };
  };
  const owner = { id: o.user.id, auth: { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` } };
  const sam = await mkUser("Sam Staff", "agent");
  const tina = await mkUser("Tina Staff", "agent");
  for (const [session, who] of [["line-sam", sam], ["line-tina", tina]])
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id) VALUES(gen_random_uuid()::text,$1,$2,$3)", [tenantId, session, who.id]);
  const chat = async (id, session, name) =>
    query("INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,phone,contact_name,last_active_epoch) VALUES($1,$2,$3,$4,$5,$6,1700000000)", [id, tenantId, session, `${id}@c.us`, id, name]);
  await chat("conv-sam", "line-sam", "Alice");
  await chat("conv-tina", "line-tina", "Bob");

  const list = async (who) => (await request(app).get("/api/notifications").set(who.auth)).body;
  const note = (who, id, text) => request(app).post(`/api/conversations/${id}/notes`).set(who.auth).send({ text, idempotencyKey: `${id}-${text}-${Math.random()}` });
  const pushes = (userId) => emitted.filter((e) => e.event === "notification:new" && e.rooms.includes(`user:${userId}`));

  await t.test("a team note tells the person whose WhatsApp it is, not the author or other staff", async () => {
    assert.equal((await note(owner, "conv-sam", "Customer wants a call back")).status, 201);
    const n = await until(async () => (await list(sam)).notifications[0]);
    assert.equal(n.type, "note");
    assert.equal(n.conversationId, "conv-sam");
    assert.match(n.title, /Olivia Owner left a team note on Alice/);
    assert.equal(n.body, "Customer wants a call back");
    assert.equal(n.read, false);
    assert.equal((await list(sam)).unreadCount, 1);
    assert.equal((await list(owner)).notifications.length, 0, "the author is never notified of their own note");
    assert.equal((await list(tina)).notifications.length, 0, "another staff member's chat stays private");
    assert.equal(pushes(sam.id).length, 1, "pushed live to the recipient's browser");
    assert.equal(pushes(tina.id).length, 0);
  });

  await t.test("@mentions reach people who can open the chat and are ignored for people who cannot", async () => {
    await note(sam, "conv-sam", "cc @Olivia Owner and @Tina Staff please check");
    const mine = await until(async () => (await list(owner)).notifications.find((n) => n.type === "mention"));
    assert.match(mine.title, /Sam Staff left a team note/);
    await settle();
    assert.equal((await list(tina)).notifications.length, 0, "Tina cannot open this chat, so she is not told about it");
    assert.equal((await list(sam)).notifications.length, 1, "no self-notification");
  });

  await t.test("assigning a chat notifies the assignee and lets them open it", async () => {
    assert.equal((await request(app).get("/api/conversations/conv-tina").set(sam.auth)).status, 404, "before assignment");
    const res = await request(app).patch("/api/conversations/conv-tina").set(owner.auth).send({ assignedUserId: sam.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.conversation.assignedTo, "Sam Staff");
    assert.equal(res.body.conversation.assignedUserId, sam.id);
    const n = await until(async () => (await list(sam)).notifications.find((x) => x.type === "assignment"));
    assert.match(n.title, /Olivia Owner assigned you a chat/);
    assert.equal(n.body, "Bob");
    assert.equal(n.conversationId, "conv-tina");

    assert.equal((await request(app).get("/api/conversations/conv-tina").set(sam.auth)).status, 200);
    const mine = (await request(app).get("/api/conversations").set(sam.auth)).body.conversations.map((c) => c.id).sort();
    assert.deepEqual(mine, ["conv-sam", "conv-tina"]);
    const delta = await request(app).get("/api/conversations/changes").query({ since: "2000-01-01" }).set(sam.auth);
    assert.equal(delta.body.conversations.length, 2);
    assert.equal((await request(app).get("/api/conversations/conv-tina/messages").set(sam.auth)).status, 200);
    assert.equal((await note(sam, "conv-tina", "I'll handle Bob")).status, 201);
    const tinaNote = await until(async () => (await list(tina)).notifications[0]);
    assert.match(tinaNote.title, /Sam Staff left a team note on Bob/, "the number's owner hears about the assignee's note");
    assert.ok(emitted.some((e) => e.rooms.includes(`user:${sam.id}`) && e.event === "conversation:updated"), "live updates also reach the assignee");
  });

  await t.test("unassigning removes the assignee's access again; unknown people cannot be assigned", async () => {
    assert.equal((await request(app).patch("/api/conversations/conv-tina").set(owner.auth).send({ assignedTo: "" })).status, 200);
    assert.equal((await request(app).get("/api/conversations/conv-tina").set(sam.auth)).status, 404);
    assert.equal((await request(app).patch("/api/conversations/conv-tina").set(owner.auth).send({ assignedTo: "Nobody Here" })).status, 400);
    assert.equal((await request(app).patch("/api/conversations/conv-tina").set(owner.auth).send({ assignedUserId: 999999 })).status, 400);
    // by display name (what older screens send) still works and also grants access
    assert.equal((await request(app).patch("/api/conversations/conv-tina").set(owner.auth).send({ assignedTo: "Sam Staff" })).status, 200);
    assert.equal((await request(app).get("/api/conversations/conv-tina").set(sam.auth)).status, 200);
    // self-assignment is not a notification
    const before = (await list(owner)).notifications.length;
    await request(app).patch("/api/conversations/conv-sam").set(owner.auth).send({ assignedUserId: owner.id });
    await settle();
    assert.equal((await list(owner)).notifications.length, before);
  });

  await t.test("everyone only ever reads and clears their own notifications", async () => {
    const mineBefore = await list(sam);
    assert.ok(mineBefore.unreadCount >= 2);
    const first = mineBefore.notifications[0];
    assert.equal((await request(app).post(`/api/notifications/${first.id}/read`).set(tina.auth).send({})).status, 404, "not Tina's");
    const read = await request(app).post(`/api/notifications/${first.id}/read`).set(sam.auth).send({});
    assert.equal(read.status, 200);
    assert.equal(read.body.unreadCount, mineBefore.unreadCount - 1);
    assert.equal((await request(app).post("/api/notifications/not-an-id/read").set(sam.auth).send({})).status, 404);
    const unread = await request(app).get("/api/notifications").query({ unread: "true" }).set(sam.auth);
    assert.ok(unread.body.notifications.every((n) => !n.read));
    const tinaCount = (await list(tina)).unreadCount;
    assert.equal((await request(app).post("/api/notifications/read-all").set(sam.auth).send({})).body.unreadCount, 0);
    assert.equal((await list(sam)).unreadCount, 0);
    assert.equal((await list(tina)).unreadCount, tinaCount, "Tina's badge is untouched");
    const page = await request(app).get("/api/notifications").query({ limit: 1 }).set(sam.auth);
    assert.equal(page.body.notifications.length, 1);
    assert.ok(page.body.nextCursor);
    assert.equal((await request(app).get("/api/notifications").query({ cursor: "junk" }).set(sam.auth)).status, 400);
    assert.equal((await request(app).get("/api/notifications")).status, 401);
  });

  await t.test("an unexpectedly dropped phone alerts its owner and the managers once", async () => {
    let status;
    provider.startSession = async (tenant, name, cb) => {
      status = cb.onStatus;
      await cb.onStatus("CONNECTED");
    };
    provider.getSession = () => ({ phone: "15550009999@c.us" });
    provider.closeSession = async () => {};
    emitted.length = 0;
    assert.equal((await request(app).post("/api/sessions/start").set(sam.auth).send({})).status, 202);
    const name = `staff-${sam.id}`;
    await until(async () => (await query("SELECT phone FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [tenantId, name])).rows[0]?.phone);
    await status("DISCONNECTED");
    const alert = await until(async () => (await list(sam)).notifications.find((n) => n.type === "session"));
    assert.match(alert.title, /disconnected/);
    assert.ok((await list(owner)).notifications.some((n) => n.type === "session"), "managers are told as well");
    assert.equal((await list(tina)).notifications.some((n) => n.type === "session"), false, "unrelated staff are not");
    await status("DISCONNECTED");
    await settle();
    assert.equal((await list(sam)).notifications.filter((n) => n.type === "session").length, 1, "one alert per outage");
  });
});
