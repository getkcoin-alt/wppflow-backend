// A number somebody types ("+971 50 123 4567", "00971501234567", "(971) 50-123-4567") becomes the plain digits
// WhatsApp uses, country code first. Anything that could not be a full international number is refused, so a
// chat is never started with half a number.
export function normalizePhone(input) {
  const raw = String(input ?? "").trim();
  if (!raw || !/^[+\d\s().-]+$/.test(raw)) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

export const PHONE_HELP = "Enter the number with its country code, for example +971 50 123 4567";

// "+971 50 123 4567": the digits with a plus, for showing to people.
export const displayPhone = (digits) => `+${String(digits).replace(/\D/g, "")}`;
