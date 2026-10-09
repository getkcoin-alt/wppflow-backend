import express from 'express';
import { authenticateToken, requireTenantContext } from '../middleware/auth.js';
import { sendMessageRateLimiter } from '../middleware/rateLimiter.js';
import { getConversations, markConversationRead, syncConversations } from '../services/conversationService.js';
import { getConversationMessages, sendTextMessage } from '../services/messageService.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireTenantContext);

/**
 * GET /api/conversations
 * Cursor-paginated conversations in active tenant
 */
router.get('/', async (req, res) => {
  try {
    const { limit, cursor, filter, search } = req.query;
    const result = await getConversations({
      tenantId: req.tenantId,
      limit,
      cursor,
      filter,
      search
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/conversations/:id/messages
 * Cursor-paginated message history
 */
router.get('/:id/messages', async (req, res) => {
  try {
    const { limit, cursor } = req.query;
    const result = await getConversationMessages({
      tenantId: req.tenantId,
      conversationId: req.params.id,
      limit,
      cursor
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/conversations/:id/messages
 * Exactly-once message dispatch with idempotency key
 */
router.post('/:id/messages', sendMessageRateLimiter, async (req, res) => {
  try {
    const { text, idempotencyKey } = req.body;
    const io = req.app.get('io');

    const result = await sendTextMessage({
      tenantId: req.tenantId,
      conversationId: req.params.id,
      text,
      idempotencyKey,
      agentName: req.user.name || 'Agent',
      io
    });

    res.status(result.duplicate ? 200 : 201).json({
      status: 'success',
      ...result
    });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 400).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * POST /api/conversations/:id/read
 * Mark conversation as read
 */
router.post('/:id/read', async (req, res) => {
  try {
    const io = req.app.get('io');
    const result = await markConversationRead({
      tenantId: req.tenantId,
      conversationId: req.params.id,
      io
    });
    res.json({ status: 'success', conversation: result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/conversations/sync
 * Sync conversations from WhatsApp session
 */
router.post('/sync', async (req, res) => {
  try {
    const { sessionName } = req.body;
    const io = req.app.get('io');
    const result = await syncConversations({
      tenantId: req.tenantId,
      sessionName: sessionName || 'primary-whatsapp',
      io
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;
