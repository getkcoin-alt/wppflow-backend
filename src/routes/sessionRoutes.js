import express from 'express';
import { authenticateToken, requireTenantContext } from '../middleware/auth.js';
import { defaultWhatsAppProvider } from '../services/whatsapp/WhatsAppProvider.js';
import { query } from '../db/index.js';
import { handleIncomingMessage, handleAckEvent } from '../services/messageService.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireTenantContext);

/**
 * GET /api/sessions
 * List active sessions in this tenant
 */
router.get('/', async (req, res) => {
  try {
    const { rows: sessions } = await query(`
      SELECT id, session_name, status, phone, battery, anti_ban_health, created_at, updated_at
      FROM whatsapp_sessions
      WHERE tenant_id = $1
      ORDER BY created_at ASC
    `, [req.tenantId]);

    // Augment with in-memory provider state if connected
    const enriched = sessions.map(s => {
      const live = defaultWhatsAppProvider.getSession(req.tenantId, s.session_name);
      return {
        ...s,
        liveStatus: live ? live.status : s.status,
        hasQr: Boolean(live?.qrcode),
        qrcode: live?.qrcode || null
      };
    });

    res.json({ status: 'success', sessions: enriched });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/sessions/start
 * Start or restore a WhatsApp session for this tenant
 */
router.post('/start', async (req, res) => {
  const sessionName = req.body?.sessionName || 'primary-whatsapp';
  const io = req.app.get('io');

  try {
    // Check session limit
    const { rows: currentSessions } = await query(`
      SELECT COUNT(*) FROM whatsapp_sessions WHERE tenant_id = $1
    `, [req.tenantId]);

    if (parseInt(currentSessions[0].count, 10) >= (req.tenant.sessionsLimit || 5)) {
      return res.status(403).json({
        status: 'error',
        message: `Plan limit reached: maximum ${req.tenant.sessionsLimit} sessions allowed.`
      });
    }

    const sessionId = `sess_${req.tenantId}_${sessionName}`;
    await query(`
      INSERT INTO whatsapp_sessions (id, tenant_id, session_name, status)
      VALUES ($1, $2, $3, 'STARTING')
      ON CONFLICT (tenant_id, session_name) DO UPDATE SET status = 'STARTING', updated_at = CURRENT_TIMESTAMP
    `, [sessionId, req.tenantId, sessionName]);

    // Start asynchronously through WhatsAppProvider
    defaultWhatsAppProvider.startSession(req.tenantId, sessionName, {
      onQr: (qrCode) => {
        if (io) {
          io.to(`tenant:${req.tenantId}`).emit('session:qr', {
            sessionName,
            qrcode: qrCode
          });
        }
      },
      onStatus: async (status) => {
        await query(`
          UPDATE whatsapp_sessions SET status = $1, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $2 AND session_name = $3
        `, [status, req.tenantId, sessionName]);

        if (io) {
          io.to(`tenant:${req.tenantId}`).emit('session:status', {
            sessionName,
            status
          });
        }
      },
      onMessage: (msg) => {
        handleIncomingMessage({
          tenantId: req.tenantId,
          sessionName,
          msg,
          io
        }).catch(e => console.error('Incoming message handler error:', e));
      },
      onAck: (ackData) => {
        handleAckEvent({
          tenantId: req.tenantId,
          ackData,
          io
        }).catch(e => console.error('Ack handler error:', e));
      }
    }).catch(err => {
      console.error(`Failed starting session ${sessionName}:`, err.message);
    });

    res.json({
      status: 'success',
      message: `Session '${sessionName}' initialization started.`,
      sessionName
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/sessions/logout
 */
router.post('/logout', async (req, res) => {
  const sessionName = req.body?.sessionName || 'primary-whatsapp';
  try {
    await defaultWhatsAppProvider.closeSession(req.tenantId, sessionName);
    await query(`
      UPDATE whatsapp_sessions SET status = 'DISCONNECTED', updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = $1 AND session_name = $2
    `, [req.tenantId, sessionName]);

    const io = req.app.get('io');
    if (io) {
      io.to(`tenant:${req.tenantId}`).emit('session:status', {
        sessionName,
        status: 'DISCONNECTED'
      });
    }

    res.json({ status: 'success', message: `Session '${sessionName}' disconnected.` });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;
