import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { closeSessions } from "../src/services/sessionService.js";

test("A manager sees every WhatsApp number and can look at one at a time; staff only their own", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@numbers.test", password: "Password@123", companyName: "Numbers Co" });
  const tenantId = o.tenant.id;
  const mk = async (name) => (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [name, `${name.toLowerCase()}@numbers.test`])).rows[0];
  const sam = await mk("Sam"), tina = await mk("Tina");
  for (const u of [sam, tina]) await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, u.id]);
  await query(
    "INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id) VALUES(gen_random_uuid()::text,$1,'line-olivia',$2),(gen_random_uuid()::text,$1,'line-sam',$3),(gen_random_uuid()::text,$1,'line-tina',$4)",
    [tenantId, o.user.id, sam.id, tina.id],
  );
  const auth = (u, role) => ({ Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` });
  const owner = auth(o.user, "owner"), samAuth = auth(sam, "agent");

  let epoch = 1700000000;
  const receive = (session, remote, name) =>
    handleIncomingMessage({
      tenantId,
      sessionName: session,
      msg: { providerMessageId: `true_${remote}_${++epoch}`, fromMe: false, remoteId: remote, rawType: "chat", type: "text", text: `hi from ${name}`, timestampEpoch: epoch, senderName: name, ack: 2 },
    });
  await receive("line-olivia", "919000000001@c.us", "Asha");
  await receive("line-sam", "919000000002@c.us", "Bala");
  await receive("line-sam", "919000000003@c.us", "Chitra");
  await receive("line-tina", "919000000004@c.us", "Dev");
  const chats = async (who, qs = "") => (await request(app).get(`/api/conversations${qs}`).set(who)).body.conversations.map((c) => c.contactName).sort();

  await t.test("the owner sees every number's chats together, with the number each one is on", async () => {
    assert.deepEqual(await chats(owner), ["Asha", "Bala", "Chitra", "Dev"]);
    const body = (await request(app).get("/api/conversations").set(owner)).body;
    const by = Object.fromEntries(body.conversations.map((c) => [c.contactName, c.channel]));
    assert.deepEqual(by, { Asha: "line-olivia", Bala: "line-sam", Chitra: "line-sam", Dev: "line-tina" });
  });

  await t.test("the owner can look at one number at a time", async () => {
    assert.deepEqual(await chats(owner, "?sessionName=line-sam"), ["Bala", "Chitra"]);
    assert.deepEqual(await chats(owner, "?sessionName=line-tina"), ["Dev"]);
    assert.deepEqual(await chats(owner, "?sessionName=line-olivia"), ["Asha"]);
    assert.deepEqual(await chats(owner, "?sessionName=nobody"), []);
    assert.deepEqual(await chats(owner, "?sessionName="), ["Asha", "Bala", "Chitra", "Dev"], "an empty choice means every number");
  });

  await t.test("a number can be combined with search and the unread filter", async () => {
    assert.deepEqual(await chats(owner, "?sessionName=line-sam&search=chit"), ["Chitra"]);
    assert.deepEqual(await chats(owner, "?sessionName=line-sam&filter=unread"), ["Bala", "Chitra"]);
    assert.deepEqual(await chats(owner, "?sessionName=line-tina&search=chit"), []);
  });

  await t.test("a teammate sees only their own number, and cannot reach another's by asking", async () => {
    assert.deepEqual(await chats(samAuth), ["Bala", "Chitra"]);
    assert.deepEqual(await chats(samAuth, "?sessionName=line-sam"), ["Bala", "Chitra"]);
    assert.deepEqual(await chats(samAuth, "?sessionName=line-tina"), []);
    assert.deepEqual(await chats(samAuth, "?sessionName=line-olivia"), []);
  });

  await t.test("the numbers list shows the owner everything and a teammate just theirs", async () => {
    const all = (await request(app).get("/api/sessions").set(owner)).body;
    assert.equal(all.scope, "workspace");
    assert.deepEqual(all.sessions.map((s) => [s.sessionKey, s.ownerName]).sort(), [["line-olivia", "Olivia"], ["line-sam", "Sam"], ["line-tina", "Tina"]]);
    const mine = (await request(app).get("/api/sessions").set(samAuth)).body;
    assert.equal(mine.scope, "own");
    assert.deepEqual(mine.sessions.map((s) => s.sessionKey), ["line-sam"]);
  });
});
