import express from "express";
import rateLimit from "express-rate-limit";
import { route } from "../middleware/http.js";
import { requireOtpKey } from "../services/otp/keys.js";
import { sendOtp, verifyOtp, statusOf } from "../services/otp/otpService.js";
import { OTP } from "../services/otp/config.js";
import { consumeProof } from "../services/otp/proof.js";

// The OTP API a company's own server calls: send a code, check a code. Secret keys only (otp_sk_...); a key can do nothing else
// in Scriwo, and nothing else in Scriwo accepts it.
const router = express.Router();
// Calls arrive through the app's proxy, so the caller is the first forwarded address (as with the website's contact form). This
// runs before the key is looked up, so a flood of made-up keys cannot hammer the database.
const callerOf = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
router.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: callerOf,
    validate: false,
    message: { status: "error", code: "rate_limited", message: "Too many requests.", fix: "Slow down and try again in a few seconds." },
  }),
  requireOtpKey({ kinds: ["secret"] }),
  rateLimit({
    windowMs: 60 * 1000,
    max: OTP.keyPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.otpKey?.id || req.ip,
    validate: false,
    message: { status: "error", code: "rate_limited", message: "Too many requests.", fix: "Slow down and try again in a few seconds." },
  }),
);

// Send a code to a phone number. { phone, reference?, template?, locale? } and optionally an Idempotency-Key header.
router.post(
  "/send",
  route(async (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const { httpStatus = 201, ...body } = await sendOtp({
      tenantId: req.tenantId,
      key: req.otpKey,
      source: "api",
      phone: b.phone,
      reference: b.reference,
      template: b.template,
      locale: b.locale,
      idempotencyKey: req.headers["idempotency-key"],
    });
    res.status(httpStatus).json({ status: "success", ...body });
  }),
);

// Check a code. { id, code } (or { phone, code } for the latest code sent to that number). A wrong code is a 200 with valid:false.
router.post(
  "/verify",
  route(async (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const { row, ...body } = await verifyOtp({ tenantId: req.tenantId, key: req.otpKey, id: b.id, phone: b.phone, code: b.code });
    res.json({ status: "success", ...body });
  }),
);

// A page that used the widget hands its server the proof the widget gave it; this says whether it is genuine, once. { proof }
router.post(
  "/proof/verify",
  route(async (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    res.json({ status: "success", ...(await consumeProof({ tenantId: req.tenantId, proof: b.proof })) });
  }),
);

// What became of a code (never the code itself)
router.get(
  "/requests/:id",
  route(async (req, res) => res.json({ status: "success", request: await statusOf(req.tenantId, req.params.id, req.otpKey) })),
);

export default router;
