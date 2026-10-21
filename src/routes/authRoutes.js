import express from "express";
import crypto from "node:crypto";
import {
  registerTenantAndUser,
  comparePassword,
  hashPassword,
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
} from "../services/authService.js";
import {
  authenticateToken,
  requireTenantContext,
  requireRole,
} from "../middleware/auth.js";
import { authRateLimiter } from "../middleware/rateLimiter.js";
import { query, withTransaction } from "../db/index.js";
import { ENV } from "../config/env.js";
import { route, fail, text } from "../middleware/http.js";
import { sendWelcomeEmail, sendInvitationEmail } from "../services/emailService.js";
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
async function context(userId, tenantId) {
  const { rows } = await query(
    `SELECT t.*,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.status='active'
    ${tenantId ? "AND t.id=$2" : ""} ORDER BY m.created_at,t.id LIMIT 1`,
    tenantId ? [userId, tenantId] : [userId],
  );
  if (!rows[0]) throw fail(403, "Workspace access is unavailable");
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
    const tenant = await context(user.id);
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
    const tenant = await context(result.userId, result.tenantId);
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
  requireTenantContext,
  route(async (req, res) => {
    if (req.apiKey) throw fail(403, "Interactive login required");
    const tenant = await context(req.user.id, req.tenantId);
    res.json({ status: "success", user: userView(req.user, tenant), tenant });
  }),
);
router.post(
  "/switch-tenant",
  authenticateToken,
  route(async (req, res) => {
    if (req.apiKey) throw fail(403, "Interactive login required");
    const tenant = await context(
      req.user.id,
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
      `SELECT u.id,u.name,u.email,m.role,m.status,u.created_at,t.name AS company,t.plan,t.sessions_limit,
    (SELECT count(*)::int FROM memberships WHERE tenant_id=t.id AND status='active') AS seats,
    (SELECT count(*)::int FROM whatsapp_sessions WHERE tenant_id=t.id AND status='CONNECTED') AS sessions
    FROM memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1 ORDER BY u.name`,
      [req.tenantId],
    );
    res.json({
      status: "success",
      users: rows.map((u) => ({
        ...u,
        id: String(u.id),
        company_name: u.company,
        role: u.role === "owner" || u.role === "admin" ? "admin" : "user",
        membershipRole: u.role,
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
router.post(
  "/users",
  authenticateToken,
  requireTenantContext,
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const name = text(req.body.name, "Name", 255),
      email = emailOf(req.body.email),
      requested = req.body.role || "agent";
    const role = ["admin", "tenant_admin"].includes(requested)
      ? "admin"
      : "agent";
    if (
      role === "admin" &&
      req.membership.role !== "owner" &&
      !req.user.isSuperAdmin
    )
      throw fail(403, "Only an owner can invite an administrator");
    const token = crypto.randomBytes(32).toString("hex"),
      id = crypto.randomUUID();
    await query(
      `INSERT INTO invitations(id,tenant_id,email,name,role,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours')`,
      [
        id,
        req.tenantId,
        email,
        name,
        role,
        crypto.createHash("sha256").update(token).digest("hex"),
      ],
    );
    await query(
      "INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'member.invited',$3)",
      [req.tenantId, req.user.id, JSON.stringify({ email, role })],
    );
    res.status(201).json({
      status: "success",
      message: "Invitation created. Share this single-use setup link.",
      activationLink: `${ENV.APP_URL}/?invite=${token}`,
      expiresInHours: 24,
    });
    sendInvitationEmail({
      to: email,
      name,
      inviteUrl: `${ENV.APP_URL}/?invite=${token}`,
      workspaceName: req.membership?.tenantName || "Workspace",
      inviterName: req.user?.name || "Administrator",
    }).catch((e) => console.warn(`Invitation email dispatch skipped: ${e.message}`));
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
      if (userId) {
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
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [inv.tenant_id, userId, inv.role],
      );
      await c.query("UPDATE invitations SET accepted_at=now() WHERE id=$1", [
        inv.id,
      ]);
    });
    res.json({
      status: "success",
      message: "Account activated. Log in to continue.",
    });
  }),
);
router.patch(
  "/users/:id",
  authenticateToken,
  requireTenantContext,
  requireRole("owner", "admin"),
  route(async (req, res) => {
    await withTransaction(async (c) => {
      const { rows } = await c.query(
        "SELECT * FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
        [req.tenantId, req.params.id],
      );
      const member = rows[0];
      if (!member) throw fail(404, "Member not found");
      if (member.role === "owner")
        throw fail(403, "Workspace ownership cannot be changed here");
      if (
        req.body.role &&
        req.membership.role !== "owner" &&
        !req.user.isSuperAdmin
      )
        throw fail(403, "Only an owner can change roles");
      const role = req.body.role
        ? ["admin", "tenant_admin"].includes(req.body.role)
          ? "admin"
          : "agent"
        : member.role;
      const status = req.body.status
        ? ["active", "suspended", "blocked"].includes(req.body.status)
          ? req.body.status
          : null
        : member.status;
      if (!status) throw fail(400, "Invalid status");
      await c.query(
        "UPDATE memberships SET role=$1,status=$2,updated_at=now() WHERE id=$3",
        [role, status, member.id],
      );
      await c.query(
        "INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'member.updated',$3)",
        [
          req.tenantId,
          req.user.id,
          JSON.stringify({ userId: req.params.id, role, status }),
        ],
      );
    });
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
