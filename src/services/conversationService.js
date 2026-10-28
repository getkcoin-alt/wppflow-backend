import crypto from "crypto";
import { query, withTransaction } from "../db/index.js";
import { defaultWhatsAppProvider } from "./whatsapp/WhatsAppProvider.js";
import { fail } from "../middleware/http.js";
import { emitForConversation, emitForSession } from "./realtime.js";

import { formatConversation } from "./conversationFormat.js";
import { chatMatch } from "./chatMatch.js";
import { scheduleLidResolution } from "./lidService.js";
export { formatConversation };

// The labels of the person each chat is with, so the list can show and filter by them. Groups have no contact.
export async function withLabels(tenantId, conversations) {
  const ids = [...new Set(conversations.map((c) => c.contactId).filter(Boolean))];
  const by = new Map();
  if (ids.length) {
    const { rows } = await query(
      `SELECT cl.contact_id,l.id,l.name,l.color FROM contact_labels cl JOIN labels l ON l.id=cl.label_id
       WHERE cl.tenant_id=$1 AND cl.contact_id = ANY($2::text[]) ORDER BY lower(l.name)`,
      [tenantId, ids],
    );
    for (const r of rows) (by.get(r.contact_id) || by.set(r.contact_id, []).get(r.contact_id)).push({ id: r.id, name: r.name, color: r.color });
  }
  return conversations.map((c) => ({ ...c, labels: by.get(c.contactId) || [] }));
}

