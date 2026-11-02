import express from "express";
import rateLimit from "express-rate-limit";
import { query } from "../db/index.js";
import { authenticateToken, requireTenantContext, requireRole } from "../middleware/auth.js";
import { route } from "../middleware/http.js";
import { buildExport, messageCsv } from "../services/dataExport.js";
import { listAutomated, verifyChain } from "../services/auditTrail.js";

// Taking your data with you, and seeing what the machine said on your behalf.
export const exportRouter = express.Router();
exportRouter.use(authenticateToken, requireTenantContext, requireRole("owner", "admin"));

// A whole company's data is heavy and sensitive, so it is rationed and every export is written to the audit log.
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.tenantId}:export`,
  validate: false,
  message: { status: "error", message: "You've exported a lot just now. Please try again in a while." },
});
const note = (req, what) =>
  query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'company.exported',$3)", [req.tenantId, req.user?.id ?? null, JSON.stringify({ what })]);

exportRouter.get(
  "/",
  limiter,
  route(async (req, res) => {
    const data = await buildExport(req.tenantId);
    await note(req, "data");
    res.setHeader("Content-Disposition", `attachment; filename="scriwo-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.type("application/json").send(JSON.stringify(data, null, 2));
  }),
);

exportRouter.get(
  "/messages.csv",
  limiter,
  route(async (req, res) => {
    await note(req, "messages");
    res.setHeader("Content-Disposition", `attachment; filename="scriwo-messages-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.type("text/csv; charset=utf-8");
    for await (const chunk of messageCsv(req.tenantId)) res.write(chunk);
    res.end();
  }),
);

// What Riwo and the rules said, newest first; managers see all, staff only their own chats
export const automatedRouter = express.Router();
automatedRouter.use(authenticateToken, requireTenantContext);
automatedRouter.get(
  "/",
  route(async (req, res) => {
    res.json({ status: "success", rows: await listAutomated(req, { conversationId: req.query.conversationId || null, limit: req.query.limit, beforeId: req.query.beforeId || null }) });
  }),
);
automatedRouter.get(
  "/verify",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    res.json({ status: "success", ...(await verifyChain(req.tenantId)) });
  }),
);
