import crypto from 'crypto';
import express from 'express';
import { authenticateToken, requireTenantContext } from '../middleware/auth.js';
import { query } from '../db/index.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireTenantContext);

/**
 * GET /api/contacts
 */
router.get('/', async (req, res) => {
  try {
    const { rows: contacts } = await query(`
      SELECT id, tenant_id, name, phone, email, avatar, tags, custom_traits,
             lifetime_value, assigned_agent, created_at, updated_at
      FROM contacts
      WHERE tenant_id = $1
      ORDER BY name ASC
    `, [req.tenantId]);

    // Format for frontend
    const formatted = contacts.map(c => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email || '',
      avatar: c.avatar || '',
      tags: Array.isArray(c.tags) ? c.tags : [],
      customTraits: c.custom_traits || {},
      lifetimeValue: Number(c.lifetime_value || 0),
      assignedAgent: c.assigned_agent || '',
      channel: 'general',
      lastSeen: 'Recently',
      orders: [],
      notes: [],
      createdAt: c.created_at
    }));

    res.json({ status: 'success', contacts: formatted });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/contacts
 */
router.post('/', async (req, res) => {
  try {
    const { name, phone, email, avatar, tags, customTraits, assignedAgent } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ status: 'error', message: 'Name and phone are required' });
    }

    const contactId = `cnt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const cleanPhone = String(phone).trim();

    const { rows } = await query(`
      INSERT INTO contacts (
        id, tenant_id, name, phone, email, avatar, tags, custom_traits, assigned_agent
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (tenant_id, phone) DO UPDATE SET
        name = EXCLUDED.name,
        email = COALESCE(NULLIF(EXCLUDED.email, ''), contacts.email),
        avatar = COALESCE(NULLIF(EXCLUDED.avatar, ''), contacts.avatar),
        tags = EXCLUDED.tags,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      contactId,
      req.tenantId,
      name.trim(),
      cleanPhone,
      email || '',
      avatar || '',
      JSON.stringify(tags || []),
      JSON.stringify(customTraits || {}),
      assignedAgent || ''
    ]);

    res.status(201).json({ status: 'success', contact: rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * DELETE /api/contacts/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    await query(`
      DELETE FROM contacts WHERE id = $1 AND tenant_id = $2
    `, [req.params.id, req.tenantId]);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;
