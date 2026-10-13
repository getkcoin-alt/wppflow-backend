import express from 'express';
import { 
  registerTenantAndUser, 
  comparePassword, 
  generateAccessToken, 
  generateRefreshToken, 
  rotateRefreshToken, 
  revokeAllRefreshTokens 
} from '../services/authService.js';
import { authenticateToken } from '../middleware/auth.js';
import { authRateLimiter } from '../middleware/rateLimiter.js';
import { query } from '../db/index.js';

const router = express.Router();

/**
 * POST /api/auth/signup
 */
router.post('/signup', authRateLimiter, async (req, res) => {
  try {
    const { email, password, name, companyName } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({
        status: 'error',
        message: 'Name, email, and password (minimum 8 characters) are required.'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        status: 'error',
        message: 'Password must be at least 8 characters long.'
      });
    }

    const { rows: existing } = await query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (existing.length > 0) {
      return res.status(409).json({
        status: 'error',
        message: 'An account with this email already exists. Please log in.'
      });
    }

    const { user, tenant, role } = await registerTenantAndUser({
      email,
      password,
      name,
      companyName
    });

    const accessToken = generateAccessToken(user, tenant.id, role);
    const { refreshToken } = await generateRefreshToken(user.id);

    // Set secure HttpOnly refresh cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.status(201).json({
      status: 'success',
      message: 'Workspace created successfully!',
      token: accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isSuperAdmin: user.is_superadmin
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        role
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Internal signup error' });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', authRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        status: 'error',
        message: 'Email and password are required.'
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const { rows: users } = await query(
      `SELECT id, email, password_hash, name, is_superadmin, status FROM users WHERE email = $1`,
      [normalizedEmail]
    );

    if (users.length === 0) {
      return res.status(401).json({ status: 'error', message: 'Invalid email or password.' });
    }

    const user = users[0];

    if (user.status !== 'active') {
      return res.status(403).json({
        status: 'error',
        code: 'ACCOUNT_SUSPENDED',
        message: 'Account is not active. Please contact your workspace administrator.'
      });
    }

    const isMatch = await comparePassword(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ status: 'error', message: 'Invalid email or password.' });
    }

    // Resolve tenant memberships
    const { rows: memberships } = await query(`
      SELECT m.tenant_id, m.role, t.name as tenant_name, t.slug as tenant_slug, t.plan
      FROM memberships m
      JOIN tenants t ON m.tenant_id = t.id
      WHERE m.user_id = $1
      ORDER BY m.created_at ASC
    `, [user.id]);

    let activeTenant = null;
    let activeRole = 'agent';

    if (memberships.length > 0) {
      activeTenant = {
        id: memberships[0].tenant_id,
        name: memberships[0].tenant_name,
        slug: memberships[0].tenant_slug,
        plan: memberships[0].plan
      };
      activeRole = memberships[0].role;
    } else {
      // Auto-provision a personal tenant if none exists
      const tenantId = `tenant_user_${user.id}`;
      await query(`
        INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING
      `, [tenantId, `${user.name}'s Workspace`, `workspace-${user.id}`]);
      await query(`
        INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING
      `, [tenantId, user.id]);
      activeTenant = { id: tenantId, name: `${user.name}'s Workspace`, slug: `workspace-${user.id}` };
      activeRole = 'owner';
    }

    const accessToken = generateAccessToken(user, activeTenant.id, activeRole);
    const { refreshToken } = await generateRefreshToken(user.id);

    // Audit log
    await query(`
      INSERT INTO audit_events (tenant_id, actor_id, event_type, metadata)
      VALUES ($1, $2, 'auth.login_success', $3)
    `, [activeTenant.id, user.id, JSON.stringify({ ip: req.ip })]);

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      status: 'success',
      message: 'Login successful!',
      token: accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isSuperAdmin: user.is_superadmin
      },
      tenant: {
        id: activeTenant.id,
        name: activeTenant.name,
        slug: activeTenant.slug,
        role: activeRole
      },
      memberships: memberships.map(m => ({
        tenantId: m.tenant_id,
        tenantName: m.tenant_name,
        role: m.role
      }))
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Internal login error' });
  }
});

