import express from "express";
import crypto from "node:crypto";
import {
  registerTenantAndUser,
  comparePassword,
  hashPassword,
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
  revokeAllRefreshTokens,
} from "../services/authService.js";
import {
  authenticateToken,
  requireTenantContext,
  requireRole,
} from "../middleware/auth.js";
import { authRateLimiter } from "../middleware/rateLimiter.js";
import { planOf } from "../services/plans.js";
import { query, withTransaction } from "../db/index.js";
import { ENV } from "../config/env.js";
import { route, fail, text } from "../middleware/http.js";
import { sendWelcomeEmail } from "../services/emailService.js";
import { sendStaffInvite } from "../services/mailer.js";
import {
  categoryOf,
  roleOf,
  hashToken,
  isId,
  recordInviteMail,
  pendingInvitations,
} from "../services/teamService.js";
const router = express.Router();
const cookieOptions = {
  httpOnly: true,
  secure: ENV.NODE_ENV === "production",
  sameSite: "lax",
  path: "/api/auth",
  maxAge: ENV.JWT_REFRESH_EXPIRES_IN_DAYS * 86400000,
};
const emailOf = (value) => {
  const email = text(value, "Email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw fail(400, "Invalid email");
  return email;
};
const platformTenant = {
  id: null,
  name: "Scriwo Platform",
  plan: "Platform",
  sessions_limit: 0,
  role: "superadmin",
};
async function context(user, tenantId) {
  const userId = typeof user === "object" ? user.id : user;
  const isSuper =
    typeof user === "object"
      ? Boolean(user.is_superadmin || user.isSuperAdmin)
      : false;
  const { rows } = await query(
    `SELECT t.*,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.status='active' AND t.status='active'
    ${tenantId ? "AND t.id=$2" : ""} ORDER BY m.created_at,t.id LIMIT 1`,
    tenantId ? [userId, tenantId] : [userId],
  );
  if (!rows[0]) {
    if (isSuper && !tenantId) return platformTenant;
    throw fail(403, "Workspace access is unavailable");
  }
  return rows[0];
}
const userView = (user, tenant) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  isSuperAdmin: Boolean(user.is_superadmin),
  is_superadmin: Boolean(user.is_superadmin),
  role: user.is_superadmin
    ? "superadmin"
    : ["owner", "admin"].includes(tenant.role)
      ? "admin"
      : "user",
  membershipRole: tenant.role,
  mustChangePassword: Boolean(user.must_change_password),
  company_name: tenant.name,
  plan: tenant.plan,
  sessions_limit: tenant.sessions_limit,
  status: user.status || "active",
  created_at: user.created_at,
});
async function respondSession(res, user, tenant, issueRefresh = true) {
  if (issueRefresh) {
    const { refreshToken } = await generateRefreshToken(user.id, tenant.id);
    res.cookie("refreshToken", refreshToken, cookieOptions);
  }
  res.json({
    status: "success",
    token: generateAccessToken(user, tenant.id, tenant.role),
    user: userView(user, tenant),
    tenant: { ...tenant, role: tenant.role },
  });
}
router.post(
  "/signup",
  authRateLimiter,
  route(async (req, res) => {
    if (!ENV.ALLOW_PUBLIC_SIGNUP)
      throw fail(
        403,
        "Self-service signup is disabled; ask your platform administrator to create your company",
      );
    const name = text(req.body.name, "Name", 255),
      email = emailOf(req.body.email),
      password = text(req.body.password, "Password", 128);
    if (password.length < 10)
      throw fail(400, "Use at least 10 password characters");
    const { user, tenant, role } = await registerTenantAndUser({
      name,
      email,
      password,
      companyName: req.body.companyName,
    });
    res.status(201);
    await respondSession(res, user, { ...tenant, role });
    sendWelcomeEmail({
      to: email,
      name: name.trim(),
      workspaceName: (req.body.companyName || `${name}'s Workspace`).trim(),
    }).catch((e) => console.warn(`Welcome email dispatch skipped: ${e.message}`));
  }),
);
router.post(
  "/login",
  authRateLimiter,
  route(async (req, res) => {
    const email = emailOf(req.body.email),
      password = text(req.body.password, "Password", 128);
    const { rows } = await query("SELECT * FROM users WHERE email=$1", [email]);
    const user = rows[0];
    if (
      !user ||
      user.status !== "active" ||
      !(await comparePassword(password, user.password_hash))
    )
      throw fail(401, "Invalid email or password");
    const tenant = await context(user);
    if (tenant.id)
      await query(
        "INSERT INTO audit_events(tenant_id,actor_id,event_type) VALUES($1,$2,'auth.login')",
        [tenant.id, user.id],
      );
    await respondSession(res, user, tenant);
  }),
);
router.post(
  "/refresh",
  authRateLimiter,
  route(async (req, res) => {
    const value = req.cookies?.refreshToken;
    if (!value) throw fail(401, "No refresh session");
    let result;
    try {
      result = await rotateRefreshToken(value);
    } catch {
      res.clearCookie("refreshToken", cookieOptions);
      throw fail(401, "Refresh session expired or revoked");
    }
    const { rows } = await query("SELECT * FROM users WHERE id=$1", [
      result.userId,
    ]);
    const tenant = await context(rows[0], result.tenantId);
    res.cookie("refreshToken", result.refreshToken, cookieOptions);
    await respondSession(res, rows[0], tenant, false);
  }),
);
router.post(
  "/logout",
  route(async (req, res) => {
    const id = String(req.cookies?.refreshToken || "").split(".")[0];
    if (id)
      await query("UPDATE refresh_tokens SET revoked=true WHERE id=$1", [id]);
    res.clearCookie("refreshToken", cookieOptions);
    res.json({ status: "success" });
  }),
);
router.get(
  "/me",
  authenticateToken,
  route(async (req, res) => {
    if (req.apiKey) throw fail(403, "Interactive login required");
    const tenant = await context(req.user, req.tenantId);
    const { rows } = await query("SELECT * FROM users WHERE id=$1", [
      req.user.id,
    ]);
    res.json({ status: "success", user: userView(rows[0], tenant), tenant });
  }),
);
router.post(
  "/switch-tenant",
  authenticateToken,
  route(async (req, res) => {
    if (req.apiKey) throw fail(403, "Interactive login required");
    const tenant = await context(
      req.user,
      text(req.body.tenantId, "Workspace", 64),
    );
    await respondSession(res, req.user, tenant);
  }),
);
router.get(
  "/workspaces",
  authenticateToken,
  route(async (req, res) => {
    if (req.apiKey) throw fail(403, "Interactive login required");
    const { rows } = await query(
      "SELECT t.id,t.name,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.status='active' ORDER BY t.name",
      [req.user.id],
    );
    res.json({ status: "success", workspaces: rows });
  }),
);
router.get(
  "/users",
  authenticateToken,
  requireTenantContext,
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const { rows } = await query(
      `SELECT u.id,u.name,u.email,m.role,m.status,m.category,u.created_at,t.name AS company,t.plan,t.sessions_limit,
    (SELECT count(*)::int FROM memberships WHERE tenant_id=t.id AND status='active') AS seats,
    (SELECT count(*)::int FROM whatsapp_sessions WHERE tenant_id=t.id AND status='CONNECTED') AS sessions,
    (SELECT count(*)::int FROM memberships mm WHERE mm.user_id=u.id AND mm.tenant_id<>t.id) AS other_workspaces
    FROM memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1 ORDER BY u.name`,
      [req.tenantId],
    );
    res.json({
      status: "success",
      invitations: await pendingInvitations(req.tenantId),
      users: rows.map((u) => ({
        ...u,
        id: String(u.id),
        company_name: u.company,
        role: u.role === "owner" || u.role === "admin" ? "admin" : "user",
        membershipRole: u.role,
        category: u.category,
        // A person in several workspaces has one name everywhere, so only they (or the platform) change it.
        canRename:
          String(u.id) === String(req.user.id) ||
          Boolean(req.user.isSuperAdmin) ||
          (u.role !== "owner" && u.other_workspaces === 0),
        whatsappSessionsQuota: u.sessions_limit,
        activeSessionsCount: u.sessions,
        teamSeats: u.seats,
        monthlyBroadcastLimit: null,
        broadcastsUsed: null,
        apiCallsThisMonth: null,
        lastLogin: null,
        createdAt: u.created_at,
      })),
    });
  }),
);
const mayManageInvite = (req, role) =>
  role !== "admin" || req.membership.role === "owner" || req.user.isSuperAdmin;
