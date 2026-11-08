import crypto from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import { query, withTransaction } from "../db/index.js";
import { authenticateToken, requireTenantContext, requireRole } from "../middleware/auth.js";
import { route, fail } from "../middleware/http.js";
import { resolveWebhook, encryptSecret, recordWebhook } from "../services/webhookService.js";
import { otpEnabled, OTP } from "../services/otp/config.js";
import { createOtpKey, listOtpKeys, revokeOtpKey, otpError } from "../services/otp/keys.js";
import { TEMPLATES, LOCALES, LOCALE_NAMES, renderOtp, brandProblem, cleanBrand } from "../services/otp/templates.js";
import { settingsOf, settingsView, updateSettings, usageOf, statsOf, recentRequests, testedOk, sendOtp, verifyOtp, statusOf } from "../services/otp/otpService.js";

// The Free OTP page in Developers: what the studio reads and changes. Owners and administrators of any plan, signed in (an API key
// is refused here); it is the only part of Developers that no plan locks.
const router = express.Router();
router.use(authenticateToken, requireTenantContext, (req, res, next) => (req.apiKey ? next(fail(403, "Interactive workspace login required")) : next()), requireRole("owner", "admin"));

const audit = (req, event, metadata = {}) =>
  query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,$3,$4)", [req.tenantId, req.user?.id ?? null, event, JSON.stringify(metadata)]).catch((e) => console.error("Audit failed:", e.message));

// the test button sends real WhatsApp messages, so it is held to a few a minute
const testLimiter = rateLimit({ windowMs: 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.tenantId || req.ip, validate: false, message: { status: "error", code: "rate_limited", message: "That is a lot of test codes.", fix: "Wait a minute and try again." } });

const SAMPLE = "48291357";
const sampleCode = (length) => SAMPLE.slice(0, Math.min(8, Math.max(4, Number(length) || 6)));

router.get(
  "/",
  route(async (req, res) => {
    const settings = await settingsOf(req.tenantId);
    const [keys, usage, stats, numbers, hook, tested] = await Promise.all([
      listOtpKeys(req.tenantId),
      usageOf(req.tenantId, settings),
      statsOf(req.tenantId),
      query("SELECT session_name,status,phone FROM whatsapp_sessions WHERE tenant_id=$1 ORDER BY created_at,session_name", [req.tenantId]),
      query("SELECT id,url,enabled,created_at FROM webhook_endpoints WHERE tenant_id=$1 AND scope='otp' AND enabled", [req.tenantId]),
      testedOk(req.tenantId),
    ]);
    const connected = numbers.rows.filter((n) => n.status === "CONNECTED");
    res.json({
      status: "success",
      available: otpEnabled(),
      settings: settingsView(settings),
      templates: TEMPLATES.map((t) => ({ key: t.key, title: t.title, blurb: t.blurb, defaults: t.defaults })),
      locales: LOCALES.map((l) => ({ key: l, name: LOCALE_NAMES[l] })),
      numbers: numbers.rows.map((n) => ({ sessionName: n.session_name, phone: n.phone, connected: n.status === "CONNECTED" })),
      keys,
      usage,
      stats,
      webhook: hook.rows[0] ? { id: hook.rows[0].id, url: hook.rows[0].url, createdAt: hook.rows[0].created_at } : null,
      limits: { perPhoneWindow: OTP.perPhoneWindow, perPhoneWindowMinutes: OTP.perPhoneWindowSeconds / 60, perPhoneDay: OTP.perPhoneDay },
      ready: { number: connected.length > 0, tested, key: keys.some((k) => !k.revokedAt && k.kind === "secret") },
    });
  }),
);

// the message as it will read, for the live preview (nothing is saved or sent)
router.get(
  "/preview",
  route(async (req, res) => {
    const q = req.query;
    const settings = await settingsOf(req.tenantId);
    const typed = String(q.brand ?? "").trim();
    if (typed) {
      const problem = brandProblem(typed);
      if (problem) throw otpError(400, "invalid_brand", problem, "For example: Acme Stores");
    }
    const length = Math.min(8, Math.max(4, Number(q.codeLength) || settings.code_length));
    const ttl = Math.min(3600, Math.max(60, Number(q.ttlSeconds) || settings.ttl_seconds));
    const text = renderOtp({
      template: String(q.template || settings.template_key),
      locale: LOCALES.includes(String(q.locale)) ? String(q.locale) : settings.locale,
      brand: cleanBrand(typed) || settings.brandResolved,
      code: sampleCode(length),
      ttlSeconds: ttl,
    });
    res.json({ status: "success", text });
  }),
);

