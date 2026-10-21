import crypto from "crypto";
import { query, withTransaction } from "../db/index.js";
import { defaultWhatsAppProvider } from "./whatsapp/WhatsAppProvider.js";
import { fail } from "../middleware/http.js";
import { emitForConversation, emitForSession } from "./realtime.js";

import { formatConversation } from "./conversationFormat.js";
export { formatConversation };

export async function getConversations({
  tenantId,
  sessionName = null,
  ownerUserId = null,
  limit = 30,
  cursor = null,
  filter = "all",
  search = "",
}) {
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  let sql = `
    SELECT id, tenant_id, session_name, provider_chat_id, contact_id, phone,
           contact_name, avatar, unread_count, is_group, group_members_count,
           assigned_to, is_closed, is_pinned, is_archived, last_active_epoch,
           last_message, tags, created_at, updated_at
    FROM conversations
    WHERE tenant_id = $1
  `;
  const params = [tenantId];

  if (ownerUserId) {
    params.push(ownerUserId);
    sql += ` AND session_name IN (SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 AND owner_user_id=$${params.length})`;
  }

  if (sessionName) {
    params.push(sessionName);
    sql += ` AND session_name = $${params.length}`;
  }

  if (filter === "unread") {
    sql += ` AND unread_count > 0`;
  } else if (filter === "groups") {
    sql += ` AND is_group = true`;
  }

  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    sql += ` AND (contact_name ILIKE $${params.length} OR phone ILIKE $${params.length})`;
  }

  // Compound cursor: (last_active_epoch, id)
  if (cursor) {
    const parts = String(cursor).split(":");
    const cursorEpoch = Number(parts[0]);
    const cursorId = parts[1];
    if (!Number.isFinite(cursorEpoch))
      throw fail(400, "Invalid conversation cursor");

    if (cursorId) {
      params.push(cursorEpoch, cursorId);
      sql += ` AND (last_active_epoch < $${params.length - 1} OR (last_active_epoch = $${params.length - 1} AND id < $${params.length}))`;
    } else {
      params.push(cursorEpoch);
      sql += ` AND last_active_epoch < $${params.length}`;
    }
  }

  params.push(parsedLimit + 1);
  sql += ` ORDER BY last_active_epoch DESC, id DESC LIMIT $${params.length}`;

  const { rows } = await query(sql, params);
  const hasMore = rows.length > parsedLimit;
  const items = hasMore ? rows.slice(0, parsedLimit) : rows;

  const nextCursor =
    items.length > 0
      ? `${items[items.length - 1].last_active_epoch}:${items[items.length - 1].id}`
      : null;

  const formatted = items.map(formatConversation);

  return {
    conversations: formatted,
    chats: formatted, // alias for frontend compatibility
    nextCursor: hasMore ? nextCursor : null,
    hasMore,
  };
}

export async function markConversationRead({
  tenantId,
  conversationId,
  io = null,
}) {
  const conv = await query(
    "SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2",
    [conversationId, tenantId],
  );
  if (!conv.rows[0]) throw new Error("Conversation not found");
  await defaultWhatsAppProvider.markRead(
    tenantId,
    conv.rows[0].session_name,
    conv.rows[0].provider_chat_id,
  );
  const { rows } = await query(
    `
    UPDATE conversations
    SET unread_count = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1 AND tenant_id = $2
    RETURNING *
  `,
    [conversationId, tenantId],
  );

  if (rows.length === 0) {
    throw new Error("Conversation not found in current workspace.");
  }

  const updated = formatConversation(rows[0]);

  if (io) {
    emitForConversation(
      io,
      tenantId,
      updated.id,
      "conversation:read",
      { conversationId: updated.id, chatId: updated.id },
      { snapshot: true },
    );
  }

  return updated;
}

export async function syncConversations({
  tenantId,
  sessionName,
  io = null,
  remote = null,
}) {
  const remoteConversations =
    remote ||
    (await defaultWhatsAppProvider.syncConversations(tenantId, sessionName));
  let upsertedCount = 0;

  for (const remote of remoteConversations) {
    const providerChatId = String(remote.id || remote.phone);
    const convId = `conv_${crypto.randomUUID()}`;

    await query(
      `
      INSERT INTO conversations (
        id, tenant_id, session_name, provider_chat_id, phone, contact_name, avatar,
        unread_count, is_group, group_members_count, last_active_epoch,
        last_message,contact_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,(SELECT id FROM contacts WHERE tenant_id=$2::varchar AND phone=$13 LIMIT 1))
      ON CONFLICT (tenant_id, session_name, provider_chat_id) DO UPDATE SET
        contact_name = EXCLUDED.contact_name,
        contact_id = COALESCE(conversations.contact_id,EXCLUDED.contact_id),
        avatar = COALESCE(NULLIF(EXCLUDED.avatar, ''), conversations.avatar),
        unread_count = EXCLUDED.unread_count,
        last_active_epoch = GREATEST(conversations.last_active_epoch, EXCLUDED.last_active_epoch),
        last_message = CASE
          WHEN EXCLUDED.last_active_epoch>=conversations.last_active_epoch AND EXCLUDED.last_message->>'text' != 'Chat active' AND EXCLUDED.last_message->>'text' != 'Group joined'
          THEN EXCLUDED.last_message
          ELSE conversations.last_message
        END,
        updated_at = CURRENT_TIMESTAMP
    `,
      [
        convId,
        tenantId,
        sessionName,
        providerChatId,
        remote.phone,
        remote.contactName,
        remote.avatar || "",
        remote.unreadCount || 0,
        remote.isGroup,
        remote.groupMembersCount || 0,
        remote.lastActiveEpoch || 0,
        JSON.stringify(remote.lastMessage || {}),
        String(remote.phone).replace(/@c\.us$/, ""),
      ],
    );
    upsertedCount++;
  }

  if (io) {
    emitForSession(io, tenantId, sessionName, "conversations:synced", {
      sessionName,
      sessionKey: sessionName,
      count: upsertedCount,
    });
  }

  return { status: "success", upsertedCount };
}

// Everything that changed after `since`, so a browser that was away (sleep, network
// loss, token refresh, deploy) can catch up with one small request instead of
// reloading every list. Agents only ever see their own sessions' conversations.
export async function getConversationChanges({
  tenantId,
  ownerUserId = null,
  since,
  limit = 200,
}) {
  const from = new Date(since);
  if (Number.isNaN(from.getTime())) throw fail(400, "Invalid since timestamp");
  const cap = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const params = [tenantId, from.toISOString()];
  let scope = "";
  if (ownerUserId) {
    params.push(ownerUserId);
    scope = ` AND session_name IN (SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 AND owner_user_id=$3)`;
  }
  // Taken before the read: a change committed while we query is seen again next time.
  const serverTime = (await query("SELECT now() AS t")).rows[0].t.toISOString();
  params.push(cap + 1);
  const { rows } = await query(
    `SELECT id, tenant_id, session_name, provider_chat_id, contact_id, phone,
            contact_name, avatar, unread_count, is_group, group_members_count,
            assigned_to, is_closed, is_pinned, is_archived, last_active_epoch,
            last_message, tags, created_at, updated_at
     FROM conversations WHERE tenant_id=$1 AND updated_at > $2${scope}
     ORDER BY updated_at ASC LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > cap;
  return {
    serverTime,
    hasMore,
    conversations: rows.slice(0, cap).map(formatConversation),
  };
}
