import express from "express";
import rateLimit from "express-rate-limit";
import {
  authenticateToken,
  requireTenantContext,
  requireRole,
  requireScope,
  requireWriteAccess,
} from "../middleware/auth.js";
import { route, fail } from "../middleware/http.js";
import { query } from "../db/index.js";
import { assertConversationAccess } from "../services/access.js";
import {
  aiStatus,
  suggestReply,
  summarize,
  improveText,
  translateText,
} from "../services/aiService.js";

const router = express.Router();
router.use(authenticateToken, requireTenantContext, requireScope("inbox"), requireWriteAccess);
// Each request costs money, so one person can't run them in a tight loop. The company's daily allowance
// is the real ceiling; this only stops a runaway client.
const perPerson = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.tenantId}:${req.user?.id ?? "api"}`,
  validate: false,
  message: { status: "error", message: "You're going a little fast. Wait a moment and try again." },
});

router.get(
  "/status",
  route(async (req, res) => {
    res.json({ status: "success", ...(await aiStatus(req.tenant)) });
  }),
);

router.post(
  "/conversations/:id/suggest-reply",
  perPerson,
  route(async (req, res) => {
    await assertConversationAccess(req, req.params.id);
    res.json({
      status: "success",
      ...(await suggestReply({ tenant: req.tenant, conversationId: req.params.id, tone: req.body?.tone })),
    });
  }),
);
router.post(
  "/conversations/:id/summary",
  perPerson,
  route(async (req, res) => {
    await assertConversationAccess(req, req.params.id);
    res.json({
      status: "success",
      ...(await summarize({ tenant: req.tenant, conversationId: req.params.id })),
    });
  }),
);
router.post(
  "/improve",
  perPerson,
  route(async (req, res) =>
    res.json({
      status: "success",
      ...(await improveText({ tenant: req.tenant, text: req.body?.text, style: req.body?.style })),
    }),
  ),
);
router.post(
  "/translate",
  perPerson,
  route(async (req, res) =>
    res.json({
      status: "success",
      ...(await translateText({ tenant: req.tenant, text: req.body?.text, target: req.body?.target })),
    }),
  ),
);

// Owners and administrators can switch the assistant off for the whole company.
router.put(
  "/settings",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    if (typeof req.body?.enabled !== "boolean") throw fail(400, "enabled must be true or false");
    await query("UPDATE tenants SET ai_enabled=$2 WHERE id=$1", [req.tenantId, req.body.enabled]);
    await query(
      "INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'ai.toggled',$3)",
      [req.tenantId, req.user.id, JSON.stringify({ enabled: req.body.enabled })],
    );
    const { rows } = await query("SELECT * FROM tenants WHERE id=$1", [req.tenantId]);
    res.json({ status: "success", ...(await aiStatus(rows[0])) });
  }),
);
export default router;
