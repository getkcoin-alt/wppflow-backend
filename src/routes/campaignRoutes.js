import express from 'express';
import { authenticateToken, requireTenantContext } from '../middleware/auth.js';
import { query } from '../db/index.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireTenantContext);

router.get('/', async (req, res) => {
  try {
    const { rows: campaigns } = await query(`
      SELECT * FROM campaigns WHERE user_id IN (
        SELECT user_id FROM memberships WHERE tenant_id = $1
      ) ORDER BY created_at DESC
    `, [req.tenantId]);
    res.json({ status: 'success', campaigns });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/:id/send', async (req, res) => {
  // Campaign dispatch is disabled pending explicit recipient consent verification
  // and compliance review to protect against spam and fabricated delivery statistics.
  return res.status(403).json({
    status: 'error',
    code: 'CAMPAIGN_SAFETY_HOLD',
    message: 'Broadcast campaigns are currently paused until explicit recipient opt-in consent and suppression lists are configured.'
  });
});

export default router;
