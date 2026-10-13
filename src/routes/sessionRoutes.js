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
  validateSession,
} from "../services/sessionService.js";
import { syncConversations } from "../services/conversationService.js";
import { syncContacts } from "./contactRoutes.js";
import { route, fail } from "../middleware/http.js";
const router = express.Router();
router.use(authenticateToken, requireTenantContext, requireScope("sessions"));
const manager = (req) =>
  ["owner", "admin"].includes(req.membership?.role) || req.user.isSuperAdmin;
async function sessionView(tenantId, name, showQr = false) {
  const { rows } = await query(
    "SELECT * FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2",
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
  };
}
router.get(
  "/",
  route(async (req, res) => {
    const { rows } = await query(
      "SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 ORDER BY created_at",
      [req.tenantId],
    );
    res.json({
      status: "success",
      sessions: await Promise.all(
        rows.map((s) =>
          sessionView(req.tenantId, s.session_name, manager(req)),
        ),
      ),
    });
  }),
);
router.post(
  "/start",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const name = validateSession(req.body.sessionName || req.body.sessionKey);
    await startTenantSession(req.tenantId, name, req.app.get("io"));
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
  route(async (req, res) =>
    res.json({
      status: "success",
      ...(await sessionView(
        req.tenantId,
        req.params.sessionName,
        manager(req),
      )),
    }),
  ),
);
router.get(
  "/:sessionName/qr",
  requireRole("owner", "admin"),
  route(async (req, res) =>
    res.json({
      status: "success",
      ...(await sessionView(req.tenantId, req.params.sessionName, true)),
    }),
  ),
);
router.post(
  ["/:sessionName/close", "/:sessionName/logout"],
  requireRole("owner", "admin"),
  route(async (req, res) => {
    await sessionView(req.tenantId, req.params.sessionName);
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
  requireRole("owner", "admin"),
  route(async (req, res) => {
    await closeTenantSession(
      req.tenantId,
      req.params.sessionName,
      req.app.get("io"),
    );
    await query(
      "DELETE FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2",
      [req.tenantId, req.params.sessionName],
    );
    res.json({ status: "success" });
  }),
);
router.post(
  "/:sessionName/sync-inbox",
  route(async (req, res) => {
    await sessionView(req.tenantId, req.params.sessionName);
    await syncContacts(req.tenantId, req.params.sessionName);
    const result = await syncConversations({
      tenantId: req.tenantId,
      sessionName: req.params.sessionName,
      io: req.app.get("io"),
    });
    req.app
      .get("io")
      ?.to(`tenant:${req.tenantId}`)
      .emit("inbox:synced", { sessionName: req.params.sessionName });
    res.json(result);
  }),
);
export default router;
