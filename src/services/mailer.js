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
// One quiet, branded layout for every transactional email (table-based so it renders in any client).
const layout = ({ heading, intro, cta, link, note }) => `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:24px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d1d1f;">
<tr><td style="background:#0a0b0c;padding:28px 36px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:36px;height:36px;border-radius:10px;background:#16191b;border:1px solid #2a2f33;text-align:center;color:#d6b97b;font-size:19px;font-weight:700;line-height:36px;">W</td>
<td style="padding-left:14px;color:#ffffff;font-size:13px;letter-spacing:0.34em;font-weight:500;">SCRIWO</td>
</tr></table>
</td></tr>
<tr><td style="height:3px;background:linear-gradient(90deg,#f3e3bc,#d2b06a,#a8843f);line-height:3px;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:36px;">
<h1 style="margin:0 0 14px;font-size:26px;line-height:1.2;font-weight:600;letter-spacing:-0.02em;">${heading}</h1>
<p style="margin:0 0 28px;font-size:16px;line-height:1.55;color:#515154;">${intro}</p>
<p style="margin:0 0 28px;"><a href="${esc(link)}" style="display:inline-block;background:#0f6b55;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 28px;border-radius:999px;">${cta}</a></p>
<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#86868b;">${note}</p>
<p style="margin:0;font-size:12px;line-height:1.5;color:#a1a1a6;word-break:break-all;">If the button does not work, copy this address into your browser: ${esc(link)}</p>
</td></tr>
</table>
<p style="margin:20px 0 0;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:12px;color:#a1a1a6;">Scriwo &middot; Conversations, thoughtfully handled.</p>
</td></tr></table>
</body></html>`;

export const sendOwnerSetup = ({ to, name, company, link }) =>
  sendMail({
    to,
    subject: `Set up ${company} on Scriwo`,
    text: `Hello ${name},\n\nYou are the owner of "${company}" on Scriwo. Use the link below to choose your password and sign in. The link works once and expires in 72 hours.\n\n${link}\n\nYour login email: ${to}`,
    html: layout({
      heading: "Welcome to Scriwo",
      intro: `Hello ${esc(name)}, you are the owner of <b>${esc(company)}</b>. Choose a password to sign in and start inviting your team.`,
      cta: "Set your password",
      link,
      note: `The link works once and expires in 72 hours. Your login email is ${esc(to)}.`,
    }),
  });
// After paying on the website: what was bought, what was paid, and where to sign in. The setup link comes in its own email.
export const sendPurchaseReceipt = ({ to, name, company, plan, period, total, invoice }) =>
  sendMail({
    to,
    subject: `Your Scriwo receipt: ${plan} plan`,
    text: `Hello ${name},\n\nThank you. We received ${total} for the ${plan} plan for "${company}", which runs ${period}.\n\nYour tax invoice ${invoice} is in the app under Team, Plans & Billing once you sign in.\n\nA separate email has the link to choose your password. If it does not arrive, open ${ENV.APP_URL} and use "Forgot password" with ${to}.`,
    html: layout({
      heading: "Thank you for your purchase",
      intro: `Hello ${esc(name)}, we received <b>${esc(total)}</b> for the <b>${esc(plan)}</b> plan for <b>${esc(company)}</b>. It runs ${esc(period)}.`,
      cta: "Open Scriwo",
      link: ENV.APP_URL,
      note: `Your tax invoice ${esc(invoice)} is under Team, Plans & Billing. A separate email has the link to choose your password; if it does not arrive, use Forgot password with ${esc(to)}.`,
    }),
  });
export const sendStaffInvite = ({ to, name, company, link }) =>
  sendMail({
    to,
    subject: `${company} invited you to Scriwo`,
    text: `Hello ${name},\n\n${company} added you to their team on Scriwo. Set your password here (single use, expires in 24 hours):\n${link}`,
    html: layout({
      heading: `Join ${esc(company)} on Scriwo`,
      intro: `Hello ${esc(name)}, <b>${esc(company)}</b> added you to their team. Choose a password, then connect your own WhatsApp number.`,
      cta: "Set your password",
      link,
      note: "The link works once and expires in 24 hours.",
    }),
  });
const LEAD_FIELDS = [
  ["Name", "name"],
  ["Email", "email"],
  ["Phone", "phone"],
  ["Company", "company"],
  ["Country", "country"],
  ["Team size", "teamSize"],
  ["Interested in", "interest"],
  ["Plan", "plan"],
  ["Page", "sourcePage"],
];
export const sendLeadNotification = ({ to, lead }) => {
  const rows = LEAD_FIELDS.filter(([, k]) => lead[k]);
  return sendMail({
    to,
    subject: `New website enquiry: ${lead.company || lead.name} (${lead.interest})`,
    text: `${rows.map(([l, k]) => `${l}: ${lead[k]}`).join("\n")}\n\n${lead.message}`,
    html: layout({
      heading: "New website enquiry",
      intro: `${rows.map(([l, k]) => `<b>${l}:</b> ${esc(lead[k])}`).join("<br>")}${lead.message ? `<br><br>${esc(lead.message).replace(/\n/g, "<br>")}` : ""}`,
      cta: `Reply to ${esc(lead.name)}`,
      link: `mailto:${lead.email}`,
      note: "Sent from the contact form on scriwo.com. Every enquiry is also saved in the database.",
    }),
  });
};
