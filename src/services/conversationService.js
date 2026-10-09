import { query, withTransaction } from '../db/index.js';
import { defaultWhatsAppProvider } from './whatsapp/WhatsAppProvider.js';

export async function getConversations({
  tenantId,
  limit = 30,
  cursor = null,
  filter = 'all',
  search = ''
}) {
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  let sql = `
    SELECT id, tenant_id, session_name, contact_id, phone, contact_name,
           avatar, unread_count, is_group, group_members_count, assigned_to,
           is_closed, is_pinned, is_archived, last_active_epoch, last_message,
           tags, created_at, updated_at
    FROM conversations
    WHERE tenant_id = $1
  `;
  const params = [tenantId];

  if (filter === 'unread') {
    sql += ` AND unread_count > 0`;
  } else if (filter === 'groups') {
    sql += ` AND is_group = true`;
  }

  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    sql += ` AND (contact_name ILIKE $${params.length} OR phone ILIKE $${params.length})`;
  }

  if (cursor) {
    params.push(Number(cursor));
    sql += ` AND last_active_epoch < $${params.length}`;
  }

  params.push(parsedLimit + 1);
  sql += ` ORDER BY last_active_epoch DESC LIMIT $${params.length}`;

  const { rows } = await query(sql, params);
  const hasMore = rows.length > parsedLimit;
  const items = hasMore ? rows.slice(0, parsedLimit) : rows;

  const nextCursor = items.length > 0 ? items[items.length - 1].last_active_epoch : null;

  return {
    conversations: items,
    nextCursor: hasMore ? nextCursor : null,
    hasMore
  };
}

export async function markConversationRead({ tenantId, conversationId, io = null }) {
  const { rows } = await query(`
    UPDATE conversations
    SET unread_count = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1 AND tenant_id = $2
    RETURNING id, unread_count
  `, [conversationId, tenantId]);

  if (rows.length === 0) {
    throw new Error('Conversation not found in current workspace.');
  }

  if (io) {
    io.to(`tenant:${tenantId}`).emit('conversation:read', {
      conversationId
    });
  }

  return rows[0];
}

export async function syncConversations({ tenantId, sessionName, io = null }) {
  const remoteConversations = await defaultWhatsAppProvider.syncConversations(tenantId, sessionName);
  let upsertedCount = 0;

  for (const remote of remoteConversations) {
    await query(`
      INSERT INTO conversations (
        id, tenant_id, session_name, phone, contact_name, avatar,
        unread_count, is_group, group_members_count, last_active_epoch,
        last_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (tenant_id, phone) DO UPDATE SET
        contact_name = EXCLUDED.contact_name,
        avatar = COALESCE(NULLIF(EXCLUDED.avatar, ''), conversations.avatar),
        unread_count = EXCLUDED.unread_count,
        last_active_epoch = GREATEST(conversations.last_active_epoch, EXCLUDED.last_active_epoch),
        last_message = CASE
          WHEN EXCLUDED.last_message->>'text' != 'Chat active' AND EXCLUDED.last_message->>'text' != 'Group joined'
          THEN EXCLUDED.last_message
          ELSE conversations.last_message
        END
    `, [
      `conv_${remote.phone.replace(/[^a-zA-Z0-9]/g, '_')}`,
      tenantId,
      sessionName,
      remote.phone,
      remote.contactName,
      remote.avatar || '',
      remote.unreadCount || 0,
      remote.isGroup,
      remote.groupMembersCount || 0,
      remote.lastActiveEpoch || 0,
      JSON.stringify(remote.lastMessage || {})
    ]);
    upsertedCount++;
  }

  if (io) {
    io.to(`tenant:${tenantId}`).emit('conversations:synced', {
      sessionName,
      count: upsertedCount
    });
  }

  return { status: 'success', upsertedCount };
}
