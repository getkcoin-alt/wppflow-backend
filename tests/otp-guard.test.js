import test, { after } from "node:test";
import assert from "node:assert/strict";
import { io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser } from "../src/services/authService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { closeSessions } from "../src/services/sessionService.js";
import { handleIncomingMessage, handleAckEvent } from "../src/services/messageService.js";
import { syncConversations } from "../src/services/conversationService.js";
import { sendOtp } from "../src/services/otp/otpService.js";
import { isOtpMessage, hasRecentOtp, forgetOtpCache } from "../src/services/otp/guard.js";

// A one-time code goes out from the company's own WhatsApp number, so it comes back as an echo, in history and in the chat list.
// None of those may turn the person who got a code into a chat, a contact or a stored message.
const SESSION = "otp-line";
let sentCount = 0;
let beforeReturn = null; // lets a test make WhatsApp's echo arrive before the send call returns
provider.getSession = () => ({ client: {} });
provider.checkNumber = async (_t, _s, p) => ({ checked: true, exists: true, jid: `${p}@c.us` });
provider.sendTextMessage = async (tenantId, sessionName, to, text) => {
  const providerMessageId = `true_${to}_${++sentCount}`;
  if (beforeReturn) await beforeReturn({ tenantId, sessionName, to, text, providerMessageId });
  return { providerMessageId, to, text, ack: 1 };
};
after(async () => {
  await closeSessions(io);
  io.close();
});

let n = 0;
const phone = () => `97152${String(1000000 + ++n)}`;
async function company(label) {
  const o = await registerTenantAndUser({ name: "Owner", email: `${label}@guard.test`, password: "Password@123", companyName: `${label} Stores` });
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,phone,status) VALUES(gen_random_uuid()::text,$1,$2,$3,'971500000000','CONNECTED')", [o.tenant.id, SESSION, o.user.id]);
  return o.tenant.id;
}
const inboxOf = async (tenantId) => ({
  conversations: (await query("SELECT count(*)::int AS n FROM conversations WHERE tenant_id=$1", [tenantId])).rows[0].n,
  contacts: (await query("SELECT count(*)::int AS n FROM contacts WHERE tenant_id=$1", [tenantId])).rows[0].n,
  messages: (await query("SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1", [tenantId])).rows[0].n,
});
const echo = (tenantId, over) =>
  handleIncomingMessage({
    tenantId,
    sessionName: SESSION,
    msg: { providerMessageId: "x", fromMe: true, remoteId: "x@c.us", rawType: "chat", type: "text", text: "", ack: 1, timestampEpoch: Math.floor(Date.now() / 1000), ...over },
  });
const codeSent = async (tenantId, to) => {
  const res = await sendOtp({ tenantId, key: null, source: "dashboard", phone: to });
  const row = (await query("SELECT * FROM otp_requests WHERE id=$1", [res.id])).rows[0];
  return row;
};

test("the echo of a code WhatsApp shows back is not a message, a chat or a contact", async () => {
  forgetOtpCache();
  const tenantId = await company("echo");
  const to = phone();
  let text;
  beforeReturn = async (s) => {
    text = s.text;
  };
  let row;
  try {
    row = await codeSent(tenantId, to);
  } finally {
    beforeReturn = null;
  }
  assert.ok(row.provider_message_id);
  forgetOtpCache(); // from here on only what is recorded in the database can recognise it
  const byId = await echo(tenantId, { providerMessageId: row.provider_message_id, remoteId: `${to}@c.us`, text: "something that is not the code's text" });
  assert.equal(byId, null, "the message id alone identifies it");
  const byText = await echo(tenantId, { providerMessageId: "another_id", remoteId: `${to}@c.us`, text });
  assert.equal(byText, null, "and so does its exact text, whatever id it arrives with");
  assert.deepEqual(await inboxOf(tenantId), { conversations: 0, contacts: 0, messages: 0 });
});

