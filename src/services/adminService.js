import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { ENV } from "../config/env.js";
import { hashPassword } from "./authService.js";
import { fail } from "../middleware/http.js";
import { mailEnabled, sendOwnerSetup } from "./mailer.js";

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

const OWNER_LINK_HOURS = 72;
// One live setup link per owner: issuing a new one retires the previous.
async function issueOwnerSetupLink(c, { tenantId, email, name }) {
  const token = crypto.randomBytes(32).toString("hex");
  await c.query(
    "UPDATE invitations SET expires_at=now() WHERE tenant_id=$1 AND email=$2 AND set_password AND accepted_at IS NULL AND expires_at>now()",
    [tenantId, email],
  );
  await c.query(
    `INSERT INTO invitations(id,tenant_id,email,name,role,token_hash,expires_at,set_password)
     VALUES($1,$2,$3,$4,'owner',$5,now()+($6||' hours')::interval,true)`,
    [
      crypto.randomUUID(),
      tenantId,
      email,
      name,
      crypto.createHash("sha256").update(token).digest("hex"),
      String(OWNER_LINK_HOURS),
    ],
  );
  return `${ENV.APP_URL}/?invite=${token}`;
}

export async function createCompany({
  actorId,
  companyName,
  ownerName,
  ownerEmail,
  sessionsLimit,
  plan,
}) {
  if (!mailEnabled())
    throw fail(
      503,
      "Email delivery is not configured (RESEND_API_KEY), so the owner's setup link cannot be sent. Nothing was created.",
    );
  const tenantId = `tenant_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const slug = `${companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company"}-${Date.now().toString(36)}`;
  // Brand-new owners get an unusable random password until they follow the link.
  const placeholderHash = await hashPassword(crypto.randomBytes(32).toString("hex"));
  const { tenant, link } = await withTransaction(async (c) => {
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
          [ownerEmail, placeholderHash, ownerName],
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
    const link = await issueOwnerSetupLink(c, {
      tenantId,
      email: ownerEmail,
      name: ownerName,
    });
    return { tenant: { ...t.rows[0], owner_id: ownerId }, link };
  });
  const mail = await sendOwnerSetup({
    to: ownerEmail,
    name: ownerName,
    company: companyName,
    link,
  });
  return { tenant, emailSent: mail.sent, emailError: mail.detail };
}

export async function resendOwnerSetupLink(tenantId) {
  const { rows } = await query(
    `SELECT u.email,u.name,t.name AS company FROM memberships m
     JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1 AND m.role='owner' ORDER BY m.id LIMIT 1`,
    [tenantId],
  );
  const owner = rows[0];
  if (!owner) throw fail(404, "Company owner not found");
  if (!mailEnabled()) throw fail(503, "Email delivery is not configured");
  const link = await withTransaction((c) =>
    issueOwnerSetupLink(c, { tenantId, email: owner.email, name: owner.name }),
  );
  const mail = await sendOwnerSetup({
    to: owner.email,
    name: owner.name,
    company: owner.company,
    link,
  });
  return { emailSent: mail.sent, emailError: mail.detail, ownerEmail: owner.email };
}
