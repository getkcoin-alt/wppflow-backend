import { emitForConversation } from "./realtime.js";
import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { fail, text as validateText } from "../middleware/http.js";
import { recordWebhook } from "./webhookService.js";
import { defaultWhatsAppProvider as provider } from "./whatsapp/WhatsAppProvider.js";
import {
  mediaEnabled,
  mediaTypes,
  limitFor,
  canOpenInline,
  storeIncoming,
  downloadUrl,
  previewUrl,
} from "./mediaService.js";
import { backfillPreviews } from "./previewService.js";

export function formatMessage(m) {
  return m
    ? {
        ...m,
        tenantId: m.tenant_id,
        conversationId: m.conversation_id,
        chatId: m.conversation_id,
        providerMessageId: m.provider_message_id,
        idempotencyKey: m.idempotency_key,
        agentName: m.agent_name,
        text: m.text || "",
        mediaUrl: m.media_url,
        fileName: m.file_name,
        fileSize: m.file_size,
        audioDuration: m.audio_duration,
        timestampEpoch: Number(m.timestamp_epoch),
        isNote: m.type === "internal_note",
        quoted:
          typeof m.quoted === "string"
            ? JSON.parse(m.quoted)
            : m.quoted || null,
        quotedMessageId: m.quoted_message_id || null,
        isDeleted: Boolean(m.is_deleted),
      }
    : null;
}
const IGNORED_TYPES = new Set([
  "e2e_notification",
  "notification_template",
  "protocol",
  "gp2",
  "broadcast_notification",
  "ciphertext",
]);
const emitMessage = (io, tenant, event, message) => {
  const formatted = formatMessage(message);
  emitForConversation(
    io,
    tenant,
    message.conversation_id,
    event,
    {
      conversationId: message.conversation_id,
      chatId: message.conversation_id,
      message: formatted,
    },
    { snapshot: true },
  );
  if (io && tenant) {
    io.to(`tenant:${tenant}`).emit(event, {
      conversationId: message.conversation_id,
      chatId: message.conversation_id,
      message: formatted,
    });
    io.to(`tenant:${tenant}`).emit("conversation:updated", {
      conversationId: message.conversation_id,
      chatId: message.conversation_id,
    });
  }
};
export async function sendTextMessage({
  tenantId,
  conversationId,
  text,
  idempotencyKey,
  agentName = "Agent",
  sentByUserId = null,
  io = null,
  type = "text",
  attachment = null,
  campaignId = null,
  quotedMessageId = null,
}) {
  text = validateText(text, "Message", 10000);
  idempotencyKey = validateText(idempotencyKey, "Idempotency key", 128);
  if (
    !["text", "internal_note", "image", "video", "audio", "document"].includes(
      type,
    )
  )
    throw fail(400, "Unsupported message type");
  const result = await withTransaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${tenantId}:${idempotencyKey}`,
    ]);
    const existing = await c.query(
      "SELECT * FROM messages WHERE tenant_id=$1 AND idempotency_key=$2",
      [tenantId, idempotencyKey],
    );
    if (existing.rows[0]) {
      const m = existing.rows[0];
      if (
        m.conversation_id !== conversationId ||
        m.text !== text ||
        m.type !== type
      )
        throw fail(
          409,
          "Idempotency key was already used for another operation",
        );
      if (attachment) {
        const linked = await c.query(
          "SELECT 1 FROM attachments WHERE id=$1 AND tenant_id=$2 AND message_id=$3",
          [attachment.id, tenantId, m.id],
        );
        if (!linked.rowCount)
          throw fail(409, "Idempotency key belongs to a different attachment");
      }
      return { message: m, duplicate: true };
    }
    const { rows } = await c.query(
      "SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2",
      [conversationId, tenantId],
    );
    const conv = rows[0];
    if (!conv) throw fail(404, "Conversation not found");
    if (type !== "internal_note") {
      const suppressed = await c.query(
        "SELECT 1 FROM suppressions WHERE tenant_id=$1 AND phone=$2",
        [tenantId, conv.phone],
      );
      if (suppressed.rowCount) throw fail(403, "Recipient is suppressed");
    }
    if (attachment) {
      const a = await c.query(
        "SELECT id FROM attachments WHERE id=$1 AND tenant_id=$2 AND conversation_id=$3 AND upload_status='ready' AND message_id IS NULL FOR UPDATE",
        [attachment.id, tenantId, conversationId],
      );
      if (!a.rowCount) throw fail(400, "Attachment is not ready");
    }
    let quoted = null;
    let quotedProviderMessageId = null;
    if (quotedMessageId) {
      const qTarget = await c.query(
        "SELECT id, provider_message_id, sender, agent_name, text, type FROM messages WHERE id=$1 AND tenant_id=$2",
        [quotedMessageId, tenantId],
      );
      if (qTarget.rows[0]) {
        const qm = qTarget.rows[0];
        quoted = {
          id: qm.id,
          providerMessageId: qm.provider_message_id,
          sender: qm.sender,
          agentName:
            qm.agent_name || (qm.sender === "agent" ? "Agent" : "Customer"),
          text: qm.text || "",
          type: qm.type || "text",
        };
        quotedProviderMessageId = qm.provider_message_id || null;
      }
    }
    const id = crypto.randomUUID(),
      epoch = Math.floor(Date.now() / 1000),
      stamp = new Date().toISOString(),
      note = type === "internal_note";
    const saved = await c.query(
      `INSERT INTO messages(id,tenant_id,conversation_id,idempotency_key,sender,agent_name,text,type,status,ack,timestamp,timestamp_epoch,sent_by_user_id,quoted,quoted_message_id)
      VALUES($1,$2,$3,$4,'agent',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        id,
        tenantId,
        conversationId,
        idempotencyKey,
        agentName,
        text,
        type,
        note ? "sent" : "sending",
        note ? 1 : 0,
        stamp,
        epoch,
        sentByUserId,
        quoted ? JSON.stringify(quoted) : null,
        quoted ? quoted.id : null,
      ],
    );
    if (!note) {
      await c.query(
        `INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'message',$2,'message.outgoing',$3)`,
        [
          tenantId,
          id,
          JSON.stringify({
            tenantId,
            sessionName: conv.session_name,
            conversationId,
            messageId: id,
            to: conv.provider_chat_id,
            text,
            type,
            attachmentId: attachment?.id,
            campaignId,
            quotedMsg: quotedProviderMessageId,
          }),
        ],
      );
      await c.query(
        // a reply from a person ends the customer's wait; an automatic reply or a broadcast does not
        "UPDATE conversations SET last_active_epoch=$1,last_message=$2,awaiting_since=CASE WHEN $5::boolean THEN NULL ELSE awaiting_since END,updated_at=now() WHERE id=$3 AND tenant_id=$4",
        [
          epoch,
          JSON.stringify({
            id,
            text,
            timestamp: stamp,
            status: "sending",
            fromMe: true,
          }),
          conversationId,
          tenantId,
          !["Automation", "Campaign"].includes(agentName),
        ],
      );
    }
    if (attachment)
      await c.query(
        "UPDATE attachments SET message_id=$1 WHERE id=$2 AND tenant_id=$3",
        [id, attachment.id, tenantId],
      );
    return { message: saved.rows[0], duplicate: false };
  });
  if (!result.duplicate)
    emitMessage(io, tenantId, "message:created", result.message);
  return { ...result, message: formatMessage(result.message) };
}
// Earlier syncs trusted WhatsApp's sender/recipient ids and could file a message under a different
// conversation of the same number (a phone-number chat instead of the "lid" chat, say). When the chat
// they truly belong to is opened, move them there instead of treating them as already saved.
export async function adoptMisfiledMessages({
  tenantId,
  sessionName,
  conversationId,
  providerMessageIds,
}) {
  const ids = [...new Set(providerMessageIds.filter(Boolean))];
  if (!ids.length) return 0;
  return withTransaction(async (c) => {
    const moved = await c.query(
      `UPDATE messages m SET conversation_id=$3
         FROM conversations c
        WHERE m.tenant_id=$1 AND m.provider_message_id=ANY($4) AND m.conversation_id<>$3
          AND c.id=m.conversation_id AND c.tenant_id=$1 AND c.session_name=$2
        RETURNING m.id`,
      [tenantId, sessionName, conversationId, ids],
    );
    if (moved.rowCount)
      await c.query(
        "UPDATE attachments SET conversation_id=$1 WHERE tenant_id=$2 AND message_id=ANY($3)",
        [conversationId, tenantId, moved.rows.map((r) => r.id)],
      );
    return moved.rowCount;
  });
}

