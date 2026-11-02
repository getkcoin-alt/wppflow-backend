import express from "express";
import rateLimit from "express-rate-limit";
import { authenticateToken, requireTenantContext, requireRole } from "../middleware/auth.js";
import { route } from "../middleware/http.js";
import { requireFeature } from "../services/plans.js";
import { addSource, queueRefresh, removeSource, saveNotes, statusOf } from "../services/knowledgeService.js";

// The company's knowledge base: the websites Riwo reads, a refresh button, and the owner's own notes.
const router = express.Router();
router.use(authenticateToken, requireTenantContext, requireRole("owner", "admin"), requireFeature("automations"));

// Reading a site costs the site's bandwidth and a Riwo request, so it is rationed
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.tenantId}:knowledge`,
  validate: false,
  message: { status: "error", message: "You've asked Riwo to read a lot just now. Please try again in a while." },
});

router.get("/", route(async (req, res) => res.json({ status: "success", ...(await statusOf(req.tenantId)) })));
router.post(
  "/sources",
  limiter,
  route(async (req, res) => {
    await addSource(req.tenantId, req.body?.url);
    res.status(202).json({ status: "success", ...(await statusOf(req.tenantId)) });
  }),
);
router.post(
  "/sources/:id/refresh",
  limiter,
  route(async (req, res) => {
    await queueRefresh(req.tenantId, req.params.id);
    res.status(202).json({ status: "success", ...(await statusOf(req.tenantId)) });
  }),
);
router.delete(
  "/sources/:id",
  route(async (req, res) => {
    await removeSource(req.tenantId, req.params.id);
    res.json({ status: "success", ...(await statusOf(req.tenantId)) });
  }),
);
router.put(
  "/notes",
  route(async (req, res) => {
    await saveNotes(req.tenantId, req.body?.notes);
    res.json({ status: "success", ...(await statusOf(req.tenantId)) });
  }),
);
export default router;
