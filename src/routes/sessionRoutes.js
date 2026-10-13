import express from 'express';
import { authenticateToken, requireTenantContext } from '../middleware/auth.js';
import { defaultWhatsAppProvider } from '../services/whatsapp/WhatsAppProvider.js';
import { query } from '../db/index.js';
import { handleIncomingMessage, handleAckEvent } from '../services/messageService.js';
import { syncConversations } from '../services/conversationService.js';

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
      const liveStatus = live ? live.status : s.status;
      return {
        id: s.id,
        session_name: s.session_name,
        sessionName: s.session_name,
        sessionKey: s.session_name,
        displayName: s.session_name,
        status: liveStatus,
        liveStatus,
        phone: s.phone || (live ? live.phone : null),
        battery: s.battery,
        antiBanHealth: s.anti_ban_health,
        anti_ban_health: s.anti_ban_health,
        hasQr: Boolean(live?.qrcode),
        qrcode: live?.qrcode || null,
        created_at: s.created_at,
        updated_at: s.updated_at
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
  const sessionName = req.body?.sessionName || req.body?.sessionKey || 'primary-whatsapp';
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
            session: sessionName,
            sessionKey: sessionName,
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
            session: sessionName,
            sessionKey: sessionName,
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
      sessionName,
      sessionKey: sessionName
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/sessions/logout or /api/sessions/:sessionName/logout
 */
router.post(['/logout', '/:sessionName/logout', '/:sessionName/close'], async (req, res) => {
  const sessionName = req.params.sessionName || req.body?.sessionName || req.body?.sessionKey || 'primary-whatsapp';
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
        session: sessionName,
        sessionKey: sessionName,
        status: 'DISCONNECTED'
      });
    }

    res.json({ status: 'success', message: `Session '${sessionName}' disconnected.` });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/sessions/:sessionName/sync-inbox
 */
router.post('/:sessionName/sync-inbox', async (req, res) => {
  try {
    const sessionName = req.params.sessionName;
    const io = req.app.get('io');
    const result = await syncConversations({
      tenantId: req.tenantId,
      sessionName,
      io
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/sessions/:sessionName/status
 */
router.get('/:sessionName/status', async (req, res) => {
  const sessionName = req.params.sessionName;
  const live = defaultWhatsAppProvider.getSession(req.tenantId, sessionName);
  const { rows } = await query(`
    SELECT * FROM whatsapp_sessions WHERE tenant_id = $1 AND session_name = $2
  `, [req.tenantId, sessionName]);

  const dbStatus = rows[0]?.status || 'DISCONNECTED';
  res.json({
    status: 'success',
    sessionName,
    sessionKey: sessionName,
    liveStatus: live ? live.status : dbStatus,
    hasQr: Boolean(live?.qrcode),
    qrcode: live?.qrcode || null
  });
});

export default router;
