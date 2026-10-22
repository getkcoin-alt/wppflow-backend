import express from "express";
import { checkDatabaseHealth, query } from "../db/index.js";
import { BUILD } from "../config/build.js";
import { defaultWhatsAppProvider } from "../services/whatsapp/WhatsAppProvider.js";
import { getEmailServiceStatus } from "../services/emailService.js";

const router = express.Router();

router.get("/health", async (req, res) => {
  const dbHealth = await checkDatabaseHealth();
  const activeSessionsCount = [
    ...defaultWhatsAppProvider.sessions.values(),
  ].filter((s) => s.status === "CONNECTED" && s.client).length;

  const isHealthy = dbHealth.isConnected;
  let schemaVersion = null;
  if (isHealthy)
    schemaVersion = await query(
      "SELECT max(version) AS v FROM schema_migrations",
    )
      .then(({ rows }) => rows[0]?.v || null)
      .catch(() => null);
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? "ok" : "degraded",
    engine: "scriwo-engine",
    version: "3.0.0",
    apiContract: 3,
    database: {
      connected: dbHealth.isConnected,
      type: "PostgreSQL",
    },
    build: BUILD,
    schemaVersion,
    emailService: getEmailServiceStatus(),
    activeSessions: activeSessionsCount,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

export default router;
