import crypto from "node:crypto";
import { ENV } from "../../config/env.js";

// Every number that decides how much OTP a company may use, in one place. The allowance is the same on every plan (it is a free
// service); a company's own row in otp_settings can raise or lower it, and OTP_DAILY_LIMIT / OTP_MONTHLY_LIMIT change the default.
export const OTP = Object.freeze({
  perDay: 100,
  perMonth: 1000,
  // one phone number: at most this many codes in the window, and this many a day, whatever the company's allowance
  perPhoneWindowSeconds: 600,
  perPhoneWindow: 3,
  perPhoneDay: 10,
  // what one WhatsApp number may be asked to send, so a burst cannot get it restricted
  perNumberPerMinute: 20,
  // calls one key may make
  keyPerMinute: 120,
  // the browser widget is open to the public, so it is held tighter
  widgetPerIpPerHour: 12,
  widgetPerKeyPerHour: 120,
  retentionDays: 30,
  // a test key never sends anything and always uses this code
  testCode: "123456",
  proofSeconds: 600,
});

export const otpEnabled = () => process.env.OTP_ENABLED !== "false";
const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : fallback);

// the allowance for a company: its own setting if it has one, else the default
export const allowanceOf = (settings) => ({
  perDay: settings?.daily_limit ?? positive(process.env.OTP_DAILY_LIMIT, OTP.perDay),
  perMonth: settings?.monthly_limit ?? positive(process.env.OTP_MONTHLY_LIMIT, OTP.perMonth),
});

// HMACs for codes and proofs use a key derived from the server secret, one per purpose, so one can never stand in for another
const keyFor = (purpose) => crypto.createHmac("sha256", ENV.JWT_SECRET).update(`scriwo-otp:${purpose}`).digest();
export const hmac = (purpose, value) => crypto.createHmac("sha256", keyFor(purpose)).update(String(value)).digest("hex");
export const sameHex = (a, b) => {
  const x = Buffer.from(String(a), "hex");
  const y = Buffer.from(String(b), "hex");
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const dayStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
export const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
export const nextDay = (now = new Date()) => new Date(dayStart(now).getTime() + 86400000);
export const nextMonth = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
