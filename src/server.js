import http from "http";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";

import { ENV } from "./config/env.js";
import { checkDatabaseHealth, closePool, query } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { initMessageQueue, closeQueue } from "./services/queue/messageQueue.js";

import authRoutes from "./routes/authRoutes.js";
import conversationRoutes from "./routes/conversationRoutes.js";
import sessionRoutes from "./routes/sessionRoutes.js";
import campaignRoutes from "./routes/campaignRoutes.js";
import contactRoutes from "./routes/contactRoutes.js";
import automationRoutes from "./routes/automationRoutes.js";
import healthRoutes from "./routes/healthRoutes.js";
import workspaceRoutes from "./routes/workspaceRoutes.js";
import mediaRoutes from "./routes/mediaRoutes.js";
import emailRoutes from "./routes/emailRoutes.js";
import { errorHandler } from "./middleware/http.js";
import { restoreSessions, closeSessions } from "./services/sessionService.js";
import { startDomainJobs, stopDomainJobs } from "./services/domainJobs.js";

const app = express();
const server = http.createServer(app);

// 1. Security & CORS Configuration
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (
        ENV.ALLOWED_ORIGINS.includes("*") ||
        ENV.ALLOWED_ORIGINS.includes(origin)
      ) {
        return callback(null, true);
      }
      return callback(
        new Error(`Origin ${origin} not permitted by CORS policy`),
      );
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
      "X-Tenant-Id",
    ],
  }),
);

app.use(cookieParser());
app.use(express.json({ limit: ENV.BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: ENV.BODY_LIMIT }));

// 2. Authenticated Socket.IO Server with strict membership authorization
const io = new SocketIOServer(server, {
  cors: {
    origin: ENV.ALLOWED_ORIGINS,
    credentials: true,
  },
});
app.set("io", io);

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) {
    return next(new Error("Authentication token required"));
  }

  try {
    const cleanToken = token.startsWith("Bearer ") ? token.slice(7) : token;
    const decoded = jwt.verify(cleanToken, ENV.JWT_SECRET);
    const userId = decoded.userId || decoded.id;

    // Verify user is active in database and resolve authorized tenant memberships
    const { rows: userRows } = await query(
      "SELECT id, email, status, is_superadmin FROM users WHERE id = $1",
      [userId],
    );

    if (userRows.length === 0 || userRows[0].status !== "active") {
      return next(new Error("User account is invalid or deactivated"));
    }

    const { rows: memberships } = await query(
      "SELECT tenant_id, role FROM memberships WHERE user_id = $1 AND status='active'",
      [userId],
    );

    socket.user = {
      ...decoded,
      isSuperAdmin: Boolean(userRows[0].is_superadmin),
    };

    const requestedTenant =
      socket.handshake.auth?.tenantId ||
      socket.handshake.query?.tenantId ||
      decoded.tenantId;

    // Only join tenant rooms where user holds server-verified membership
    const hasMembership = memberships.some(
      (m) => m.tenant_id === requestedTenant,
    );
    if (requestedTenant && hasMembership) {
      socket.tenantId = requestedTenant;
    } else if (requestedTenant) {
      return next(new Error("Workspace access denied"));
    } else if (memberships.length > 0) {
      socket.tenantId = memberships[0].tenant_id;
    } else {
      return next(new Error("No authorized workspace"));
    }
    socket.membershipRole = memberships.find(
      (m) => m.tenant_id === socket.tenantId,
    )?.role;

    next();
  } catch (err) {
    next(new Error("Invalid socket authentication token"));
  }
});

io.on("connection", (socket) => {
  const userId = socket.user?.userId || socket.user?.id;
  const tenantId = socket.tenantId;

  if (tenantId) {
    socket.join(`tenant:${tenantId}`);
    if (["owner", "admin"].includes(socket.membershipRole))
      socket.join(`tenant:${tenantId}:managers`);
  }
  if (userId) {
    socket.join(`user:${userId}`);
  }
  const expiry = Math.max(1, (socket.user.exp || 0) * 1000 - Date.now());
  const expiryTimer = setTimeout(
    () => socket.disconnect(true),
    Math.min(expiry, 2147483647),
  );
  expiryTimer.unref();
  const membershipTimer = setInterval(async () => {
    try {
      const { rows } = await query(
        "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.tenant_id=$2 AND m.status='active' AND u.status='active'",
        [userId, tenantId],
      );
      if (!rows.length) socket.disconnect(true);
    } catch {
      socket.disconnect(true);
    }
  }, 30000);
  membershipTimer.unref();

  socket.on("disconnect", () => {
    clearTimeout(expiryTimer);
    clearInterval(membershipTimer);
  });
});

// 3. API Routes
app.use(healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/automations", automationRoutes);
app.use("/api/workspace", workspaceRoutes);
app.use("/api/attachments", mediaRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/mail", emailRoutes);

// Backward compatibility alias for /api/chats
app.use("/api/chats", conversationRoutes);
app.use((req, res) =>
  res.status(404).json({ status: "error", message: "Endpoint not found" }),
);
app.use(errorHandler);

// 4. Server Lifecycle & Initialization
export async function startServer() {
  console.log("🚀 Starting WppFlow Enterprise Backend Engine...");
  console.log(`📁 Environment: ${ENV.NODE_ENV} | Port: ${ENV.PORT}`);

  // 1. Verify PostgreSQL Database
  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.isConnected) {
    const errorMsg = `PostgreSQL connection failed: ${dbHealth.error}`;
    console.error(`❌ ${errorMsg}`);
    throw new Error("Database unavailable; startup cancelled");
  } else {
    console.log("✅ PostgreSQL database connected successfully.");
  }

  // 2. Await Migrations
  try {
    if (ENV.AUTO_MIGRATE) await runMigrations();
    else {
      const { rows } = await query(
        "SELECT 1 FROM schema_migrations WHERE version='004_configure_superadmin'",
      );
      if (!rows.length)
        throw new Error(
          "Run the reviewed database migration before starting this release",
        );
    }
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    throw err;
  }

  // 3. Initialize Message Queue
  await initMessageQueue(io);
  await restoreSessions(io);
  startDomainJobs(io);

  // 4. Listen on configured port
  return new Promise((resolve) => {
    server.listen(ENV.PORT, () => {
      console.log(`✨ WppFlow Core Backend running on port ${ENV.PORT}`);
      resolve(server);
    });
  });
}

export async function stopServer() {
  await stopDomainJobs();
  await closeQueue();
  await closeSessions(io);
  io.disconnectSockets(true);
  await new Promise((resolve) => io.close(resolve));
  await closePool();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => stopServer().finally(() => process.exit(0)));

export { app, server, io };

// Auto-start when executed directly
if (process.argv[1]?.endsWith("server.js")) {
  startServer().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
