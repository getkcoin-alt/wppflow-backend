import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { ENV } from "../../config/env.js";
import { query, withTransaction } from "../../db/index.js";
import { defaultWhatsAppProvider as provider } from "../whatsapp/WhatsAppProvider.js";
import { handleAckEvent } from "../messageService.js";
let redis,
  queue,
  worker,
  timer,
  busy = false,
  closing = false;
export function queueHealth() {
  return {
    connected: Boolean(queue) && redis?.status === "ready",
    pendingDispatcher: Boolean(timer),
  };
}
export async function dispatchMessage(payload, io) {
  const {
    tenantId,
    sessionName,
    messageId,
    conversationId,
    to,
    text,
    type,
    attachmentId,
    campaignId,
  } = payload;
  const claimed = await withTransaction(async (c) => {
    let campaignDelay;
    if (campaignId) {
      const camp = await c.query(
        "SELECT anti_ban_delay_seconds FROM campaigns WHERE id=$1 AND tenant_id=$2 AND status='running' FOR SHARE",
        [campaignId, tenantId],
      );
      if (!camp.rowCount) return false;
      campaignDelay = Math.max(4, camp.rows[0].anti_ban_delay_seconds || 4);
      const eligible = await c.query(
        `SELECT 1 FROM campaign_recipients r JOIN consents x ON x.tenant_id=r.tenant_id AND x.phone=r.phone AND x.opt_in_status=true WHERE r.tenant_id=$1 AND r.campaign_id=$2 AND r.message_id=$3 AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.tenant_id=r.tenant_id AND s.phone=r.phone)`,
        [tenantId, campaignId, messageId],
      );
      if (!eligible.rowCount) {
        await c.query(
          "UPDATE messages SET status='failed',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='sending'",
          [messageId, tenantId],
        );
        await c.query(
          "UPDATE outbox_events SET status='cancelled',last_error='Recipient no longer eligible' WHERE aggregate_id=$1 AND tenant_id=$2",
          [messageId, tenantId],
        );
        return false;
      }
    }
    const lock = await c.query(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok",
      [`dispatch:${tenantId}:${sessionName}`],
    );
    if (!lock.rows[0].ok) return false;
    const inFlight = await c.query(
      "SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.tenant_id=$1 AND c.session_name=$2 AND m.status='dispatching'",
      [tenantId, sessionName],
    );
    if (inFlight.rowCount) return false;
    if (campaignId) {
      const session = await c.query(
        "SELECT next_send_at FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2 FOR UPDATE",
        [tenantId, sessionName],
      );
      if (
        !session.rowCount ||
        new Date(session.rows[0].next_send_at) > new Date()
      )
        return false;
    }
    const result = await c.query(
      "UPDATE messages SET status='dispatching',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='sending' RETURNING id",
      [messageId, tenantId],
    );
    if (!result.rowCount) return false;
    if (campaignId)
      await c.query(
        "UPDATE whatsapp_sessions SET next_send_at=now()+make_interval(secs=>$3) WHERE tenant_id=$1 AND session_name=$2",
        [tenantId, sessionName, campaignDelay],
      );
    await c.query(
      "UPDATE outbox_events SET status='dispatching' WHERE aggregate_id=$1 AND tenant_id=$2",
      [messageId, tenantId],
    );
    return true;
  });
  if (!claimed) return;
  let result;
  try {
    result = attachmentId
      ? await provider.sendAttachment(
          tenantId,
          sessionName,
          to,
          attachmentId,
          type,
          text,
        )
      : await provider.sendTextMessage(tenantId, sessionName, to, text);
    if (!result?.providerMessageId) {
      const e = new Error("Provider did not confirm delivery");
      e.code = "DELIVERY_UNCERTAIN";
      throw e;
    }
    await withTransaction(async (c) => {
      // A provider echo can arrive before the send promise resolves. Merge by provider identity.
      const echo = await c.query(
        "SELECT id,ack FROM messages WHERE tenant_id=$1 AND provider_message_id=$2 AND id<>$3 FOR UPDATE",
        [tenantId, result.providerMessageId, messageId],
      );
      const ack = Math.max(0, result.ack ?? 0, echo.rows[0]?.ack || 0);
      if (echo.rows[0]) {
        await c.query(
          "UPDATE message_receipts SET message_id=$1 WHERE message_id=$2 AND tenant_id=$3",
          [messageId, echo.rows[0].id, tenantId],
        );
        await c.query("DELETE FROM messages WHERE id=$1 AND tenant_id=$2", [
          echo.rows[0].id,
          tenantId,
        ]);
      }
      await c.query(
        "UPDATE messages SET provider_message_id=$1,ack=$2,status=CASE WHEN $2>=3 THEN 'read' WHEN $2=2 THEN 'delivered' WHEN $2=1 THEN 'sent' ELSE 'sending' END,updated_at=now() WHERE id=$3 AND tenant_id=$4",
        [result.providerMessageId, ack, messageId, tenantId],
      );
      await c.query(
        "UPDATE outbox_events SET status='processed',processed_at=now() WHERE aggregate_id=$1 AND tenant_id=$2",
        [messageId, tenantId],
      );
    });
    const early = await query(
      "DELETE FROM early_receipts WHERE tenant_id=$1 AND provider_message_id=$2 RETURNING ack",
      [tenantId, result.providerMessageId],
    );
    if (early.rows[0])
      await handleAckEvent({
        tenantId,
        ackData: {
          providerMessageId: result.providerMessageId,
          ack: early.rows[0].ack,
        },
        io,
      });
    const saved = await query(
      "SELECT status,ack FROM messages WHERE id=$1 AND tenant_id=$2",
      [messageId, tenantId],
    );
    io?.to(`tenant:${tenantId}`).emit("message:updated", {
      conversationId,
      chatId: conversationId,
      messageId,
      providerMessageId: result.providerMessageId,
      ...saved.rows[0],
    });
  } catch (error) {
    const offline = error.code === "SESSION_OFFLINE";
    await query(
      "UPDATE messages SET status=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3",
      [offline ? "sending" : "uncertain", messageId, tenantId],
    );
    await query(
      "UPDATE outbox_events SET status=$1,last_error=$2,retry_at=now()+interval '10 seconds' WHERE aggregate_id=$3 AND tenant_id=$4",
      [offline ? "pending" : "uncertain", error.message, messageId, tenantId],
    );
    io?.to(`tenant:${tenantId}`).emit("message:updated", {
      conversationId,
      messageId,
      status: offline ? "sending" : "uncertain",
      ack: 0,
    });
  }
}
export async function publishOutbox() {
  if (busy || !queue || redis?.status !== "ready") return;
  busy = true;
  try {
    await recoverInterruptedDispatches();
    const { rows } = await query(
      "SELECT id,payload FROM outbox_events WHERE status IN ('pending','queued') AND event_type='message.outgoing' AND retry_at<=now() ORDER BY id LIMIT 100",
    );
    for (const row of rows) {
      if (
        !provider.getSession(row.payload.tenantId, row.payload.sessionName)
          ?.client
      )
        continue;
      await queue.add("send", row.payload, {
        jobId: row.payload.messageId,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      });
      await query(
        "UPDATE outbox_events SET status='queued',retry_at=now()+interval '10 seconds' WHERE id=$1 AND status IN ('pending','queued')",
        [row.id],
      );
    }
  } finally {
    busy = false;
  }
}
export async function initMessageQueue(io) {
  // A crash after provider dispatch must not trigger an automatic resend.
  await recoverInterruptedDispatches();
  closing = false;
  redis = new IORedis(ENV.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    retryStrategy: (n) => (closing ? null : Math.min(n * 500, 10000)),
    connectTimeout: 2000,
    enableOfflineQueue: false,
  });
  redis.on("error", () => {});
  redis.on("ready", () => {
    if (queue || closing) return;
    queue = new Queue("whatsapp-outgoing-messages", { connection: redis });
    worker = new Worker(
      "whatsapp-outgoing-messages",
      (job) => dispatchMessage(job.data, io),
      { connection: redis, concurrency: 5 },
    );
    worker.on("error", (e) => console.error("Message worker:", e.message));
    queue.on("error", (e) => console.error("Message queue:", e.message));
  });
  void redis
    .connect()
    .catch(() =>
      console.warn(
        "Redis unavailable; outgoing work remains persisted until reconnection.",
      ),
    );
  timer = setInterval(
    () =>
      publishOutbox().catch((e) =>
        console.error("Outbox dispatcher:", e.message),
      ),
    2000,
  );
  timer.unref();
}
export async function recoverInterruptedDispatches() {
  await query(`UPDATE messages m SET status='uncertain' FROM conversations c WHERE m.conversation_id=c.id AND m.status='dispatching' AND m.updated_at<now()-interval '2 minutes'
    AND NOT EXISTS(SELECT 1 FROM whatsapp_sessions s WHERE s.tenant_id=m.tenant_id AND s.session_name=c.session_name AND s.lease_until>now())`);
  await query(
    "UPDATE outbox_events o SET status='uncertain' FROM messages m WHERE m.id=o.aggregate_id AND m.tenant_id=o.tenant_id AND m.status='uncertain' AND o.status='dispatching'",
  );
}
export async function closeQueue(force = false) {
  closing = true;
  clearInterval(timer);
  timer = null;
  if (worker) await worker.close(force);
  if (queue) await queue.close();
  if (redis) redis.disconnect();
  queue = null;
  worker = null;
}
