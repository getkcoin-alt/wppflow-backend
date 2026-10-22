import crypto from "node:crypto";
import express from "express";
import {
  authenticateToken,
  requireTenantContext,
  requireRole,
} from "../middleware/auth.js";
import { query } from "../db/index.js";
import { route, fail, text } from "../middleware/http.js";
import { audienceFor, campaignView, duplicateCampaign, startCampaign } from "../services/campaignService.js";
import { CAMPAIGN_TEMPLATES, unfilledBlanks } from "../services/campaignTemplates.js";
import { unknownVariables, VARIABLES } from "../services/templating.js";
import { requireFeature } from "../services/plans.js";
const router = express.Router();
router.use(
  authenticateToken,
  requireTenantContext,
  requireRole("owner", "admin"),
  requireFeature("broadcasts"),
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
// Ready-made messages to start from.
router.get("/templates", (req, res) => res.json({ status: "success", templates: CAMPAIGN_TEMPLATES, variables: VARIABLES }));
// Who a broadcast would reach: the numbers behind "will receive", and the tags to choose from.
router.get(
  "/audience",
  route(async (req, res) => {
    const tag = req.query.tag ? text(String(req.query.tag), "Tag", 255) : "All Contacts";
    res.json({ status: "success", ...(await audienceFor(req.tenantId, tag)) });
  }),
);
// `launch` says what happens next: "draft" (the default) saves it, "now" starts it, "schedule" starts it at
// `scheduledFor`. Starting checks that the number is connected and that someone would actually receive it.
router.post(
  "/",
  route(async (req, res) => {
    const name = text(req.body.name, "Name", 255),
      template = text(req.body.templateText, "Message", 10000);
    const bad = unknownVariables(template);
    if (bad.length)
      throw fail(400, `${bad.join(", ")} isn't a field. Use ${VARIABLES.map((v) => `{{${v}}}`).join(", ")}.`);
    const blanks = unfilledBlanks(template);
    if (blanks.length) throw fail(400, `Fill in ${blanks.join(", ")} before sending`);
    const launch = ["draft", "now", "schedule"].includes(req.body.launch) ? req.body.launch : "draft";
    const scheduled = launch === "now" ? "" : req.body.scheduledFor || "";
    if (scheduled && !Number.isFinite(Date.parse(scheduled))) throw fail(400, "Invalid schedule");
    if (launch === "schedule" && !(Date.parse(scheduled) > Date.now() - 60_000))
      throw fail(400, "Choose a start time in the future");
    const segment = req.body.targetSegment || "All Contacts";
    if (req.body.sessionName) {
      const session = await query("SELECT status FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [req.tenantId, req.body.sessionName]);
      if (!session.rowCount) throw fail(400, "Choose one of your WhatsApp numbers");
      if (launch !== "draft" && session.rows[0].status !== "CONNECTED")
        throw fail(400, "That number isn't connected right now. Reconnect it, or save this as a draft.");
    } else if (launch !== "draft") throw fail(400, "Choose the WhatsApp number to send from");
    if (launch !== "draft" && !(await audienceFor(req.tenantId, segment)).willReceive)
      throw fail(400, "Nobody in this audience has given permission yet, so nothing would be sent");
    const { rows } = await query(
      `INSERT INTO campaigns(id,tenant_id,name,target_segment,template_text,session_name,anti_ban_delay_seconds,scheduled_for) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        crypto.randomUUID(),
        req.tenantId,
        name,
        segment,
        template,
        req.body.sessionName || null,
        Math.max(4, Math.min(Number(req.body.antiBanDelaySeconds) || 4, 60)),
        scheduled,
      ],
    );
    let campaign = campaignView(rows[0]);
    if (launch !== "draft") {
      campaign = await startCampaign(req.tenantId, rows[0].id);
      req.app.get("io")?.to(`tenant:${req.tenantId}`).emit("campaign:status", { campaignId: campaign.id, status: campaign.status });
    }
    res.status(201).json({ status: "success", campaign });
  }),
);
router.post(
  "/:id/duplicate",
  route(async (req, res) => {
    res.status(201).json({ status: "success", campaign: await duplicateCampaign(req.tenantId, req.params.id) });
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
