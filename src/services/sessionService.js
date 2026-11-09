import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { ENV } from "../config/env.js";
import { defaultWhatsAppProvider as provider } from "./whatsapp/WhatsAppProvider.js";
import { handleIncomingMessage, handleAckEvent, handleRevokedMessage } from "./messageService.js";
import { fail } from "../middleware/http.js";
import { emitForSession } from "./realtime.js";
import { scheduleSync } from "./syncService.js";
import { notifySessionLost } from "./notificationService.js";
import { isLapsed, entitledPlan } from "./plans.js";
import { recordSessionEvent } from "./sessionEvents.js";
// What the person pairing a number sees: plain language, never server file paths.
export function friendlyStartError(error) {
  const message = String(error?.message || error || "");
  if (/already running/i.test(message))
    return "The previous connection for this number was still shutting down. Please try again.";
  return message.replace(/(?:\/[\w.@:+-]+){2,}\/?/g, "…").slice(0, 300);
}
// Shown on the number when it was linked (or logged in) but WhatsApp had not finished loading its chats when the time limit ran out.
const DEVICE_SYNC_MESSAGE =
  "WhatsApp had not finished loading this number's chats when the waiting time ran out. Keep the phone unlocked with WhatsApp open, then press Reconnect; a phone with a lot of chats can take several minutes.";
const workerId = crypto.randomUUID(),
  owned = new Map();
let recoveryTimer;
let recovering = false;
// numbers whose connection to WhatsApp dropped: key -> the timer that restarts the browser if it does not come back
const streamTimers = new Map();
// numbers being restarted right now, so that two causes (a failed check and a dropped stream) do not restart one twice
const restarting = new Set();
// resolves with `fallback` when `promise` takes longer than `ms`; the timer never keeps the process alive
const within = (promise, ms, fallback) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
};
const clearStreamTimer = (key) => {
  clearTimeout(streamTimers.get(key));
  streamTimers.delete(key);
};
// What the database remembers when a number changes state: the status itself, the pairing, since when it has been
// connected or down, and the counters of the number-health screen that a successful connection resets.
export function saveSessionStatus({ tenantId, sessionName, workerId: ownerWorker, status, phone }) {
  return query(
    `UPDATE whatsapp_sessions SET status=$1::varchar,phone=COALESCE($2,phone),qr_code=CASE WHEN $1::varchar='QRCODE' THEN qr_code ELSE NULL END,
            restore_on_start=CASE WHEN $1::varchar='CONNECTED' AND COALESCE($2,phone) IS NOT NULL THEN true ELSE restore_on_start END,
            last_error=CASE WHEN $1::varchar='CONNECTED' THEN NULL WHEN $1::varchar='EXPIRED' THEN 'The QR code was not scanned in time. Start again and scan it within a few minutes.' ELSE last_error END,
            connected_since=CASE WHEN $1::varchar<>'CONNECTED' THEN NULL WHEN status='CONNECTED' THEN COALESCE(connected_since,now()) ELSE now() END,
            down_since=CASE WHEN $1::varchar='CONNECTED' THEN NULL WHEN status='CONNECTED' THEN now() ELSE down_since END,
            reconnect_attempts=CASE WHEN $1::varchar='CONNECTED' THEN 0 ELSE reconnect_attempts END,
            heartbeat_failures=CASE WHEN $1::varchar='CONNECTED' THEN 0 ELSE heartbeat_failures END,
            heartbeat_error=CASE WHEN $1::varchar='CONNECTED' THEN NULL ELSE heartbeat_error END,
            updated_at=now() WHERE tenant_id=$3 AND session_name=$4 AND worker_id=$5`,
    [status, phone, tenantId, sessionName, ownerWorker],
  );
}
export function validateSession(value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(value)
  )
    throw fail(
      400,
      "Session name must contain 1–40 letters, digits, underscores or dashes",
    );
  return value;
}

// How long a number that is down, and has failed to come back, is left alone before the next try: nothing before the first,
// then 30 s, 1 min, 2 min ... up to 10 min. Without it a number that cannot start (a damaged profile, a phone that is off) launches a
// browser every 30 seconds for ever.
export function retryDelayMs(attempts, { base = ENV.SESSION_RETRY_BASE_MS, max = ENV.SESSION_RETRY_MAX_MS } = {}) {
  if (!(attempts > 0)) return 0;
  return Math.min(max, base * 2 ** Math.min(attempts - 1, 20));
}
// 0.9 to 1.1, the same for the same number, so that numbers that failed together do not all retry in the same second.
const spread = (name) => 0.9 + (parseInt(crypto.createHash("sha1").update(String(name)).digest("hex").slice(0, 4), 16) / 65535) * 0.2;

