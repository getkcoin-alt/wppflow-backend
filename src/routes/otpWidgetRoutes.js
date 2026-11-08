import express from "express";
import rateLimit from "express-rate-limit";
import { query } from "../db/index.js";
import { route } from "../middleware/http.js";
import { OTP, visitorHashOf } from "../services/otp/config.js";
import { findOtpKey, otpError } from "../services/otp/keys.js";
import { settingsOf, sendOtp, verifyOtp } from "../services/otp/otpService.js";
import { makeProof } from "../services/otp/proof.js";
import { LOCALES } from "../services/otp/templates.js";

// The calls the drop-in widget makes from a visitor's browser, with a public key (otp_pk_...). They are open to the public web, so:
//  - a live key only works from the websites listed on it (the Origin header; a script can fake that, so it only keeps honest
//    mistakes and other people's sites out: the real limits are below),
//  - one visitor, one key and one company can only ask for so many codes an hour, and a number a few,
//  - a public key can do nothing but this: it cannot read anything, and the secret API refuses it.
// The body is plain text holding JSON, which browsers send without a preflight request; the reply names the caller's own origin.
const router = express.Router();

const callerOf = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
const bodyOf = (req) => {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    const parsed = JSON.parse(String(req.body || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw otpError(400, "invalid_request", "The request was not understood.", "Send JSON: { key, phone } or { key, id, code }.");
  }
};

router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    // everyone may read the answer; who may ask is decided by the key
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

async function publicKey(req, text) {
  const key = await findOtpKey(text);
  if (!key) throw otpError(401, "invalid_key", "This key is not valid.", "Check the key on your page against the one under Developers, Free OTP.");
  if (key.kind !== "public") throw otpError(403, "wrong_key_kind", "A secret key must never be used in a web page.", "Use the public key (otp_pk_...) here and keep the secret key on your server.");
  const origin = req.headers.origin || "";
  if (key.mode === "live" && !(origin && (key.allowed_origins || []).includes(origin)))
    throw otpError(403, "origin_not_allowed", `${origin || "This page"} is not allowed to use this key.`, "Add the website's address to the key under Developers, Free OTP.");
  return key;
}

// what the widget needs to draw itself: the name, how many digits, how long before a resend
router.get(
  "/config",
  route(async (req, res) => {
    const key = await publicKey(req, String(req.query.key || ""));
    const s = await settingsOf(key.tenant_id);
    res.json({ status: "success", brand: s.brandResolved, codeLength: s.code_length, resendSeconds: s.resend_seconds, locale: s.locale, test: key.mode === "test", available: s.enabled && !s.suspended_reason });
  }),
);

router.post(
  "/send",
  rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: callerOf, validate: false, message: { status: "error", code: "rate_limited", message: "Too many requests.", fix: "Try again in a minute." } }),
  route(async (req, res) => {
    const b = bodyOf(req);
    const key = await publicKey(req, String(b.key || ""));
    const visitor = callerOf(req);
    if (key.mode === "live") {
      const visitorHash = visitorHashOf(visitor);
      const { rows } = await query(
        `SELECT count(*) FILTER (WHERE visitor_hash=$3) AS visitor, count(*) AS total FROM otp_requests WHERE tenant_id=$1 AND key_id=$2 AND source='widget' AND mode='live' AND created_at > now() - interval '1 hour'`,
        [key.tenant_id, key.id, visitorHash],
      );
      if (Number(rows[0].visitor) >= OTP.widgetPerIpPerHour) throw otpError(429, "too_many_requests", "Too many codes were asked for from this device.", "Try again in an hour.", { retryAfter: 3600 });
      if (Number(rows[0].total) >= OTP.widgetPerKeyPerHour) throw otpError(429, "too_many_requests", "This page is asking for a lot of codes right now.", "Try again in a little while.", { retryAfter: 600 });
    }
    const locale = LOCALES.includes(b.locale) ? b.locale : undefined;
    const { httpStatus = 201, ...out } = await sendOtp({ tenantId: key.tenant_id, key, source: "widget", phone: b.phone, reference: b.reference, locale, visitor });
    res.status(httpStatus).json({ status: "success", ...out });
  }),
);

router.post(
  "/verify",
  rateLimit({ windowMs: 60 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: callerOf, validate: false, message: { status: "error", code: "rate_limited", message: "Too many attempts.", fix: "Try again in an hour." } }),
  route(async (req, res) => {
    const b = bodyOf(req);
    const key = await publicKey(req, String(b.key || ""));
    const result = await verifyOtp({ tenantId: key.tenant_id, key, id: b.id, code: b.code });
    const { row, phone, reference, ...rest } = result;
    res.json({ status: "success", ...rest, ...(result.valid ? { proof: makeProof(row) } : {}) });
  }),
);

router.use((req, res) => res.status(404).json({ status: "error", code: "not_found", message: "No such widget call.", fix: "Use /send, /verify or /config." }));

export default router;
