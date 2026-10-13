import crypto from "node:crypto";
import express from "express";
import {
  authenticateToken,
  requireTenantContext,
  requireRole,
} from "../middleware/auth.js";
import { query } from "../db/index.js";
import { route, fail, text } from "../middleware/http.js";
import { campaignView, startCampaign } from "../services/campaignService.js";
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
      "SELECT * FROM campaigns WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100",
      [req.tenantId],
    );
    res.json({ status: "success", campaigns: rows.map(campaignView) });
  }),
);
router.post(
  "/",
  route(async (req, res) => {
    const name = text(req.body.name, "Name", 255),
      template = text(req.body.templateText, "Message", 10000);
    const scheduled = req.body.scheduledFor || "";
    if (scheduled && !Number.isFinite(Date.parse(scheduled)))
      throw fail(400, "Invalid schedule");
    const { rows } = await query(
      `INSERT INTO campaigns(id,tenant_id,name,target_segment,template_text,session_name,anti_ban_delay_seconds,scheduled_for) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        crypto.randomUUID(),
        req.tenantId,
        name,
        req.body.targetSegment || "All Contacts",
        template,
        req.body.sessionName || null,
        Math.max(4, Math.min(Number(req.body.antiBanDelaySeconds) || 4, 60)),
        scheduled,
      ],
    );
    res
      .status(201)
      .json({ status: "success", campaign: campaignView(rows[0]) });
  }),
);
router.post(
  ["/:id/start", "/:id/send"],
  route(async (req, res) => {
    const campaign = await startCampaign(req.tenantId, req.params.id);
    req.app
      .get("io")
      ?.to(`tenant:${req.tenantId}`)
      .emit("campaign:status", {
        campaignId: campaign.id,
        status: campaign.status,
      });
    res.json({ status: "success", campaign });
  }),
);
router.post(
  ["/:id/stop", "/:id/pause"],
  route(async (req, res) => {
    const status = req.path.endsWith("pause") ? "paused" : "stopped";
    const { rows } = await query(
      "UPDATE campaigns SET status=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3 RETURNING *",
      [status, req.params.id, req.tenantId],
    );
    if (!rows[0]) throw fail(404, "Campaign not found");
    req.app
      .get("io")
      ?.to(`tenant:${req.tenantId}`)
      .emit("campaign:status", { campaignId: req.params.id, status });
    res.json({ status: "success", campaign: campaignView(rows[0]) });
  }),
);
export default router;