test("an echo that arrives before the send call has returned is recognised too", async () => {
  forgetOtpCache();
  const tenantId = await company("early");
  const to = phone();
  const outcomes = [];
  beforeReturn = async ({ to: jid, text, providerMessageId }) => {
    // WhatsApp shows the message to us before our own send promise resolves: nothing is stored about it yet
    outcomes.push(await echo(tenantId, { providerMessageId, remoteId: jid, text }));
  };
  try {
    await sendOtp({ tenantId, key: null, source: "dashboard", phone: to });
  } finally {
    beforeReturn = null;
  }
  assert.deepEqual(outcomes, [null]);
  assert.deepEqual(await inboxOf(tenantId), { conversations: 0, contacts: 0, messages: 0 });
});

test("history and chat-list imports, which carry no id we know, leave the code out as well", async () => {
  forgetOtpCache();
  const tenantId = await company("history");
  const to = phone();
  let text;
  beforeReturn = async (s) => {
    text = s.text;
  };
  try {
    await codeSent(tenantId, to);
  } finally {
    beforeReturn = null;
  }
  forgetOtpCache();
  // an imported message has WhatsApp's own id, not the one the send call gave us
  const imported = await handleIncomingMessage({ tenantId, sessionName: SESSION, history: true, msg: { providerMessageId: "history_unknown_id", fromMe: true, remoteId: `${to}@c.us`, rawType: "chat", type: "text", text, ack: 2, timestampEpoch: Math.floor(Date.now() / 1000) } });
  assert.equal(imported, null);
  // the phone's chat list: a preview with no id, just the last message's text
  const ordinary = phone();
  const result = await syncConversations({
    tenantId,
    sessionName: SESSION,
    remote: [
      { id: `${to}@c.us`, phone: `${to}@c.us`, contactName: to, isGroup: false, unreadCount: 0, lastActiveEpoch: Math.floor(Date.now() / 1000), lastMessage: { text, status: "sent", fromMe: true } },
      { id: `${ordinary}@c.us`, phone: `${ordinary}@c.us`, contactName: "Real Customer", isGroup: false, unreadCount: 1, lastActiveEpoch: Math.floor(Date.now() / 1000), lastMessage: { text: "Is the shop open today?", status: "delivered", fromMe: false } },
    ],
  });
  assert.equal(result.upsertedCount, 1, "only the real chat was imported");
  const chats = (await query("SELECT phone FROM conversations WHERE tenant_id=$1", [tenantId])).rows.map((r) => r.phone);
  assert.deepEqual(chats, [`${ordinary}@c.us`]);
  assert.equal((await inboxOf(tenantId)).messages, 0);
});

test("a person who answers a code is an ordinary customer, and a message typed on the phone is an ordinary message", async () => {
  forgetOtpCache();
  const tenantId = await company("reply");
  const to = phone();
  let text;
  beforeReturn = async (s) => {
    text = s.text;
  };
  try {
    await codeSent(tenantId, to);
  } finally {
    beforeReturn = null;
  }
  await echo(tenantId, { providerMessageId: "echo_1", remoteId: `${to}@c.us`, text });
  assert.equal((await inboxOf(tenantId)).conversations, 0);
  const reply = await echo(tenantId, { providerMessageId: "in_1", fromMe: false, remoteId: `${to}@c.us`, text: "who is this?", senderName: "Asha" });
  assert.ok(reply, "a customer's reply is stored");
  const typed = await echo(tenantId, { providerMessageId: "typed_1", fromMe: true, remoteId: `${to}@c.us`, text: "Hi Asha, this is the shop. How can I help?" });
  assert.ok(typed, "what the owner types on the phone is stored");
  const stored = (await query("SELECT text,sender FROM messages WHERE tenant_id=$1 ORDER BY timestamp_epoch,created_at", [tenantId])).rows;
  assert.deepEqual(stored.map((m) => m.text).sort(), ["Hi Asha, this is the shop. How can I help?", "who is this?"]);
  assert.ok(!stored.some((m) => /\*\d+\*/.test(m.text)), "no code is in the message tables");
  assert.deepEqual(await inboxOf(tenantId), { conversations: 1, contacts: 1, messages: 2 });
});

