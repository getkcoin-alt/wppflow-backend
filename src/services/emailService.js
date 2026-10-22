import { Resend } from 'resend';
import { ENV } from '../config/env.js';

let resendClient = null;

function getResendClient() {
  if (!resendClient && ENV.RESEND_API_KEY) {
    resendClient = new Resend(ENV.RESEND_API_KEY);
  }
  return resendClient;
}

/**
 * Send an email using Resend
 * @param {Object} options
 * @param {string|string[]} options.to - Recipient email(s)
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plain text body
 * @param {string} [options.from] - Sender address
 * @param {string} [options.replyTo] - Reply-to address
 * @returns {Promise<{ success: boolean, id?: string, error?: string, raw?: any }>}
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
  from = ENV.RESEND_FROM_EMAIL,
  replyTo
}) {
  if (!to) {
    return { success: false, error: 'Recipient email ("to") is required.' };
  }
  if (!subject) {
    return { success: false, error: 'Email "subject" is required.' };
  }
  if (!html && !text) {
    return { success: false, error: 'Email content ("html" or "text") is required.' };
  }

  const client = getResendClient();
  if (!client) {
    console.warn('⚠️ Resend email sending skipped: RESEND_API_KEY is not configured.');
    return { success: false, error: 'Email service is not configured (missing RESEND_API_KEY).' };
  }

  const recipients = Array.isArray(to) ? to : [to];

  try {
    const payload = {
      from,
      to: recipients,
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(replyTo ? { reply_to: replyTo } : {})
    };

    const response = await client.emails.send(payload);

    if (response.error) {
      console.error(`❌ Resend email error to ${recipients.join(', ')}:`, response.error.message || response.error);
      return {
        success: false,
        error: response.error.message || 'Failed to dispatch email via Resend.',
        raw: response.error
      };
    }

    const emailId = response.data?.id;
    console.log(`📧 Email dispatched via Resend to [${recipients.join(', ')}] (Subject: "${subject}", ID: ${emailId})`);
    return {
      success: true,
      id: emailId,
      raw: response.data
    };
  } catch (err) {
    console.error(`❌ Resend exception sending to ${recipients.join(', ')}:`, err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Send an onboarding / welcome email to a new user
 */
export async function sendWelcomeEmail({
  to,
  name = 'there',
  workspaceName = 'your workspace',
  loginUrl = 'https://scriwo.com',
  temporaryPassword = null
}) {
  const subject = `Welcome to Scriwo — ${workspaceName}`;
  const passwordSection = temporaryPassword
    ? `
      <div style="background-color: #1a2a32; border-radius: 8px; padding: 16px; margin: 20px 0; border-left: 4px solid #10b981;">
        <p style="margin: 0; color: #94a3b8; font-size: 13px;">Your temporary sign-in password:</p>
        <p style="margin: 6px 0 0 0; color: #ffffff; font-family: monospace; font-size: 16px; font-weight: bold;">${temporaryPassword}</p>
        <p style="margin: 8px 0 0 0; color: #64748b; font-size: 12px;">We recommend updating your password once signed in.</p>
      </div>
    `
    : '';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${subject}</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0c1317; color: #e2e8f0; margin: 0; padding: 32px 16px;">
      <div style="max-width: 560px; margin: 0 auto; background-color: #111b21; border-radius: 16px; border: 1px solid #2a3942; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
        
        <div style="padding: 24px 32px; background: linear-gradient(135deg, #0d1f17 0%, #111b21 100%); border-bottom: 1px solid #2a3942;">
          <h1 style="margin: 0; color: #ffffff; font-size: 20px; font-weight: 800; letter-spacing: -0.5px;">SCRIWO</h1>
          <p style="margin: 4px 0 0 0; color: #10b981; font-size: 12px; font-weight: 600;">Conversations, thoughtfully handled.</p>
        </div>

        <div style="padding: 32px;">
          <h2 style="color: #ffffff; font-size: 18px; font-weight: 700; margin-top: 0;">Welcome, ${name}! 👋</h2>
          <p style="color: #94a3b8; font-size: 14px; line-height: 1.6;">
            Your account has been configured for the workspace <strong>${workspaceName}</strong>. You now have access to a shared WhatsApp inbox, broadcasts and automations.
          </p>

          ${passwordSection}

          <div style="margin: 32px 0 24px 0; text-align: center;">
            <a href="${loginUrl}" style="background-color: #10b981; color: #ffffff; padding: 12px 28px; border-radius: 10px; font-weight: 700; font-size: 14px; text-decoration: none; display: inline-block;">
              Open Workspace
            </a>
          </div>

          <p style="color: #64748b; font-size: 12px; line-height: 1.5; border-top: 1px solid #202c33; padding-top: 20px; margin-top: 28px;">
            If you did not request this invitation, please ignore this email or contact support.
          </p>
        </div>

      </div>
    </body>
    </html>
  `;

  return sendEmail({ to, subject, html });
}

/**
 * Send an invitation email to a teammate
 */
export async function sendInvitationEmail({
  to,
  name,
  inviterName = 'The Admin Team',
  workspaceName = 'your workspace',
  loginUrl = 'https://scriwo.com',
  temporaryPassword
}) {
  const subject = `You have been invited to join ${workspaceName} on Scriwo`;
  return sendWelcomeEmail({
    to,
    name,
    workspaceName,
    loginUrl,
    temporaryPassword
  });
}

/**
 * Send a verification / test email
 */
export async function sendTestEmail({ to }) {
  const subject = 'Scriwo email — connection test';
  const html = `
    <div style="font-family: sans-serif; background-color: #0c1317; color: #ffffff; padding: 24px; border-radius: 12px;">
      <h2 style="color: #10b981; margin-top: 0;">Resend Mail Service is Live! ✅</h2>
      <p style="color: #94a3b8; font-size: 14px;">This email confirms that Resend API is properly connected and functioning for your Scriwo instance.</p>
      <p style="color: #64748b; font-size: 12px;">Timestamp: ${new Date().toISOString()}</p>
    </div>
  `;
  return sendEmail({ to, subject, html });
}

/**
 * Get email service operational status
 */
export function getEmailServiceStatus() {
  return {
    provider: 'resend',
    configured: Boolean(ENV.RESEND_API_KEY),
    fromEmail: ENV.RESEND_FROM_EMAIL
  };
}
