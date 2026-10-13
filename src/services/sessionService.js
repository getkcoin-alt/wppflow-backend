import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { defaultWhatsAppProvider as provider } from "./whatsapp/WhatsAppProvider.js";
import { handleIncomingMessage, handleAckEvent } from "./messageService.js";
import { fail } from "../middleware/http.js";
const workerId = crypto.randomUUID(),
  owned = new Map();
let recoveryTimer;
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
export async function startTenantSession(tenantId, sessionName, io) {
  validateSession(sessionName);
  const key = `${tenantId}:${sessionName}`;
  if (owned.has(key)) {
    if (
      ["CONNECTED", "STARTING", "QRCODE", "AUTHENTICATING"].includes(
        provider.getSession(tenantId, sessionName)?.status,
      )
    )
      return;
    await closeTenantSession(tenantId, sessionName, io, true);
  }
  await withTransaction(async (c) => {
    const tenant = await c.query(
      "SELECT sessions_limit FROM tenants WHERE id=$1 FOR UPDATE",
      [tenantId],
    );
    if (!tenant.rows[0]) throw fail(404, "Workspace not found");
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
    if (
      !exists.rowCount &&
      count.rows[0].count >= tenant.rows[0].sessions_limit
    )
      throw fail(403, "Session quota reached");
    await c.query(
      `INSERT INTO whatsapp_sessions(id,tenant_id,session_name,status,worker_id,lease_until) VALUES($1,$2,$3,'STARTING',$4,now()+interval '45 seconds')
      ON CONFLICT(tenant_id,session_name) DO UPDATE SET status='STARTING',restore_on_start=true,worker_id=$4,lease_until=now()+interval '45 seconds',updated_at=now()`,
      [crypto.randomUUID(), tenantId, sessionName, workerId],
    );
  });
  if (owned.has(key)) return;
  const timer = setInterval(async () => {
    try {
      const result = await query(
        "UPDATE whatsapp_sessions SET lease_until=now()+interval '45 seconds' WHERE tenant_id=$1 AND session_name=$2 AND worker_id=$3",
        [tenantId, sessionName, workerId],
      );
      if (!result.rowCount)
        await closeTenantSession(tenantId, sessionName, io, true);
    } catch {
      clearInterval(timer);
      owned.delete(key);
      await provider.closeSession(tenantId, sessionName);
    }
  }, 10000);
  timer.unref();
  owned.set(key, timer);
  provider
    .startSession(tenantId, sessionName, {
      onQr: async (qrcode) => {
        await query(
          "UPDATE whatsapp_sessions SET qr_code=$1 WHERE tenant_id=$2 AND session_name=$3 AND worker_id=$4",
          [qrcode, tenantId, sessionName, workerId],
        );
        io?.to(`tenant:${tenantId}:managers`).emit("session:qr", {
          session: sessionName,
          sessionName,
          qrcode,
        });
      },
      onStatus: async (status) => {
        const phone = provider.getSession(tenantId, sessionName)?.phone || null;
        await query(
          "UPDATE whatsapp_sessions SET status=$1::varchar,phone=COALESCE($2,phone),qr_code=CASE WHEN $1::varchar='QRCODE' THEN qr_code ELSE NULL END,updated_at=now() WHERE tenant_id=$3 AND session_name=$4 AND worker_id=$5",
          [status, phone, tenantId, sessionName, workerId],
        );
        if (["DISCONNECTED", "EXPIRED"].includes(status)) {
          clearInterval(owned.get(key));
          owned.delete(key);
          await query(
            "UPDATE whatsapp_sessions SET worker_id=NULL,lease_until=NULL,restore_on_start=$3 WHERE tenant_id=$1 AND session_name=$2 AND worker_id=$4",
            [tenantId, sessionName, status !== "EXPIRED", workerId],
          );
        }
        io?.to(`tenant:${tenantId}`).emit("session:status", {
          session: sessionName,
          sessionName,
          status,
          phone,
        });
      },
      onMessage: (msg) =>
        handleIncomingMessage({ tenantId, sessionName, msg, io }).catch((e) =>
          console.error("Message event failed:", e.message),
        ),
      onAck: (ackData) =>
        handleAckEvent({ tenantId, ackData, io }).catch((e) =>
          console.error("Receipt event failed:", e.message),
        ),
    })
    .catch(async (error) => {
      clearInterval(timer);
      owned.delete(key);
      await provider.closeSession(tenantId, sessionName);
      await query(
        "UPDATE whatsapp_sessions SET status='FAILED',worker_id=NULL,lease_until=NULL,qr_code=NULL WHERE tenant_id=$1 AND session_name=$2 AND worker_id=$3",
        [tenantId, sessionName, workerId],
      );
      io?.to(`tenant:${tenantId}`).emit("session:status", {
        session: sessionName,
        status: "FAILED",
      });
      console.error("Session start failed:", error.message);
    })
    .catch((error) => console.error("Session failure cleanup:", error.message));
}
export async function closeTenantSession(
  tenantId,
  sessionName,
  io,
  restore = false,
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
  await provider.closeSession(tenantId, sessionName);
  await query(
    "UPDATE whatsapp_sessions SET status='DISCONNECTED',restore_on_start=$3,worker_id=NULL,lease_until=NULL,qr_code=NULL,updated_at=now() WHERE tenant_id=$1 AND session_name=$2 AND (worker_id=$4 OR worker_id IS NULL)",
    [tenantId, sessionName, restore, workerId],
  );
  io?.to(`tenant:${tenantId}`).emit("session:status", {
    session: sessionName,
    status: "DISCONNECTED",
  });
}
async function recoverSessions(io) {
  const { rows } = await query(
    "SELECT tenant_id,session_name FROM whatsapp_sessions WHERE restore_on_start=true AND (lease_until IS NULL OR lease_until<now())",
  );
  for (const s of rows)
    await startTenantSession(s.tenant_id, s.session_name, io).catch((e) =>
      console.error("Session recovery failed:", e.message),
    );
}
export async function restoreSessions(io) {
  await recoverSessions(io);
  recoveryTimer = setInterval(
    () =>
      recoverSessions(io).catch((e) =>
        console.error("Session recovery:", e.message),
      ),
    30000,
  );
  recoveryTimer.unref();
}
export async function closeSessions(io) {
  clearInterval(recoveryTimer);
  for (const key of [...owned.keys()]) {
    const i = key.indexOf(":");
    await closeTenantSession(key.slice(0, i), key.slice(i + 1), io, true);
  }
}
