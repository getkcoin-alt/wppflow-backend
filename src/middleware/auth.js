import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { ENV } from "../config/env.js";
import { query } from "../db/index.js";
import { fail } from "./http.js";

export async function authenticateToken(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token) throw fail(401, "Authentication required");
    if (token.startsWith("wpp_")) {
      const { rows } = await query(
        "UPDATE api_keys SET last_used_at=now() WHERE key_hash=$1 AND revoked_at IS NULL RETURNING id,tenant_id,scopes",
        [crypto.createHash("sha256").update(token).digest("hex")],
      );
      if (!rows[0]) throw fail(401, "Invalid API credential");
      req.apiKey = rows[0];
      req.tenantId = rows[0].tenant_id;
      req.user = { id: null, name: "API", isSuperAdmin: false };
      return next();
    }
    let decoded;
    try {
      decoded = jwt.verify(token, ENV.JWT_SECRET);
    } catch {
      throw fail(401, "Access session expired");
    }
    const { rows } = await query(
      "SELECT id,email,name,status,is_superadmin FROM users WHERE id=$1",
      [decoded.userId || decoded.id],
    );
    if (!rows[0] || rows[0].status !== "active")
      throw fail(401, "Account is inactive");
    req.user = { ...rows[0], isSuperAdmin: Boolean(rows[0].is_superadmin) };
    req.tenantId = decoded.tenantId || null;
    next();
  } catch (error) {
    next(error);
  }
}
export async function requireTenantContext(req, res, next) {
  try {
    if (req.apiKey) {
      req.membership = { role: "api" };
      return next();
    }
    const requested = req.headers["x-tenant-id"] || req.tenantId;
    const { rows } = await query(
      `SELECT t.*,m.role,m.status AS membership_status FROM memberships m JOIN tenants t ON t.id=m.tenant_id
      WHERE m.user_id=$1 AND m.status='active' ${requested ? "AND t.id=$2" : ""} ORDER BY m.created_at,t.id LIMIT 1`,
      requested ? [req.user.id, requested] : [req.user.id],
    );
    if (!rows[0]) throw fail(403, "No authorized workspace membership");
    req.tenantId = rows[0].id;
    req.tenant = { ...rows[0], sessionsLimit: rows[0].sessions_limit };
    req.membership = { role: rows[0].role };
    next();
  } catch (error) {
    next(error);
  }
}
export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (req.user?.isSuperAdmin || roles.includes(req.membership?.role))
      return next();
    next(fail(403, "You do not have permission for this action"));
  };
export const requireScope = (scope) => (req, res, next) => {
  if (!req.apiKey || req.apiKey.scopes.includes(scope)) return next();
  next(fail(403, "API credential lacks the required scope"));
};
export const requireWriteAccess = (req, res, next) => {
  if (
    ["GET", "HEAD", "OPTIONS"].includes(req.method) ||
    req.apiKey ||
    req.user?.isSuperAdmin ||
    ["owner", "admin", "agent"].includes(req.membership?.role)
  )
    return next();
  next(fail(403, "This membership is read-only"));
};