export async function handleIncomingMessage({
  tenantId,
  sessionName,
  msg,
  io = null,
  history = false,
}) {
  if (!msg.providerMessageId || !msg.remoteId) return null;
  // Status updates, channels and WhatsApp's own system notices are not team conversations.
  if (/@(broadcast|newsletter)$/.test(msg.remoteId)) return null;
  if (IGNORED_TYPES.has(msg.rawType)) return null;
  const isGroup = Boolean(msg.isGroup) || msg.remoteId.endsWith("@g.us");
  const inserted = await withTransaction(async (c) => {
    if (msg.rawType === "revoked" || msg.type === "revoked") {
      const revoked = await c.query(
        `UPDATE messages SET type='revoked', status='deleted', text='🚫 This message was deleted', media_url='', file_name='', updated_at=now()
         WHERE tenant_id=$1 AND provider_message_id=$2 RETURNING *`,
        [tenantId, msg.providerMessageId],
      );
      if (revoked.rowCount) {
        await c.query(
          `UPDATE conversations
           SET last_message = jsonb_set(coalesce(last_message, '{}'::jsonb), '{text}', to_jsonb('🚫 This message was deleted'::text)),
               updated_at = now()
           WHERE id=$1 AND tenant_id=$2 AND (last_message->>'id'=$3 OR last_message->>'providerMessageId'=$4)`,
          [
            revoked.rows[0].conversation_id,
            tenantId,
            revoked.rows[0].id,
            msg.providerMessageId,
          ],
        );
        return revoked.rows[0];
      }
    }
    const old = await c.query(
      "SELECT id FROM messages WHERE tenant_id=$1 AND provider_message_id=$2",
      [tenantId, msg.providerMessageId],
    );
    if (old.rowCount) return null;
    const phone = msg.remoteId.replace(/@c\.us$/, ""),
      epoch = Number(msg.timestampEpoch) || Math.floor(Date.now() / 1000),
      stamp = new Date(epoch * 1000).toISOString();
    // A group is not a person: no contact record, and its title is the group's subject.
    // Your own outgoing messages say "You", which is not the other person's name either.
    const personName = msg.fromMe ? phone : msg.senderName || phone;
    const contactId = isGroup
      ? null
      : (
          await c.query(
            // WhatsApp's name for the person is kept in whatsapp_name. The name on the contact only follows it while it
            // is still the bare number or WhatsApp's own earlier name: a name the team typed is never replaced.
            `INSERT INTO contacts(id,tenant_id,name,whatsapp_name,phone) VALUES($1,$2,$3,$3,$4) ON CONFLICT(tenant_id,phone) DO UPDATE SET
               whatsapp_name=CASE WHEN EXCLUDED.whatsapp_name<>EXCLUDED.phone THEN EXCLUDED.whatsapp_name ELSE contacts.whatsapp_name END,
               name=CASE WHEN NOT contacts.name_edited AND EXCLUDED.whatsapp_name<>EXCLUDED.phone AND (contacts.name=contacts.phone OR contacts.name=contacts.whatsapp_name) THEN EXCLUDED.whatsapp_name ELSE contacts.name END,
               updated_at=contacts.updated_at RETURNING id`,
            [crypto.randomUUID(), tenantId, personName, phone],
          )
        ).rows[0].id;
    const conv = await c.query(
      `INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,contact_id,phone,contact_name,is_group)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,session_name,provider_chat_id) DO UPDATE SET
        contact_id=COALESCE(conversations.contact_id,EXCLUDED.contact_id),
        is_group=conversations.is_group OR EXCLUDED.is_group,
        contact_name=CASE WHEN $9::boolean THEN EXCLUDED.contact_name
          WHEN NOT conversations.is_group AND conversations.contact_name=conversations.phone AND EXCLUDED.contact_name<>conversations.phone THEN COALESCE((SELECT c.name FROM contacts c WHERE c.id=conversations.contact_id),EXCLUDED.contact_name)
          ELSE conversations.contact_name END
      RETURNING id`,
      [
        crypto.randomUUID(),
        tenantId,
        sessionName,
        msg.remoteId,
        contactId,
        phone,
        isGroup ? msg.groupName || "WhatsApp Group" : personName,
        isGroup,
        isGroup && Boolean(msg.groupName),
      ],
    );
    const id = conv.rows[0].id;

    let quotedMessageId = null;
    if (msg.quoted?.providerMessageId) {
      const qm = await c.query(
        "SELECT id FROM messages WHERE tenant_id=$1 AND provider_message_id=$2",
        [tenantId, msg.quoted.providerMessageId],
      );
      quotedMessageId = qm.rows[0]?.id || null;
    }

    const saved = await c.query(
      `INSERT INTO messages(id,tenant_id,conversation_id,provider_message_id,sender,agent_name,text,type,status,ack,media_url,file_name,file_size,timestamp,timestamp_epoch,quoted,quoted_message_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(tenant_id,provider_message_id) DO NOTHING RETURNING *`,
      [
        crypto.randomUUID(),
        tenantId,
        id,
        msg.providerMessageId,
        msg.fromMe ? "agent" : "customer",
        msg.senderName || "",
        msg.text || "",
        msg.type || "text",
        msg.fromMe
          ? msg.ack >= 3
            ? "read"
            : msg.ack === 2
              ? "delivered"
              : msg.ack === 1
                ? "sent"
                : "sending"
          : "delivered",
        msg.fromMe ? Math.max(0, msg.ack || 0) : 2,
        msg.mediaUrl || "",
        msg.fileName || "",
        msg.fileSize || "",
        stamp,
        epoch,
        msg.quoted ? JSON.stringify(msg.quoted) : null,
        quotedMessageId,
      ],
    );
    if (!saved.rowCount) return null;
    if (!history && !msg.fromMe) {
      await c.query(
        "INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'message',$2,'automation.incoming',$3) ON CONFLICT DO NOTHING",
        [
          tenantId,
          saved.rows[0].id,
          JSON.stringify({ messageId: saved.rows[0].id }),
        ],
      );
      await recordWebhook(
        tenantId,
        "message.received",
        {
          messageId: saved.rows[0].id,
          conversationId: id,
          text: msg.text || "",
        },
        c,
      );
    }
    await c.query(
      // awaiting_since: a customer's message starts a wait if none is running; a reply typed on the phone ends it.
      // Imported history and groups never change it.
      `UPDATE conversations SET unread_count=unread_count+$1,last_message=CASE WHEN last_active_epoch<=$2 THEN $3 ELSE last_message END,last_active_epoch=GREATEST(last_active_epoch,$2),
         awaiting_since=CASE WHEN $6::boolean THEN COALESCE(awaiting_since,$2) WHEN $7::boolean THEN NULL ELSE awaiting_since END,updated_at=now() WHERE id=$4 AND tenant_id=$5`,
      [
        !history && !msg.fromMe ? 1 : 0,
        epoch,
        JSON.stringify({
          id: saved.rows[0].id,
          text: msg.text || "",
          timestamp: stamp,
          status: msg.fromMe ? "sent" : "delivered",
          fromMe: Boolean(msg.fromMe),
        }),
        id,
        tenantId,
        !history && !msg.fromMe && !isGroup,
        !history && Boolean(msg.fromMe) && !isGroup,
      ],
    );
    return saved.rows[0];
  });
  if (inserted) {
    if (inserted.type === "revoked") {
      emitMessage(io, tenantId, "message:updated", inserted);
      return inserted;
    }
    if (
      msg.downloadMedia &&
      mediaEnabled() &&
      mediaTypes[msg.mimeType] &&
      Number(msg.byteSize) > 0 &&
      Number(msg.byteSize) <= limitFor(msg.mimeType)
    ) {
      try {
        const attachment = await storeIncoming(
          tenantId,
          await msg.downloadMedia(),
          msg.mimeType,
        );
        await query(
          `INSERT INTO attachments(id,tenant_id,conversation_id,message_id,storage_key,original_name,mime_type,byte_size,upload_status,thumb_key,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready',$9,$10,$11)`,
          [
            attachment.id,
            tenantId,
            inserted.conversation_id,
            inserted.id,
            attachment.key,
            msg.fileName || "WhatsApp media",
            attachment.mime,
            attachment.bytes,
            attachment.thumb_key,
            attachment.width,
            attachment.height,
          ],
        );
      } catch (error) {
        console.error("Incoming media unavailable:", error.message);
      }
    }
    emitMessage(io, tenantId, "message:received", inserted);
    emitForConversation(
      io,
      tenantId,
      inserted.conversation_id,
      "conversation:updated",
      {
        conversationId: inserted.conversation_id,
        chatId: inserted.conversation_id,
      },
      { snapshot: true },
    );
  }
  if (msg.fromMe && Number.isInteger(msg.ack) && msg.ack !== 0)
    await handleAckEvent({
      tenantId,
      ackData: { providerMessageId: msg.providerMessageId, ack: msg.ack },
      io,
    });
  return formatMessage(inserted);
}
export async function handleAckEvent({ tenantId, ackData, io = null }) {
  const { providerMessageId, ack } = ackData;
  if (!providerMessageId || !Number.isInteger(ack)) return null;
  const m = await withTransaction(async (c) => {
    const result = await c.query(
      `UPDATE messages SET ack=GREATEST(ack,$1),status=CASE WHEN $1<0 THEN 'failed' WHEN $1>=3 THEN 'read' WHEN $1=2 THEN 'delivered' WHEN $1=1 THEN 'sent' ELSE 'sending' END,updated_at=now()
      WHERE tenant_id=$2 AND provider_message_id=$3 AND (ack<$1 OR ($1<0 AND ack=0 AND status<>'failed')) RETURNING *`,
      [ack, tenantId, providerMessageId],
    );
    if (!result.rows[0]) {
      const exists = await c.query(
        "SELECT 1 FROM messages WHERE tenant_id=$1 AND provider_message_id=$2",
        [tenantId, providerMessageId],
      );
      if (!exists.rowCount)
        await c.query(
          `INSERT INTO early_receipts(tenant_id,provider_message_id,ack) VALUES($1,$2,$3) ON CONFLICT(tenant_id,provider_message_id) DO UPDATE SET ack=CASE WHEN EXCLUDED.ack>0 THEN GREATEST(early_receipts.ack,EXCLUDED.ack) ELSE LEAST(early_receipts.ack,EXCLUDED.ack) END`,
          [tenantId, providerMessageId, ack],
        );
      return null;
    }
    const row = result.rows[0];
    await c.query(
      "INSERT INTO message_receipts(tenant_id,message_id,provider_message_id,ack) VALUES($1,$2,$3,$4)",
      [tenantId, row.id, providerMessageId, ack],
    );
    await c.query(
      `UPDATE conversations
       SET last_message = jsonb_set(
         jsonb_set(coalesce(last_message, '{}'::jsonb), '{status}', to_jsonb($3::text)),
         '{ack}', to_jsonb($4::int)
       ),
       updated_at = now()
       WHERE id = $1 AND tenant_id = $2
         AND (last_message->>'id' = $5 OR last_message->>'providerMessageId' = $6 OR last_message->>'id' IS NULL)`,
      [
        row.conversation_id,
        tenantId,
        row.status,
        row.ack,
        row.id,
        providerMessageId,
      ],
    );
    await recordWebhook(
      tenantId,
      "message.status",
      {
        messageId: row.id,
        conversationId: row.conversation_id,
        ack: row.ack,
        status: row.status,
      },
      c,
    );
    return row;
  });
  if (m) {
    emitForConversation(io, tenantId, m.conversation_id, "message:ack", {
      conversationId: m.conversation_id,
      messageId: m.id,
      providerMessageId,
      ack: m.ack,
      status: m.status,
    });
    emitForConversation(
      io,
      tenantId,
      m.conversation_id,
      "conversation:updated",
      {
        conversationId: m.conversation_id,
        chatId: m.conversation_id,
      },
      { snapshot: true },
    );
  }
  return m ? { messageId: m.id, ack: m.ack, status: m.status } : null;
}