const inviteLink = (token) => `${ENV.APP_URL}/?invite=${token}`;
const mailFacts = (mail, status) => ({
  emailSent: mail.sent,
  emailStatus: status,
  emailError: mail.sent ? undefined : mail.detail || mail.reason,
});
router.post(
  "/users",
  authenticateToken,
  requireTenantContext,
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const name = text(req.body.name, "Name", 255),
      email = emailOf(req.body.email),
      role = roleOf(req.body.role || "agent"),
      category = categoryOf(req.body.category);
    if (!mayManageInvite(req, role))
      throw fail(403, "Only an owner can invite an administrator");
    const already = await query(
      "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND lower(u.email)=$2",
      [req.tenantId, email],
    );
    if (already.rowCount) throw fail(409, `${email} is already on your team`);
    const seats = planOf(req.tenant?.plan).seats;
    if (seats) {
      const people = await query(
        "SELECT count(*)::int AS n FROM memberships WHERE tenant_id=$1 AND status='active'",
        [req.tenantId],
      );
      if (people.rows[0].n >= seats)
        throw fail(
          403,
          `The ${planOf(req.tenant.plan).name} plan is for ${seats === 1 ? "one person" : `${seats} people`}. Ask the Scriwo team to move your company to a plan with a team.`,
        );
    }
    const token = crypto.randomBytes(32).toString("hex"),
      id = crypto.randomUUID();
    await withTransaction(async (c) => {
      // One live invitation per person: inviting again replaces the earlier one.
      await c.query(
        "DELETE FROM invitations WHERE tenant_id=$1 AND lower(email)=$2 AND accepted_at IS NULL AND role IN ('admin','agent')",
        [req.tenantId, email],
      );
      await c.query(
        `INSERT INTO invitations(id,tenant_id,email,name,role,category,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '24 hours')`,
        [id, req.tenantId, email, name, role, category, hashToken(token)],
      );
    });
    await query(
      "INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'member.invited',$3)",
      [req.tenantId, req.user.id, JSON.stringify({ email, role, category })],
    );
    const activationLink = inviteLink(token);
    const mail = await sendStaffInvite({
      to: email,
      name,
      company: req.tenant?.name || "Your company",
      link: activationLink,
    });
    const emailStatus = await recordInviteMail(id, mail);
    res.status(201).json({
      status: "success",
      message: mail.sent
        ? `Invitation emailed to ${email}.`
        : "Invitation created. Email delivery is unavailable; share this single-use setup link.",
      ...mailFacts(mail, emailStatus),
      invitationId: id,
      activationLink,
      expiresInHours: 24,
    });
  }),
);
router.post(
  "/users/invitations/:id/resend",
  authenticateToken,
  requireTenantContext,
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const found = isId(req.params.id)
      ? await query(
          "SELECT * FROM invitations WHERE id=$1 AND tenant_id=$2 AND accepted_at IS NULL AND role IN ('admin','agent')",
          [req.params.id, req.tenantId],
        )
      : { rows: [] };
    const inv = found.rows[0];
    if (!inv) throw fail(404, "Invitation not found or already accepted");
    if (!mayManageInvite(req, inv.role))
      throw fail(403, "Only an owner can manage administrator invitations");
    const token = crypto.randomBytes(32).toString("hex");
    // A fresh link replaces the old one, so an earlier email can no longer be used.
    await query(
      "UPDATE invitations SET token_hash=$2,expires_at=now()+interval '24 hours' WHERE id=$1",
      [inv.id, hashToken(token)],
    );
    const activationLink = inviteLink(token);
    const mail = await sendStaffInvite({
      to: inv.email,
      name: inv.name,
      company: req.tenant?.name || "Your company",
      link: activationLink,
    });
    const emailStatus = await recordInviteMail(inv.id, mail);
    await query(
      "INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'member.invitation_resent',$3)",
      [req.tenantId, req.user.id, JSON.stringify({ email: inv.email })],
    );
    res.json({
      status: "success",
      message: mail.sent
        ? `A new invitation was emailed to ${inv.email}. The earlier link no longer works.`
        : "Email delivery is unavailable; share this single-use setup link.",
      ...mailFacts(mail, emailStatus),
      activationLink,
      expiresInHours: 24,
    });
  }),
);
router.delete(
  "/users/invitations/:id",
  authenticateToken,
  requireTenantContext,
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const found = isId(req.params.id)
      ? await query(
          "SELECT id,role,email FROM invitations WHERE id=$1 AND tenant_id=$2 AND accepted_at IS NULL AND role IN ('admin','agent')",
          [req.params.id, req.tenantId],
        )
      : { rows: [] };
    const inv = found.rows[0];
    if (!inv) throw fail(404, "Invitation not found or already accepted");
    if (!mayManageInvite(req, inv.role))
      throw fail(403, "Only an owner can manage administrator invitations");
    await query("DELETE FROM invitations WHERE id=$1", [inv.id]);
    await query(
      "INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'member.invitation_cancelled',$3)",
      [req.tenantId, req.user.id, JSON.stringify({ email: inv.email })],
    );
    res.json({ status: "success" });
  }),
);
router.get(
  "/invite-info",
  authRateLimiter,
  route(async (req, res) => {
    const token = text(String(req.query.token || ""), "Invitation", 128);
    const { rows } = await query(
      `SELECT i.email,i.name,i.set_password,t.name AS company,
        EXISTS(SELECT 1 FROM users u WHERE u.email=i.email) AS has_account
       FROM invitations i JOIN tenants t ON t.id=i.tenant_id
       WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.expires_at>now()`,
      [crypto.createHash("sha256").update(token).digest("hex")],
    );
    if (!rows[0]) throw fail(400, "This link is invalid, expired or already used");
    const r = rows[0];
    res.json({
      status: "success",
      email: r.email,
      name: r.name,
      company: r.company,
      // true: the link itself lets them choose a password (company owners).
      // false with an existing account: they must prove their current password.
      setPassword: r.set_password || !r.has_account,
      existingAccount: r.has_account && !r.set_password,
    });
  }),
);
router.post(
  "/accept-invite",
  authRateLimiter,
  route(async (req, res) => {
    const token = text(req.body.token, "Invitation", 128),
      password = text(req.body.password, "Password", 128);
    await withTransaction(async (c) => {
      const { rows } = await c.query(
        "SELECT * FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now() FOR UPDATE",
        [crypto.createHash("sha256").update(token).digest("hex")],
      );
      const inv = rows[0];
      if (!inv) throw fail(400, "Invitation is invalid or expired");
      const existing = await c.query(
        "SELECT id,password_hash,status FROM users WHERE email=$1",
        [inv.email],
      );
      let userId = existing.rows[0]?.id;
      if (userId && inv.set_password) {
        // Owner link sent by the platform admin: proof of inbox control is enough.
        if (existing.rows[0].status !== "active")
          throw fail(403, "This account is not active");
        if (password.length < 10)
          throw fail(400, "Use at least 10 password characters");
        await c.query(
          "UPDATE users SET password_hash=$1,must_change_password=false,updated_at=now() WHERE id=$2",
          [await hashPassword(password), userId],
        );
        await c.query("UPDATE refresh_tokens SET revoked=true WHERE user_id=$1", [userId]);
      } else if (userId) {
        if (
          existing.rows[0].status !== "active" ||
          !(await comparePassword(password, existing.rows[0].password_hash))
        )
          throw fail(
            401,
            "Use the existing account password to accept this invitation",
          );
      } else {
        if (password.length < 10)
          throw fail(400, "New accounts need at least 10 password characters");
        const user = await c.query(
          "INSERT INTO users(email,password_hash,name,status) VALUES($1,$2,$3,'active') RETURNING id",
          [inv.email, await hashPassword(password), inv.name],
        );
        userId = user.rows[0].id;
      }
      await c.query(
        "INSERT INTO memberships(tenant_id,user_id,role,category) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [inv.tenant_id, userId, inv.role, inv.category || "general"],
      );
      await c.query("UPDATE invitations SET accepted_at=now() WHERE id=$1", [
        inv.id,
      ]);
    });
    res.json({
      status: "success",
      message: "Password saved. Log in to continue.",
    });
  }),
);
router.post(
  "/change-password",
  authRateLimiter,
  authenticateToken,
  route(async (req, res) => {
    if (req.apiKey) throw fail(403, "Interactive login required");
    const current = text(req.body.currentPassword, "Current password", 128),
      next = text(req.body.newPassword, "New password", 128);
    if (next.length < 10) throw fail(400, "Use at least 10 password characters");
    if (next === current)
      throw fail(400, "Choose a password different from the current one");
    const { rows } = await query("SELECT * FROM users WHERE id=$1", [
      req.user.id,
    ]);
    if (!(await comparePassword(current, rows[0].password_hash)))
      throw fail(401, "Current password is incorrect");
    await query(
      "UPDATE users SET password_hash=$1,must_change_password=false,updated_at=now() WHERE id=$2",
      [await hashPassword(next), req.user.id],
    );
    await revokeAllRefreshTokens(req.user.id);
    const tenant = await context(rows[0], req.tenantId);
    await respondSession(
      res,
      { ...rows[0], must_change_password: false },
      tenant,
    );
  }),
);
router.patch(
  "/users/:id",
  authenticateToken,
  requireTenantContext,
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const wantsName = req.body.name !== undefined,
      wantsCategory = req.body.category !== undefined,
      touchesAccess = req.body.role !== undefined || req.body.status !== undefined;
    const name = wantsName ? text(req.body.name, "Name", 255) : null,
      category = wantsCategory ? categoryOf(req.body.category) : null;
    if (!wantsName && !wantsCategory && !touchesAccess)
      throw fail(400, "Nothing to update");
    await withTransaction(async (c) => {
      const { rows } = await c.query(
        "SELECT * FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
        [req.tenantId, req.params.id],
      );
      const member = rows[0];
      if (!member) throw fail(404, "Member not found");
      if (member.role === "owner" && (touchesAccess || wantsCategory))
        throw fail(403, "Workspace ownership cannot be changed here");
      if (wantsName) {
        const isSelf = String(req.user.id) === String(req.params.id);
        if (!isSelf && !req.user.isSuperAdmin) {
          if (member.role === "owner")
            throw fail(403, "Only the owner can change the owner's name");
          const other = await c.query(
            "SELECT count(*)::int AS n FROM memberships WHERE user_id=$1 AND tenant_id<>$2",
            [req.params.id, req.tenantId],
          );
          if (other.rows[0].n)
            throw fail(
              409,
              "This person also belongs to other workspaces, so only they can change their name.",
            );
        }
        const prev = (
          await c.query("SELECT name FROM users WHERE id=$1", [req.params.id])
        ).rows[0]?.name;
        await c.query("UPDATE users SET name=$1,updated_at=now() WHERE id=$2", [
          name,
          req.params.id,
        ]);
        // Assignments and assign-by-name rules refer to the display name; keep them pointing at the same person.
        await c.query(
          "UPDATE conversations SET assigned_to=$1 WHERE assigned_user_id=$2",
          [name, req.params.id],
        );
        if (prev)
          await c.query(
            `UPDATE automations SET action_summary=$1,updated_at=now()
              WHERE action_type='assign_agent' AND action_summary=$2
                AND tenant_id IN (SELECT tenant_id FROM memberships WHERE user_id=$3)`,
            [name, prev, req.params.id],
          );
        await c.query(
          "INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'member.renamed',$3)",
          [
            req.tenantId,
            req.user.id,
            JSON.stringify({ userId: req.params.id, from: prev, to: name }),
          ],
        );
      }
      if (touchesAccess || wantsCategory) {
        if (
          req.body.role &&
          req.membership.role !== "owner" &&
          !req.user.isSuperAdmin
        )
          throw fail(403, "Only an owner can change roles");
        const role = req.body.role ? roleOf(req.body.role) : member.role;
        const status = req.body.status
          ? ["active", "suspended", "blocked"].includes(req.body.status)
            ? req.body.status
            : null
          : member.status;
        if (!status) throw fail(400, "Invalid status");
        await c.query(
          "UPDATE memberships SET role=$1,status=$2,category=$3,updated_at=now() WHERE id=$4",
          [role, status, category ?? member.category, member.id],
        );
        await c.query(
          "INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'member.updated',$3)",
          [
            req.tenantId,
            req.user.id,
            JSON.stringify({
              userId: req.params.id,
              role,
              status,
              category: category ?? member.category,
            }),
          ],
        );
      }
    });
    // Only a change of access ends the person's live connections; a new name or label must not.
    if (touchesAccess)
      req.app.get("io")?.in(`user:${req.params.id}`).disconnectSockets();
    res.json({ status: "success" });
  }),
);
router.delete(
  "/users/:id",
  authenticateToken,
  requireTenantContext,
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const { rows } = await query(
      "DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND role<>'owner' RETURNING id",
      [req.tenantId, req.params.id],
    );
    if (!rows.length) throw fail(404, "Removable member not found");
    req.app.get("io")?.in(`user:${req.params.id}`).disconnectSockets();
    res.json({ status: "success" });
  }),
);
export default router;
