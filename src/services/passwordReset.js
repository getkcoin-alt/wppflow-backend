import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { ENV } from "../config/env.js";
import { fail } from "../middleware/http.js";
import { hashPassword } from "./authService.js";
import { hashToken } from "./teamService.js";
import { sendPasswordChanged, sendPasswordReset } from "./mailer.js";

export const RESET_LINK_HOURS = 1;
// Requests per address per hour. Stops the form being used to flood someone's inbox.
export const RESET_REQUESTS_PER_HOUR = 3;
export const MIN_PASSWORD = 10;

export const resetLink = (token) => `${ENV.APP_URL}/?reset=${token}`;

// Always resolves the same way whether or not the address has an account, so the answer cannot be used to find out
// who is a customer. Only an active account is mailed, and only up to the hourly limit.
export async function requestPasswordReset(email) {
  const { rows } = await query(
    "SELECT id,email,name,status FROM users WHERE lower(email)=lower($1)",
    [email],
  );
  const user = rows[0];
  if (!user || user.status !== "active") return { sent: false };
  const recent = await query(
    "SELECT count(*)::int AS n FROM password_resets WHERE user_id=$1 AND created_at>now()-interval '1 hour'",
    [user.id],
  );
  if (recent.rows[0].n >= RESET_REQUESTS_PER_HOUR) return { sent: false };
  const token = crypto.randomBytes(32).toString("hex");
  await withTransaction(async (c) => {
    // only the newest link works
    await c.query(
      "UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",
      [user.id],
    );
    await c.query(
      `INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,$2,now()+make_interval(hours=>$3))`,
      [user.id, hashToken(token), RESET_LINK_HOURS],
    );
  });
  const result = await mailLink(user, token);
  return { sent: result.sent };
}
async function mailLink(user, token) {
  const result = await sendPasswordReset({
    to: user.email,
    name: user.name,
    link: resetLink(token),
  });
  if (!result.sent)
    console.warn(
      `Password reset mail for user ${user.id} was not sent (${result.reason}${result.detail ? ": " + result.detail : ""}).`,
    );
  return result;
}

export async function resetInfo(token) {
  const { rows } = await query(
    `SELECT u.email FROM password_resets r JOIN users u ON u.id=r.user_id
     WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.expires_at>now() AND u.status='active'`,
    [hashToken(token)],
  );
  if (!rows[0])
    throw fail(400, "This link is invalid, expired or already used");
  return { email: rows[0].email };
}

export async function resetPassword(token, password) {
  if (password.length < MIN_PASSWORD)
    throw fail(400, `Use at least ${MIN_PASSWORD} password characters`);
  const user = await withTransaction(async (c) => {
    const { rows } = await c.query(
      `SELECT r.id,r.user_id,u.email,u.name,u.status FROM password_resets r JOIN users u ON u.id=r.user_id
       WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.expires_at>now() FOR UPDATE OF r`,
      [hashToken(token)],
    );
    const link = rows[0];
    if (!link || link.status !== "active")
      throw fail(400, "This link is invalid, expired or already used");
    await c.query(
      "UPDATE users SET password_hash=$1,must_change_password=false,updated_at=now() WHERE id=$2",
      [await hashPassword(password), link.user_id],
    );
    await c.query(
      "UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",
      [link.user_id],
    );
    // a forgotten password may mean a lost laptop: every signed-in device has to sign in again
    await c.query("UPDATE refresh_tokens SET revoked=true WHERE user_id=$1", [
      link.user_id,
    ]);
    return link;
  });
  // a failed notice must not undo a reset that has already happened
  await sendPasswordChanged({ to: user.email, name: user.name }).catch(
    () => {},
  );
}
