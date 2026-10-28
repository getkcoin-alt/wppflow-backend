import test from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db/index.js";
import { registerTenantAndUser } from "../src/services/authService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { createGroupConversation } from "../src/services/conversationService.js";
import { sendTextMessage } from "../src/services/messageService.js";

test("Group Creation Service and Persistence Suite", async (t) => {
  const o = await registerTenantAndUser({
    name: "Group Tester",
    email: `grp_${Date.now()}@test.invalid`,
    password: "Password@123",
    companyName: "Group Creation Co",
  });
  const tenantId = o.tenant.id;
  const sessionName = "primary-whatsapp";

  // Ensure session exists in DB
  await query(
    `INSERT INTO whatsapp_sessions (id, tenant_id, session_name, status, phone)
     VALUES (gen_random_uuid(), $1, $2, 'CONNECTED', '919000000000')
     ON CONFLICT (tenant_id, session_name) DO UPDATE SET status='CONNECTED'`,
    [tenantId, sessionName],
  );

  let mockCreatedWith = null;
  const fakeGid = `120363099999999999@g.us`;

  // Mock WPPConnect client on provider session
  const mockClient = {
    createGroup: async (title, participants) => {
      mockCreatedWith = { title, participants };
      return {
        gid: { _serialized: fakeGid, user: "120363099999999999", server: "g.us" },
        participants: participants.reduce((acc, p) => ({ ...acc, [p]: { code: 200 } }), {}),
      };
    },
  };
  provider.sessions.set(provider.sessionKey(tenantId, sessionName), {
    status: "CONNECTED",
    client: mockClient,
  });

  await t.test("1. WhatsAppProvider.createGroup formats participants and returns group ID", async () => {
    const res = await provider.createGroup(tenantId, sessionName, "VIP Investors Club", [
      "+971 50 123 4567",
      "919876543210@c.us",
      "+1 (555) 000-1111",
    ]);

    assert.equal(res.groupId, fakeGid);
    assert.equal(res.title, "VIP Investors Club");
    assert.deepEqual(res.participants, [
      "971501234567@c.us",
      "919876543210@c.us",
      "15550001111@c.us",
    ]);
    assert.deepEqual(mockCreatedWith, {
      title: "VIP Investors Club",
      participants: [
        "971501234567@c.us",
        "919876543210@c.us",
        "15550001111@c.us",
      ],
    });
  });

  await t.test("2. WhatsAppProvider.createGroup rejects invalid input", async () => {
    // Empty title
    await assert.rejects(
      async () => provider.createGroup(tenantId, sessionName, "", ["971500000000"]),
      /Group title is required/,
    );

    // Empty participants
    await assert.rejects(
      async () => provider.createGroup(tenantId, sessionName, "Valid Title", []),
      /At least one participant/,
    );
  });

  let createdConv = null;
  await t.test("3. createGroupConversation stores conversation with is_group=true and correct metadata", async () => {
    const res = await createGroupConversation({
      tenantId,
      sessionName,
      title: "VIP Investors Club",
      participants: ["971501234567", "919876543210"],
    });

    assert.equal(res.status, "success");
    assert.ok(res.conversation);
    assert.equal(res.conversation.contactName, "VIP Investors Club");
    assert.equal(res.conversation.isGroup, true);
    assert.equal(res.conversation.groupMembersCount, 3); // 2 participants + creator
    assert.equal(res.conversation.providerChatId, fakeGid);
    assert.equal(res.conversation.lastMessage.text, "Group created");
    assert.equal(res.conversation.lastMessage.status, "sent");

    createdConv = res.conversation;

    // Verify row directly in PostgreSQL
    const dbRow = (
      await query(
        "SELECT * FROM conversations WHERE tenant_id=$1 AND provider_chat_id=$2",
        [tenantId, fakeGid],
      )
    ).rows[0];

    assert.ok(dbRow, "Conversation record must exist in DB");
    assert.equal(dbRow.is_group, true);
    assert.equal(dbRow.contact_name, "VIP Investors Club");
    assert.equal(dbRow.group_members_count, 3);
    assert.equal(dbRow.session_name, sessionName);
    assert.equal(dbRow.contact_id, null, "Groups do not bind to single contact");
  });

  await t.test("4. sendTextMessage sends message to group conversation and creates outbox event for group JID", async () => {
    assert.ok(createdConv, "createdConv must be defined from previous test");

    const sent = await sendTextMessage({
      tenantId,
      conversationId: createdConv.id,
      text: "Welcome everyone to VIP Investors Club!",
      idempotencyKey: `idemp_grp_${Date.now()}`,
      agentName: "Agent Host",
    });

    assert.equal(sent.message.text, "Welcome everyone to VIP Investors Club!");
    assert.equal(sent.message.sender, "agent");
    assert.equal(sent.message.conversation_id, createdConv.id);

    // Verify outbox payload targets group JID
    const outbox = (
      await query(
        "SELECT payload FROM outbox_events WHERE tenant_id=$1 AND aggregate_id=$2",
        [tenantId, sent.message.id],
      )
    ).rows[0];
    assert.ok(outbox, "Outbox event must be created");
    const payload = typeof outbox.payload === "object" ? outbox.payload : JSON.parse(outbox.payload);
    assert.equal(payload.to, fakeGid);
    assert.equal(payload.sessionName, sessionName);

    // Verify conversation last_message updated
    const updatedConv = (
      await query("SELECT last_message FROM conversations WHERE id=$1", [createdConv.id])
    ).rows[0];
    const lastMsg = typeof updatedConv.last_message === "string"
      ? JSON.parse(updatedConv.last_message)
      : updatedConv.last_message;
    assert.equal(lastMsg.text, "Welcome everyone to VIP Investors Club!");
    assert.equal(lastMsg.status, "sending");
  });

  t.after(async () => {
    setTimeout(() => process.exit(0), 100);
  });
});