// The number's claim on the database row: renewed on a timer. A failed renewal is almost always the database being busy (every
// connection in use) or restarting, not the number being unwell, so the browser is kept and the renewal tried again. Closing a healthy
// browser here forced a relaunch, and a browser that is killed at the wrong moment can lose WhatsApp's login. A number is let go only
// if renewals keep failing for the whole grace period, or if the claim is really held by someone else now.
function keepClaim({ tenantId, sessionName, key }) {
  let failingSince = 0;
  let reported = false;
  const tick = async () => {
    let result;
    try {
      result = await query(
        "UPDATE whatsapp_sessions SET lease_until=now()+interval '45 seconds' WHERE tenant_id=$1 AND session_name=$2 AND worker_id=$3",
        [tenantId, sessionName, workerId],
      );
    } catch (error) {
      failingSince ||= Date.now();
      if (!reported) {
        reported = true;
        console.warn(`Could not renew the claim on ${sessionName} (${error.message}); the number keeps running`);
        recordSessionEvent({ tenantId, sessionName, event: "claim_error", cause: "database", detail: error.message, workerId });
      }
      if (Date.now() - failingSince >= ENV.SESSION_LEASE_GRACE_MS) {
        clearInterval(timer);
        if (owned.get(key) === timer) owned.delete(key);
        clearStreamTimer(key);
        console.warn(`The claim on ${sessionName} could not be renewed for ${Math.round(ENV.SESSION_LEASE_GRACE_MS / 1000)} s; letting the number go`);
        await recordSessionEvent({ tenantId, sessionName, event: "claim_released", cause: "database_unavailable", workerId });
        await provider.closeSession(tenantId, sessionName).catch(() => {});
      }
      return;
    }
    if (failingSince) {
      console.warn(`The claim on ${sessionName} is being renewed again`);
      failingSince = 0;
      reported = false;
    }
    if (!result.rowCount) {
      // Another worker holds the number now (or it was removed): let the browser go, and leave the row to whoever owns it.
      clearInterval(timer);
      if (owned.get(key) === timer) owned.delete(key);
      clearStreamTimer(key);
      await provider.closeSession(tenantId, sessionName).catch(() => {});
      await recordSessionEvent({ tenantId, sessionName, event: "claim_lost", cause: "another_worker", workerId });
    }
  };
  const timer = setInterval(() => {
    tick().catch((error) => console.error("Claim renewal:", error.message));
  }, ENV.SESSION_LEASE_TICK_MS);
  timer.unref();
  return timer;
}

// What WhatsApp itself reports about the connection (see WhatsAppProvider: onStateChange). Every report is kept; two are acted on.
async function onWhatsAppState({ tenantId, sessionName, key, io, state, current }) {
  const word = String(state || "").toUpperCase();
  if (!word || !current()) return;
  await recordSessionEvent({ tenantId, sessionName, event: "whatsapp_state", cause: word, workerId });
  if (word === "CONFLICT") {
    // "WhatsApp is open in another window". Taking the number back ("Use here") keeps it connected; ignoring it ends in a drop.
    const took = await provider.useHere(tenantId, sessionName).catch((error) => {
      console.warn(`WhatsApp ${sessionName}: could not take the number back: ${error.message}`);
      return false;
    });
    await recordSessionEvent({ tenantId, sessionName, event: "conflict", cause: took ? "took_back" : "could_not_take_back", workerId });
  } else if (word === "UNPAIRED" || word === "UNPAIRED_IDLE") {
    // The phone logged this device out (or WhatsApp did). Starting it again would only show a QR code nobody is there to scan,
    // so it is not restored; the owner is told what to do.
    clearInterval(owned.get(key));
    owned.delete(key);
    clearStreamTimer(key);
    await provider.closeSession(tenantId, sessionName).catch(() => {});
    await saveSessionStatus({ tenantId, sessionName, workerId, status: "EXPIRED", phone: null });
    await query(
      "UPDATE whatsapp_sessions SET worker_id=NULL,lease_until=NULL,restore_on_start=false,last_error=$3 WHERE tenant_id=$1 AND session_name=$2 AND worker_id=$4",
      [tenantId, sessionName, "WhatsApp unlinked this number (it was logged out from the phone). Scan the QR code again to link it.", workerId],
    );
    await recordSessionEvent({ tenantId, sessionName, event: "unlinked", cause: "whatsapp_unpaired", workerId });
    notifySessionLost({ io, tenantId, sessionName, status: "EXPIRED" }).catch((e) => console.error("Session notification failed:", e.message));
    emitForSession(io, tenantId, sessionName, "session:status", { session: sessionName, sessionName, status: "EXPIRED", phone: null });
  }
}

