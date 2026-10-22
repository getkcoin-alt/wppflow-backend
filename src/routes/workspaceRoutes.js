import crypto from "node:crypto";
import express from "express";
import os from "node:os";
import { query } from "../db/index.js";
import {
  authenticateToken,
  requireTenantContext,
  requireRole,
} from "../middleware/auth.js";
import { route, fail, text } from "../middleware/http.js";
import { queueHealth } from "../services/queue/messageQueue.js";
import {
  mediaEnabled,
  checkStorage,
  checkUploadTarget,
  finishUploadCheck,
} from "../services/mediaService.js";
import {
  resolveWebhook,
  encryptSecret,
  recordWebhook,
} from "../services/webhookService.js";
const router = express.Router();
router.use(authenticateToken, requireTenantContext, (req, res, next) =>
  req.apiKey ? next(fail(403, "Interactive workspace login required")) : next(),
);
router.get(
  "/capabilities",
  route(async (req, res) =>
    res.json({
      status: "success",
      media: mediaEnabled(),
      store: false,
      queue: queueHealth().connected,
    }),
  ),
);
// Settings checks for company owners and administrators: they prove media storage really works.
router.get(
  "/media-check",
  requireRole("owner", "admin"),
  route(async (req, res) =>
    res.json({ status: "success", ...(await checkStorage()) }),
  ),
);
router.post(
  "/media-check/upload",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    if (!mediaEnabled()) throw fail(503, "Media storage is not configured");
    res.json({ status: "success", ...(await checkUploadTarget(req.tenantId)) });
  }),
);
router.post(
  "/media-check/finish",
  requireRole("owner", "admin"),
  route(async (req, res) =>
    res.json({
      status: "success",
      ...(await finishUploadCheck(req.tenantId, text(req.body.key, "Key", 200))),
    }),
  ),
);
router.get(
  "/team",
  route(async (req, res) => {
    const { rows } = await query(
      "SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' ORDER BY u.name",
      [req.tenantId],
    );
    res.json({ status: "success", members: rows });
  }),
);
router.get(
  "/summary",
  route(async (req, res) => {
    const { rows } = await query(
      `SELECT
  (SELECT count(*)::int FROM contacts WHERE tenant_id=$1) AS contacts,
  (SELECT count(*)::int FROM conversations WHERE tenant_id=$1) AS conversations,
  (SELECT count(*)::int FROM conversations WHERE tenant_id=$1 AND unread_count>0) AS unread,
  (SELECT count(*)::int FROM whatsapp_sessions WHERE tenant_id=$1 AND status='CONNECTED') AS sessions,
  (SELECT count(*)::int FROM messages WHERE tenant_id=$1 AND sender='agent' AND type<>'internal_note' AND ack>=1) AS sent,
  (SELECT count(*)::int FROM messages WHERE tenant_id=$1 AND sender='agent' AND type<>'internal_note' AND ack>=2) AS delivered,
  (SELECT count(*)::int FROM messages WHERE tenant_id=$1 AND sender='agent' AND type<>'internal_note' AND ack>=3) AS read,
  (SELECT count(*)::int FROM outbox_events WHERE tenant_id=$1 AND status IN ('pending','queued','dispatching')) AS pending`,
      [req.tenantId],
    );
    res.json({ status: "success", summary: rows[0] });
  }),
);
router.get(
  "/canned-replies",
  route(async (req, res) => {
    const { rows } = await query(
      "SELECT id,shortcut,title,text FROM canned_replies WHERE tenant_id=$1 ORDER BY shortcut",
      [req.tenantId],
    );
    res.json({ status: "success", replies: rows });
  }),
);
router.post(
  "/canned-replies",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const { rows } = await query(
      `INSERT INTO canned_replies(id,tenant_id,shortcut,title,text) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,shortcut) DO UPDATE SET title=EXCLUDED.title,text=EXCLUDED.text RETURNING *`,
      [
        crypto.randomUUID(),
        req.tenantId,
        text(req.body.shortcut, "Shortcut", 50),
        text(req.body.title, "Title", 100),
        text(req.body.text, "Reply", 10000),
      ],
    );
    res.status(201).json({ status: "success", reply: rows[0] });
  }),
);
router.get(
  "/audit",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const { rows } = await query(
      "SELECT a.id,a.event_type,a.metadata,a.created_at,u.name AS actor FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE a.tenant_id=$1 ORDER BY a.id DESC LIMIT 100",
      [req.tenantId],
    );
    res.json({ status: "success", events: rows });
  }),
);
router.get(
  "/health",
  requireRole("owner", "admin"),
  route(async (req, res) =>
    res.json({
      status: "success",
      uptime: process.uptime(),
      nodeMemoryBytes: process.memoryUsage().rss,
      hostTotalMemoryBytes: os.totalmem(),
      loadAverage: os.loadavg(),
      queue: queueHealth(),
      note: "Memory is the API process; load is the host. Chromium and container metrics are unavailable.",
    }),
  ),
);
router.get(
  "/keys",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const { rows } = await query(
      "SELECT id,name,prefix,scopes,created_at,last_used_at,revoked_at FROM api_keys WHERE tenant_id=$1 ORDER BY created_at DESC",
      [req.tenantId],
    );
    res.json({ status: "success", keys: rows });
  }),
);
router.post(
  "/keys",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const scopes = req.body.scopes || ["inbox"];
    if (
      !Array.isArray(scopes) ||
      !scopes.length ||
      scopes.some((s) => !["inbox", "contacts", "sessions"].includes(s))
    )
      throw fail(400, "Invalid scopes");
    const key = `wpp_${crypto.randomBytes(32).toString("hex")}`,
      id = crypto.randomUUID();
    await query(
      "INSERT INTO api_keys(id,tenant_id,name,key_hash,prefix,scopes) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        req.tenantId,
        text(req.body.name, "Key name", 100),
        crypto.createHash("sha256").update(key).digest("hex"),
        key.slice(0, 12),
        JSON.stringify(scopes),
      ],
    );
    res
      .status(201)
      .json({
        status: "success",
        id,
        key,
        message: "Copy now. This key cannot be retrieved again.",
      });
  }),
);
router.delete(
  "/keys/:id",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    await query(
      "UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND tenant_id=$2",
      [req.params.id, req.tenantId],
    );
    res.json({ status: "success" });
  }),
);
router.get(
  "/webhooks",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const endpoints = await query(
      "SELECT id,url,enabled,created_at FROM webhook_endpoints WHERE tenant_id=$1",
      [req.tenantId],
    );
    const logs = await query(
      "SELECT id,event,status,attempts,response_status,error,created_at FROM webhook_deliveries WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100",
      [req.tenantId],
    );
    res.json({
      status: "success",
      endpoints: endpoints.rows,
      deliveries: logs.rows,
    });
  }),
);
router.post(
  "/webhooks",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const { url } = await resolveWebhook(text(req.body.url, "URL", 2000));
    const secret = crypto.randomBytes(32).toString("hex");
    await query(
      "INSERT INTO webhook_endpoints(id,tenant_id,url,secret) VALUES($1,$2,$3,$4)",
      [crypto.randomUUID(), req.tenantId, url.href, encryptSecret(secret)],
    );
    res
      .status(201)
      .json({
        status: "success",
        secret,
        message: "Save the signing secret now; it is shown once.",
      });
  }),
);
router.delete(
  "/webhooks/:id",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    await query(
      "UPDATE webhook_endpoints SET enabled=false WHERE id=$1 AND tenant_id=$2",
      [req.params.id, req.tenantId],
    );
    res.json({ status: "success" });
  }),
);
router.post(
  "/webhooks/test",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    await recordWebhook(req.tenantId, "test", {
      synthetic: true,
      createdAt: new Date().toISOString(),
    });
    res
      .status(202)
      .json({ status: "success", message: "Synthetic test delivery queued" });
  }),
);
export default router;
