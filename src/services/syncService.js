import { query } from "../db/index.js";
import { ENV } from "../config/env.js";
import { defaultWhatsAppProvider as provider } from "./whatsapp/WhatsAppProvider.js";
import { syncConversations } from "./conversationService.js";
import { handleIncomingMessage, adoptMisfiledMessages } from "./messageService.js";
import { syncContacts } from "../routes/contactRoutes.js";
import { emitForSession } from "./realtime.js";

// How much history each pass pulls. Live messages already arrive instantly; this only
// fills the first-time view and repairs anything missed while the server was away.
const LIMITS = {
  initial: { chats: 40, messages: 30 },
  reconcile: { chats: 25, messages: 20 },
};
const PAUSE_MS = 200; // be gentle with the WhatsApp browser
const running = new Set();
let timer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mode "auto": a session with no chats yet gets the first-time backfill, otherwise only
// chats that changed since we last looked are refreshed.
export async function syncSession({ tenantId, sessionName, io = null, mode = "auto" }) {
  const key = `${tenantId}:${sessionName}`;
  if (running.has(key)) return { skipped: true };
  running.add(key);
  const progress = (phase, done = 0, total = 0, extra = {}) =>
    emitForSession(io, tenantId, sessionName, "sync:progress", {
      sessionName,
      phase,
      done,
      total,
      ...extra,
    });
  try {
    const known = new Map(
      (
        await query(
          "SELECT provider_chat_id,last_active_epoch FROM conversations WHERE tenant_id=$1 AND session_name=$2",
          [tenantId, sessionName],
        )
      ).rows.map((r) => [r.provider_chat_id, Number(r.last_active_epoch)]),
    );
    const kind = mode === "auto" ? (known.size ? "reconcile" : "initial") : mode;
    const { chats: chatLimit, messages: messageLimit } = LIMITS[kind];
    progress("chats");

    const remote = await provider.syncConversations(tenantId, sessionName);
    await syncConversations({ tenantId, sessionName, io, remote });
    if (kind === "initial") await syncContacts(tenantId, sessionName).catch((e) => console.error("Contact sync:", e.message));

    const pending = remote
      .filter((c) => !known.has(c.id) || c.lastActiveEpoch > known.get(c.id))
      .sort((a, b) => b.lastActiveEpoch - a.lastActiveEpoch)
      .slice(0, chatLimit);
    let done = 0;
    for (const chat of pending) {
      progress("messages", done, pending.length);
      try {
        const history = await provider.getHistory(tenantId, sessionName, chat.id, messageLimit);
        const target = await query(
          "SELECT id FROM conversations WHERE tenant_id=$1 AND session_name=$2 AND provider_chat_id=$3",
          [tenantId, sessionName, chat.id],
        );
        if (target.rows[0])
          await adoptMisfiledMessages({
            tenantId,
            sessionName,
            conversationId: target.rows[0].id,
            providerMessageIds: history.map((m) => m.providerMessageId),
          });
        // Oldest first so the conversation preview ends on the newest message.
        for (const msg of history.sort((a, b) => a.timestampEpoch - b.timestampEpoch))
          await handleIncomingMessage({ tenantId, sessionName, msg, history: true });
      } catch (error) {
        console.error(`History sync for ${chat.id} failed:`, error.message);
      }
      done++;
      await sleep(PAUSE_MS);
    }
    progress("done", done, pending.length, { kind });
    return { kind, chats: remote.length, backfilled: done };
  } catch (error) {
    console.error(`Sync for ${sessionName} failed:`, error.message, process.env.SYNC_DEBUG ? error.stack : "");
    progress("failed", 0, 0, { message: "Sync will retry automatically" });
    return { failed: true };
  } finally {
    running.delete(key);
  }
}

// Called when a phone connects: wait a moment for WhatsApp Web to finish loading.
export function scheduleSync({ tenantId, sessionName, io, delayMs = 3000 }) {
  const t = setTimeout(() => void syncSession({ tenantId, sessionName, io }), delayMs);
  t.unref?.();
}

// Safety net: every few minutes, repair anything the live feed missed.
export function startReconcileLoop(io) {
  if (!ENV.SYNC_RECONCILE_MS) return;
  timer = setInterval(async () => {
    for (const s of [...provider.sessions.values()]) {
      if (s.status === "CONNECTED" && s.client)
        await syncSession({ tenantId: s.tenantId, sessionName: s.sessionName, io, mode: "reconcile" });
    }
  }, ENV.SYNC_RECONCILE_MS);
  timer.unref();
}
export const stopReconcileLoop = () => clearInterval(timer);