export async function handleRevokedMessage({ tenantId, sessionName, revokedData, io = null }) {
  const providerMessageId = String(
    revokedData?.providerMessageId || revokedData?.refId || revokedData?.id || "",
  );
  if (!tenantId || !providerMessageId) return null;

  const found = await query(
    `SELECT * FROM messages WHERE tenant_id = $1 AND provider_message_id = $2`,
    [tenantId, providerMessageId],
  );
  if (!found.rows[0]) return null;
  const msg = found.rows[0];

  await query(
    `UPDATE messages
     SET type = 'revoked', status = 'deleted', text = '🚫 This message was deleted', media_url = '', file_name = '', updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [msg.id, tenantId],
  );

  await query(
    `UPDATE conversations
     SET last_message = jsonb_set(coalesce(last_message, '{}'::jsonb), '{text}', to_jsonb('🚫 This message was deleted'::text)),
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND (last_message->>'id' = $3 OR last_message->>'providerMessageId' = $4)`,
    [msg.conversation_id, tenantId, msg.id, msg.provider_message_id],
  );

  const updated = await query(
    "SELECT * FROM messages WHERE id = $1 AND tenant_id = $2",
    [msg.id, tenantId],
  );
  const formatted = formatMessage(updated.rows[0]);

  if (io) {
    emitForConversation(io, tenantId, msg.conversation_id, "message:updated", {
      conversationId: msg.conversation_id,
      chatId: msg.conversation_id,
      messageId: msg.id,
      message: formatted,
    });
    io.to(`tenant:${tenantId}`).emit("message:updated", {
      conversationId: msg.conversation_id,
      chatId: msg.conversation_id,
      messageId: msg.id,
      message: formatted,
    });
    io.to(`tenant:${tenantId}`).emit("conversation:updated", {
      conversationId: msg.conversation_id,
      chatId: msg.conversation_id,
    });
    emitForConversation(
      io,
      tenantId,
      msg.conversation_id,
      "conversation:updated",
      { conversationId: msg.conversation_id, chatId: msg.conversation_id },
      { snapshot: true },
    );
  }
  return formatted;
}
export const MEDIA_MESSAGE_TYPES = new Set([
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "gif",
]);
const MEDIA_TYPE_LIST = [...MEDIA_MESSAGE_TYPES];
export async function countPendingMedia(tenantId, conversationId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM messages m
      WHERE m.tenant_id=$1 AND m.conversation_id=$2 AND m.type=ANY($3) AND m.provider_message_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id=m.id AND a.tenant_id=$1 AND a.upload_status='ready')`,
    [tenantId, conversationId, MEDIA_TYPE_LIST],
  );
  return rows[0].n;
}
export const ATTACHMENT_COLUMNS =
  "id,tenant_id,message_id,storage_key,original_name,mime_type,byte_size,thumb_key,width,height";