/**
 * POST /api/auth/refresh
 */
router.post('/refresh', async (req, res) => {
  const tokenValue = req.body?.refreshToken || req.cookies?.refreshToken;
  if (!tokenValue) {
    return res.status(400).json({ status: 'error', message: 'Refresh token is required.' });
  }

  try {
    const { refreshToken: newRefreshToken, tokenId } = await rotateRefreshToken(tokenValue);
    const { rows } = await query(`
      SELECT r.user_id, u.email, u.name, u.is_superadmin
      FROM refresh_tokens r
      JOIN users u ON r.user_id = u.id
      WHERE r.id = $1
    `, [tokenId]);

    const user = rows[0];

    // Resolve tenant
    const { rows: memberships } = await query(`
      SELECT tenant_id, role FROM memberships WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1
    `, [user.user_id]);

    const tenantId = memberships[0]?.tenant_id || null;
    const role = memberships[0]?.role || 'agent';

    const accessToken = generateAccessToken(
      { id: user.user_id, email: user.email, is_superadmin: user.is_superadmin },
      tenantId,
      role
    );

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      status: 'success',
      token: accessToken,
      refreshToken: newRefreshToken
    });
  } catch (err) {
    return res.status(401).json({ status: 'error', message: err.message || 'Token refresh failed.' });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    await revokeAllRefreshTokens(req.user.id);
    res.clearCookie('refreshToken');
    res.json({ status: 'success', message: 'Logged out successfully.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/auth/me
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const { rows: users } = await query(
      `SELECT id, email, name, is_superadmin, status, created_at FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    const { rows: memberships } = await query(`
      SELECT m.tenant_id, m.role, t.name as tenant_name, t.slug as tenant_slug, t.plan
      FROM memberships m
      JOIN tenants t ON m.tenant_id = t.id
      WHERE m.user_id = $1
      ORDER BY m.created_at ASC
    `, [req.user.id]);

    const activeTenantId = req.tenantId || memberships[0]?.tenant_id;
    const activeMembership = memberships.find(m => m.tenant_id === activeTenantId) || memberships[0];

    res.json({
      status: 'success',
      user: users[0],
      tenant: activeMembership ? {
        id: activeMembership.tenant_id,
        name: activeMembership.tenant_name,
        slug: activeMembership.tenant_slug,
        role: activeMembership.role
      } : null,
      memberships: memberships.map(m => ({
        tenantId: m.tenant_id,
        tenantName: m.tenant_name,
        role: m.role
      }))
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/auth/switch-tenant
 */
router.post('/switch-tenant', authenticateToken, async (req, res) => {
  const { tenantId } = req.body;
  if (!tenantId) {
    return res.status(400).json({ status: 'error', message: 'tenantId is required.' });
  }

  try {
    const { rows } = await query(`
      SELECT m.role, t.id, t.name, t.slug, t.plan
      FROM memberships m
      JOIN tenants t ON m.tenant_id = t.id
      WHERE m.user_id = $1 AND m.tenant_id = $2
    `, [req.user.id, tenantId]);

    if (rows.length === 0) {
      return res.status(403).json({ status: 'error', message: 'You do not have access to this workspace.' });
    }

    const target = rows[0];
    const { rows: users } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const newToken = generateAccessToken(users[0], target.id, target.role);

    res.json({
      status: 'success',
      token: newToken,
      tenant: {
        id: target.id,
        name: target.name,
        slug: target.slug,
        role: target.role
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/auth/users
 * List users in current tenant (or all users if platform superadmin)
 */
router.get('/users', authenticateToken, async (req, res) => {
  try {
    const isSuperAdmin = Boolean(req.user.isSuperAdmin || req.user.is_superadmin);
    let usersQuery;
    let params;

    if (isSuperAdmin && !req.tenantId) {
      usersQuery = `
        SELECT u.id, u.email, u.name, u.status, u.is_superadmin, u.created_at,
               COALESCE(m.role, 'user') as role,
               COALESCE(t.name, 'WppFlow Workspace') as company
        FROM users u
        LEFT JOIN memberships m ON m.user_id = u.id
        LEFT JOIN tenants t ON m.tenant_id = t.id
        ORDER BY u.created_at DESC
      `;
      params = [];
    } else {
      const tenantId = req.tenantId || req.user.tenantId;
      usersQuery = `
        SELECT u.id, u.email, u.name, u.status, u.is_superadmin, u.created_at,
               m.role, t.name as company
        FROM memberships m
        JOIN users u ON m.user_id = u.id
        JOIN tenants t ON m.tenant_id = t.id
        WHERE m.tenant_id = $1
        ORDER BY u.created_at ASC
      `;
      params = [tenantId];
    }

    const { rows } = await query(usersQuery, params);
    const formatted = rows.map(u => ({
      id: String(u.id),
      name: u.name,
      email: u.email,
      avatar: `https://images.unsplash.com/photo-1535713875002?w=120&auto=format&fit=crop&q=80`,
      role: u.role === 'owner' ? 'tenant_admin' : (u.role === 'admin' ? 'tenant_admin' : 'agent'),
      company: u.company || 'WppFlow Workspace',
      plan: 'enterprise',
      status: u.status || 'active',
      whatsappSessionsQuota: 5,
      activeSessionsCount: 1,
      monthlyBroadcastLimit: 10000,
      broadcastsUsed: 0,
      teamSeats: 10,
      apiCallsThisMonth: 0,
      createdAt: u.created_at,
      lastLogin: u.created_at
    }));

    res.json({ status: 'success', users: formatted });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/auth/users
 * Add user / member to tenant
 */
router.post('/users', authenticateToken, async (req, res) => {
  try {
    const { email, password, name, role = 'agent' } = req.body;
    if (!email || !name) {
      return res.status(400).json({ status: 'error', message: 'Name and email are required.' });
    }

    const tenantId = req.tenantId || req.user.tenantId;
    if (!tenantId) {
      return res.status(400).json({ status: 'error', message: 'Tenant context required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const defaultPassword = password || 'TempPass123!';
    const passwordHash = await hashPassword(defaultPassword);

    let userId;
    const { rows: existingUser } = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existingUser.length > 0) {
      userId = existingUser[0].id;
    } else {
      const { rows: newUser } = await query(`
        INSERT INTO users (email, password_hash, name, status)
        VALUES ($1, $2, $3, 'active')
        RETURNING id
      `, [normalizedEmail, passwordHash, name.trim()]);
      userId = newUser[0].id;
    }

    const membershipRole = role.includes('admin') ? 'admin' : 'agent';
    await query(`
      INSERT INTO memberships (tenant_id, user_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `, [tenantId, userId, membershipRole]);

    res.status(201).json({
      status: 'success',
      message: 'User added to workspace successfully.',
      user: { id: String(userId), email: normalizedEmail, name: name.trim(), role: membershipRole }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * PATCH /api/auth/users/:id
 * Update user status or role
 */
router.patch('/users/:id', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const tenantId = req.tenantId || req.user.tenantId;
    const { status, role } = req.body;

    if (status) {
      await query(`UPDATE users SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [status, userId]);
    }

    if (role && tenantId) {
      const membershipRole = role.includes('admin') ? 'admin' : 'agent';
      await query(`
        UPDATE memberships SET role = $1, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $2 AND tenant_id = $3
      `, [membershipRole, userId, tenantId]);
    }

    res.json({ status: 'success', message: 'User updated successfully' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * DELETE /api/auth/users/:id
 * Remove user from workspace
 */
router.delete('/users/:id', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const tenantId = req.tenantId || req.user.tenantId;

    if (tenantId) {
      await query(`DELETE FROM memberships WHERE user_id = $1 AND tenant_id = $2`, [userId, tenantId]);
    }

    res.json({ status: 'success', message: 'User removed from workspace.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;
