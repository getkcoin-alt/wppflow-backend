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
  try {
    await query(`UPDATE campaigns SET status = 'running' WHERE id = $1`, [req.params.id]);
    const io = req.app.get('io');
    if (io) io.emit('campaign:status', { campaignId: req.params.id, status: 'running' });
    res.json({ status: 'success', message: 'Campaign started', campaignId: req.params.id });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/:id/start', async (req, res) => {
  try {
    await query(`UPDATE campaigns SET status = 'running' WHERE id = $1`, [req.params.id]);
    const io = req.app.get('io');
    if (io) io.emit('campaign:status', { campaignId: req.params.id, status: 'running' });
    res.json({ status: 'success', message: 'Campaign started', campaignId: req.params.id });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post(['/:id/stop', '/:id/pause'], async (req, res) => {
  try {
    await query(`UPDATE campaigns SET status = 'stopped' WHERE id = $1`, [req.params.id]);
    const io = req.app.get('io');
    if (io) io.emit('campaign:status', { campaignId: req.params.id, status: 'stopped' });
    res.json({ status: 'success', message: 'Campaign stopped', campaignId: req.params.id });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;
