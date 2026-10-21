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
export const sendOwnerCredentials = ({ to, name, company, password }) =>
  sendMail({
    to,
    subject: `Your ${company} WppFlow workspace is ready`,
    text: `Hello ${name},\n\nYour company workspace "${company}" has been created on WppFlow.\n\nLogin: ${ENV.APP_URL}\nEmail: ${to}\nTemporary password: ${password}\n\nYou will be asked to choose a new password on first login.`,
    html: `<p>Hello ${esc(name)},</p><p>Your company workspace <b>${esc(company)}</b> has been created on WppFlow.</p><p>Login: <a href="${esc(ENV.APP_URL)}">${esc(ENV.APP_URL)}</a><br>Email: ${esc(to)}<br>Temporary password: <code>${esc(password)}</code></p><p>You will be asked to choose a new password on first login.</p>`,
  });
export const sendOwnerAccess = ({ to, name, company }) =>
  sendMail({
    to,
    subject: `You now own ${company} on WppFlow`,
    text: `Hello ${name},\n\nYou have been made the owner of "${company}" on WppFlow. Log in with your existing password: ${ENV.APP_URL}`,
  });
export const sendStaffInvite = ({ to, name, company, link }) =>
  sendMail({
    to,
    subject: `${company} invited you to WppFlow`,
    text: `Hello ${name},\n\n${company} added you to their WppFlow team. Set your password here (single use, expires in 24 hours):\n${link}`,
    html: `<p>Hello ${esc(name)},</p><p>${esc(company)} added you to their WppFlow team.</p><p><a href="${esc(link)}">Set your password</a> (single use, expires in 24 hours).</p>`,
  });
