import crypto from "node:crypto";
import { query } from "../db/index.js";
import { fail } from "../middleware/http.js";

// What a teammate does. A label for organising people; permissions still come from the role.
export const MEMBER_CATEGORIES = [
  "general",
  "sales",
  "support",
  "billing",
  "operations",
  "marketing",
];

export function categoryOf(value) {
  const v = String(value ?? "general").toLowerCase().trim() || "general";
  if (!MEMBER_CATEGORIES.includes(v))
    throw fail(400, `Choose a category: ${MEMBER_CATEGORIES.join(", ")}`);
  return v;
}
export const roleOf = (value) =>
  ["admin", "tenant_admin"].includes(value) ? "admin" : "agent";
export const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");
export const isId = (value) => /^[0-9a-f-]{36}$/i.test(String(value));

// Remember what really happened to an invitation email so the team page can show it.
export async function recordInviteMail(invitationId, mail) {
  const status = mail.sent
    ? "sent"
    : mail.reason === "not_configured"
      ? "not_configured"
      : "failed";
  await query(
    `UPDATE invitations SET email_status=$2::varchar, email_error=$3,
       email_sent_at=CASE WHEN $2::varchar='sent' THEN now() ELSE email_sent_at END,
       email_attempts=email_attempts+1 WHERE id=$1`,
    [
      invitationId,
      status,
      mail.sent ? null : String(mail.detail || mail.reason || "").slice(0, 300),
    ],
  );
  return status;
}

export const invitationView = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  category: r.category,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  expired: new Date(r.expires_at).getTime() < Date.now(),
  mail: {
    status: r.email_status || "unknown",
    sentAt: r.email_sent_at,
    error: r.email_error,
    attempts: r.email_attempts,
  },
});

export async function pendingInvitations(tenantId) {
  const { rows } = await query(
    `SELECT id,name,email,role,category,created_at,expires_at,email_status,email_error,email_sent_at,email_attempts
       FROM invitations
      WHERE tenant_id=$1 AND accepted_at IS NULL AND role IN ('admin','agent')
        AND created_at > now() - interval '30 days'
      ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows.map(invitationView);
}
