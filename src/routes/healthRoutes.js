import express from 'express';
import { checkDatabaseHealth } from '../db/index.js';
import { defaultWhatsAppProvider } from '../services/whatsapp/WhatsAppProvider.js';

const router = express.Router();

router.get('/health', async (req, res) => {
  const dbHealth = await checkDatabaseHealth();
  const activeSessionsCount = defaultWhatsAppProvider.sessions.size;

  const isHealthy = dbHealth.isConnected;
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    engine: 'wppflow-enterprise-engine',
    version: '3.0.0',
    database: {
      connected: dbHealth.isConnected,
      type: 'PostgreSQL'
    },
    activeSessions: activeSessionsCount,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

export default router;
