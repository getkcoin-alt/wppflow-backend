import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { ENV } from "../config/env.js";
import { hashPassword } from "./authService.js";
import { fail } from "../middleware/http.js";
import {
  mailEnabled,
  sendOwnerCredentials,
  sendOwnerAccess,
} from "./mailer.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
export const temporaryPassword = (length = 14) =>
  Array.from({ length }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");

// The platform operator is configured through the environment; an existing
// password is never overwritten by a restart.
export async function ensureSuperAdmin() {
  if (!ENV.SUPERADMIN_EMAIL || !ENV.SUPERADMIN_PASSWORD) return;
  if (ENV.SUPERADMIN_PASSWORD.length < 10)
    throw new Error("SUPERADMIN_PASSWORD must contain at least 10 characters");
  await query(
    `INSERT INTO users(email,password_hash,name,is_superadmin,status) VALUES($1,$2,'Platform Administrator',true,'active')
     ON CONFLICT(email) DO UPDATE SET is_superadmin=true,status='active'`,
    [ENV.SUPERADMIN_EMAIL, await hashPassword(ENV.SUPERADMIN_PASSWORD)],
  );
}

export async function createCompany({
  actorId,
  companyName,
  ownerName,
  ownerEmail,
  sessionsLimit,
  plan,
}) {
  const existing = await query("SELECT id FROM users WHERE email=$1", [ownerEmail]);
  const password = existing.rowCount ? null : temporaryPassword();
  if (password && !mailEnabled())
    throw fail(
      503,
      "Email delivery is not configured (RESEND_API_KEY), so owner credentials cannot be sent. Nothing was created.",
    );
  const tenantId = `tenant_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const slug = `${companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company"}-${Date.now().toString(36)}`;
  const hash = password ? await hashPassword(password) : null;
  const tenant = await withTransaction(async (c) => {
    const t = await c.query(
      "INSERT INTO tenants(id,name,slug,plan,sessions_limit) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [tenantId, companyName, slug, plan || "Workspace", sessionsLimit],
    );
    let ownerId = (
      await c.query("SELECT id FROM users WHERE email=$1 FOR UPDATE", [ownerEmail])
    ).rows[0]?.id;
    if (!ownerId)
      ownerId = (
        await c.query(
          "INSERT INTO users(email,password_hash,name,status,must_change_password) VALUES($1,$2,$3,'active',true) RETURNING id",
          [ownerEmail, hash, ownerName],
        )
      ).rows[0].id;
    await c.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
      [tenantId, ownerId],
    );
    await c.query(
      "INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'company.created',$3)",
      [tenantId, actorId, JSON.stringify({ companyName, ownerEmail })],
    );
    return { ...t.rows[0], owner_id: ownerId };
  });
  const mail = password
    ? await sendOwnerCredentials({ to: ownerEmail, name: ownerName, company: companyName, password })
    : await sendOwnerAccess({ to: ownerEmail, name: ownerName, company: companyName });
  return {
    tenant,
    emailSent: mail.sent,
    emailError: mail.detail,
    newOwnerAccount: Boolean(password),
  };
}

export async function resendOwnerCredentials(tenantId) {
  const { rows } = await query(
    `SELECT u.id,u.email,u.name,u.must_change_password,t.name AS company FROM memberships m
     JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1 AND m.role='owner' ORDER BY m.id LIMIT 1`,
    [tenantId],
  );
  const owner = rows[0];
  if (!owner) throw fail(404, "Company owner not found");
  if (!owner.must_change_password)
    throw fail(409, "The owner has already activated this account");
  if (!mailEnabled()) throw fail(503, "Email delivery is not configured");
  const password = temporaryPassword();
  await query("UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2", [
    await hashPassword(password),
    owner.id,
  ]);
  const mail = await sendOwnerCredentials({
    to: owner.email,
    name: owner.name,
    company: owner.company,
    password,
  });
  return {
    emailSent: mail.sent,
    emailError: mail.detail,
    ownerEmail: owner.email,
  };
}
