import { query } from "../db/index.js";
import { ENV } from "../config/env.js";
import { defaultWhatsAppProvider as provider } from "./whatsapp/WhatsAppProvider.js";
import { createNotifications } from "./notificationService.js";
import { restartTenantSession } from "./sessionService.js";
import { pruneSessionEvents } from "./sessionEvents.js";

// How each linked WhatsApp number is doing: whether it answers when asked, how long it has been connected or down,
// how many messages went wrong or are stuck, and who is told when it stays bad. Read by the Numbers screen, the
// platform console and the alert job.
export const THRESHOLDS = {
  heartbeatEverySeconds: 60,
  unresponsiveAfter: 3, // checks in a row that went unanswered: shown as a problem. The server restarts the number's browser by itself at this point
  alertAfter: 5, // ... and people are told only when that did not help (an alert about something already being fixed teaches them to ignore alerts)
  downMinutes: 30, // a linked number still not connected after this long
  failedSendsPerHour: 5,
  failedShare: 0.5, // of the sends in that hour
  stuckMinutes: 10, // a message waiting this long to leave
  alertCooldownHours: 6,
};
const SENT = ["sent", "delivered", "read"];
const WRONG = ["failed", "uncertain"];
const WAITING = ["sending", "dispatching"];

const span = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} seconds`;
  if (s < 5400) return `${Math.round(s / 60)} minutes`;
  if (s < 172800) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 86400)} days`;
};

// Everything below the line about one number, as plain statements. Pure so it can be tested without a database.
export function judge(r, nowMs = Date.now()) {
  const problems = [];
  const sec = (iso) => (iso ? Math.max(0, (nowMs - new Date(iso).getTime()) / 1000) : null);
  const connected = r.status === "CONNECTED";
  if (!r.phone) return { level: "unpaired", problems };
  if (!connected) {
    const down = sec(r.downSince);
    const trying = ["STARTING", "AUTHENTICATING"].includes(r.status);
    problems.push({
      code: "down",
      text:
        `${trying ? "Reconnecting" : "Not connected"}${down !== null ? ` for ${span(down)}` : ""}` +
        (r.reconnectAttempts > 0 ? `. The server has tried to bring it back ${r.reconnectAttempts} time${r.reconnectAttempts === 1 ? "" : "s"}` : "") +
        ".",
      alert: down !== null && down >= THRESHOLDS.downMinutes * 60,
      title: `${r.label} has been disconnected for ${span(down ?? 0)}`,
      body: "Open Numbers and scan the QR code again, or restart it, to bring it back.",
    });
  }
  if (connected && r.heartbeatFailures >= THRESHOLDS.unresponsiveAfter) {
    problems.push({
      code: "unresponsive",
      text: `Did not answer the last ${r.heartbeatFailures} checks${r.heartbeatError ? ` (${r.heartbeatError})` : ""}.`,
      alert: r.heartbeatFailures >= THRESHOLDS.alertAfter,
      title: `${r.label} stopped answering`,
      body: `WhatsApp did not respond to the last ${r.heartbeatFailures} checks, and restarting its browser automatically did not help. Open Numbers to see its health; if it stays like this, disconnect it and link it again.`,
    });
  }
  const f = r.sends.failedLastHour,
    t = r.sends.totalLastHour;
  if (f >= THRESHOLDS.failedSendsPerHour && t > 0 && f / t >= THRESHOLDS.failedShare) {
    problems.push({
      code: "failing",
      text: `${f} of the last ${t} messages sent in the past hour did not go through.`,
      alert: true,
      title: `Messages from ${r.label} are failing`,
      body: `${f} of ${t} sends in the last hour did not go through. Check that the phone is online and WhatsApp is open on it.`,
    });
  }
  if (r.queued.count > 0 && r.queued.oldestSeconds !== null && r.queued.oldestSeconds >= THRESHOLDS.stuckMinutes * 60) {
    problems.push({
      code: "stuck",
      text: `${r.queued.count} message${r.queued.count === 1 ? " has" : "s have"} been waiting to leave for ${span(r.queued.oldestSeconds)}.`,
      alert: true,
      title: `Messages are waiting on ${r.label}`,
      body: `${r.queued.count} message${r.queued.count === 1 ? " has" : "s have"} been waiting for ${span(r.queued.oldestSeconds)}. Open Numbers to check the connection.`,
    });
  }
  return { level: problems.some((p) => p.code === "down") ? "down" : problems.length ? "warn" : "ok", problems };
}