test("a code to someone who is already a customer does not appear in their chat or change its preview", async () => {
  forgetOtpCache();
  const tenantId = await company("existing");
  const to = phone();
  await echo(tenantId, { providerMessageId: "in_0", fromMe: false, remoteId: `${to}@c.us`, text: "Hello", senderName: "Ravi" });
  const before = (await query("SELECT last_message FROM conversations WHERE tenant_id=$1", [tenantId])).rows[0].last_message;
  let text;
  beforeReturn = async (s) => {
    text = s.text;
  };
  try {
    await codeSent(tenantId, to);
  } finally {
    beforeReturn = null;
  }
  await echo(tenantId, { providerMessageId: "echo_2", remoteId: `${to}@c.us`, text });
  assert.equal((await inboxOf(tenantId)).messages, 1);
  assert.deepEqual((await query("SELECT last_message FROM conversations WHERE tenant_id=$1", [tenantId])).rows[0].last_message, before);
  // the same in the chat list
  await syncConversations({ tenantId, sessionName: SESSION, remote: [{ id: `${to}@c.us`, phone: `${to}@c.us`, contactName: "Ravi", isGroup: false, unreadCount: 0, lastActiveEpoch: Math.floor(Date.now() / 1000) + 5, lastMessage: { text, status: "sent", fromMe: true } }] });
  assert.deepEqual((await query("SELECT last_message FROM conversations WHERE tenant_id=$1", [tenantId])).rows[0].last_message, before, "the preview never shows a code");
});

test("delivery receipts for a code update the OTP log, and leave no unmatched receipt behind", async () => {
  forgetOtpCache();
  const tenantId = await company("acks");
  const row = await codeSent(tenantId, phone());
  const r2 = await handleAckEvent({ tenantId, ackData: { providerMessageId: row.provider_message_id, ack: 2 } });
  assert.equal(r2, null, "it was not a chat message");
  let now = (await query("SELECT status,ack,delivered_at FROM otp_requests WHERE id=$1", [row.id])).rows[0];
  assert.deepEqual({ status: now.status, ack: now.ack, delivered: Boolean(now.delivered_at) }, { status: "delivered", ack: 2, delivered: true });
  await handleAckEvent({ tenantId, ackData: { providerMessageId: row.provider_message_id, ack: 3 } });
  now = (await query("SELECT status,ack FROM otp_requests WHERE id=$1", [row.id])).rows[0];
  assert.deepEqual({ status: now.status, ack: now.ack }, { status: "read", ack: 3 });
  assert.equal((await query("SELECT count(*)::int AS n FROM early_receipts WHERE tenant_id=$1", [tenantId])).rows[0].n, 0);
  // a receipt for something that is not a code still waits for its message, as before
  await handleAckEvent({ tenantId, ackData: { providerMessageId: "true_other_message", ack: 2 } });
  assert.equal((await query("SELECT count(*)::int AS n FROM early_receipts WHERE tenant_id=$1", [tenantId])).rows[0].n, 1);
  // a failed delivery closes the code
  const bad = await codeSent(tenantId, phone());
  await handleAckEvent({ tenantId, ackData: { providerMessageId: bad.provider_message_id, ack: -1 } });
  const failed = (await query("SELECT status,error_code FROM otp_requests WHERE id=$1", [bad.id])).rows[0];
  assert.deepEqual(failed, { status: "failed", error_code: "delivery_failed" });
});

test("a company that never sends a code pays nothing for the guard, and only outgoing messages are ever looked at", async () => {
  forgetOtpCache();
  const quiet = await company("quiet");
  assert.equal(await hasRecentOtp(quiet), false);
  assert.equal(await isOtpMessage({ tenantId: quiet, sessionName: SESSION, providerMessageId: "x", text: "*123456* is your code", fromMe: true }), false);
  const busy = await company("busy");
  await codeSent(busy, phone());
  assert.equal(await hasRecentOtp(busy), true);
  assert.equal(await isOtpMessage({ tenantId: busy, sessionName: SESSION, providerMessageId: "x", text: "something else", fromMe: true }), false);
  assert.equal(await isOtpMessage({ tenantId: busy, sessionName: SESSION, providerMessageId: "x", text: "something else", fromMe: false }), false, "an incoming message is never a code");
  // one company's code is not another's
  let text;
  beforeReturn = async (s) => {
    text = s.text;
  };
  try {
    await codeSent(busy, phone());
  } finally {
    beforeReturn = null;
  }
  assert.equal(await isOtpMessage({ tenantId: busy, sessionName: SESSION, text, fromMe: true }), true);
  assert.equal(await isOtpMessage({ tenantId: quiet, sessionName: SESSION, text, fromMe: true }), false);
});
