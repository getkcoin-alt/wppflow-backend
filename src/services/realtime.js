import { query } from "../db/index.js";

// Session-scoped events reach the workspace managers and the staff member who
// owns that WhatsApp session, never the rest of the tenant.
async function emitScoped(io, tenantId, ownerUserId, event, payload) {
  if (!io) return;
  let target = io.to(`tenant:${tenantId}:managers`);
  if (ownerUserId) target = target.to(`user:${ownerUserId}`);
  target.emit(event, payload);
}
export function emitForSession(io, tenantId, sessionName, event, payload) {
  if (!io) return;
  query(
    "SELECT owner_user_id FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2",
    [tenantId, sessionName],
  )
    .then(({ rows }) =>
      emitScoped(io, tenantId, rows[0]?.owner_user_id, event, payload),
    )
    .catch((e) => console.error("Realtime emit failed:", e.message));
}
export function emitForConversation(io, tenantId, conversationId, event, payload) {
  if (!io) return;
  query(
    `SELECT s.owner_user_id FROM conversations c LEFT JOIN whatsapp_sessions s
     ON s.tenant_id=c.tenant_id AND s.session_name=c.session_name WHERE c.id=$1 AND c.tenant_id=$2`,
    [conversationId, tenantId],
  )
    .then(({ rows }) =>
      emitScoped(io, tenantId, rows[0]?.owner_user_id, event, payload),
    )
    .catch((e) => console.error("Realtime emit failed:", e.message));
}
