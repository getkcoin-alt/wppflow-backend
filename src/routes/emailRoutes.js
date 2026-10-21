import express from 'express';
import { authenticateToken, requireSuperAdmin } from '../middleware/auth.js';
import { sendEmail, sendTestEmail, getEmailServiceStatus } from '../services/emailService.js';
import { ENV } from '../config/env.js';

const router = express.Router();

// Outbound mail is a platform capability: only the platform admin may use it directly.
// Owner/staff emails are sent by the onboarding and invitation flows, never by these routes.
router.use(authenticateToken, requireSuperAdmin);

/**
 * GET /api/email/status
 * Platform-admin status check for the email subsystem
 */
router.get('/status', (req, res) => {
  res.json({
    status: 'success',
    emailService: getEmailServiceStatus()
  });
});

/**
 * POST /api/email/send
 * Dispatch an email via Resend
 */
router.post('/send', async (req, res) => {
  try {
    const { to, subject, html, text, replyTo } = req.body;

    if (!to || !subject || (!html && !text)) {
      return res.status(400).json({
        status: 'error',
        message: 'Fields "to", "subject", and at least one of "html" or "text" are required.'
      });
    }

    const result = await sendEmail({ to, subject, html, text, replyTo });

    if (!result.success) {
      return res.status(500).json({
        status: 'error',
        message: result.error || 'Failed to dispatch email via Resend.',
        raw: result.raw
      });
    }

    res.json({
      status: 'success',
      message: 'Email dispatched successfully.',
      id: result.id
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/email/test
 * Send a verification test email
 */
router.post('/test', async (req, res) => {
  try {
    const to = req.body.to || req.user.email || ENV.SUPERADMIN_EMAIL;
    const result = await sendTestEmail({ to });

    if (!result.success) {
      return res.status(500).json({
        status: 'error',
        message: result.error || 'Failed to send test email via Resend.',
        raw: result.raw
      });
    }

    res.json({
      status: 'success',
      message: `Test email dispatched to ${to} via Resend.`,
      id: result.id
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;