// The stream between the browser and WhatsApp's servers. It drops and comes back by itself all the time; when it has not come back
// within STREAM_DOWN_RESTART_MS the page is stuck, and restarting the browser (from its saved login: no QR code) fixes it.
async function onWhatsAppStream({ tenantId, sessionName, key, io, state, current }) {
  const word = String(state || "").toUpperCase();
  if (!word || !current()) return;
  const waiting = streamTimers.has(key);
  clearStreamTimer(key);
  if (word === "DISCONNECTED") {
    await recordSessionEvent({ tenantId, sessionName, event: "stream_down", cause: "whatsapp", workerId });
    const timer = setTimeout(() => {
      streamTimers.delete(key);
      if (!current()) return;
      restartTenantSession(tenantId, sessionName, io, { cause: "stream_down" }).catch((error) => console.error(`Restart of ${sessionName} failed:`, error.message));
    }, ENV.STREAM_DOWN_RESTART_MS);
    timer.unref?.();
    streamTimers.set(key, timer);
  } else if (word === "CONNECTED" && waiting) {
    await recordSessionEvent({ tenantId, sessionName, event: "stream_up", cause: "came_back_by_itself", workerId });
  }
}

// `wait` (used when many numbers are brought back at once): the returned promise settles when the number's browser is up (connected,
// showing its QR code, or failed), so that only a few browsers launch at the same time. `reason` is who asked, kept in the history.
export async function startTenantSession(
  tenantId,
  sessionName,
  io,
  ownerUserId = null,
  { wait = false, reason = "user" } = {},
) {
  validateSession(sessionName);
  const key = `${tenantId}:${sessionName}`;
  if (owned.has(key)) {
    if (
      ["CONNECTED", "STARTING", "QRCODE", "AUTHENTICATING"].includes(
        provider.getSession(tenantId, sessionName)?.status,
      )
    )
      return;
    await closeTenantSession(tenantId, sessionName, io, true, "stale");
  }
  await withTransaction(async (c) => {
    const tenant = await c.query(
      "SELECT sessions_limit,status,plan,period_end,scheduled_plan FROM tenants WHERE id=$1 FOR UPDATE",
      [tenantId],
    );
    if (!tenant.rows[0]) throw fail(404, "Workspace not found");
    if (tenant.rows[0].status !== "active")
      throw fail(403, "This company workspace is suspended");
    const exists = await c.query(
      "SELECT id,worker_id,lease_until FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2 FOR UPDATE",
      [tenantId, sessionName],
    );
    if (
      exists.rows[0]?.worker_id &&
      exists.rows[0].worker_id !== workerId &&
      new Date(exists.rows[0].lease_until) > new Date()
    )
      throw fail(409, "Session is owned by another worker");
    const count = await c.query(
      "SELECT count(*)::int AS count FROM whatsapp_sessions WHERE tenant_id=$1",
      [tenantId],
    );
    // Past the grace period, the plan it pays for is not in force: the numbers it has keep working, no new one is added.
    const limit = isLapsed(tenant.rows[0]) ? Math.min(tenant.rows[0].sessions_limit, entitledPlan(tenant.rows[0]).numbers ?? 1) : tenant.rows[0].sessions_limit;
    if (!exists.rowCount && count.rows[0].count >= limit)
      throw fail(
        403,
        isLapsed(tenant.rows[0]) ? "Payment for your plan is overdue, so no new number can be linked. Pay the invoice or message the Scriwo team." : "Session quota reached",
      );
    await c.query(
      `INSERT INTO whatsapp_sessions(id,tenant_id,session_name,status,worker_id,lease_until,owner_user_id,restore_on_start) VALUES($1,$2,$3,'STARTING',$4,now()+interval '45 seconds',$5,false)
      ON CONFLICT(tenant_id,session_name) DO UPDATE SET status='STARTING',last_error=NULL,worker_id=$4,lease_until=now()+interval '45 seconds',owner_user_id=COALESCE(whatsapp_sessions.owner_user_id,$5),updated_at=now()`,
      [crypto.randomUUID(), tenantId, sessionName, workerId, ownerUserId],
    );
  });
  if (owned.has(key)) return;
  let launched;
  const launch = new Promise((resolve) => {
    launched = resolve;
  });
  const claim = keepClaim({ tenantId, sessionName, key });
  owned.set(key, claim);
  // Events from a browser that has since been replaced (a restart, a cancelled pairing) are about a number that is no longer this
  // one: acting on them would take the new browser's claim and status away.
  const current = () => owned.get(key) === claim;
  // not awaited: the browser must be launching in this same tick (a second request that arrives now must find a number that is
  // starting, not one with nothing yet); the events that follow wait for it so that the history stays in order
  const startRecorded = recordSessionEvent({ tenantId, sessionName, event: "start", cause: reason, workerId });
  let connectedRecorded = false;
  provider
    .startSession(tenantId, sessionName, {
      onQr: async (qrcode) => {
        launched();
        if (!current()) return;
        await query(
          "UPDATE whatsapp_sessions SET qr_code=$1 WHERE tenant_id=$2 AND session_name=$3 AND worker_id=$4",
          [qrcode, tenantId, sessionName, workerId],
        );
        emitForSession(io, tenantId, sessionName, "session:qr", {
          session: sessionName,
          sessionName,
          qrcode,
        });
      },
      onStatus: async (status, cause) => {
        try {
          await startRecorded;
          if (!current()) return;
          const phone = provider.getSession(tenantId, sessionName)?.phone || null;
          await saveSessionStatus({ tenantId, sessionName, workerId, status, phone });
          if (status === "CONNECTED" && !connectedRecorded) {
            connectedRecorded = true;
            await recordSessionEvent({ tenantId, sessionName, event: "connected", cause: reason, workerId });
          }
          if (["DISCONNECTED", "EXPIRED"].includes(status)) {
            // A drop we did not ask for (phone offline, logged out, browser died). A deliberate close (a "disconnect" click, a
            // restart, the server stopping) removes the number from `owned` first, so its late report returned above.
            clearInterval(claim);
            owned.delete(key);
            clearStreamTimer(key);
            connectedRecorded = false;
            await recordSessionEvent({
              tenantId,
              sessionName,
              event: status === "EXPIRED" ? "expired" : "disconnected",
              cause: cause || "unexpected",
              workerId,
            });
            query(
              "SELECT 1 FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2 AND phone IS NOT NULL",
              [tenantId, sessionName],
            )
              .then(({ rowCount }) =>
                rowCount && notifySessionLost({ io, tenantId, sessionName, status }),
              )
              .catch((e) => console.error("Session notification failed:", e.message));
            // A number that was linked but whose chats had not finished loading is started again from its saved login, which needs no
            // new scan (a new scan would add another linked device to the phone), a few times before a person is asked to step in.
            const syncTimeout = cause === "device_sync_timeout";
            await query(
              `UPDATE whatsapp_sessions SET worker_id=NULL,lease_until=NULL,
                 restore_on_start=(($3::boolean AND phone IS NOT NULL) OR ($5::boolean AND reconnect_attempts < 3)),
                 last_error=CASE WHEN $5::boolean THEN $6::text ELSE last_error END
               WHERE tenant_id=$1 AND session_name=$2 AND worker_id=$4`,
              [tenantId, sessionName, status !== "EXPIRED", workerId, syncTimeout, DEVICE_SYNC_MESSAGE],
            );
          }
          emitForSession(io, tenantId, sessionName, "session:status", {
            session: sessionName,
            sessionName,
            status,
            phone,
          });
          // A freshly paired (or re-connected) phone fills the inbox without any button.
          if (status === "CONNECTED" && phone)
            scheduleSync({ tenantId, sessionName, io });
        } finally {
          // the lane that is bringing numbers back moves on to the next one only once this one's state has been saved
          if (status !== "STARTING") launched();
        }
      },
      onState: (state) => onWhatsAppState({ tenantId, sessionName, key, io, state, current }),
      onStream: (state) => onWhatsAppStream({ tenantId, sessionName, key, io, state, current }),
      onMessage: (msg) =>
        handleIncomingMessage({ tenantId, sessionName, msg, io }).catch((e) =>
          console.error("Message event failed:", e.message),
        ),
      onAck: (ackData) =>
        handleAckEvent({ tenantId, ackData, io }).catch((e) =>
          console.error("Receipt event failed:", e.message),
        ),
      onRevokedMessage: (revokedData) =>
        handleRevokedMessage({ tenantId, sessionName, revokedData, io }).catch((e) =>
          console.error("Revoked event failed:", e.message),
        ),
    })
    .catch(async (error) => {
      // Cancelled on purpose: the canceller cleaned up, and a newer start may own this session now.
      if (error?.code === "SESSION_CANCELLED") return;
      if (!current()) {
        // A newer start owns this number: its failure is not this one's business. If nobody does, this start's drop was already handled
        // by a status report (a timeout, for one), and the library has left its browser running: make sure it is gone.
        if (owned.has(key)) return console.warn(`A replaced start of ${sessionName} failed (${error.message}); ignored`);
        await provider.closeSession(tenantId, sessionName).catch(() => {});
        return;
      }
      clearInterval(claim);
      owned.delete(key);
      clearStreamTimer(key);
      await provider.closeSession(tenantId, sessionName);
      await query(
        "UPDATE whatsapp_sessions SET status='FAILED',worker_id=NULL,lease_until=NULL,qr_code=NULL WHERE tenant_id=$1 AND session_name=$2 AND worker_id=$3",
        [tenantId, sessionName, workerId],
      );
      // Keep the cause so the person pairing sees why, not just "failed".
      await query(
        "UPDATE whatsapp_sessions SET last_error=COALESCE(last_error,$3) WHERE tenant_id=$1 AND session_name=$2 AND status<>'CONNECTED'",
        [tenantId, sessionName, friendlyStartError(error)],
      );
      await recordSessionEvent({ tenantId, sessionName, event: "failed", cause: "start_failed", detail: friendlyStartError(error), workerId });
      emitForSession(io, tenantId, sessionName, "session:status", {
        session: sessionName,
        status: "FAILED",
      });
      console.error("Session start failed:", error.message);
    })
    .catch((error) => console.error("Session failure cleanup:", error.message))
    .finally(() => launched());
  if (wait) await within(launch, ENV.SESSION_LAUNCH_TIMEOUT_MS);
}
// Permanently remove a number: unlink it from the phone, stop the browser, delete the saved
// login and forget the session. Inbox history is kept.
export async function removeTenantSession(tenantId, sessionName, io, { cause = "removed_by_user", actorId = null } = {}) {
  const unlinked = await provider.logoutSession(tenantId, sessionName);
  await closeTenantSession(tenantId, sessionName, io, false, "removed");
  provider.deleteTokens(tenantId, sessionName);
  await query(
    "DELETE FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2",
    [tenantId, sessionName],
  );
  // The one way this server ever unlinks a phone. When a number vanishes from the phone's Linked devices, this record says whether
  // it was us (and who asked) or not.
  await recordSessionEvent({
    tenantId,
    sessionName,
    event: "removed",
    cause,
    detail: `${unlinked ? "unlinked from the phone" : "could not be unlinked from the phone"}${actorId ? `; asked by user ${actorId}` : ""}`,
    workerId,
  });
  return { unlinked };
}
export async function closeTenantSession(
  tenantId,
  sessionName,
  io,
  restore = false,
  cause = restore ? "restart" : "user",
) {
  const current = await query(
    "SELECT worker_id,lease_until FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2",
    [tenantId, sessionName],
  );
  if (
    current.rows[0]?.worker_id &&
    current.rows[0].worker_id !== workerId &&
    new Date(current.rows[0].lease_until) > new Date()
  )
    throw fail(
      409,
      "Session is running on another worker; close it on that worker",
    );
  const key = `${tenantId}:${sessionName}`;
  clearInterval(owned.get(key));
  owned.delete(key);
  clearStreamTimer(key);
  await provider.closeSession(tenantId, sessionName);
  await query(
    "UPDATE whatsapp_sessions SET status='DISCONNECTED',restore_on_start=$3,worker_id=NULL,lease_until=NULL,qr_code=NULL,updated_at=now() WHERE tenant_id=$1 AND session_name=$2 AND (worker_id=$4 OR worker_id IS NULL)",
    [tenantId, sessionName, restore, workerId],
  );
  // a number that is being deleted has no row left to hang the history on
  if (cause !== "removed") await recordSessionEvent({ tenantId, sessionName, event: "closed", cause, workerId });
  emitForSession(io, tenantId, sessionName, "session:status", {
    session: sessionName,
    sessionName,
    status: "DISCONNECTED",
  });
}

