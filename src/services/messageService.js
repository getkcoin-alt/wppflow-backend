import { emitForConversation } from "./realtime.js";
import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { fail, text as validateText } from "../middleware/http.js";
import { recordWebhook } from "./webhookService.js";
import {
  mediaEnabled,
  mediaTypes,
  MAX_MEDIA_BYTES,
  storeIncoming,
  downloadUrl,
} from "./mediaService.js";

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
const emitMessage = (io, tenant, event, message) =>
  emitForConversation(
    io,
    tenant,
    message.conversation_id,
    event,
    {
      conversationId: message.conversation_id,
      chatId: message.conversation_id,
      message: formatMessage(message),
    },
    { snapshot: true },
  );
export async function sendTextMessage({
  tenantId,
  conversationId,
  text,
  idempotencyKey,
  agentName = "Agent",
  io = null,
  type = "text",
  attachment = null,
  campaignId = null,
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
    const id = crypto.randomUUID(),
      epoch = Math.floor(Date.now() / 1000),
      stamp = new Date().toISOString(),
      note = type === "internal_note";
    const saved = await c.query(
      `INSERT INTO messages(id,tenant_id,conversation_id,idempotency_key,sender,agent_name,text,type,status,ack,timestamp,timestamp_epoch)
      VALUES($1,$2,$3,$4,'agent',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
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
          }),
        ],
      );
      await c.query(
        "UPDATE conversations SET last_active_epoch=$1,last_message=$2,updated_at=now() WHERE id=$3 AND tenant_id=$4",
        [
          epoch,
          JSON.stringify({
            text,
            timestamp: stamp,
            status: "sending",
            fromMe: true,
          }),
          conversationId,
          tenantId,
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
            `INSERT INTO contacts(id,tenant_id,name,phone) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,phone) DO UPDATE SET updated_at=contacts.updated_at RETURNING id`,
            [crypto.randomUUID(), tenantId, personName, phone],
          )
        ).rows[0].id;
    const conv = await c.query(
      `INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,contact_id,phone,contact_name,is_group)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,session_name,provider_chat_id) DO UPDATE SET
        contact_id=COALESCE(conversations.contact_id,EXCLUDED.contact_id),
        is_group=conversations.is_group OR EXCLUDED.is_group,
        contact_name=CASE WHEN $9::boolean THEN EXCLUDED.contact_name ELSE conversations.contact_name END
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
    const saved = await c.query(
      `INSERT INTO messages(id,tenant_id,conversation_id,provider_message_id,sender,agent_name,text,type,status,ack,media_url,file_name,file_size,timestamp,timestamp_epoch)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(tenant_id,provider_message_id) DO NOTHING RETURNING *`,
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
      `UPDATE conversations SET unread_count=unread_count+$1,last_message=CASE WHEN last_active_epoch<=$2 THEN $3 ELSE last_message END,last_active_epoch=GREATEST(last_active_epoch,$2),updated_at=now() WHERE id=$4 AND tenant_id=$5`,
      [
        !history && !msg.fromMe ? 1 : 0,
        epoch,
        JSON.stringify({
          text: msg.text || "",
          timestamp: stamp,
          status: msg.fromMe ? "sent" : "delivered",
          fromMe: Boolean(msg.fromMe),
        }),
        id,
        tenantId,
      ],
    );
    return saved.rows[0];
  });
  if (inserted) {
    if (
      msg.downloadMedia &&
      mediaEnabled() &&
      mediaTypes[msg.mimeType] &&
      Number(msg.byteSize) > 0 &&
      Number(msg.byteSize) <= MAX_MEDIA_BYTES
    ) {
      try {
        const attachment = await storeIncoming(
          tenantId,
          await msg.downloadMedia(),
          msg.mimeType,
        );
        await query(
          `INSERT INTO attachments(id,tenant_id,conversation_id,message_id,storage_key,original_name,mime_type,byte_size,upload_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready')`,
          [
            attachment.id,
            tenantId,
            inserted.conversation_id,
            inserted.id,
            attachment.key,
            msg.fileName || "WhatsApp media",
            attachment.mime,
            attachment.bytes,
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
  if (m)
    emitForConversation(io, tenantId, m.conversation_id, "message:ack", {
      conversationId: m.conversation_id,
      messageId: m.id,
      providerMessageId,
      ack: m.ack,
      status: m.status,
    });
  return m ? { messageId: m.id, ack: m.ack, status: m.status } : null;
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
    `SELECT * FROM messages WHERE tenant_id=$1 AND conversation_id=$2${filter} ORDER BY timestamp_epoch DESC,id DESC LIMIT $${params.length + 1}`,
    [...params, count + 1],
  );
  const hasMore = rows.length > count,
    items = rows.slice(0, count),
    last = items.at(-1),
    messages = items.map(formatMessage).reverse();
  if (mediaEnabled() && items.length) {
    const attachments = await query(
      "SELECT message_id,storage_key,original_name,byte_size FROM attachments WHERE tenant_id=$1 AND message_id=ANY($2) AND upload_status='ready'",
      [tenantId, items.map((m) => m.id)],
    );
    await Promise.all(
      attachments.rows.map(async (a) => {
        const message = messages.find((m) => m.id === a.message_id);
        if (message) {
          message.mediaUrl = await downloadUrl(a.storage_key);
          message.fileName = a.original_name;
          message.fileSize = `${Math.ceil(Number(a.byte_size) / 1024)} KB`;
        }
      }),
    );
  }
  return {
    messages,
    hasMore,
    nextCursor: hasMore ? `${last.timestamp_epoch}:${last.id}` : null,
  };
}
