import crypto from 'crypto';
import { query, withTransaction } from '../db/index.js';
import { ACK_STATUS } from '../config/constants.js';
import { enqueueOutgoingMessage } from './queue/messageQueue.js';

export function formatMessage(m) {
  if (!m) return null;
  return {
    id: m.id,
    tenantId: m.tenant_id,
    conversationId: m.conversation_id,
    chatId: m.conversation_id, // frontend model compatibility
    providerMessageId: m.provider_message_id || '',
    idempotencyKey: m.idempotency_key || '',
    sender: m.sender,
    agentName: m.agent_name || '',
    text: m.text || '',
    type: m.type || 'text',
    status: m.status || 'sent',
    ack: Number(m.ack || 0),
    mediaUrl: m.media_url || '',
    fileName: m.file_name || '',
    fileSize: m.file_size || '',
    audioDuration: m.audio_duration || '',
    timestamp: m.timestamp || '',
    timestampEpoch: Number(m.timestamp_epoch || 0),
    createdAt: m.created_at,
    // snake_case mirrors for legacy callers
    tenant_id: m.tenant_id,
    conversation_id: m.conversation_id,
    provider_message_id: m.provider_message_id,
    idempotency_key: m.idempotency_key,
    agent_name: m.agent_name,
    media_url: m.media_url,
    file_name: m.file_name,
    file_size: m.file_size,
    audio_duration: m.audio_duration,
    timestamp_epoch: Number(m.timestamp_epoch || 0),
    created_at: m.created_at
  };
}

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

  // 1. Pre-check idempotency key if provided
  if (idempotencyKey) {
    const { rows: existing } = await query(`
      SELECT * FROM messages
      WHERE tenant_id = $1 AND idempotency_key = $2
      LIMIT 1
    `, [tenantId, idempotencyKey]);

    if (existing.length > 0) {
      return { message: formatMessage(existing[0]), duplicate: true };
    }
  }

  // 2. Fetch conversation with session info
  const { rows: convs } = await query(`
    SELECT id, tenant_id, session_name, provider_chat_id, phone, contact_name
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

  // 4. Save message and outbox event atomically
  let message;
  try {
    message = await withTransaction(async (client) => {
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

      const inserted = msgRes.rows[0];

      // Insert transactional outbox event
      await client.query(`
        INSERT INTO outbox_events (
          tenant_id, aggregate_type, aggregate_id, event_type, payload, status
        )
        VALUES ($1, 'message', $2, 'message.outgoing', $3, 'pending')
      `, [
        tenantId,
        inserted.id,
        JSON.stringify({
          tenantId,
          sessionName: conv.session_name,
          conversationId: conv.id,
          messageId: inserted.id,
          to: conv.provider_chat_id || conv.phone,
          text: text.trim()
        })
      ]);

      // Update conversation last activity
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

      return inserted;
    });
  } catch (err) {
    // Catch unique constraint violation on idempotency_key (concurrent identical request)
    if (err.code === '23505' && idempotencyKey) {
      const { rows: existing } = await query(`
        SELECT * FROM messages WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1
      `, [tenantId, idempotencyKey]);
      if (existing.length > 0) {
        return { message: formatMessage(existing[0]), duplicate: true };
      }
    }
    throw err;
  }

  const formattedMsg = formatMessage(message);

  // 5. Real-time broadcast to tenant room
  if (io) {
    io.to(`tenant:${tenantId}`).emit('message:created', {
      conversationId: conv.id,
      chatId: conv.id,
      message: formattedMsg
    });
    io.to(`tenant:${tenantId}`).emit('conversation:updated', {
      conversationId: conv.id,
      chatId: conv.id,
      lastMessage: { text: text.trim(), timestamp: timeStr, status: 'sending', fromMe: true },
      lastActiveEpoch: nowEpoch
    });
  }

  // 6. Enqueue outgoing message with stable BullMQ jobId
  enqueueOutgoingMessage({
    tenantId,
    sessionName: conv.session_name,
    conversationId: conv.id,
    messageId: message.id,
    to: conv.provider_chat_id || conv.phone,
    text: text.trim(),
    io
  }).catch(err => {
    console.error(`Failed to dispatch message ${messageId}:`, err.message);
  });

  return { message: formattedMsg, duplicate: false };
}

export async function handleIncomingMessage({
  tenantId,
  sessionName,
  msg,
  io = null
}) {
  const { providerMessageId, fromMe, remoteId, text, senderName, timestampEpoch, mediaUrl, fileName, fileSize } = msg;

  // 1. Idempotency Check for provider message ID
  if (providerMessageId) {
    const { rows: existing } = await query(`
      SELECT * FROM messages WHERE tenant_id = $1 AND provider_message_id = $2 LIMIT 1
    `, [tenantId, providerMessageId]);

    if (existing.length > 0) {
      // Message already exists; deduplicate repeat provider events
      return null;
    }
  }

  const cleanPhone = String(remoteId || '').replace(/@c\.us$/, '');
  const nowEpoch = timestampEpoch || Math.floor(Date.now() / 1000);
  const timeStr = new Date(nowEpoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isOutgoingEcho = Boolean(fromMe);

  // 2. Resolve or create conversation
  let convId = null;
  const { rows: existingConv } = await query(`
    SELECT id, unread_count FROM conversations
    WHERE tenant_id = $1 AND session_name = $2 AND (provider_chat_id = $3 OR phone = $4)
    LIMIT 1
  `, [tenantId, sessionName, remoteId, cleanPhone]);

  if (existingConv.length > 0) {
    convId = existingConv[0].id;
    // Only increment unread count if message is from the customer (not outgoing echo)
    const unreadIncrement = isOutgoingEcho ? 0 : 1;
    await query(`
      UPDATE conversations
      SET unread_count = unread_count + $1,
          last_active_epoch = $2,
          last_message = $3,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $4 AND tenant_id = $5
    `, [
      unreadIncrement,
      nowEpoch,
      JSON.stringify({ text, timestamp: timeStr, status: isOutgoingEcho ? 'sent' : 'delivered', fromMe: isOutgoingEcho }),
      convId,
      tenantId
    ]);
  } else {
    convId = `conv_${tenantId}_${sessionName}_${String(remoteId || cleanPhone).replace(/[^a-zA-Z0-9]/g, '_')}`;
    const isGroup = remoteId.includes('@g.us');
    await query(`
      INSERT INTO conversations (
        id, tenant_id, session_name, provider_chat_id, phone, contact_name,
        unread_count, is_group, last_active_epoch, last_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (tenant_id, session_name, provider_chat_id) DO UPDATE SET
        unread_count = conversations.unread_count + EXCLUDED.unread_count,
        last_active_epoch = EXCLUDED.last_active_epoch,
        last_message = EXCLUDED.last_message,
        updated_at = CURRENT_TIMESTAMP
    `, [
      convId, tenantId, sessionName, remoteId, cleanPhone, senderName || cleanPhone,
      isOutgoingEcho ? 0 : 1, isGroup, nowEpoch,
      JSON.stringify({ text, timestamp: timeStr, status: isOutgoingEcho ? 'sent' : 'delivered', fromMe: isOutgoingEcho })
    ]);
  }

  // 3. Insert incoming / echoed message
  const messageId = `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const senderRole = isOutgoingEcho ? 'agent' : 'customer';
  const initialStatus = isOutgoingEcho ? 'sent' : 'delivered';
  const initialAck = isOutgoingEcho ? ACK_STATUS.SERVER : ACK_STATUS.DELIVERY;

  const { rows: savedMsg } = await query(`
    INSERT INTO messages (
      id, tenant_id, conversation_id, provider_message_id, sender,
      agent_name, text, type, status, ack, media_url, file_name, file_size,
      timestamp, timestamp_epoch
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (tenant_id, provider_message_id) DO UPDATE SET
      ack = GREATEST(messages.ack, EXCLUDED.ack),
      status = EXCLUDED.status
    RETURNING *
  `, [
    messageId, tenantId, convId, providerMessageId,
    senderRole, senderName || '', text, msg.type || 'text',
    initialStatus, initialAck, mediaUrl, fileName, fileSize, timeStr, nowEpoch
  ]);

  const inserted = formatMessage(savedMsg[0]);

  // 4. Emit to tenant room
  if (io) {
    io.to(`tenant:${tenantId}`).emit('message:received', {
      conversationId: convId,
      chatId: convId,
      message: inserted
    });
    io.to(`tenant:${tenantId}`).emit('conversation:updated', {
      conversationId: convId,
      chatId: convId,
      lastMessage: { text, timestamp: timeStr, status: initialStatus, fromMe: isOutgoingEcho },
      lastActiveEpoch: nowEpoch,
      unreadCountIncrement: isOutgoingEcho ? 0 : 1
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

  // Disallow backwards ACK transitions
  if (msg.ack >= ack) return null;

  const status = ack >= ACK_STATUS.READ ? 'read' : (ack >= ACK_STATUS.DELIVERY ? 'delivered' : 'sent');

  await withTransaction(async (client) => {
    await client.query(`
      UPDATE messages
      SET ack = GREATEST(ack, $1), status = $2
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
      chatId: msg.conversation_id,
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

  // Compound cursor for messages: (timestamp_epoch, id)
  if (cursor) {
    const parts = String(cursor).split(':');
    const cursorEpoch = Number(parts[0]);
    const cursorId = parts[1];
    if (cursorId) {
      params.push(cursorEpoch, cursorId);
      sql += ` AND (timestamp_epoch < $${params.length - 1} OR (timestamp_epoch = $${params.length - 1} AND id < $${params.length}))`;
    } else {
      params.push(cursorEpoch);
      sql += ` AND timestamp_epoch < $${params.length}`;
    }
  }

  sql += ` ORDER BY timestamp_epoch DESC, id DESC LIMIT $${params.length + 1}`;
  params.push(parsedLimit + 1);

  const { rows } = await query(sql, params);
  const hasMore = rows.length > parsedLimit;
  const items = hasMore ? rows.slice(0, parsedLimit) : rows;

  const nextCursor = items.length > 0
    ? `${items[items.length - 1].timestamp_epoch}:${items[items.length - 1].id}`
    : null;

  const formatted = items.map(formatMessage).reverse();

  return {
    messages: formatted,
    nextCursor: hasMore ? nextCursor : null,
    hasMore
  };
}
