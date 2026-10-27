import express from "express";
import { authenticateToken, requireTenantContext, requireRole } from "../middleware/auth.js";
import { route, fail } from "../middleware/http.js";
import { solutionsFor, settingsOf, saveSettings, requireSolution } from "../solutions/entitlements.js";
import { isSolution } from "../solutions/registry.js";

// What a company has been given, and the settings it may change for each. The solutions' own endpoints live under
// /api/solutions/<key>/ and are mounted by server.js behind requireSolution.
const router = express.Router();
router.use(authenticateToken, requireTenantContext, (req, res, next) =>
  req.apiKey ? next(fail(403, "Interactive workspace login required")) : next(),
);
router.get(
  "/",
  route(async (req, res) => res.json({ status: "success", solutions: (await solutionsFor(req.tenantId)).filter((s) => s.enabled) })),
);
const known = (req, res, next) => (isSolution(req.params.key) ? next() : next(fail(404, "Unknown solution")));
router.get(
  "/:key/settings",
  known,
  requireSolution(),
  route(async (req, res) => res.json({ status: "success", settings: await settingsOf(req.tenantId, req.params.key) })),
);
router.put(
  "/:key/settings",
  known,
  requireRole("owner", "admin"),
  route(async (req, res) => res.json({ status: "success", settings: await saveSettings(req.tenantId, req.params.key, req.body || {}) })),
);
export default router;
