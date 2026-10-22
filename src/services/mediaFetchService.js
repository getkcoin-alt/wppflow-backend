import crypto from "node:crypto";
import { query } from "../db/index.js";
import { fail } from "../middleware/http.js";
import { defaultWhatsAppProvider as provider } from "./whatsapp/WhatsAppProvider.js";
import {
  mediaEnabled,
  validateMedia,
  validateContent,
  storeIncoming,
  downloadUrl,
  canOpenInline,
} from "./mediaService.js";
import {
  MEDIA_MESSAGE_TYPES,
  countPendingMedia,
  formatMessage,
} from "./messageService.js";

// Files that were never saved (sent before storage was on, or while the app was offline) are fetched
// from WhatsApp the first time someone opens them, then kept like any other file.
const MEDIA_TYPE_LIST = [...MEDIA_MESSAGE_TYPES];
const inflight = new Map();
const lanes = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One download at a time per WhatsApp number: its browser is shared with live messages.
function inLane(key, work) {
  const previous = lanes.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  lanes.set(key, next);
  next.finally(() => lanes.get(key) === next && lanes.delete(key)).catch(() => {});
  return next;
}

const explain = (error) => {
  if (error?.status) return error;
  switch (error?.code) {
    case "SESSION_OFFLINE":
      return fail(409, "The WhatsApp number for this chat is offline. Reconnect it under Numbers, then try again.");
    case "MEDIA_TOO_LARGE":
      return fail(413, `Files over ${Math.round(error.limit / 1024 / 1024)} MB can't be saved. This one is ${Math.ceil(error.size / 1024 / 1024)} MB.`);
    case "MEDIA_UNAVAILABLE":
      return fail(404, "WhatsApp no longer has this file. Files expire on WhatsApp after a while.");
    default:
      return fail(502, "Couldn't load this file from WhatsApp. Please try again.");
  }
};

async function viewOf(tenantId, messageId) {
  const { rows } = await query("SELECT * FROM messages WHERE id=$1 AND tenant_id=$2", [messageId, tenantId]);
  const message = formatMessage(rows[0]);
  const attachment = (
    await query(
      "SELECT storage_key,original_name,mime_type,byte_size FROM attachments WHERE tenant_id=$1 AND message_id=$2 AND upload_status='ready' ORDER BY created_at DESC LIMIT 1",
      [tenantId, messageId],
    )
  ).rows[0];
  if (attachment) {
    message.mediaUrl = await downloadUrl(attachment.storage_key, { filename: attachment.original_name });
    if (canOpenInline(attachment.mime_type))
      message.openUrl = await downloadUrl(attachment.storage_key, {
        inline: true,
        mime: attachment.mime_type,
        filename: attachment.original_name,
      });
    message.mimeType = attachment.mime_type;
    message.fileName = attachment.original_name;
    message.fileSize = `${Math.ceil(Number(attachment.byte_size) / 1024)} KB`;
    message.mediaState = "ready";
  }
  return message;
}

async function run({ tenantId, conversationId, messageId }) {
  if (!mediaEnabled())
    throw fail(503, "Media storage isn't set up yet. An administrator can finish it under Team, then System.");
  const { rows } = await query(
    `SELECT m.id,m.type,m.provider_message_id,c.session_name,c.provider_chat_id
       FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.id=$1 AND m.tenant_id=$2 AND m.conversation_id=$3`,
    [messageId, tenantId, conversationId],
  );
  const m = rows[0];
  if (!m) throw fail(404, "Message not found");
  if (!MEDIA_MESSAGE_TYPES.has(m.type)) throw fail(400, "This message has no file");
  const saved = await query(
    "SELECT 1 FROM attachments WHERE tenant_id=$1 AND message_id=$2 AND upload_status='ready'",
    [tenantId, messageId],
  );
  if (saved.rowCount) return viewOf(tenantId, messageId);
  if (!m.provider_message_id) throw fail(409, "This message was not received from WhatsApp, so there is nothing to load.");

  let media;
  try {
    media = await inLane(`${tenantId}:${m.session_name}`, () =>
      provider.fetchMedia(tenantId, m.session_name, m.provider_message_id, m.provider_chat_id),
    );
  } catch (error) {
    throw explain(error);
  }
  validateMedia(media.mime, media.size);
  validateContent(media.buffer, media.mime);
  const stored = await storeIncoming(tenantId, media.buffer, media.mime);
  await query(
    `INSERT INTO attachments(id,tenant_id,conversation_id,message_id,storage_key,original_name,mime_type,byte_size,upload_status)
     SELECT $1::varchar,$2::varchar,$3::varchar,$4::varchar,$5::varchar,$6::varchar,$7::varchar,$8::bigint,'ready'
      WHERE NOT EXISTS (SELECT 1 FROM attachments WHERE tenant_id=$2::varchar AND message_id=$4::varchar AND upload_status='ready')`,
    [
      crypto.randomUUID(),
      tenantId,
      conversationId,
      messageId,
      stored.key,
      media.fileName || `${m.type}-${String(m.provider_message_id).slice(-6)}`,
      stored.mime,
      stored.bytes,
    ],
  );
  return viewOf(tenantId, messageId);
}

// Two people opening the same file at once share one download.
export function fetchMessageMedia(args) {
  const key = `${args.tenantId}:${args.messageId}`;
  if (inflight.has(key)) return inflight.get(key);
  const work = run(args).finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

// A small batch of a chat's unsaved files, newest first. `before` continues where the last batch stopped,
// so a file that cannot be loaded is reported once and not retried in the same run.
export async function fetchPendingMedia({ tenantId, conversationId, limit = 6, before = null }) {
  const size = Math.min(Math.max(Number(limit) || 6, 1), 10);
  const params = [tenantId, conversationId, MEDIA_TYPE_LIST];
  let cursor = "";
  if (before) {
    const [epoch, id] = String(before).split(":");
    if (!id || !Number.isFinite(Number(epoch))) throw fail(400, "Invalid cursor");
    params.push(Number(epoch), id);
    cursor = " AND (m.timestamp_epoch,m.id)<($4,$5)";
  }
  const { rows } = await query(
    `SELECT m.id,m.timestamp_epoch FROM messages m
      WHERE m.tenant_id=$1 AND m.conversation_id=$2 AND m.type=ANY($3) AND m.provider_message_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id=m.id AND a.tenant_id=$1 AND a.upload_status='ready')${cursor}
      ORDER BY m.timestamp_epoch DESC, m.id DESC LIMIT ${size + 1}`,
    params,
  );
  const batch = rows.slice(0, size);
  let saved = 0,
    stopped = null,
    last = null;
  const failed = [];
  for (const row of batch) {
    last = row;
    try {
      await fetchMessageMedia({ tenantId, conversationId, messageId: row.id });
      saved++;
    } catch (error) {
      failed.push({ messageId: row.id, reason: error.message });
      // Nothing more can load while the number is offline or storage is not ready.
      if ([409, 503].includes(error.status)) {
        stopped = error.message;
        break;
      }
    }
    await sleep(150);
  }
  return {
    saved,
    failed,
    stopped,
    remaining: await countPendingMedia(tenantId, conversationId),
    nextBefore: !stopped && rows.length > size && last ? `${last.timestamp_epoch}:${last.id}` : null,
  };
}
