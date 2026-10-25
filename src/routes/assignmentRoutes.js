import express from "express";
import { authenticateToken, requireTenantContext, requireRole } from "../middleware/auth.js";
import { route, fail } from "../middleware/http.js";
import { requireFeature } from "../services/plans.js";
import { getSettings, saveSettings, setAvailability } from "../services/assignmentService.js";
import { query } from "../db/index.js";

const router = express.Router();
router.use(authenticateToken, requireTenantContext);

// A person's own switch: "I'm taking new chats" (off while on a break or on leave).
router.get(
  "/me",
  route(async (req, res) => {
    if (req.apiKey) throw fail(403, "Interactive login required");
    const r = (await query("SELECT available,assignable FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'", [req.tenantId, req.user.id])).rows[0];
    if (!r) throw fail(404, "You are not a member of this company");
    res.json({ status: "success", available: r.available, inRotation: r.assignable });
  }),
);
router.put(
  "/me",
  route(async (req, res) => {
    if (req.apiKey) throw fail(403, "Interactive login required");
    if (typeof req.body.available !== "boolean") throw fail(400, "Say whether you are available");
    res.json({ status: "success", ...(await setAvailability(req.tenantId, req.user.id, req.body.available)) });
  }),
);

// The company's rule for new chats.
router.get(
  "/",
  requireRole("owner", "admin"),
  requireFeature("automations"),
  route(async (req, res) => res.json({ status: "success", settings: await getSettings(req.tenantId) })),
);
router.put(
  "/",
  requireRole("owner", "admin"),
  requireFeature("automations"),
  route(async (req, res) => res.json({ status: "success", settings: await saveSettings(req.tenantId, req.body || {}, req.user) })),
);

export default router;
