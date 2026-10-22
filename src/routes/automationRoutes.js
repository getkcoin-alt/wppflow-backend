import crypto from "node:crypto";
import express from "express";
import {
  authenticateToken,
  requireTenantContext,
  requireRole,
} from "../middleware/auth.js";
import { route, fail } from "../middleware/http.js";
import { query } from "../db/index.js";
import { automationView } from "../services/automationService.js";
import { cleanRule } from "../services/automationRules.js";
import { AUTOMATION_TEMPLATES } from "../services/automationTemplates.js";
import { requireFeature } from "../services/plans.js";
const router = express.Router();
router.use(
  authenticateToken,
  requireTenantContext,
  requireRole("owner", "admin"),
  requireFeature("automations"),
);
router.get(
  "/",
  route(async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM automations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100",
      [req.tenantId],
    );
    res.json({ status: "success", automations: rows.map(automationView) });
  }),
);
// The ready-made rules, so the screen doesn't carry its own copy.
router.get("/templates", (req, res) => res.json({ status: "success", templates: AUTOMATION_TEMPLATES }));

const teammateOf = (tenantId) => async (name) =>
  (
    await query(
      "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND u.name=$2",
      [tenantId, name],
    )
  ).rowCount > 0;

router.post(
  "/",
  route(async (req, res) => {
    const rule = await cleanRule(req.body, { teammate: teammateOf(req.tenantId) });
    // A new rule never goes live by itself: the person reads it first.
    const { rows } = await query(
      `INSERT INTO automations(id,tenant_id,name,trigger_type,trigger_condition,action_type,action_summary,config,template_id,is_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false) RETURNING *`,
      [crypto.randomUUID(), req.tenantId, rule.name, rule.triggerType, rule.triggerCondition, rule.actionType, rule.actionSummary, JSON.stringify(rule.config), rule.templateId],
    );
    res.status(201).json({ status: "success", automation: automationView(rows[0]) });
  }),
);
// Changing a saved rule keeps whether it is live and how often it has run.
router.put(
  "/:id",
  route(async (req, res) => {
    const rule = await cleanRule(req.body, { teammate: teammateOf(req.tenantId) });
    const { rows } = await query(
      `UPDATE automations SET name=$3,trigger_type=$4,trigger_condition=$5,action_type=$6,action_summary=$7,config=$8,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [req.params.id, req.tenantId, rule.name, rule.triggerType, rule.triggerCondition, rule.actionType, rule.actionSummary, JSON.stringify(rule.config)],
    );
    if (!rows[0]) throw fail(404, "Automation not found");
    res.json({ status: "success", automation: automationView(rows[0]) });
  }),
);
router.patch(
  "/:id/toggle",
  route(async (req, res) => {
    const { rows } = await query(
      "UPDATE automations SET is_enabled=NOT is_enabled,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *",
      [req.params.id, req.tenantId],
    );
    if (!rows[0]) throw fail(404, "Automation not found");
    res.json({ status: "success", automation: automationView(rows[0]) });
  }),
);
router.delete(
  "/:id",
  route(async (req, res) => {
    await query(
      "DELETE FROM automation_executions WHERE automation_id=$1 AND tenant_id=$2",
      [req.params.id, req.tenantId],
    );
    await query("DELETE FROM automations WHERE id=$1 AND tenant_id=$2", [
      req.params.id,
      req.tenantId,
    ]);
    res.json({ status: "success" });
  }),
);
export default router;
