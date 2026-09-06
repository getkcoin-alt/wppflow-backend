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
const JWT_SECRET = process.env.JWT_SECRET;
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
 * Register a new organization / user
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, password, name, companyName, role } = req.body;

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

    // Determine role (first user or admin email becomes admin)
    const assignedRole = role === 'admin' || email.toLowerCase().includes('admin') ? 'admin' : 'user';
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