// What the API returns: the alert wording stays on the server.
export const numberHealthView = ({ alerts, ...rest }) => rest;

const labelOf = (name, ownerName) => (ownerName ? `${ownerName}'s number` : `Number ${name}`);

// One row per number: what the database holds, plus what the running browser says, plus the last day's sends.
export async function numberHealth(tenantId, { ownerUserId = null, nowMs = Date.now() } = {}) {
  const epoch = Math.floor(nowMs / 1000);
  const params = [tenantId, epoch];
  if (ownerUserId) params.push(ownerUserId);
  const { rows } = await query(
    `SELECT s.session_name,s.phone,s.status,s.last_error,s.owner_user_id,u.name AS owner_name,s.lease_until,
        s.last_heartbeat_at,s.last_heartbeat_ok_at,s.heartbeat_failures,s.heartbeat_error,s.connected_since,s.down_since,
        s.reconnect_attempts,s.last_reconnect_at,
        COALESCE(m.sent24,0)::int AS sent24,COALESCE(m.wrong24,0)::int AS wrong24,COALESCE(m.wrong1h,0)::int AS wrong1h,
        COALESCE(m.total1h,0)::int AS total1h,COALESCE(m.queued,0)::int AS queued,m.oldest_queued
     FROM whatsapp_sessions s LEFT JOIN users u ON u.id=s.owner_user_id
     LEFT JOIN LATERAL (
       SELECT count(*) FILTER (WHERE x.status = ANY($${params.length + 1}::text[])) AS sent24,
              count(*) FILTER (WHERE x.status = ANY($${params.length + 2}::text[])) AS wrong24,
              count(*) FILTER (WHERE x.status = ANY($${params.length + 2}::text[]) AND x.timestamp_epoch > ($2::bigint-3600)) AS wrong1h,
              count(*) FILTER (WHERE (x.status = ANY($${params.length + 1}::text[]) OR x.status = ANY($${params.length + 2}::text[])) AND x.timestamp_epoch > ($2::bigint-3600)) AS total1h,
              count(*) FILTER (WHERE x.status = ANY($${params.length + 3}::text[])) AS queued,
              min(x.timestamp_epoch) FILTER (WHERE x.status = ANY($${params.length + 3}::text[])) AS oldest_queued
       FROM messages x JOIN conversations c ON c.id=x.conversation_id
       WHERE x.tenant_id=s.tenant_id AND x.timestamp_epoch > ($2::bigint-86400) AND x.sender='agent' AND x.type<>'internal_note'
         AND c.tenant_id=s.tenant_id AND c.session_name=s.session_name
     ) m ON true
     WHERE s.tenant_id=$1 ${ownerUserId ? "AND s.owner_user_id=$3" : ""} ORDER BY s.created_at`,
    [...params, SENT, WRONG, WAITING],
  );
  return rows.map((s) => {
    const live = provider.getSession(tenantId, s.session_name);
    const status = live?.status || (s.lease_until && new Date(s.lease_until) > new Date(nowMs) ? s.status : "DISCONNECTED");
    const view = {
      sessionName: s.session_name,
      label: labelOf(s.session_name, s.owner_name),
      phone: live?.phone || s.phone,
      status,
      ownerUserId: s.owner_user_id,
      ownerName: s.owner_name || null,
      lastError: s.last_error || null,
      lastHeartbeatAt: s.last_heartbeat_at,
      lastHeartbeatOkAt: s.last_heartbeat_ok_at,
      heartbeatFailures: s.heartbeat_failures,
      heartbeatError: s.heartbeat_error || null,
      connectedSince: status === "CONNECTED" ? s.connected_since : null,
      downSince: status === "CONNECTED" ? null : s.down_since,
      reconnectAttempts: s.reconnect_attempts,
      lastReconnectAt: s.last_reconnect_at,
      sends: { sentLast24h: s.sent24, failedLast24h: s.wrong24, failedLastHour: s.wrong1h, totalLastHour: s.total1h },
      queued: { count: s.queued, oldestSeconds: s.oldest_queued ? Math.max(0, epoch - Number(s.oldest_queued)) : null },
    };
    const { level, problems } = judge(view, nowMs);
    return { ...view, level, problems: problems.map(({ code, text }) => ({ code, text })), alerts: problems.filter((p) => p.alert) };
  });
}

// when a number's browser was last restarted because it stopped answering: one restart per cooldown, so that a number that
// stays unwell is not restarted over and over
const restartedAt = new Map();

