import crypto from 'crypto';
import express from 'express';
import { authenticateToken, requireTenantContext } from '../middleware/auth.js';
import { query } from '../db/index.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireTenantContext);

/**
 * GET /api/automations
 */
router.get('/', async (req, res) => {
  try {
    const { rows: automations } = await query(`
      SELECT id, tenant_id, name, trigger_type, trigger_condition, action_type,
             action_summary, is_enabled, executions_count, created_at, updated_at
      FROM automations
      WHERE tenant_id = $1
      ORDER BY created_at DESC
    `, [req.tenantId]);

    // Format for frontend
    const formatted = automations.map(a => ({
      id: a.id,
      name: a.name,
      triggerType: a.trigger_type,
      triggerCondition: a.trigger_condition,
      actionType: a.action_type,
      actionSummary: a.action_summary,
      isEnabled: Boolean(a.is_enabled),
      executionsCount: Number(a.executions_count || 0),
      createdAt: a.created_at
    }));

    res.json({ status: 'success', automations: formatted });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/automations
 */
router.post('/', async (req, res) => {
  try {
    const { name, triggerType, triggerCondition, actionType, actionSummary } = req.body;
    if (!name) {
      return res.status(400).json({ status: 'error', message: 'Name is required' });
    }

    const autoId = `auto_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const { rows } = await query(`
      INSERT INTO automations (
        id, tenant_id, name, trigger_type, trigger_condition,
        action_type, action_summary, is_enabled, executions_count
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, true, 0)
      RETURNING *
    `, [
      autoId,
      req.tenantId,
      name.trim(),
      triggerType || 'keyword',
      triggerCondition || '',
      actionType || 'reply_text',
      actionSummary || ''
    ]);

    res.status(201).json({ status: 'success', automation: rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * PATCH /api/automations/:id/toggle
 */
router.patch('/:id/toggle', async (req, res) => {
  try {
    const { rows } = await query(`
      UPDATE automations
      SET is_enabled = NOT is_enabled, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND tenant_id = $2
      RETURNING *
    `, [req.params.id, req.tenantId]);

    if (rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Automation not found' });
    }

    res.json({ status: 'success', isEnabled: rows[0].is_enabled, automation: rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * DELETE /api/automations/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    await query(`
      DELETE FROM automations WHERE id = $1 AND tenant_id = $2
    `, [req.params.id, req.tenantId]);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;
