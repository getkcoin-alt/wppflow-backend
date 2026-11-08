import crypto from "node:crypto";
import { query } from "../../db/index.js";

// OTP messages go out from the company's own WhatsApp number, so they also exist in that phone's WhatsApp and come back to Scriwo
// as echoes, in the chat list and in history. Left alone, every person who received a code would become a chat and a contact in
// the inbox (eating the contact allowance) and the codes would be stored in the message tables. This is how an OTP message is
// recognised, so those three places can leave it out:
//   1. by the message id WhatsApp gave it,
//   2. by its exact text (the code is in it, so the text is unique to one request), which is what a chat-list preview and an
//      imported history message have to go on, because they carry no id,
//   3. for the moment between WhatsApp showing the message and our send call returning, by a short in-memory note made just before sending.
export const textHash = (text) => crypto.createHash("sha256").update(String(text ?? "").trim()).digest("hex");

const WINDOW_MS = 120000;
const justSent = new Map();
const keyOf = (tenantId, sessionName) => `${tenantId}|${sessionName}`;
const sweep = (now) => {
  for (const [k, list] of justSent) {
    const keep = list.filter((e) => e.until > now);
    keep.length ? justSent.set(k, keep) : justSent.delete(k);
  }
};
export function expectEcho({ tenantId, sessionName, text }) {
  const now = Date.now();
  if (justSent.size > 500) sweep(now);
  const k = keyOf(tenantId, sessionName);
  justSent.set(k, [...(justSent.get(k) || []).filter((e) => e.until > now), { hash: textHash(text), until: now + WINDOW_MS }]);
}
const recentlySent = (tenantId, sessionName, text) => {
  const now = Date.now();
  const hash = textHash(text);
  return (justSent.get(keyOf(tenantId, sessionName)) || []).some((e) => e.until > now && e.hash === hash);
};

// Does this company have any OTP at all lately? Asked at most once a minute, so a company that never sends one costs nothing.
const hasOtp = new Map();
export async function hasRecentOtp(tenantId) {
  const hit = hasOtp.get(tenantId);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const { rowCount } = await query("SELECT 1 FROM otp_requests WHERE tenant_id=$1 AND mode='live' AND created_at > now() - interval '31 days' LIMIT 1", [tenantId]);
  hasOtp.set(tenantId, { value: rowCount > 0, at: Date.now() });
  return rowCount > 0;
}
export const noteOtpSent = (tenantId) => hasOtp.set(tenantId, { value: true, at: Date.now() });
export const forgetOtpCache = () => {
  hasOtp.clear();
  justSent.clear();
};

// Is this message (an outgoing one: fromMe) one of ours?
export async function isOtpMessage({ tenantId, sessionName, providerMessageId = null, text = "", fromMe = true }) {
  if (!fromMe) return false;
  if (text && recentlySent(tenantId, sessionName, text)) return true;
  if (!(await hasRecentOtp(tenantId))) return false;
  if (providerMessageId) {
    const byId = await query("SELECT 1 FROM otp_requests WHERE tenant_id=$1 AND provider_message_id=$2 LIMIT 1", [tenantId, providerMessageId]);
    if (byId.rowCount) return true;
  }
  if (text) {
    const byText = await query("SELECT 1 FROM otp_requests WHERE tenant_id=$1 AND text_hash=$2 LIMIT 1", [tenantId, textHash(text)]);
    if (byText.rowCount) return true;
  }
  return false;
}