// Adds a saved file's addresses and details to its message.
export async function attachFile(message, a) {
  message.mediaUrl = await downloadUrl(a.storage_key, {
    filename: a.original_name,
  });
  // Opens in the browser (PDF, photo, video, audio) instead of downloading.
  if (canOpenInline(a.mime_type))
    message.openUrl = await downloadUrl(a.storage_key, {
      inline: true,
      mime: a.mime_type,
      filename: a.original_name,
    });
  // The small version the chat shows in place of the full photo.
  if (a.thumb_key) message.thumbUrl = await previewUrl(a.thumb_key);
  if (a.width && a.height) {
    message.width = a.width;
    message.height = a.height;
  }
  message.mimeType = a.mime_type;
  message.fileName = a.original_name;
  message.fileSize = `${Math.ceil(Number(a.byte_size) / 1024)} KB`;
  message.mediaState = "ready";
}
export async function getConversationMessages({
  tenantId,
  conversationId,
  limit = 50,
  cursor = null,
}) {
  const count = Math.min(Math.max(Number(limit) || 50, 1), 100),
    params = [tenantId, conversationId];
  let filter = "";
  if (cursor) {
    const [epoch, id] = String(cursor).split(":");
    if (!id || !Number.isFinite(Number(epoch)))
      throw fail(400, "Invalid cursor");
    params.push(Number(epoch), id);
    filter = " AND (timestamp_epoch,id)<($3,$4)";
  }
  const { rows } = await query(
    `SELECT * FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND (is_deleted IS NOT TRUE)${filter} ORDER BY timestamp_epoch DESC,id DESC LIMIT $${params.length + 1}`,
    [...params, count + 1],
  );
  const hasMore = rows.length > count,
    items = rows.slice(0, count),
    last = items.at(-1),
    messages = items.map(formatMessage).reverse();
  let mediaPending, previewsPending = 0;
  if (mediaEnabled() && items.length) {
    const attachments = await query(
      `SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE tenant_id=$1 AND message_id=ANY($2) AND upload_status='ready'`,
      [tenantId, items.map((m) => m.id)],
    );
    await Promise.all(
      attachments.rows.map(async (a) => {
        const message = messages.find((m) => m.id === a.message_id);
        if (message) await attachFile(message, a);
      }),
    );
    previewsPending = backfillPreviews(attachments.rows);
  }
  // Files that were never saved (sent before storage was on, or from the phone while offline) say so,
  // so the chat can offer to load them from WhatsApp.
  for (const message of messages)
    if (MEDIA_MESSAGE_TYPES.has(message.type) && !message.mediaState)
      message.mediaState = !mediaEnabled()
        ? "storage_off"
        : message.providerMessageId
          ? "not_saved"
          : "unavailable";
  if (mediaEnabled() && !cursor) mediaPending = await countPendingMedia(tenantId, conversationId);
  return {
    messages,
    hasMore,
    nextCursor: hasMore ? `${last.timestamp_epoch}:${last.id}` : null,
    ...(mediaPending !== undefined ? { mediaPending } : {}),
    ...(previewsPending ? { previewsPending } : {}),
  };
}

