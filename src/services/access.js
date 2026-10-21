import { query } from "../db/index.js";
import { fail } from "../middleware/http.js";

// Owners/admins, super admins and API keys see every session in the workspace;
// agents only see WhatsApp sessions they paired themselves.
export const isManager = (req) =>
  Boolean(req.apiKey) ||
  Boolean(req.user?.isSuperAdmin) ||
  ["owner", "admin"].includes(req.membership?.role);

export async function assertSessionAccess(req, sessionName) {
  const { rows } = await query(
    "SELECT owner_user_id FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2",
    [req.tenantId, sessionName],
  );
  if (!rows[0] || (!isManager(req) && rows[0].owner_user_id !== req.user.id))
    throw fail(404, "Session not found");
  return rows[0];
}

export async function assertConversationAccess(req, conversationId) {
  const { rows } = await query(
    `SELECT c.session_name,s.owner_user_id FROM conversations c
     LEFT JOIN whatsapp_sessions s ON s.tenant_id=c.tenant_id AND s.session_name=c.session_name
     WHERE c.id=$1 AND c.tenant_id=$2`,
    [conversationId, req.tenantId],
  );
  if (!rows[0] || (!isManager(req) && rows[0].owner_user_id !== req.user.id))
    throw fail(404, "Conversation not found");
  return rows[0];
}
