import test from 'node:test';
import assert from 'node:assert';
import { sendTextMessage, handleIncomingMessage } from '../src/services/messageService.js';
import { registerTenantAndUser } from '../src/services/authService.js';
import { query } from '../src/db/index.js';

test('Message Idempotency and Deduplication Suite', async (t) => {
  const tData = await registerTenantAndUser({
    name: 'Idempotency User',
    email: `idemp_${Date.now()}@example.com`,
    password: 'Password@123',
    companyName: 'Idemp Org'
  });
  const tenantId = tData.tenant.id;

  const convId = `conv_idemp_${Date.now()}`;
  await query(`
    INSERT INTO conversations (id, tenant_id, session_name, phone, contact_name, last_active_epoch)
    VALUES ($1, $2, 'primary-whatsapp', '919111111111', 'Test Customer', 1700000000)
  `, [convId, tenantId]);

  const idempotencyKey = `idem_key_${Date.now()}`;

  await t.test('First send creates new message', async () => {
    const res = await sendTextMessage({
      tenantId,
      conversationId: convId,
      text: 'Order confirmation #1234',
      idempotencyKey,
      agentName: 'Support Agent'
    });

    assert.strictEqual(res.duplicate, false);
    assert.strictEqual(res.message.text, 'Order confirmation #1234');
    assert.strictEqual(res.message.idempotency_key, idempotencyKey);
  });

  await t.test('Second send with identical idempotencyKey returns existing without duplicate DB insert', async () => {
    const res = await sendTextMessage({
      tenantId,
      conversationId: convId,
      text: 'Order confirmation #1234',
      idempotencyKey,
      agentName: 'Support Agent'
    });

    assert.strictEqual(res.duplicate, true, 'Must flag as duplicate');
    assert.strictEqual(res.message.idempotency_key, idempotencyKey);

    // Verify only 1 message exists in DB with this key
    const { rows } = await query(`
      SELECT COUNT(*) FROM messages WHERE tenant_id = $1 AND idempotency_key = $2
    `, [tenantId, idempotencyKey]);
    assert.strictEqual(parseInt(rows[0].count, 10), 1, 'Only 1 message must exist in database');
  });

  await t.test('Duplicate incoming provider message ID is ignored', async () => {
    const providerMsgId = `wamid_test_${Date.now()}`;
    const incomingMsg = {
      providerMessageId: providerMsgId,
      remoteId: '919111111111@c.us',
      text: 'Customer message text',
      senderName: 'Customer',
      timestampEpoch: Math.floor(Date.now() / 1000)
    };

    const first = await handleIncomingMessage({
      tenantId,
      sessionName: 'primary-whatsapp',
      msg: incomingMsg
    });
    assert.ok(first, 'First incoming event must be saved');

    const second = await handleIncomingMessage({
      tenantId,
      sessionName: 'primary-whatsapp',
      msg: incomingMsg
    });
    assert.strictEqual(second, null, 'Duplicate provider message ID must be skipped');
  });
});
