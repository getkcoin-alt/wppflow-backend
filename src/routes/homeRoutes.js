import express from "express";
import { authenticateToken, requireTenantContext } from "../middleware/auth.js";
import { route } from "../middleware/http.js";
import { homeFor } from "../services/homeService.js";

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

export default router;
