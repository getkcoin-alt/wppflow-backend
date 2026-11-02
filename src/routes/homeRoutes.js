import express from "express";
import { query } from "../db/index.js";
import { authenticateToken, requireTenantContext, requireRole } from "../middleware/auth.js";
import { route, fail } from "../middleware/http.js";
import { homeFor } from "../services/homeService.js";
import { RULES, AUTOPILOT, rulesOf, setRule, sentToday, logFor, undo } from "../services/autopilotService.js";
import { unavailableReason } from "../services/aiService.js";
import { planAllows, notIncluded } from "../services/plans.js";
import { isManager } from "../services/access.js";

const router = express.Router();
router.use(authenticateToken);
router.use(requireTenantContext);

/**
 * GET /api/home?until=ISO
 * What needs this person now: waiting customers, follow-ups due, numbers that need care, and setup steps. `until` is the
 * end of the person's own day, which only their browser knows.
 */
router.get(
  "/",
  route(async (req, res) => {
    res.json({ status: "success", ...(await homeFor(req, { until: req.query.until })) });
  }),
);

/**
 * GET /api/home/autopilot
 * What Riwo may do by itself in this company, whether it is allowed to, and what it has done lately.
 */
router.get(
  "/autopilot",
  route(async (req, res) => {
    const reason = unavailableReason(req.tenant);
    const [rules, today, log] = await Promise.all([rulesOf(req.tenantId), sentToday(req.tenantId), logFor(req)]);
    res.json({
      status: "success",
      // "plan" when the company's plan has no AI, and so no Autopilot; other reasons are why Riwo is off right now
      available: reason === null,
      reason,
      canEdit: isManager(req) && req.membership?.role !== "agent",
      rules: Object.entries(RULES).map(([key, r]) => ({ key, label: r.label, description: r.description, enabled: rules[key] })),
      sentToday: today,
      dailyCap: AUTOPILOT.dailyCap,
      log,
    });
  }),
);

// Owners and administrators switch each rule on or off. It needs the plan that has Riwo.
router.put(
  "/autopilot/rules/:key",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    if (typeof req.body?.enabled !== "boolean") throw fail(400, "enabled must be true or false");
    if (!RULES[req.params.key]) throw fail(404, "That is not an Autopilot rule.");
    if (req.body.enabled && !planAllows(req.tenant, "ai")) throw notIncluded(req.tenant.plan, "ai");
    await setRule(req.tenantId, req.params.key, req.body.enabled, req.user.id);
    await query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'autopilot.rule',$3)", [req.tenantId, req.user.id, JSON.stringify({ rule: req.params.key, enabled: req.body.enabled })]);
    res.json({ status: "success", rules: await rulesOf(req.tenantId) });
  }),
);

// Takes one of Autopilot's actions back.
router.post(
  "/autopilot/:id/undo",
  route(async (req, res) => {
    res.json({ status: "success", ...(await undo(req, req.params.id, req.app.get("io"))) });
  }),
);

export default router;
