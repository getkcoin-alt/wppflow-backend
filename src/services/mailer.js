import { ENV } from "../config/env.js";
let override;
export const mailEnabled = () => Boolean(override || ENV.RESEND_API_KEY);
// Tests inject a stub so no real mail is ever sent.
export const setMailTransport = (value) => {
  override = value;
};
const esc = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
async function deliver(message) {
  if (override) return override.sendMail(message);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: ENV.MAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const raw = (await res.text()).slice(0, 500);
    let detail = raw;
    try {
      detail = JSON.parse(raw).message || raw;
    } catch {}
    const error = new Error(`Resend responded ${res.status}: ${raw}`);
    error.detail = `Resend ${res.status}: ${detail}`;
    throw error;
  }
}
export async function sendMail({ to, subject, text, html }) {
  if (!mailEnabled()) return { sent: false, reason: "not_configured" };
  try {
    await deliver({ to, subject, text, html });
    return { sent: true };
  } catch (error) {
    console.error("Email delivery failed:", error.message);
    return {
      sent: false,
      reason: "delivery_failed",
      detail: error.detail || error.message,
    };
  }
}
export const sendOwnerSetup = ({ to, name, company, link }) =>
  sendMail({
    to,
    subject: `Set up your ${company} workspace on WppFlow`,
    text: `Hello ${name},\n\nYou are the owner of "${company}" on WppFlow. Click the link below to choose your password and sign in. The link works once and expires in 72 hours.\n\n${link}\n\nYour login email: ${to}`,
    html: `<p>Hello ${esc(name)},</p><p>You are the owner of <b>${esc(company)}</b> on WppFlow.</p><p><a href="${esc(link)}" style="background:#10b981;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block">Set your password</a></p><p>The link works once and expires in 72 hours. Your login email is ${esc(to)}.</p><p style="color:#64748b;font-size:12px">If the button does not work, copy this address into your browser: ${esc(link)}</p>`,
  });
export const sendStaffInvite = ({ to, name, company, link }) =>
  sendMail({
    to,
    subject: `${company} invited you to WppFlow`,
    text: `Hello ${name},\n\n${company} added you to their WppFlow team. Set your password here (single use, expires in 24 hours):\n${link}`,
    html: `<p>Hello ${esc(name)},</p><p>${esc(company)} added you to their WppFlow team.</p><p><a href="${esc(link)}">Set your password</a> (single use, expires in 24 hours).</p>`,
  });