// Asks every number this server is running whether it is still there, and remembers the answer. A number that has not answered
// HEARTBEAT_RESTART_AFTER checks in a row has a stuck browser (the page hung, WhatsApp's connection is gone), which only a restart
// cures: it is restarted from its saved login, without a QR code. Until now it was only reported, and stayed down until a person acted.
export async function pingSessions({ timeoutMs = 8000, io = null, nowMs = Date.now() } = {}) {
  const running = [...provider.sessions.values()].filter((s) => s.status === "CONNECTED" && s.client);
  await Promise.all(
    running.map(async (s) => {
      const result = await provider.ping(s.tenantId, s.sessionName, timeoutMs);
      const { rows } = await query(
        `UPDATE whatsapp_sessions SET last_heartbeat_at=now(),
           last_heartbeat_ok_at=CASE WHEN $3::boolean THEN now() ELSE last_heartbeat_ok_at END,
           heartbeat_failures=CASE WHEN $3::boolean THEN 0 ELSE heartbeat_failures+1 END,
           heartbeat_error=CASE WHEN $3::boolean THEN NULL ELSE $4 END
         WHERE tenant_id=$1 AND session_name=$2 RETURNING heartbeat_failures,connected_since`,
        [s.tenantId, s.sessionName, result.ok, result.ok ? null : result.error || "No answer"],
      );
      const key = `${s.tenantId}:${s.sessionName}`;
      // A number that has only just connected is still loading its chats in the background, and a browser that is that busy answers
      // slowly. Restarting it then would interrupt the very sync it needs, so while it settles it is given three times as many misses.
      const settling = rows[0]?.connected_since && nowMs - new Date(rows[0].connected_since).getTime() < ENV.HEARTBEAT_SETTLE_MS;
      const misses = settling ? ENV.HEARTBEAT_RESTART_AFTER * 3 : ENV.HEARTBEAT_RESTART_AFTER;
      if (result.ok || (rows[0]?.heartbeat_failures ?? 0) < misses) return;
      if (nowMs - (restartedAt.get(key) ?? -Infinity) < ENV.HEARTBEAT_RESTART_COOLDOWN_MS) return;
      restartedAt.set(key, nowMs);
      // not awaited: a restart takes a minute, and the background jobs that call this must not wait for it
      restartTenantSession(s.tenantId, s.sessionName, io, { cause: "heartbeat" }).catch((e) => console.error(`Restart of ${s.sessionName} failed:`, e.message));
    }),
  );
  return running.length;
}

// Tells the number's owner and the workspace managers about a problem that has lasted, once per cooldown.
export async function alertOnProblems({ io = null, nowMs = Date.now() } = {}) {
  const tenants = (
    await query(
      `SELECT DISTINCT s.tenant_id FROM whatsapp_sessions s JOIN tenants t ON t.id=s.tenant_id WHERE t.status='active' AND s.phone IS NOT NULL`,
    )
  ).rows;
  let sent = 0;
  for (const { tenant_id: tenantId } of tenants) {
    const managers = (
      await query(
        `SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id
         WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND m.role IN ('owner','admin')`,
        [tenantId],
      )
    ).rows;
    for (const n of await numberHealth(tenantId, { nowMs })) {
      for (const p of n.alerts) {
        const key = `health:${p.code}:${n.sessionName}`;
        const recent = await query(
          `SELECT 1 FROM notifications WHERE tenant_id=$1 AND type='session' AND dedupe_key=$2 AND created_at > now() - make_interval(hours => $3) LIMIT 1`,
          [tenantId, key, THRESHOLDS.alertCooldownHours],
        );
        if (recent.rowCount) continue;
        const made = await createNotifications({
          io,
          tenantId,
          recipients: [{ userId: n.ownerUserId, type: "session" }, ...managers.map((m) => ({ userId: m.id, type: "session" }))],
          actor: null,
          dedupeKey: key,
          title: p.title,
          body: p.body,
        });
        if (made.length) sent++;
      }
    }
  }
  return sent;
}

let lastBeat = 0;
let lastPrune = 0;
// Called by the background jobs every few seconds: it asks the numbers once a minute and then looks for trouble.
export async function pumpNumberHealth(io, nowMs = Date.now()) {
  if (nowMs - lastBeat < THRESHOLDS.heartbeatEverySeconds * 1000) return;
  lastBeat = nowMs;
  await pingSessions({ io, nowMs });
  await alertOnProblems({ io, nowMs });
  if (nowMs - lastPrune > 24 * 3600 * 1000) {
    lastPrune = nowMs;
    await pruneSessionEvents().catch((e) => console.warn("Pruning the number history:", e.message));
  }
}
