import jwt from 'jsonwebtoken';
import { ENV } from '../config/env.js';
import { query } from '../db/index.js';

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ status: 'error', message: 'Authentication required. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, ENV.JWT_SECRET);
    req.user = {
      id: decoded.userId || decoded.id,
      email: decoded.email,
      isSuperAdmin: Boolean(decoded.isSuperAdmin)
    };
    req.tenantId = decoded.tenantId || req.headers['x-tenant-id'] || null;
    req.role = decoded.role || 'agent';
    next();
  } catch (err) {
    return res.status(403).json({ status: 'error', message: 'Invalid or expired access token.' });
  }
}

/**
 * Middleware: Derives and enforces active tenant context from database membership
 */
export async function requireTenantContext(req, res, next) {
  if (!req.user?.id) {
    return res.status(401).json({ status: 'error', message: 'User authentication required.' });
  }

  const requestedTenantId = req.headers['x-tenant-id'] || req.tenantId;

  try {
    let membershipQuery = `
      SELECT m.tenant_id, m.role, t.name as tenant_name, t.slug as tenant_slug, t.sessions_limit
      FROM memberships m
      JOIN tenants t ON m.tenant_id = t.id
      WHERE m.user_id = $1
    `;
    const params = [req.user.id];

    if (requestedTenantId) {
      membershipQuery += ' AND m.tenant_id = $2';
      params.push(requestedTenantId);
    } else {
      membershipQuery += ' ORDER BY m.created_at ASC LIMIT 1';
    }

    const { rows } = await query(membershipQuery, params);

    if (rows.length === 0) {
      return res.status(403).json({
        status: 'error',
        message: 'No active tenant membership found for this user.'
      });
    }

    const activeMembership = rows[0];
    req.tenantId = activeMembership.tenant_id;
    req.tenant = {
      id: activeMembership.tenant_id,
      name: activeMembership.tenant_name,
      slug: activeMembership.tenant_slug,
      sessionsLimit: activeMembership.sessions_limit
    };
    req.membership = {
      role: activeMembership.role
    };

    next();
  } catch (err) {
    console.error('Tenant context error:', err);
    return res.status(500).json({ status: 'error', message: 'Failed to resolve tenant authorization.' });
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (req.user?.isSuperAdmin) return next();
    const userRole = req.membership?.role || req.role;
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        status: 'error',
        message: `Forbidden: requires one of roles [${allowedRoles.join(', ')}]`
      });
    }
    next();
  };
}
