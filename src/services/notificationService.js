import crypto from "node:crypto";
import { query } from "../db/index.js";
import { chatTitle } from "./personName.js";

// In-app notifications for the team: who needs to know, stored so nothing is lost while
// someone is offline, and pushed live to their open browsers.

export const notificationView = (r) => ({
  id: r.id,
  type: r.type,
  title: r.title,
  body: r.body,
  conversationId: r.conversation_id,
  messageId: r.message_id,
  actorName: r.actor_name,
  createdAt: r.created_at,
  read: Boolean(r.read_at),
});

const snippet = (text, max = 140) => {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Everyone who is allowed to open this chat: workspace owners/admins, whoever's WhatsApp
// number it belongs to, and whoever it is assigned to. Notifications never reveal a chat to
// someone who couldn't open it.
async function audience(tenantId, conversationId) {
  const { rows } = await query(
    `SELECT c.contact_name,c.phone,c.assigned_user_id,s.owner_user_id FROM conversations c
     LEFT JOIN whatsapp_sessions s ON s.tenant_id=c.tenant_id AND s.session_name=c.session_name
     WHERE c.id=$1 AND c.tenant_id=$2`,
    [conversationId, tenantId],
  );
  if (!rows[0]) return null;
  const members = (
    await query(
      `SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active'`,
      [tenantId],
    )
  ).rows.filter(
    (m) =>
      ["owner", "admin"].includes(m.role) ||
      m.id === rows[0].owner_user_id ||
      m.id === rows[0].assigned_user_id,
  );
  return { conversation: rows[0], members };
}

export async function createNotifications({
  io = null,
  tenantId,
  recipients, // [{ userId, type }]
  actor,
  conversationId = null,
  messageId = null,
  dedupeKey = null,
  title,
  body = "",
}) {
  const seen = new Set();
  const rows = recipients
    .filter((r) => r.userId && r.userId !== actor?.id && !seen.has(r.userId) && seen.add(r.userId))
    .map((r) => ({ id: crypto.randomUUID(), ...r }));
  if (!rows.length) return [];
  const { rows: saved } = await query(
    `INSERT INTO notifications(id,tenant_id,user_id,type,conversation_id,message_id,actor_id,actor_name,title,body,dedupe_key)
     SELECT x.id,$1,x.user_id,x.type,$2,$3,$4,$5,$6,$7,$11
     FROM unnest($8::uuid[],$9::int[],$10::text[]) AS x(id,user_id,type) RETURNING *`,
    [
      tenantId,
      conversationId,
      messageId,
      actor?.id ?? null,
      actor?.name || "",
      title,
      body,
      rows.map((r) => r.id),
      rows.map((r) => r.userId),
      rows.map((r) => r.type),
      dedupeKey,
    ],
  );
  for (const n of saved)
    io?.to(`user:${n.user_id}`).emit("notification:new", { notification: notificationView(n) });
  return saved;
}

// An internal note: tell the teammate it is assigned to and the person whose WhatsApp it is,
// and anyone @mentioned by name (mentions take priority and only reach people with access).
export async function notifyInternalNote({ io, tenantId, conversationId, messageId, actor, text }) {
  const a = await audience(tenantId, conversationId);
  if (!a) return [];
  const mentioned = a.members.filter((m) =>
    new RegExp(`@${escapeRe(m.name)}(?![\\p{L}\\p{N}_])`, "iu").test(text),
  );
  const recipients = [
    ...mentioned.map((m) => ({ userId: m.id, type: "mention" })),
    { userId: a.conversation.assigned_user_id, type: "note" },
    { userId: a.conversation.owner_user_id, type: "note" },
  ];
  const chat = chatTitle(a.conversation.contact_name, a.conversation.phone) || "a chat";
  return createNotifications({
    io,
    tenantId,
    recipients,
    actor,
    conversationId,
    messageId,
    title: `${actor?.name || "A teammate"} left a team note on ${chat}`,
    body: snippet(text),
  });
}

export async function notifyAssignment({ io, tenantId, conversationId, actor, assigneeId }) {
  const a = await audience(tenantId, conversationId);
  if (!a || !assigneeId) return [];
  return createNotifications({
    io,
    tenantId,
    recipients: [{ userId: assigneeId, type: "assignment" }],
    actor,
    conversationId,
    title: `${actor?.name || "A teammate"} assigned you a chat`,
    body: chatTitle(a.conversation.contact_name, a.conversation.phone),
  });
}

// A paired phone dropped: the staff member who owns it and the workspace managers should know.
export async function notifySessionLost({ io, tenantId, sessionName, status }) {
  const { rows } = await query(
    `SELECT owner_user_id FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2`,
    [tenantId, sessionName],
  );
  // One alert per outage, not one per flicker.
  const recent = await query(
    `SELECT 1 FROM notifications WHERE tenant_id=$1 AND type='session' AND dedupe_key=$2 AND created_at > now() - interval '10 minutes' LIMIT 1`,
    [tenantId, sessionName],
  );
  if (recent.rowCount) return [];
  const managers = (
    await query(
      `SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND m.role IN ('owner','admin')`,
      [tenantId],
    )
  ).rows;
  return createNotifications({
    io,
    tenantId,
    recipients: [
      { userId: rows[0]?.owner_user_id, type: "session" },
      ...managers.map((m) => ({ userId: m.id, type: "session" })),
    ],
    actor: null,
    dedupeKey: sessionName,
    title: "A WhatsApp number was disconnected",
    body:
      status === "EXPIRED"
        ? "Open Sessions and scan the QR code again to reconnect."
        : "Open Sessions to reconnect it.",
  });
}
