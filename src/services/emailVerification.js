import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { ENV } from "../config/env.js";
import { fail } from "../middleware/http.js";
import { hashToken } from "./teamService.js";
import { sendEmailVerification } from "./mailer.js";
import { createNotifications } from "./notificationService.js";
import { verticalOfHost, VERTICALS } from "./vertical.js";

// Confirming a person's email address, and noticing the first time someone signs in.
//
// A new account starts unverified. It can be used straight away, with a reminder, so a slow email never blocks the 14-day trial; the
// address is confirmed by a link that works once for 24 hours (only its hash is stored). People whose address was already proved by
// a single-use link (accepting an invitation, resetting a password) or by Google are verified at once. Accounts that existed before
// this was built were marked verified by the migration.

export const VERIFY_LINK_HOURS = 24;
export const VERIFY_REQUESTS_PER_HOUR = 3;

// The link goes back to the address the person signed up on (the app, or an industry's own address), never to one we do not own.
export const verifyLink = (token, origin) => `${ENV.ALLOWED_ORIGINS.includes(origin) ? origin : ENV.APP_URL}/?verify=${token}`;

export async function sendVerification(user, origin = "") {
  const fresh = (await query("SELECT id,email,name,email_verified_at,status FROM users WHERE id=$1", [user.id])).rows[0];
  if (!fresh || fresh.status !== "active" || fresh.email_verified_at) return { sent: false, reason: "not_needed" };
  const recent = (await query("SELECT count(*)::int AS n FROM email_verifications WHERE user_id=$1 AND created_at>now()-interval '1 hour'", [fresh.id])).rows[0].n;
  if (recent >= VERIFY_REQUESTS_PER_HOUR) return { sent: false, reason: "too_many" };
  const token = crypto.randomBytes(32).toString("hex");
  await withTransaction(async (c) => {
    await c.query("UPDATE email_verifications SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [fresh.id]); // only the newest link works
    await c.query("INSERT INTO email_verifications(user_id,token_hash,expires_at) VALUES($1,$2,now()+make_interval(hours=>$3))", [fresh.id, hashToken(token), VERIFY_LINK_HOURS]);
  });
  const product = VERTICALS[verticalOfHost(new URL(origin || ENV.APP_URL).host)]?.name || "Scriwo";
  const result = await sendEmailVerification({ to: fresh.email, name: fresh.name, link: verifyLink(token, origin), product });
  if (!result.sent) console.warn(`Verification mail for user ${fresh.id} was not sent (${result.reason}${result.detail ? ": " + result.detail : ""}).`);
  return { sent: result.sent, reason: result.reason };
}

// Returns the address that was confirmed. The same answer for a link that is wrong, expired or already used.
export async function verifyEmail(token) {
  const hash = hashToken(String(token || ""));
  const row = (
    await query(
      `UPDATE email_verifications v SET used_at=now() FROM users u
        WHERE v.token_hash=$1 AND v.used_at IS NULL AND v.expires_at>now() AND u.id=v.user_id AND u.status='active' RETURNING u.id,u.email`,
      [hash],
    )
  ).rows[0];
  if (!row) throw fail(400, "This link is invalid, expired or already used. Sign in and ask for a new one.");
  await markVerified(row.id);
  return { email: row.email };
}

export const markVerified = (userId, db = { query }) => db.query("UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1", [userId]);

// The first time someone signs in: noted once, and the owners and administrators of their company are told, so an invitation that
// was accepted is noticed. The person who created the company is not "invited", so no notice is made about them.
export async function noteFirstLogin({ user, tenant, io = null }) {
  const first = (await query("UPDATE users SET first_login_at=now() WHERE id=$1 AND first_login_at IS NULL RETURNING id,name,email", [user.id])).rows[0];
  if (!first || !tenant?.id || ["owner"].includes(tenant.role) || user.is_superadmin) return false;
  const managers = (await query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND status='active' AND role IN ('owner','admin') AND user_id<>$2", [tenant.id, user.id])).rows.map((r) => r.user_id);
  if (!managers.length) return false;
  await createNotifications({
    io,
    tenantId: tenant.id,
    dedupeKey: `first-login:${user.id}`,
    recipients: managers.map((userId) => ({ userId, type: "team" })),
    title: `${first.name || first.email} signed in for the first time`,
    body: "They accepted the invitation and are now in Scriwo.",
  }).catch((e) => console.error("First sign-in notice failed:", e.message));
  return true;
}
