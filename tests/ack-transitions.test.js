import test from 'node:test';
import assert from 'node:assert';
import { handleAckEvent } from '../src/services/messageService.js';
import { registerTenantAndUser } from '../src/services/authService.js';
import { query } from '../src/db/index.js';
import { ACK_STATUS } from '../src/config/constants.js';

test('ACK State Transitions and Receipts Suite', async (t) => {
  const tData = await registerTenantAndUser({
    name: 'Ack User',
    email: `ack_${Date.now()}@example.com`,
    password: 'Password@123',
    companyName: 'Ack Testing'
  });
  const tenantId = tData.tenant.id;

  const convId = `conv_ack_${Date.now()}`;
  await query(`
    INSERT INTO conversations (id, tenant_id, session_name, phone, contact_name, last_active_epoch)
    VALUES ($1, $2, 'primary-whatsapp', '919222222222', 'Ack Contact', 1700000000)
  `, [convId, tenantId]);

  const providerMsgId = `wamid_ack_${Date.now()}`;
  const msgId = `msg_ack_${Date.now()}`;

  await query(`
    INSERT INTO messages (
      id, tenant_id, conversation_id, provider_message_id, sender,
      text, status, ack, timestamp_epoch
    )
    VALUES ($1, $2, $3, $4, 'agent', 'Testing ACK', 'sent', $5, $6)
  `, [msgId, tenantId, convId, providerMsgId, ACK_STATUS.SERVER, Math.floor(Date.now() / 1000)]);

  await t.test('Transition from SERVER (1) to DELIVERY (2)', async () => {
    const res = await handleAckEvent({
      tenantId,
      ackData: { providerMessageId: providerMsgId, ack: ACK_STATUS.DELIVERY }
    });

    assert.ok(res);
    assert.strictEqual(res.ack, ACK_STATUS.DELIVERY);
    assert.strictEqual(res.status, 'delivered');

    const { rows } = await query('SELECT ack, status FROM messages WHERE id = $1', [msgId]);
    assert.strictEqual(rows[0].ack, ACK_STATUS.DELIVERY);
    assert.strictEqual(rows[0].status, 'delivered');
  });

  await t.test('Transition from DELIVERY (2) to READ (3)', async () => {
    const res = await handleAckEvent({
      tenantId,
      ackData: { providerMessageId: providerMsgId, ack: ACK_STATUS.READ }
    });

    assert.ok(res);
    assert.strictEqual(res.ack, ACK_STATUS.READ);
    assert.strictEqual(res.status, 'read');

    const { rows } = await query('SELECT ack, status FROM messages WHERE id = $1', [msgId]);
    assert.strictEqual(rows[0].ack, ACK_STATUS.READ);
    assert.strictEqual(rows[0].status, 'read');

    // Verify receipts logged
    const { rows: receipts } = await query(
      'SELECT ack FROM message_receipts WHERE message_id = $1 ORDER BY ack ASC',
      [msgId]
    );
    assert.strictEqual(receipts.length, 2, 'Should have recorded 2 receipt transitions');
  });

  await t.test('Reject backwards transition (e.g. READ going back to DELIVERY)', async () => {
    const res = await handleAckEvent({
      tenantId,
      ackData: { providerMessageId: providerMsgId, ack: ACK_STATUS.DELIVERY }
    });

    assert.strictEqual(res, null, 'Backwards ACK transition must be ignored');

    const { rows } = await query('SELECT ack, status FROM messages WHERE id = $1', [msgId]);
    assert.strictEqual(rows[0].ack, ACK_STATUS.READ, 'Status must remain READ');
  });
});
