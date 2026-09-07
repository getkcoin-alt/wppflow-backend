import express from 'express';
import jwt from 'jsonwebtoken';
import { 
  createUser, 
  findUserByEmail, 
  findUserById, 
  getAllUsers, 
  comparePassword,
  getDatabaseStatus 
} from '../db.js';

const router = express.Router();
export const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
  process.exit(1);
}

// Middleware to authenticate Bearer token
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ status: 'error', message: 'Authentication required. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ status: 'error', message: 'Invalid or expired token.' });
  }
}

/**
 * POST /api/auth/signup
 * Register a new organisation / user.
 *
 * Role assignment rules (most restrictive wins):
 *  1. Only the very first account in an empty database becomes admin.
 *  2. An explicit role='admin' body param is accepted ONLY when an existing
 *     admin is making the request (req.user present and role === 'admin').
 *  3. All other signups are forced to 'user' — no email-string sniffing.
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, password, name, companyName, role: requestedRole } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Name, email, and password (min 6 characters) are required.' 
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Password must be at least 6 characters long.' 
      });
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ 
        status: 'error', 
        message: 'An account with this email already exists. Please log in.' 
      });
    }

    // Determine role — never trust the client unless an authenticated admin asked
    const isAdminRequest = req.user && req.user.role === 'admin';
    let assignedRole = 'user';
    if (isAdminRequest && requestedRole === 'admin') {
      assignedRole = 'admin';
    }

    // First-ever account (empty DB) becomes the initial admin
    const allUsers = await getAllUsers();
    if (allUsers.length === 0) {
      assignedRole = 'admin';
    }

    const plan = assignedRole === 'admin' ? 'Enterprise' : 'Growth';
    const sessions_limit = assignedRole === 'admin' ? 25 : 5;

    const user = await createUser({
      email,
      password,
      name,
      company_name: companyName || `${name.split(' ')[0]}'s Workspace`,
      role: assignedRole,
      plan,
      sessions_limit
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      status: 'success',
      message: 'Account created successfully!',
      token,
      user
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Internal signup error' });
  }
});

/**
 * POST /api/auth/login
 * Authenticate existing user
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Email and password are required.' 
      });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Invalid email or password.' 
      });
    }

    const isMatch = await comparePassword(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Invalid email or password.' 
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    const { password_hash: _, ...safeUser } = user;

    res.json({
      status: 'success',
      message: 'Login successful!',
      token,
      user: safeUser
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Internal login error' });
  }
});

/**
 * GET /api/auth/me
 * Get currently authenticated user profile
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    res.json({
      status: 'success',
      user
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch user profile' });
  }
});

/**
 * GET /api/auth/users
 * List all tenants / registered users (Admin access)
 */
router.get('/users', authenticateToken, async (req, res) => {
  try {
    const actor = await findUserById(req.user.id);
    if (!actor || !['admin', 'superadmin'].includes(actor.role)) {
      return res.status(403).json({ status: 'error', message: 'Admin access required.' });
    }
    const users = await getAllUsers();
    res.json({
      status: 'success',
      count: users.length,
      users,
      database: getDatabaseStatus()
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch users list' });
  }
});

function isSuperAdmin(user) {
  return user?.role === 'superadmin' || user?.email === process.env.SUPERADMIN_EMAIL || user?.email === 'admin@wppflow.io';
}

function temporaryPassword() {
  return `${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function deliverCredentials({ email, name, companyName, password }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return { delivered: false, reason: 'email_not_configured' };
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `Your ${companyName} WppFlow workspace access`,
        text: `Hi ${name},\n\nYour WppFlow workspace has been created.\n\nEmail: ${email}\nTemporary password: ${password}\n\nSign in at ${process.env.APP_URL || 'https://wppflow-beige.vercel.app/'} and change your password after login.`,
      }),
    });
    if (!response.ok) return { delivered: false, reason: 'email_provider_rejected' };
    return { delivered: true };
  } catch (error) {
    console.warn('Credential email delivery failed:', error.message);
    return { delivered: false, reason: 'email_provider_unavailable' };
  }
}

/** Provision a company admin or workspace agent from an authorized admin. */
router.post('/users', authenticateToken, async (req, res) => {
  try {
    const actor = await findUserById(req.user.id);
    if (!actor || !['admin', 'superadmin'].includes(actor.role)) {
      return res.status(403).json({ status: 'error', message: 'Admin access required.' });
    }
    const { email, name, companyName, role: requestedRole, password: suppliedPassword } = req.body || {};
    if (!email || !name) return res.status(400).json({ status: 'error', message: 'Name and email are required.' });
    const superAdmin = isSuperAdmin(actor);
    const role = superAdmin
      ? (['admin', 'superadmin'].includes(requestedRole) ? requestedRole : 'user')
      : (['sales', 'support', 'user'].includes(requestedRole) ? requestedRole : 'user');
    const workspaceName = superAdmin ? String(companyName || '').trim() : actor.company_name;
    if (!workspaceName) return res.status(400).json({ status: 'error', message: 'companyName is required when creating a company.' });
    const password = suppliedPassword || temporaryPassword();
    const user = await createUser({ email, password, name, company_name: workspaceName, role });
    const emailDelivery = await deliverCredentials({ email: user.email, name: user.name, companyName: workspaceName, password });
    res.status(201).json({
      status: 'success',
      message: emailDelivery.delivered ? 'User created and credentials emailed.' : 'User created. Configure RESEND_API_KEY and EMAIL_FROM to email credentials automatically.',
      user,
      emailDelivery,
      temporaryPassword: emailDelivery.delivered ? undefined : password,
    });
  } catch (error) {
    const status = /already registered/i.test(error.message) ? 409 : 500;
    res.status(status).json({ status: 'error', message: error.message || 'Could not create user.' });
  }
});

/**
 * GET /api/auth/status
 * Public status of auth and DB connectivity
 */
router.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    auth: 'jwt-ready',
    database: getDatabaseStatus()
  });
});

export default router;