router.put(
  "/settings",
  route(async (req, res) => {
    const before = await settingsOf(req.tenantId);
    const after = await updateSettings(req.tenantId, req.body && typeof req.body === "object" ? req.body : {});
    await audit(req, "otp.settings_changed", { template: after.template_key, enabled: after.enabled, was: before.enabled });
    res.json({ status: "success", settings: settingsView(after) });
  }),
);

router.post(
  "/keys",
  route(async (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const created = await createOtpKey({ tenantId: req.tenantId, userId: req.user?.id ?? null, name: b.name, kind: b.kind, mode: b.mode, origins: b.origins });
    await audit(req, "otp.key_created", { id: created.id, kind: created.kind, mode: created.mode });
    res.status(201).json({ status: "success", key: created, message: "Copy this key now. It is shown only once." });
  }),
);

router.delete(
  "/keys/:id",
  route(async (req, res) => {
    const done = await revokeOtpKey(req.tenantId, req.params.id);
    if (!done) throw fail(404, "That key was not found, or is already revoked.");
    await audit(req, "otp.key_revoked", { id: req.params.id });
    res.json({ status: "success" });
  }),
);

// the studio's own test: a real code, from the company's real number, to a number typed in
router.post(
  "/test/send",
  testLimiter,
  route(async (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const { httpStatus, ...result } = await sendOtp({ tenantId: req.tenantId, key: null, source: "dashboard", phone: b.phone, reference: "studio-test" });
    res.status(httpStatus || 201).json({ status: "success", ...result });
  }),
);
router.post(
  "/test/verify",
  route(async (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const { row, ...result } = await verifyOtp({ tenantId: req.tenantId, key: null, id: b.id, code: b.code });
    res.json({ status: "success", ...result });
  }),
);
router.get(
  "/test/:id",
  route(async (req, res) => res.json({ status: "success", request: await statusOf(req.tenantId, req.params.id) })),
);

// One address that is told when a code is sent, delivered, checked or fails: signed like every Scriwo webhook, set up on any plan,
// and it hears nothing but OTP events (the Business-plan webhooks keep hearing what they heard before).
router.put(
  "/webhook",
  route(async (req, res) => {
    const raw = req.body && typeof req.body === "object" ? req.body.url : "";
    let resolved;
    try {
      resolved = await resolveWebhook(String(raw ?? "").trim().slice(0, 2000));
    } catch (error) {
      throw otpError(400, "invalid_webhook", error.message, "Use a public https address, for example https://example.com/otp-events");
    }
    const secret = crypto.randomBytes(32).toString("hex");
    const id = crypto.randomUUID();
    await withTransaction(async (c) => {
      await c.query("UPDATE webhook_endpoints SET enabled=false WHERE tenant_id=$1 AND scope='otp' AND enabled", [req.tenantId]);
      await c.query("INSERT INTO webhook_endpoints(id,tenant_id,url,secret,scope) VALUES($1,$2,$3,$4,'otp')", [id, req.tenantId, resolved.url.href, encryptSecret(secret)]);
    });
    await audit(req, "otp.webhook_set", { host: resolved.url.hostname });
    res.status(201).json({ status: "success", webhook: { id, url: resolved.url.href }, secret, message: "Save the signing secret now. It is shown once." });
  }),
);
router.delete(
  "/webhook",
  route(async (req, res) => {
    const done = await query("UPDATE webhook_endpoints SET enabled=false WHERE tenant_id=$1 AND scope='otp' AND enabled", [req.tenantId]);
    if (!done.rowCount) throw fail(404, "There is no OTP webhook to remove.");
    await audit(req, "otp.webhook_removed");
    res.json({ status: "success" });
  }),
);
router.post(
  "/webhook/test",
  testLimiter,
  route(async (req, res) => {
    const there = await query("SELECT 1 FROM webhook_endpoints WHERE tenant_id=$1 AND scope='otp' AND enabled", [req.tenantId]);
    if (!there.rowCount) throw otpError(400, "no_webhook", "No webhook address is set up yet.", "Add the address first.");
    await recordWebhook(req.tenantId, "otp.test", { synthetic: true, createdAt: new Date().toISOString(), note: "A test event from Scriwo. No code was sent." });
    res.status(202).json({ status: "success", message: "A test event was queued." });
  }),
);
router.get(
  "/webhook/deliveries",
  route(async (req, res) => {
    const { rows } = await query(
      `SELECT d.id,d.event,d.status,d.attempts,d.response_status,d.error,d.created_at FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id
       WHERE d.tenant_id=$1 AND e.scope='otp' ORDER BY d.created_at DESC LIMIT 20`,
      [req.tenantId],
    );
    res.json({ status: "success", deliveries: rows });
  }),
);

router.get(
  "/log",
  route(async (req, res) => res.json({ status: "success", requests: await recentRequests(req.tenantId, req.query.limit) })),
);

export default router;