export async function deleteMessage({
  tenantId,
  conversationId,
  messageId,
  forEveryone = false,
  userId = null,
  io = null,
}) {
  const mRes = await query(
    `SELECT m.*, c.session_name, c.provider_chat_id, c.phone
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id
     WHERE m.id = $1 AND m.tenant_id = $2 AND m.conversation_id = $3`,
    [messageId, tenantId, conversationId],
  );
  if (!mRes.rows[0]) throw fail(404, "Message not found");
  const msg = mRes.rows[0];

  if (forEveryone) {
    if (msg.sender !== "agent") {
      throw fail(400, "Only messages sent by your team can be deleted for everyone");
    }
  }

  const providerChatId = msg.provider_chat_id || msg.phone;
  if (msg.provider_message_id && providerChatId) {
    try {
      await provider.deleteMessage(
        tenantId,
        msg.session_name,
        providerChatId,
        msg.provider_message_id,
        !forEveryone,
      );
    } catch (err) {
      console.warn(`WhatsApp deleteMessage: ${err.message}`);
    }
  }

  if (forEveryone) {
    await query(
      `UPDATE messages
       SET type = 'revoked', status = 'deleted', text = '🚫 This message was deleted', media_url = '', file_name = '', updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [messageId, tenantId],
    );

    await query(
      `UPDATE conversations
       SET last_message = jsonb_set(coalesce(last_message, '{}'::jsonb), '{text}', to_jsonb('🚫 This message was deleted'::text)),
           updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND (last_message->>'id' = $3 OR last_message->>'providerMessageId' = $4)`,
      [conversationId, tenantId, messageId, msg.provider_message_id],
    );

    const updated = await query(
      "SELECT * FROM messages WHERE id = $1 AND tenant_id = $2",
      [messageId, tenantId],
    );
    const formatted = formatMessage(updated.rows[0]);
    if (io) {
      emitForConversation(io, tenantId, conversationId, "message:updated", {
        conversationId,
        chatId: conversationId,
        messageId,
        message: formatted,
      });
      io.to(`tenant:${tenantId}`).emit("message:updated", {
        conversationId,
        chatId: conversationId,
        messageId,
        message: formatted,
      });
      io.to(`tenant:${tenantId}`).emit("conversation:updated", {
        conversationId,
        chatId: conversationId,
      });
      emitForConversation(
        io,
        tenantId,
        conversationId,
        "conversation:updated",
        { conversationId, chatId: conversationId },
        { snapshot: true },
      );
    }
    return { message: formatted, deleted: true, forEveryone: true };
  } else {
    await query(
      `UPDATE messages SET is_deleted = TRUE, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [messageId, tenantId],
    );

    const latest = await query(
      `SELECT * FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND (is_deleted IS NOT TRUE)
       ORDER BY timestamp_epoch DESC, id DESC LIMIT 1`,
      [tenantId, conversationId],
    );
    if (latest.rows[0]) {
      const lm = latest.rows[0];
      await query(
        `UPDATE conversations
         SET last_message = $1, last_active_epoch = $2, updated_at = now()
         WHERE id = $3 AND tenant_id = $4`,
        [
          JSON.stringify({
            id: lm.id,
            text: lm.text,
            timestamp: lm.timestamp,
            status: lm.status,
            fromMe: lm.sender === "agent",
          }),
          lm.timestamp_epoch,
          conversationId,
          tenantId,
        ],
      );
    }

    if (io) {
      emitForConversation(io, tenantId, conversationId, "message:deleted", {
        conversationId,
        chatId: conversationId,
        messageId,
      });
      io.to(`tenant:${tenantId}`).emit("message:deleted", {
        conversationId,
        chatId: conversationId,
        messageId,
      });
      io.to(`tenant:${tenantId}`).emit("conversation:updated", {
        conversationId,
        chatId: conversationId,
      });
      emitForConversation(
        io,
        tenantId,
        conversationId,
        "conversation:updated",
        { conversationId, chatId: conversationId },
        { snapshot: true },
      );
    }
    return { messageId, deleted: true, forEveryone: false };
  }
}
