import http from 'http';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { Server as SocketIOServer } from 'socket.io';
import jwt from 'jsonwebtoken';

import { ENV } from './config/env.js';
import { checkDatabaseHealth, closePool, query } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { initMessageQueue, closeQueue } from './services/queue/messageQueue.js';

import authRoutes from './routes/authRoutes.js';
import conversationRoutes from './routes/conversationRoutes.js';
import sessionRoutes from './routes/sessionRoutes.js';
import campaignRoutes from './routes/campaignRoutes.js';
import contactRoutes from './routes/contactRoutes.js';
import automationRoutes from './routes/automationRoutes.js';
import healthRoutes from './routes/healthRoutes.js';

const app = express();
const server = http.createServer(app);

// 1. Security & CORS Configuration
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (ENV.ALLOWED_ORIGINS.includes('*') || ENV.ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} not permitted by CORS policy`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'X-Tenant-Id']
}));

app.use(cookieParser());
app.use(express.json({ limit: ENV.BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: ENV.BODY_LIMIT }));

// 2. Authenticated Socket.IO Server with strict membership authorization
const io = new SocketIOServer(server, {
  cors: {
    origin: ENV.ALLOWED_ORIGINS,
    credentials: true
  }
});
app.set('io', io);

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) {
    return next(new Error('Authentication token required'));
  }

  try {
    const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
    const decoded = jwt.verify(cleanToken, ENV.JWT_SECRET);
    const userId = decoded.userId || decoded.id;

    // Verify user is active in database and resolve authorized tenant memberships
    const { rows: userRows } = await query(
      'SELECT id, email, status, is_superadmin FROM users WHERE id = $1',
      [userId]
    );

    if (userRows.length === 0 || userRows[0].status !== 'active') {
      return next(new Error('User account is invalid or deactivated'));
    }

    const { rows: memberships } = await query(
      'SELECT tenant_id, role FROM memberships WHERE user_id = $1',
      [userId]
    );

    socket.user = {
      ...decoded,
      isSuperAdmin: Boolean(userRows[0].is_superadmin)
    };

    const requestedTenant = socket.handshake.auth?.tenantId || socket.handshake.query?.tenantId || decoded.tenantId;

    // Only join tenant rooms where user holds server-verified membership
    const hasMembership = memberships.some(m => m.tenant_id === requestedTenant);
    if (requestedTenant && (hasMembership || userRows[0].is_superadmin)) {
      socket.tenantId = requestedTenant;
    } else if (memberships.length > 0) {
      socket.tenantId = memberships[0].tenant_id;
    } else {
      socket.tenantId = null;
    }

    next();
  } catch (err) {
    next(new Error('Invalid socket authentication token'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.user?.userId || socket.user?.id;
  const tenantId = socket.tenantId;

  if (tenantId) {
    socket.join(`tenant:${tenantId}`);
  }
  if (userId) {
    socket.join(`user:${userId}`);
  }

  socket.on('disconnect', () => {});
});

// 3. API Routes
app.use(healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/automations', automationRoutes);

// Backward compatibility alias for /api/chats
app.use('/api/chats', conversationRoutes);

// 4. Server Lifecycle & Initialization
export async function startServer() {
  console.log('🚀 Starting WppFlow Enterprise Backend Engine...');
  console.log(`📁 Environment: ${ENV.NODE_ENV} | Port: ${ENV.PORT}`);

  // 1. Verify PostgreSQL Database
  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.isConnected) {
    const errorMsg = `PostgreSQL connection failed: ${dbHealth.error}`;
    console.error(`❌ ${errorMsg}`);
    if (ENV.NODE_ENV === 'production') {
      process.exit(1);
    }
  } else {
    console.log('✅ PostgreSQL database connected successfully.');
  }

  // 2. Await Migrations
  try {
    await runMigrations();
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    if (ENV.NODE_ENV === 'production') {
      process.exit(1);
    }
  }

  // 3. Initialize Message Queue
  await initMessageQueue(io);

  // 4. Listen on configured port
  return new Promise((resolve) => {
    server.listen(ENV.PORT, () => {
      console.log(`✨ WppFlow Core Backend running on port ${ENV.PORT}`);
      resolve(server);
    });
  });
}

export async function stopServer() {
  await closeQueue();
  await closePool();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export { app, server, io };

// Auto-start when executed directly
if (process.argv[1]?.endsWith('server.js')) {
  startServer().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
