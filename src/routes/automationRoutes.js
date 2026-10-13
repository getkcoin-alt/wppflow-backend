import crypto from "node:crypto";
import express from "express";
import {
  authenticateToken,
  requireTenantContext,
  requireRole,
} from "../middleware/auth.js";
import { route, text, fail } from "../middleware/http.js";
import { query } from "../db/index.js";
import { automationView } from "../services/automationService.js";
const router = express.Router();
router.use(
  authenticateToken,
  requireTenantContext,
  requireRole("owner", "admin"),
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
router.post(
  "/",
  route(async (req, res) => {
    const action = req.body.actionType;
    if (!["reply_text", "assign_agent"].includes(action))
      throw fail(400, "Choose reply_text or assign_agent");
    const { rows } = await query(
      `INSERT INTO automations(id,tenant_id,name,trigger_type,trigger_condition,action_type,action_summary,is_enabled) VALUES($1,$2,$3,'keyword',$4,$5,$6,false) RETURNING *`,
      [
        crypto.randomUUID(),
        req.tenantId,
        text(req.body.name, "Name", 255),
        text(req.body.triggerCondition, "Keyword", 100),
        action,
        text(req.body.actionSummary, "Action", 10000),
      ],
    );
    res
      .status(201)
      .json({ status: "success", automation: automationView(rows[0]) });
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
