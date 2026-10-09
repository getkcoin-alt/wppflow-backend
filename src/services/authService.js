import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { ENV } from '../config/env.js';
import { query, withTransaction } from '../db/index.js';

export async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

export async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

export function generateAccessToken(user, tenantId, role) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      tenantId,
      role,
      isSuperAdmin: Boolean(user.is_superadmin)
    },
    ENV.JWT_SECRET,
    { expiresIn: ENV.JWT_ACCESS_EXPIRES_IN }
  );
}

export async function generateRefreshToken(userId) {
  const tokenString = crypto.randomBytes(40).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(tokenString).digest('hex');
  const tokenId = `rf_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const expiresAt = new Date(Date.now() + ENV.JWT_REFRESH_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000);

  await query(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
    VALUES ($1, $2, $3, $4)
  `, [tokenId, userId, tokenHash, expiresAt]);

  return { tokenId, refreshToken: `${tokenId}.${tokenString}` };
}

export async function rotateRefreshToken(tokenValue) {
  const parts = String(tokenValue || '').split('.');
  if (parts.length !== 2) throw new Error('Invalid refresh token format.');
  const [tokenId, tokenSecret] = parts;
  const tokenHash = crypto.createHash('sha256').update(tokenSecret).digest('hex');

  const { rows } = await query(`
    SELECT r.id, r.user_id, r.revoked, r.expires_at, u.status, u.email, u.name, u.is_superadmin
    FROM refresh_tokens r
    JOIN users u ON r.user_id = u.id
    WHERE r.id = $1 AND r.token_hash = $2
  `, [tokenId, tokenHash]);

  if (rows.length === 0) throw new Error('Refresh token not found.');
  const tokenRecord = rows[0];

  if (tokenRecord.revoked) {
    // Possible token reuse attack! Revoke all tokens for user
    await query(`UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`, [tokenRecord.user_id]);
    throw new Error('Revoked refresh token reuse detected.');
  }

  if (new Date() > new Date(tokenRecord.expires_at)) {
    throw new Error('Refresh token expired.');
  }

  if (tokenRecord.status !== 'active') {
    throw new Error('Account is not active.');
  }

  // Revoke old token and issue new pair
  await query(`UPDATE refresh_tokens SET revoked = true WHERE id = $1`, [tokenId]);
  return await generateRefreshToken(tokenRecord.user_id);
}

export async function revokeAllRefreshTokens(userId) {
  await query(`UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`, [userId]);
}

export async function registerTenantAndUser({ name, email, password, companyName }) {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  const tenantId = `tenant_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const slug = `${(companyName || name).toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now().toString(36)}`;

  return await withTransaction(async (client) => {
    // 1. Create User
    const userRes = await client.query(`
      INSERT INTO users (email, password_hash, name, is_superadmin, status)
      VALUES ($1, $2, $3, false, 'active')
      RETURNING id, email, name, is_superadmin, status, created_at
    `, [normalizedEmail, passwordHash, name.trim()]);
    const user = userRes.rows[0];

    // 2. Create Tenant
    const tenantRes = await client.query(`
      INSERT INTO tenants (id, name, slug, plan, sessions_limit)
      VALUES ($1, $2, $3, 'Enterprise', 25)
      RETURNING id, name, slug, plan, sessions_limit
    `, [tenantId, (companyName || `${name}'s Workspace`).trim(), slug]);
    const tenant = tenantRes.rows[0];

    // 3. Create Membership as Owner
    await client.query(`
      INSERT INTO memberships (tenant_id, user_id, role)
      VALUES ($1, $2, 'owner')
    `, [tenant.id, user.id]);

    // 4. Audit Log
    await client.query(`
      INSERT INTO audit_events (tenant_id, actor_id, event_type, metadata)
      VALUES ($1, $2, 'tenant.created', $3)
    `, [tenant.id, user.id, JSON.stringify({ tenantName: tenant.name, email: user.email })]);

    return { user, tenant, role: 'owner' };
  });
}
