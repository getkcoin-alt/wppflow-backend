import crypto from 'crypto';
import { query, withTransaction } from '../db/index.js';
import { ACK_STATUS } from '../config/constants.js';
import { enqueueOutgoingMessage } from './queue/messageQueue.js';

export async function sendTextMessage({
  tenantId,
  conversationId,
  text,
  idempotencyKey = null,
  agentName = 'Agent',
  io = null
}) {
  if (!text || !text.trim()) {
    throw new Error('Message text is required.');
  }

  // 1. Idempotency Check
  if (idempotencyKey) {
    const { rows: existing } = await query(`
      SELECT * FROM messages
      WHERE tenant_id = $1 AND idempotency_key = $2
      LIMIT 1
    `, [tenantId, idempotencyKey]);

    if (existing.length > 0) {
      return { message: existing[0], duplicate: true };
    }
  }

  // 2. Fetch conversation
  const { rows: convs } = await query(`
    SELECT id, tenant_id, session_name, phone, contact_name
    FROM conversations
    WHERE id = $1 AND tenant_id = $2
    LIMIT 1
  `, [conversationId, tenantId]);

  if (convs.length === 0) {
    throw new Error('Conversation not found in current workspace.');
  }
  const conv = convs[0];

  // 3. Suppression check
  const { rows: suppressions } = await query(`
    SELECT 1 FROM suppressions WHERE tenant_id = $1 AND phone = $2 LIMIT 1
  `, [tenantId, conv.phone]);

  if (suppressions.length > 0) {
    throw new Error('Recipient has opted out or is suppressed.');
  }

  const messageId = `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const nowEpoch = Math.floor(Date.now() / 1000);
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // 4. Save message atomically & update conversation
  const message = await withTransaction(async (client) => {
    const msgRes = await client.query(`
      INSERT INTO messages (
        id, tenant_id, conversation_id, idempotency_key, sender,
        agent_name, text, type, status, ack, timestamp, timestamp_epoch
      )
      VALUES ($1, $2, $3, $4, 'agent', $5, $6, 'text', 'sending', $7, $8, $9)
      RETURNING *
    `, [
      messageId, tenantId, conv.id, idempotencyKey,
      agentName, text.trim(), ACK_STATUS.PENDING, timeStr, nowEpoch
    ]);

    await client.query(`
      UPDATE conversations
      SET last_active_epoch = $1,
          last_message = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND tenant_id = $4
    `, [
      nowEpoch,
      JSON.stringify({ text: text.trim(), timestamp: timeStr, status: 'sending', fromMe: true }),
      conv.id,
      tenantId
    ]);

    return msgRes.rows[0];
  });

  // 5. Real-time broadcast to tenant room
  if (io) {
    io.to(`tenant:${tenantId}`).emit('message:created', {
      conversationId: conv.id,
      message
    });
    io.to(`tenant:${tenantId}`).emit('conversation:updated', {
      conversationId: conv.id,
      lastMessage: { text: text.trim(), timestamp: timeStr, status: 'sending', fromMe: true },
      lastActiveEpoch: nowEpoch
    });
  }

  // 6. Enqueue outgoing message
  enqueueOutgoingMessage({
    tenantId,
    sessionName: conv.session_name,
    conversationId: conv.id,
    messageId: message.id,
    to: conv.phone,
    text: text.trim(),
    io
  }).catch(err => {
    console.error(`Failed to dispatch message ${messageId}:`, err.message);
  });

  return { message, duplicate: false };
}

export async function handleIncomingMessage({
  tenantId,
  sessionName,
  msg,
  io = null
}) {
  const { providerMessageId, remoteId, text, senderName, timestampEpoch, mediaUrl, fileName, fileSize } = msg;

  // 1. Idempotency Check for provider ID
  if (providerMessageId) {
    const { rows: existing } = await query(`
      SELECT 1 FROM messages WHERE tenant_id = $1 AND provider_message_id = $2 LIMIT 1
    `, [tenantId, providerMessageId]);

    if (existing.length > 0) return null; // Deduplicate reconnect or repeated events
  }

  const cleanPhone = remoteId.replace(/@c\.us$/, '');
  const nowEpoch = timestampEpoch || Math.floor(Date.now() / 1000);
  const timeStr = new Date(nowEpoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // 2. Resolve or create conversation
  let convId = null;
  const { rows: existingConv } = await query(`
    SELECT id, unread_count FROM conversations
    WHERE tenant_id = $1 AND (phone = $2 OR phone = $3)
    LIMIT 1
  `, [tenantId, cleanPhone, remoteId]);

  if (existingConv.length > 0) {
    convId = existingConv[0].id;
    await query(`
      UPDATE conversations
      SET unread_count = unread_count + 1,
          last_active_epoch = $1,
          last_message = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND tenant_id = $4
    `, [
      nowEpoch,
      JSON.stringify({ text, timestamp: timeStr, status: 'delivered', fromMe: false }),
      convId,
      tenantId
    ]);
  } else {
    convId = `conv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const isGroup = remoteId.includes('@g.us');
    await query(`
      INSERT INTO conversations (
        id, tenant_id, session_name, phone, contact_name,
        unread_count, is_group, last_active_epoch, last_message
      )
      VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)
      ON CONFLICT (tenant_id, phone) DO UPDATE SET
        unread_count = conversations.unread_count + 1,
        last_active_epoch = EXCLUDED.last_active_epoch,
        last_message = EXCLUDED.last_message
    `, [
      convId, tenantId, sessionName, remoteId, senderName || cleanPhone,
      isGroup, nowEpoch, JSON.stringify({ text, timestamp: timeStr, status: 'delivered', fromMe: false })
    ]);
  }

  // 3. Insert incoming message
  const messageId = `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const { rows: savedMsg } = await query(`
    INSERT INTO messages (
      id, tenant_id, conversation_id, provider_message_id, sender,
      agent_name, text, type, status, ack, media_url, file_name, file_size,
      timestamp, timestamp_epoch
    )
    VALUES ($1, $2, $3, $4, 'customer', $5, $6, $7, 'delivered', $8, $9, $10, $11, $12, $13)
    RETURNING *
  `, [
    messageId, tenantId, convId, providerMessageId,
    senderName, text, msg.type || 'text', ACK_STATUS.DELIVERY,
    mediaUrl, fileName, fileSize, timeStr, nowEpoch
  ]);

  const inserted = savedMsg[0];

  // 4. Emit to tenant room
  if (io) {
    io.to(`tenant:${tenantId}`).emit('message:received', {
      conversationId: convId,
      message: inserted
    });
    io.to(`tenant:${tenantId}`).emit('conversation:updated', {
      conversationId: convId,
      lastMessage: { text, timestamp: timeStr, status: 'delivered', fromMe: false },
      lastActiveEpoch: nowEpoch,
      unreadCountIncrement: 1
    });
  }

  return inserted;
}

export async function handleAckEvent({ tenantId, ackData, io = null }) {
  const { providerMessageId, ack } = ackData;
  if (!providerMessageId) return null;

  const { rows: msgRows } = await query(`
    SELECT id, conversation_id, ack, status
    FROM messages
    WHERE tenant_id = $1 AND provider_message_id = $2
    LIMIT 1
  `, [tenantId, providerMessageId]);

  if (msgRows.length === 0) return null;
  const msg = msgRows[0];

  // Disallow backwards ACK transitions (e.g. read cannot go back to delivered)
  if (msg.ack >= ack) return null;

  const status = ack >= ACK_STATUS.READ ? 'read' : (ack >= ACK_STATUS.DELIVERY ? 'delivered' : 'sent');

  await withTransaction(async (client) => {
    await client.query(`
      UPDATE messages
      SET ack = $1, status = $2
      WHERE id = $3 AND tenant_id = $4
    `, [ack, status, msg.id, tenantId]);

    await client.query(`
      INSERT INTO message_receipts (tenant_id, message_id, provider_message_id, ack)
      VALUES ($1, $2, $3, $4)
    `, [tenantId, msg.id, providerMessageId, ack]);
  });

  if (io) {
    io.to(`tenant:${tenantId}`).emit('message:ack', {
      conversationId: msg.conversation_id,
      messageId: msg.id,
      providerMessageId,
      ack,
      status
    });
  }

  return { messageId: msg.id, ack, status };
}

export async function getConversationMessages({
  tenantId,
  conversationId,
  limit = 50,
  cursor = null
}) {
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  let sql = `
    SELECT id, tenant_id, conversation_id, provider_message_id, idempotency_key,
           sender, agent_name, text, type, status, ack, media_url, file_name,
           file_size, audio_duration, timestamp, timestamp_epoch, created_at
    FROM messages
    WHERE tenant_id = $1 AND conversation_id = $2
  `;
  const params = [tenantId, conversationId];

  if (cursor) {
    const cursorEpoch = Number(cursor);
    sql += ` AND timestamp_epoch < $3`;
    params.push(cursorEpoch);
  }

  sql += ` ORDER BY timestamp_epoch DESC, created_at DESC LIMIT $${params.length + 1}`;
  params.push(parsedLimit + 1);

  const { rows } = await query(sql, params);
  const hasMore = rows.length > parsedLimit;
  const items = hasMore ? rows.slice(0, parsedLimit) : rows;

  const nextCursor = items.length > 0 ? items[items.length - 1].timestamp_epoch : null;

  return {
    messages: items.reverse(), // chronologically ordered for client view
    nextCursor: hasMore ? nextCursor : null,
    hasMore
  };
}
