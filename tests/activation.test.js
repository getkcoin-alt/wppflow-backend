import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage, sendTextMessage } from "../src/services/messageService.js";

test("first-enquiry setup measures delivered human replies, scoped to the company", async (t) => {
  t.after(() => io.close());
  const owner = await registerTenantAndUser({ name: "Owner", email: "owner@activation.test", password: "Password@123", companyName: "Agency" });
  const tenant = owner.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenant]);
  const auth = { Authorization: `Bearer ${generateAccessToken(owner.user, tenant, "owner")}` };
  const home = async (headers = auth) => {
    const response = await request(app).get("/api/home").set(headers);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const replied = async () => (await home()).activation.hasDeliveredReply;
  const hear = async (remote, group = false) => {
    await handleIncomingMessage({ tenantId: tenant, sessionName: "agency", msg: { providerMessageId: crypto.randomUUID(), fromMe: false, remoteId: remote, type: "text", rawType: "chat", text: "Please send details", timestampEpoch: Math.floor(Date.now()/1000)-10, ack: 2 } });
    const row = (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND provider_chat_id=$2", [tenant, remote])).rows[0];
    if (group) await query("UPDATE conversations SET is_group=true WHERE id=$1", [row.id]);
    return row;
  };
  const send = async (conversation, extra = {}) => (await sendTextMessage({ tenantId: tenant, conversationId: conversation.id, text: "Here are the details", idempotencyKey: crypto.randomUUID(), agentName: "Owner", sentByUserId: owner.user.id, ...extra })).message;
  const deliver = (id, status = "delivered") => query("UPDATE messages SET status=$2 WHERE id=$1", [id, status]);

  await t.test("a new workspace starts at zero; solo plans never require a second seat", async () => {
    let h = await home();
    assert.equal(h.activation.setup.done, 0);
    assert.equal(h.activation.firstReplyAt, null);
    assert.deepEqual(h.activation.setup.steps.map(s => s.key), ["connect", "reply", "team"]);
    await query("UPDATE tenants SET plan='Free' WHERE id=$1", [tenant]);
    h = await home();
    assert.deepEqual(h.activation.setup.steps.map(s => s.key), ["connect", "reply"]);
    await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenant]);
  });
  const conversation = await hear("971500000123@c.us");
  await t.test("notes, queued sends, failures and automatic replies do not activate", async () => {
    await send(conversation, { type: "internal_note" });
    const queued = await send(conversation);
    assert.equal(await replied(), false);
    await deliver(queued.id, "failed");
    const bot = await send(conversation, { agentName: "Riwo", sentByUserId: null });
    await deliver(bot.id);
    assert.equal(await replied(), false);
  });
  await t.test("imported outgoing history and group replies do not activate", async () => {
    await handleIncomingMessage({ tenantId: tenant, sessionName: "agency", history: true, msg: { providerMessageId: crypto.randomUUID(), fromMe: true, remoteId: "971500000123@c.us", type: "text", rawType: "chat", text: "Old reply", timestampEpoch: 100, ack: 3 } });
    const group = await hear("120363000000001@g.us", true);
    const reply = await send(group);
    await deliver(reply.id);
    assert.equal(await replied(), false);
  });
  await t.test("a reply needs an incoming enquiry in that conversation", async () => {
    const outgoingOnly = await hear("971500000124@c.us");
    await query("DELETE FROM messages WHERE conversation_id=$1", [outgoingOnly.id]);
    const reply = await send(outgoingOnly);
    await deliver(reply.id);
    assert.equal(await replied(), false);
  });
  await t.test("delivery completes the step and refreshes do not move its timestamp", async () => {
    const reply = await send(conversation);
    assert.equal(await replied(), false);
    await deliver(reply.id);
    const h = await home();
    assert.equal(h.activation.hasDeliveredReply, true);
    assert.ok(h.activation.firstReplyAt);
    assert.equal(h.activation.setup.steps.find(s => s.key === "reply").done, true);
    await deliver(reply.id, "read");
    assert.equal((await home()).activation.firstReplyAt, h.activation.firstReplyAt);
  });
  await t.test("a different company and staff cannot read the manager's activation data", async () => {
    const other = await registerTenantAndUser({ name: "Other", email: "other@activation.test", password: "Password@123", companyName: "Other agency" });
    const otherAuth = { Authorization: `Bearer ${generateAccessToken(other.user, other.tenant.id, "owner")}` };
    assert.equal((await home(otherAuth)).activation.hasDeliveredReply, false);
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenant, other.user.id]);
    const staff = await home({ Authorization: `Bearer ${generateAccessToken(other.user, tenant, "agent")}` });
    assert.equal(staff.activation, null);
    assert.equal(staff.setup, null);
  });
});