export async function getConversations({
  tenantId,
  sessionName = null,
  ownerUserId = null,
  limit = 30,
  cursor = null,
  filter = "all",
  search = "",
  labelIds = [],
  labelMode = "any",
  assignedUserId = null,
  activeDays = null,
  team = "",
  awaiting = false,
  overdue = false,
}) {
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  let sql = `
    SELECT id, tenant_id, session_name, provider_chat_id, contact_id, phone,
           contact_name, avatar, unread_count, is_group, group_members_count,
           assigned_to, assigned_user_id, is_closed, is_pinned, is_archived, last_active_epoch,
           last_message, tags, awaiting_since, created_at, updated_at
    FROM conversations
    WHERE tenant_id = $1 AND provider_chat_id !~ '@(broadcast|newsletter)$'
  `;
  const params = [tenantId];

  if (ownerUserId) {
    params.push(ownerUserId);
    sql += ` AND (session_name IN (SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 AND owner_user_id=$${params.length}) OR assigned_user_id=$${params.length})`;
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
    sql += ` AND ${chatMatch(params, search.trim().slice(0, 100))}`;
  }

  // Filters that combine: labels (any, or all of them), who the chat is with, and how recently it was active.
  const wanted = [...new Set((labelIds || []).map(String).filter(Boolean))];
  if (wanted.length) {
    params.push(wanted);
    sql +=
      labelMode === "all"
        ? ` AND (SELECT count(DISTINCT cl.label_id) FROM contact_labels cl WHERE cl.contact_id=conversations.contact_id AND cl.tenant_id=conversations.tenant_id AND cl.label_id = ANY($${params.length}::text[])) = ${wanted.length}`
        : ` AND EXISTS (SELECT 1 FROM contact_labels cl WHERE cl.contact_id=conversations.contact_id AND cl.tenant_id=conversations.tenant_id AND cl.label_id = ANY($${params.length}::text[]))`;
  }
  if (assignedUserId === "none") sql += ` AND assigned_user_id IS NULL`;
  else if (assignedUserId) {
    params.push(Number(assignedUserId) || 0);
    sql += ` AND assigned_user_id = $${params.length}`;
  }
  if (activeDays) {
    params.push(Math.min(Math.max(Number(activeDays) || 0, 1), 3650));
    sql += ` AND last_active_epoch >= extract(epoch FROM now()) - $${params.length}::int * 86400`;
  }
  // A team (the label a teammate has): the chats assigned to someone on it, and unassigned chats on a number one of them owns.
  if (team) {
    params.push(String(team).slice(0, 40));
    const t = `$${params.length}`;
    sql += ` AND (assigned_user_id IN (SELECT user_id FROM memberships WHERE tenant_id=$1 AND category=${t})
      OR (assigned_user_id IS NULL AND session_name IN (SELECT ws.session_name FROM whatsapp_sessions ws JOIN memberships m ON m.user_id=ws.owner_user_id AND m.tenant_id=ws.tenant_id WHERE ws.tenant_id=$1 AND m.category=${t})))`;
  }
  // Chats where the customer wrote last and nobody on the team has answered, and those that have waited past the reply target.
  if (awaiting || overdue) sql += ` AND awaiting_since IS NOT NULL AND NOT is_closed AND NOT is_group`;
  if (overdue) {
    const target = (await query("SELECT sla_minutes FROM report_settings WHERE tenant_id=$1", [tenantId])).rows[0]?.sla_minutes ?? 30;
    params.push(target);
    sql += ` AND awaiting_since < extract(epoch FROM now()) - $${params.length}::int * 60`;
  }
  // Pinned chats stay at the top of the first page, whatever else is going on, so they are fetched apart from the paging below.
  const base = { sql, params: [...params] };
  sql += ` AND NOT is_pinned`;

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
  const pinned = cursor ? [] : (await query(`${base.sql} AND is_pinned ORDER BY last_active_epoch DESC, id DESC LIMIT 20`, base.params)).rows;
  const hasMore = rows.length > parsedLimit;
  const items = hasMore ? rows.slice(0, parsedLimit) : rows;
  // chats WhatsApp only gave a hidden id for are asked about their real number, without making this answer wait
  scheduleLidResolution([...pinned, ...items]);

  const nextCursor =
    items.length > 0
      ? `${items[items.length - 1].last_active_epoch}:${items[items.length - 1].id}`
      : null;

  const formatted = await withLabels(tenantId, [...pinned, ...items].map(formatConversation));

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
  // The team inbox clears its own unread badge immediately, from our database.
  const { rows } = await query(
    `UPDATE conversations SET unread_count = 0, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [conversationId, tenantId],
  );
  if (!rows[0]) throw fail(404, "Conversation not found");
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

  // Telling WhatsApp "seen" is best effort and happens in the background, so a slow,
  // offline or refusing phone can never delay or break opening a chat.
  let timer;
  Promise.race([
    defaultWhatsAppProvider.markRead(
      tenantId,
      rows[0].session_name,
      rows[0].provider_chat_id,
    ),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out after 8s")), 8000);
      timer.unref?.();
    }),
  ])
    .catch((error) =>
      console.warn(`Mark-read not sent to WhatsApp: ${error.message}`),
    )
    .finally(() => clearTimeout(timer));

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
        contact_name = COALESCE((SELECT c.name FROM contacts c WHERE c.id=COALESCE(conversations.contact_id,EXCLUDED.contact_id) AND c.name_edited AND NOT conversations.is_group), EXCLUDED.contact_name),
        is_group = EXCLUDED.is_group,
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
    scope = ` AND (session_name IN (SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 AND owner_user_id=$3) OR assigned_user_id=$3)`;
  }
  // Taken before the read: a change committed while we query is seen again next time.
  const serverTime = (await query("SELECT now() AS t")).rows[0].t.toISOString();
  params.push(cap + 1);
  const { rows } = await query(
    `SELECT id, tenant_id, session_name, provider_chat_id, contact_id, phone,
            contact_name, avatar, unread_count, is_group, group_members_count,
            assigned_to, assigned_user_id, is_closed, is_pinned, is_archived, last_active_epoch,
            last_message, tags, awaiting_since, created_at, updated_at
     FROM conversations WHERE tenant_id=$1 AND updated_at > $2 AND provider_chat_id !~ '@(broadcast|newsletter)$'${scope}
     ORDER BY updated_at ASC LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > cap;
  return {
    serverTime,
    hasMore,
    conversations: await withLabels(tenantId, rows.slice(0, cap).map(formatConversation)),
  };
}
