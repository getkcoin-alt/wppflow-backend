import test from "node:test";
import assert from "node:assert";
import {
  sendTextMessage,
  deleteMessage,
  handleRevokedMessage,
} from "../src/services/messageService.js";
import {
  pumpLeadReminders,
  addTask,
  addChatTask,
} from "../src/services/leadService.js";
import { registerTenantAndUser } from "../src/services/authService.js";
import { query } from "../src/db/index.js";

test("Message Deletion Reflection & Follow-up Notifications Suite", async (t) => {
  const tData = await registerTenantAndUser({
    name: "Followup Tester",
    email: `followup_${Date.now()}@example.com`,
    password: "Password@123",
    companyName: "Followup Testing Corp",
  });
  const tenantId = tData.tenant.id;
  const user = tData.user;

  // Ensure column upcoming_notified_at exists
  await query(
    `ALTER TABLE lead_tasks ADD COLUMN IF NOT EXISTS upcoming_notified_at TIMESTAMPTZ DEFAULT NULL;`,
  );

  const convId = `conv_test_${Date.now()}`;
  await query(
    `INSERT INTO conversations (id, tenant_id, session_name, phone, provider_chat_id, contact_name, last_active_epoch, last_message)
     VALUES ($1, $2, 'primary', '919111111111', '919111111111@c.us', 'Followup Contact', 1700000000, $3)`,
    [
      convId,
      tenantId,
      JSON.stringify({ text: "Hello", status: "sent", fromMe: true }),
    ],
  );

  const emitted = [];
  const fakeIo = {
    to: (room) => ({
      emit: (event, payload) => {
        emitted.push({ room, event, payload });
      },
    }),
  };

  await t.test("1. deleteMessage broadcasts to tenant room directly", async () => {
    const sent = await sendTextMessage({
      tenantId,
      conversationId: convId,
      text: "Message to delete",
      idempotencyKey: `idemp_del_${Date.now()}`,
      agentName: "Agent Deletor",
      io: fakeIo,
    });
    const msgId = sent.message.id;

    emitted.length = 0;
    await deleteMessage({
      tenantId,
      conversationId: convId,
      messageId: msgId,
      forEveryone: true,
      io: fakeIo,
    });

    const tenantEmits = emitted.filter((e) => e.room === `tenant:${tenantId}`);
    assert.ok(tenantEmits.some((e) => e.event === "message:updated" && e.payload?.messageId === msgId));
    assert.ok(tenantEmits.some((e) => e.event === "conversation:updated"));

    const { rows } = await query("SELECT type, status, text FROM messages WHERE id = $1", [msgId]);
    assert.strictEqual(rows[0].type, "revoked");
    assert.strictEqual(rows[0].status, "deleted");
  });

  await t.test("2. handleRevokedMessage handles mobile revocation and broadcasts", async () => {
    const providerMsgId = `wamid_revoked_${Date.now()}`;
    const sent = await sendTextMessage({
      tenantId,
      conversationId: convId,
      text: "Mobile message to revoke",
      idempotencyKey: `idemp_rev_${Date.now()}`,
      agentName: "Agent Mobile",
      io: fakeIo,
    });
    await query("UPDATE messages SET provider_message_id = $1 WHERE id = $2", [
      providerMsgId,
      sent.message.id,
    ]);

    emitted.length = 0;
    const revoked = await handleRevokedMessage({
      tenantId,
      revokedData: { refId: providerMsgId },
      io: fakeIo,
    });

    assert.ok(revoked);
    assert.strictEqual(revoked.status, "deleted");
    assert.strictEqual(revoked.type, "revoked");

    const tenantEmits = emitted.filter((e) => e.room === `tenant:${tenantId}`);
    assert.ok(tenantEmits.some((e) => e.event === "message:updated"));
    assert.ok(tenantEmits.some((e) => e.event === "conversation:updated"));
  });

  await t.test("3. pumpLeadReminders fires advance warning for upcoming follow-ups", async () => {
    const in10Mins = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const req = {
      tenantId,
      user,
      app: { get: () => fakeIo },
    };

    const taskId = await addChatTask(req, {
      conversationId: convId,
      title: "Call client back about contract",
      dueAt: in10Mins,
      assignedUserId: user.id,
    });

    assert.ok(taskId);

    emitted.length = 0;
    await pumpLeadReminders(fakeIo);

    const { rows: taskAfter } = await query("SELECT upcoming_notified_at, notified_at FROM lead_tasks WHERE id = $1", [taskId]);
    assert.ok(taskAfter[0].upcoming_notified_at, "upcoming_notified_at should be set");
    assert.strictEqual(taskAfter[0].notified_at, null, "notified_at should still be null");

    // Notification should be emitted
    const userEmits = emitted.filter((e) => e.room === `user:${user.id}`);
    assert.ok(userEmits.some((e) => e.event === "notification:new" && e.payload?.notification?.title?.includes("Upcoming follow-up")));
  });
});
