// What a person is called on screen. WhatsApp's own ids ("971501234567@c.us", "83752348860497@lid", "1203…@g.us") are
// plumbing, not names: they are never shown. The order is the person's name, else their mobile number, else a plain label.

const ID_SUFFIX = /@(c\.us|s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)$/i;
export const isWhatsAppId = (value) => ID_SUFFIX.test(String(value ?? "").trim());

// The digits of a real mobile number, or "" when all we have is a hidden "linked" id or a group id.
export function mobileDigits(phone) {
  const raw = String(phone ?? "").trim();
  if (!raw || /@(lid|g\.us|broadcast|newsletter)$/i.test(raw)) return "";
  const digits = raw.replace(/(?::\d+)?@(c\.us|s\.whatsapp\.net)$/i, "").replace(/\D/g, "");
  return /^\d{6,15}$/.test(digits) ? digits : "";
}

export const mobileText = (phone) => {
  const digits = mobileDigits(phone);
  return digits ? `+${digits}` : "";
};

export const NO_NAME = "Unknown contact";

// The title for a chat: the name when it is a real one, else "+971501234567", else a label that is not an id.
export function chatTitle(name, phone, { isGroup = false } = {}) {
  const given = String(name ?? "").trim();
  if (isGroup) return given && !isWhatsAppId(given) ? given : "WhatsApp Group";
  if (given && !isWhatsAppId(given) && given !== String(phone ?? "").trim() && !/^\+?[\d\s().-]{6,}$/.test(given)) return given;
  // a name that is only a number is shown as the number, in one format
  return mobileText(given) || mobileText(phone) || NO_NAME;
}

// A title somebody typed (a lead, a deal) is left alone unless it is a WhatsApp id.
export const hideId = (value, phone) => (isWhatsAppId(value) ? chatTitle(value, phone) : value);
