import crypto from 'crypto';
import express from 'express';
import { authenticateToken, requireTenantContext } from '../middleware/auth.js';
import { query } from '../db/index.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireTenantContext);

router.get('/', async (req, res) => {
  try {
    const { rows: campaigns } = await query(`
      SELECT * FROM campaigns
      WHERE tenant_id = $1
      ORDER BY created_at DESC
    `, [req.tenantId]);
    res.json({ status: 'success', campaigns });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, targetSegment, templateText, scheduledFor, antiBanDelaySeconds } = req.body;
    const campaignId = `camp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const { rows } = await query(`
      INSERT INTO campaigns (
        id, tenant_id, name, target_segment, template_text,
        scheduled_for, anti_ban_delay_seconds, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
      RETURNING *
    `, [
      campaignId,
      req.tenantId,
      name || 'Untitled Campaign',
      targetSegment || 'All Contacts',
      templateText || '',
      scheduledFor || '',
      antiBanDelaySeconds || 4
    ]);

    res.status(201).json({ status: 'success', campaign: rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post(['/:id/send', '/:id/start'], async (req, res) => {
  try {
    const { rows } = await query(`
      UPDATE campaigns
      SET status = 'running', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND tenant_id = $2
      RETURNING *
    `, [req.params.id, req.tenantId]);

    if (rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Campaign not found in this workspace' });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`tenant:${req.tenantId}`).emit('campaign:status', {
        campaignId: req.params.id,
        status: 'running'
      });
    }

    res.json({ status: 'success', message: 'Campaign started', campaign: rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post(['/:id/stop', '/:id/pause'], async (req, res) => {
  try {
    const targetStatus = req.path.includes('pause') ? 'paused' : 'stopped';
    const { rows } = await query(`
      UPDATE campaigns
      SET status = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND tenant_id = $3
      RETURNING *
    `, [targetStatus, req.params.id, req.tenantId]);

    if (rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Campaign not found in this workspace' });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`tenant:${req.tenantId}`).emit('campaign:status', {
        campaignId: req.params.id,
        status: targetStatus
      });
    }

    res.json({ status: 'success', message: `Campaign ${targetStatus}`, campaign: rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;
