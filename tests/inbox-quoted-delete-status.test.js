import test from "node:test";
import assert from "node:assert";
import {
  handleAckEvent,
  sendTextMessage,
  deleteMessage,
  getConversationMessages,
} from "../src/services/messageService.js";
import { registerTenantAndUser } from "../src/services/authService.js";
import { query } from "../src/db/index.js";
import { ACK_STATUS } from "../src/config/constants.js";

test("Inbox Quoted Replies, Message Deletion, and last_message Status Suite", async (t) => {
  const tData = await registerTenantAndUser({
    name: "Inbox Tester",
    email: `inbox_${Date.now()}@example.com`,
    password: "Password@123",
    companyName: "Inbox Testing Corp",
  });
  const tenantId = tData.tenant.id;

  const convId = `conv_inbox_${Date.now()}`;
  await query(
    `INSERT INTO conversations (id, tenant_id, session_name, phone, provider_chat_id, contact_name, last_active_epoch, last_message)
     VALUES ($1, $2, 'primary-whatsapp', '919888888888', '919888888888@c.us', 'Inbox Contact', 1700000000, $3)`,
    [
      convId,
      tenantId,
      JSON.stringify({ text: "Hello", status: "sending", fromMe: true }),
    ],
  );

  let firstMsgId;
  const firstProviderId = `wamid_inbox_1_${Date.now()}`;

  await t.test(
    "1. sendTextMessage sets initial last_message with id and status sending",
    async () => {
      const sent = await sendTextMessage({
        tenantId,
        conversationId: convId,
        text: "Initial message to customer",
        idempotencyKey: `idemp_${Date.now()}_1`,
        agentName: "Agent One",
      });

      assert.ok(sent.message);
      firstMsgId = sent.message.id;

      const { rows } = await query(
        "SELECT last_message FROM conversations WHERE id = $1 AND tenant_id = $2",
        [convId, tenantId],
      );
      const lm = rows[0]?.last_message;
      assert.strictEqual(lm.id, firstMsgId);
      assert.strictEqual(lm.status, "sending");
    },
  );

  await t.test(
    "2. handleAckEvent updates conversations.last_message status and ack",
    async () => {
      // Simulate linking provider message ID
      await query(
        "UPDATE messages SET provider_message_id = $1 WHERE id = $2 AND tenant_id = $3",
        [firstProviderId, firstMsgId, tenantId],
      );

      const ackRes = await handleAckEvent({
        tenantId,
        ackData: {
          providerMessageId: firstProviderId,
          ack: ACK_STATUS.DELIVERY,
        },
      });

      assert.ok(ackRes);
      assert.strictEqual(ackRes.status, "delivered");

      const { rows } = await query(
        "SELECT last_message FROM conversations WHERE id = $1 AND tenant_id = $2",
        [convId, tenantId],
      );
      const lm = rows[0]?.last_message;
      assert.strictEqual(
        lm.status,
        "delivered",
        "last_message status should be updated to delivered",
      );
      assert.strictEqual(lm.ack, ACK_STATUS.DELIVERY);
    },
  );

  let replyMsgId;
  await t.test(
    "3. Quoted reply stores quoted snippet and quoted_message_id",
    async () => {
      const reply = await sendTextMessage({
        tenantId,
        conversationId: convId,
        text: "Replying to your initial message",
        idempotencyKey: `idemp_${Date.now()}_2`,
        agentName: "Agent One",
        quotedMessageId: firstMsgId,
      });

      assert.ok(reply.message);
      replyMsgId = reply.message.id;
      assert.strictEqual(reply.message.quotedMessageId, firstMsgId);
      assert.ok(reply.message.quoted);
      assert.strictEqual(reply.message.quoted.id, firstMsgId);
      assert.strictEqual(
        reply.message.quoted.text,
        "Initial message to customer",
      );

      // Verify DB column persistence
      const { rows } = await query(
        "SELECT quoted, quoted_message_id FROM messages WHERE id = $1 AND tenant_id = $2",
        [replyMsgId, tenantId],
      );
      assert.strictEqual(rows[0].quoted_message_id, firstMsgId);
      assert.strictEqual(
        rows[0].quoted?.text,
        "Initial message to customer",
      );
    },
  );

  await t.test(
    "4. Delete for everyone (revocation) marks type=revoked, status=deleted, and updates last_message",
    async () => {
      const delRes = await deleteMessage({
        tenantId,
        conversationId: convId,
        messageId: replyMsgId,
        forEveryone: true,
      });

      assert.strictEqual(delRes.deleted, true);
      assert.strictEqual(delRes.forEveryone, true);
      assert.strictEqual(delRes.message.type, "revoked");
      assert.strictEqual(delRes.message.status, "deleted");
      assert.strictEqual(delRes.message.text, "🚫 This message was deleted");

      const { rows } = await query(
        "SELECT last_message FROM conversations WHERE id = $1 AND tenant_id = $2",
        [convId, tenantId],
      );
      assert.strictEqual(
        rows[0].last_message?.text,
        "🚫 This message was deleted",
      );
    },
  );

  await t.test(
    "5. Delete for me sets is_deleted=true and excludes message from getConversationMessages",
    async () => {
      const delForMeRes = await deleteMessage({
        tenantId,
        conversationId: convId,
        messageId: firstMsgId,
        forEveryone: false,
      });

      assert.strictEqual(delForMeRes.deleted, true);
      assert.strictEqual(delForMeRes.forEveryone, false);

      const msgs = await getConversationMessages({
        tenantId,
        conversationId: convId,
      });

      const found = msgs.messages.find((m) => m.id === firstMsgId);
      assert.strictEqual(
        found,
        undefined,
        "Message deleted for me should not be returned in conversation messages",
      );
    },
  );
});
