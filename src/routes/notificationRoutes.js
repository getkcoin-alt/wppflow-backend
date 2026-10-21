import express from "express";
import { authenticateToken, requireTenantContext } from "../middleware/auth.js";
import { query } from "../db/index.js";
import { route, fail } from "../middleware/http.js";
import { notificationView } from "../services/notificationService.js";

const router = express.Router();
router.use(authenticateToken, requireTenantContext, (req, res, next) =>
  req.apiKey ? next(fail(403, "Interactive login required")) : next(),
);

const unreadCount = async (req) =>
  (
    await query(
      "SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND tenant_id=$2 AND read_at IS NULL",
      [req.user.id, req.tenantId],
    )
  ).rows[0].n;

router.get(
  "/",
  route(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const params = [req.user.id, req.tenantId];
    let where = "";
    if (req.query.unread === "true") where += " AND read_at IS NULL";
    if (req.query.cursor) {
      const when = new Date(String(req.query.cursor));
      if (Number.isNaN(when.getTime())) throw fail(400, "Invalid cursor");
      params.push(when.toISOString());
      where += ` AND created_at < $${params.length}`;
    }
    params.push(limit + 1);
    const { rows } = await query(
      `SELECT * FROM notifications WHERE user_id=$1 AND tenant_id=$2${where}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    const items = rows.slice(0, limit);
    res.json({
      status: "success",
      notifications: items.map(notificationView),
      unreadCount: await unreadCount(req),
      nextCursor: rows.length > limit ? items.at(-1).created_at.toISOString() : null,
    });
  }),
);
router.post(
  "/read-all",
  route(async (req, res) => {
    await query(
      "UPDATE notifications SET read_at=now() WHERE user_id=$1 AND tenant_id=$2 AND read_at IS NULL",
      [req.user.id, req.tenantId],
    );
    res.json({ status: "success", unreadCount: 0 });
  }),
);
router.post(
  "/:id/read",
  route(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw fail(404, "Notification not found");
    const { rowCount } = await query(
      "UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 AND tenant_id=$3",
      [req.params.id, req.user.id, req.tenantId],
    );
    if (!rowCount) throw fail(404, "Notification not found");
    res.json({ status: "success", unreadCount: await unreadCount(req) });
  }),
);
export default router;
