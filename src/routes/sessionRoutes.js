import express from "express";
import {
  authenticateToken,
  requireTenantContext,
  requireRole,
  requireScope,
} from "../middleware/auth.js";
import { query } from "../db/index.js";
import { defaultWhatsAppProvider as provider } from "../services/whatsapp/WhatsAppProvider.js";
import {
  startTenantSession,
  closeTenantSession,
  removeTenantSession,
  validateSession,
} from "../services/sessionService.js";
import { syncConversations } from "../services/conversationService.js";
import { syncContacts } from "./contactRoutes.js";
import { route, fail } from "../middleware/http.js";
import { isManager, assertSessionAccess } from "../services/access.js";
import { emitForSession, forgetSessionOwner } from "../services/realtime.js";
const router = express.Router();
router.use(authenticateToken, requireTenantContext, requireScope("sessions"));
const manager = isManager;
// Every staff member pairs their own number under a deterministic name.
const staffSessionName = (userId) => `staff-${userId}`;
async function sessionView(tenantId, name, showQr = false) {
  const { rows } = await query(
    `SELECT s.*,u.name AS owner_name,u.email AS owner_email FROM whatsapp_sessions s
     LEFT JOIN users u ON u.id=s.owner_user_id WHERE s.tenant_id=$1 AND s.session_name=$2`,
    [tenantId, name],
  );
  if (!rows[0]) throw fail(404, "Session not found");
  const s = rows[0],
    live = provider.getSession(tenantId, name),
    active = new Date(s.lease_until) > new Date(),
    status = live?.status || (active ? s.status : "DISCONNECTED"),
    qrcode = showQr ? live?.qrcode || (active ? s.qr_code : null) : null;
  return {
    id: s.id,
    sessionKey: name,
    sessionName: name,
    session: name,
    displayName: name,
    status,
    sessionStatus: status,
    phone: live?.phone || s.phone,
    battery: null,
    antiBanHealth: null,
    warmupDay: null,
    hasQr: Boolean(qrcode),
    qrcode,
    lastActive: s.updated_at,
    error: s.last_error || null,
    ownerUserId: s.owner_user_id,
    ownerName: s.owner_name || null,
    ownerEmail: s.owner_email || null,
  };
}
router.get(
  "/",
  route(async (req, res) => {
    const mine = !manager(req);
    const { rows } = await query(
      `SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 ${mine ? "AND owner_user_id=$2" : ""} ORDER BY created_at`,
      mine ? [req.tenantId, req.user.id] : [req.tenantId],
    );
    res.json({
      status: "success",
      scope: mine ? "own" : "workspace",
      sessions: await Promise.all(
        rows.map((s) => sessionView(req.tenantId, s.session_name, true)),
      ),
    });
  }),
);
router.post(
  "/start",
  requireRole("owner", "admin", "agent"),
  route(async (req, res) => {
    if (req.apiKey) throw fail(403, "Interactive login required");
    const name = manager(req)
      ? validateSession(req.body.sessionName || req.body.sessionKey)
      : staffSessionName(req.user.id);
    const existing = await query(
      "SELECT owner_user_id FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2",
      [req.tenantId, name],
    );
    // Linking a NEW number must never quietly start one that is already linked: it would come up
    // from its saved login, with no QR code to scan, and look like a new number that connected
    // by itself. Starting an existing one is what Reconnect does, and does not set newNumber.
    if (req.body.newNumber === true) {
      const same = await query(
        "SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 AND lower(session_name)=lower($2)",
        [req.tenantId, name],
      );
      if (same.rows[0])
        throw fail(
          409,
          manager(req)
            ? `You already have a number called "${same.rows[0].session_name}". Choose another name for the new one, or use Reconnect on that one.`
            : "You already have your WhatsApp number linked. Use Reconnect on it.",
        );
    }
    if (
      existing.rows[0] &&
      !manager(req) &&
      existing.rows[0].owner_user_id !== req.user.id
    )
      throw fail(403, "This WhatsApp session belongs to another team member");
    await startTenantSession(req.tenantId, name, req.app.get("io"), req.user.id);
    res
      .status(202)
      .json({
        status: "success",
        sessionName: name,
        sessionKey: name,
        message: "Pairing requested",
      });
  }),
);
router.get(
  "/:sessionName/status",
  route(async (req, res) => {
    await assertSessionAccess(req, req.params.sessionName);
    res.json({
      status: "success",
      ...(await sessionView(req.tenantId, req.params.sessionName, true)),
    });
  }),
);
router.get(
  "/:sessionName/qr",
  requireRole("owner", "admin", "agent"),
  route(async (req, res) => {
    await assertSessionAccess(req, req.params.sessionName);
    res.json({
      status: "success",
      ...(await sessionView(req.tenantId, req.params.sessionName, true)),
    });
  }),
);
router.post(
  ["/:sessionName/close", "/:sessionName/logout"],
  requireRole("owner", "admin", "agent"),
  route(async (req, res) => {
    await assertSessionAccess(req, req.params.sessionName);
    await closeTenantSession(
      req.tenantId,
      req.params.sessionName,
      req.app.get("io"),
    );
    res.json({
      status: "success",
      message: "Browser disconnected. Device credentials and history retained.",
    });
  }),
);
router.delete(
  "/:sessionName",
  requireRole("owner", "admin", "agent"),
  route(async (req, res) => {
    await assertSessionAccess(req, req.params.sessionName);
    const { unlinked } = await removeTenantSession(
      req.tenantId,
      req.params.sessionName,
      req.app.get("io"),
    );
    res.json({
      status: "success",
      unlinked,
      message: unlinked
        ? "Removed and unlinked from the phone."
        : "Removed here. WhatsApp could not unlink it automatically: on the phone open WhatsApp > Linked devices and remove it.",
    });
  }),
);
router.patch(
  "/:sessionName/owner",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    if (req.apiKey) throw fail(403, "Interactive login required");
    await assertSessionAccess(req, req.params.sessionName);
    const userId = Number(req.body.userId);
    const member = await query(
      "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND u.status='active'",
      [req.tenantId, userId],
    );
    if (!member.rowCount) throw fail(400, "Assignee is not an active teammate");
    await query(
      "UPDATE whatsapp_sessions SET owner_user_id=$3,updated_at=now() WHERE tenant_id=$1 AND session_name=$2",
      [req.tenantId, req.params.sessionName, userId],
    );
    forgetSessionOwner(req.tenantId, req.params.sessionName);
    res.json({
      status: "success",
      ...(await sessionView(req.tenantId, req.params.sessionName, true)),
    });
  }),
);
router.post(
  "/:sessionName/sync-inbox",
  route(async (req, res) => {
    await assertSessionAccess(req, req.params.sessionName);
    await syncContacts(req.tenantId, req.params.sessionName);
    const result = await syncConversations({
      tenantId: req.tenantId,
      sessionName: req.params.sessionName,
      io: req.app.get("io"),
    });
    emitForSession(
      req.app.get("io"),
      req.tenantId,
      req.params.sessionName,
      "inbox:synced",
      { sessionName: req.params.sessionName },
    );
    res.json(result);
  }),
);
export default router;