// Stops a number's browser and starts it again from its saved login (no QR code). For a browser that is stuck: the number's checks
// keep failing, or WhatsApp's connection to it dropped and did not come back. Not for a person's "disconnect", which stays stopped.
export async function restartTenantSession(tenantId, sessionName, io, { cause = "restart" } = {}) {
  const key = `${tenantId}:${sessionName}`;
  if (restarting.has(key)) return false;
  restarting.add(key);
  try {
    await recordSessionEvent({ tenantId, sessionName, event: "restart", cause, workerId });
    await closeTenantSession(tenantId, sessionName, io, true, cause);
    await startTenantSession(tenantId, sessionName, io, null, { reason: cause });
    return true;
  } finally {
    restarting.delete(key);
  }
}

// Brings back the numbers that are meant to be running but are not: the server was restarted, a browser died. At most
// SESSION_START_CONCURRENCY browsers launch at a time (all of them at once is a spike of memory and processor that makes some of the
// launches fail), and a number that keeps failing is retried less and less often (retryDelayMs).
export async function recoverSessions(io, { now = Date.now() } = {}) {
  if (recovering) return 0;
  recovering = true;
  try {
    const { rows } = await query(
      "SELECT tenant_id,session_name,reconnect_attempts,last_reconnect_at FROM whatsapp_sessions WHERE restore_on_start=true AND (lease_until IS NULL OR lease_until<now()) ORDER BY last_reconnect_at NULLS FIRST,created_at",
    );
    const due = rows.filter(
      (s) => !s.last_reconnect_at || now - new Date(s.last_reconnect_at).getTime() >= retryDelayMs(s.reconnect_attempts) * spread(s.session_name),
    );
    let next = 0;
    let started = 0;
    const lane = async () => {
      while (next < due.length) {
        const s = due[next++];
        // Every time the server brings a number back by itself is counted, so the health screen can say so.
        await query(
          "UPDATE whatsapp_sessions SET reconnect_attempts=reconnect_attempts+1,last_reconnect_at=now() WHERE tenant_id=$1 AND session_name=$2",
          [s.tenant_id, s.session_name],
        ).catch(() => {});
        await recordSessionEvent({
          tenantId: s.tenant_id,
          sessionName: s.session_name,
          event: "restore",
          cause: s.reconnect_attempts > 0 ? "retry" : "server_start_or_drop",
          detail: `attempt ${s.reconnect_attempts + 1}`,
          workerId,
        });
        await startTenantSession(s.tenant_id, s.session_name, io, null, { wait: true, reason: "restore" }).catch((e) =>
          console.error("Session recovery failed:", e.message),
        );
        started++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(ENV.SESSION_START_CONCURRENCY, due.length) }, lane));
    return started;
  } finally {
    recovering = false;
  }
}
// The first pass runs in the background: bringing every number back can take minutes, and the server must answer its health check
// (and be reachable) in the meantime.
export async function restoreSessions(io) {
  recoverSessions(io).catch((e) => console.error("Session recovery:", e.message));
  recoveryTimer = setInterval(
    () =>
      recoverSessions(io).catch((e) =>
        console.error("Session recovery:", e.message),
      ),
    ENV.SESSION_RECOVER_EVERY_MS,
  );
  recoveryTimer.unref();
}
// Stopping the server: every number is closed cleanly, all at once, within a time limit (SHUTDOWN_GRACE_MS). Closed one after another
// with no limit, the last numbers were still waiting when pm2 lost patience and killed the process, which left their browsers running
// to be killed at the next start, and a browser killed in the middle of a write can lose WhatsApp's login (a new QR code).
export async function closeSessions(io, { graceMs = ENV.SHUTDOWN_GRACE_MS } = {}) {
  clearInterval(recoveryTimer);
  for (const key of streamTimers.keys()) clearStreamTimer(key);
  const keys = [...owned.keys()];
  if (keys.length) console.log(`Closing ${keys.length} WhatsApp number(s) before stopping`);
  const closing = keys.map((key) => {
    const i = key.indexOf(":");
    return closeTenantSession(key.slice(0, i), key.slice(i + 1), io, true, "server_stop").catch((e) =>
      console.error(`Closing ${key.slice(i + 1)} failed:`, e.message),
    );
  });
  const finished = await within(Promise.allSettled(closing).then(() => true), graceMs, false);
  if (!finished) console.warn(`Not every number closed within ${Math.round(graceMs / 1000)} s; stopping anyway`);
  // whatever did not get to say goodbye still lets go of its claim, so that the next start can bring it back at once
  if (keys.length)
    await within(query("UPDATE whatsapp_sessions SET worker_id=NULL,lease_until=NULL WHERE worker_id=$1", [workerId]), 5000, null).catch(() => {});
}
