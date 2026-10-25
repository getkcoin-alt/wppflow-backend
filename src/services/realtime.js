import { query } from "../db/index.js";
import { formatConversation } from "./conversationFormat.js";

// Session-scoped events reach the workspace managers and the staff member who
// owns that WhatsApp session, never the rest of the tenant.
function emitScoped(io, tenantId, userIds, event, payload) {
  if (!io) return;
  let target = io.to(`tenant:${tenantId}:managers`);
  for (const id of new Set([].concat(userIds).filter(Boolean)))
    target = target.to(`user:${id}`);
  target.emit(event, payload);
}

// A busy inbox emits many events per second for the same few sessions, so owners
// are remembered briefly instead of being looked up for every event.
const OWNER_TTL_MS = 15000;
const owners = new Map();
export const forgetSessionOwner = (tenantId, sessionName) =>
  owners.delete(`${tenantId}:${sessionName}`);
async function ownerOf(tenantId, sessionName) {
  const key = `${tenantId}:${sessionName}`,
    hit = owners.get(key);
  if (hit && hit.until > Date.now()) return hit.owner;
  const { rows } = await query(
    "SELECT owner_user_id FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2",
    [tenantId, sessionName],
  );
  // Unknown sessions are not cached so a session created a moment later is picked up.
  if (rows[0]) owners.set(key, { owner: rows[0].owner_user_id, until: Date.now() + OWNER_TTL_MS });
  return rows[0]?.owner_user_id ?? null;
}

// Looking up the owner takes a database round trip, and two lookups can finish in either order, so
// "failed" could reach the browser before the "chats" that was sent first. A number's events wait
// for the ones sent before them.
const sessionTails = new Map();
export function emitForSession(io, tenantId, sessionName, event, payload) {
  if (!io) return;
  const key = `${tenantId}:${sessionName}`;
  const tail = (sessionTails.get(key) || Promise.resolve())
    .then(() => ownerOf(tenantId, sessionName))
    .then((owner) => emitScoped(io, tenantId, owner, event, payload))
    .catch((e) => console.error("Realtime emit failed:", e.message));
  sessionTails.set(key, tail);
  tail.then(() => sessionTails.get(key) === tail && sessionTails.delete(key));
}

// With { snapshot: true } the event also carries the conversation's current state, so
// browsers can update their lists in place instead of refetching them.
export function emitForConversation(
  io,
  tenantId,
  conversationId,
  event,
  payload,
  { snapshot = false } = {},
) {
  if (!io) return;
  query(
    `SELECT c.*,s.owner_user_id FROM conversations c LEFT JOIN whatsapp_sessions s
     ON s.tenant_id=c.tenant_id AND s.session_name=c.session_name WHERE c.id=$1 AND c.tenant_id=$2`,
    [conversationId, tenantId],
  )
    .then(({ rows }) => {
      const row = rows[0];
      emitScoped(
        io,
        tenantId,
        [row?.owner_user_id, row?.assigned_user_id],
        event,
        snapshot && row ? { ...payload, conversation: formatConversation(row) } : payload,
      );
    })
    .catch((e) => console.error("Realtime emit failed:", e.message));
}

// A lead changed: the managers, whoever owns it and whoever owns the WhatsApp number it came from are told, so
// their open boards refresh. The screens ask the server again, which applies the visibility rule.
export function emitForLead(io, tenantId, lead) {
  if (!io) return;
  const send = (sessionOwner) =>
    emitScoped(io, tenantId, [lead.owner_user_id, sessionOwner], "lead:changed", { leadId: lead.id });
  if (!lead.session_name) return send(null);
  ownerOf(tenantId, lead.session_name)
    .then(send)
    .catch((e) => console.error("Realtime emit failed:", e.message));
}

// Somebody is typing a reply in a chat. Only the people who can open that chat hear about it (the managers, the
// owner of the WhatsApp number and whoever the chat is assigned to), so two people do not answer the same customer
// without knowing. Nothing is stored. Returns whether it was passed on.
export async function relayCompose({ io, tenantId, userId, name, isManager, conversationId, typing }) {
  if (!io || !userId || typeof conversationId !== "string" || !conversationId || conversationId.length > 64) return false;
  const { rows } = await query(
    `SELECT c.assigned_user_id,s.owner_user_id FROM conversations c LEFT JOIN whatsapp_sessions s
     ON s.tenant_id=c.tenant_id AND s.session_name=c.session_name WHERE c.id=$1 AND c.tenant_id=$2`,
    [conversationId, tenantId],
  );
  const row = rows[0];
  if (!row || (!isManager && row.owner_user_id !== userId && row.assigned_user_id !== userId)) return false;
  emitScoped(io, tenantId, [row.owner_user_id, row.assigned_user_id], "compose:update", {
    conversationId,
    userId,
    name: String(name || "A teammate").slice(0, 80),
    typing: Boolean(typing),
  });
  return true;
}
