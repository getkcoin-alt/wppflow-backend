import { query } from "../db/index.js";

// What happened to a linked WhatsApp number, and why. Written at every change (connected, dropped and the reason, restarted by the
// server, restored after a deploy, unlinked from the phone) so that how often numbers drop, and what causes it, can be told afterwards.
// Read by scripts/diagnose-numbers.mjs on the server.
//
// Recording never throws: a failed insert must not take a number down or hide the event it was about.
export async function recordSessionEvent({ tenantId, sessionName, event, cause = null, detail = null, workerId = null }) {
  try {
    await query(
      `INSERT INTO whatsapp_session_events(tenant_id,session_name,event,cause,detail,worker_id)
       SELECT t.id,$2::varchar,$3::varchar,$4::varchar,$5::text,$6::uuid FROM tenants t WHERE t.id=$1`,
      [tenantId, sessionName, event, cause, detail == null ? null : String(detail).slice(0, 500), workerId],
    );
  } catch (error) {
    console.warn(`Could not record "${event}" for ${sessionName}: ${error.message}`);
  }
}

// Newest first.
export async function sessionEvents(tenantId, sessionName, { limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT event,cause,detail,created_at FROM whatsapp_session_events WHERE tenant_id=$1 AND session_name=$2 ORDER BY id DESC LIMIT $3`,
    [tenantId, sessionName, Math.min(Math.max(Number(limit) || 50, 1), 500)],
  );
  return rows;
}

// A quarter of a year is plenty to see a pattern; older rows only take room.
export async function pruneSessionEvents(days = 90) {
  const { rowCount } = await query(`DELETE FROM whatsapp_session_events WHERE created_at < now() - make_interval(days => $1)`, [days]);
  return rowCount;
}
