import express from "express";
import { authenticateToken, requireTenantContext, requireScope, requireWriteAccess, requireRole } from "../middleware/auth.js";
import { route, fail } from "../middleware/http.js";
import { query } from "../db/index.js";
import { LABEL_COLORS, listLabels, createLabel, updateLabel, deleteLabel, applyLabels } from "../services/labelService.js";

const router = express.Router();
router.use(authenticateToken, requireTenantContext, requireScope("contacts"));
router.use(requireWriteAccess);

const audit = (req, event, metadata) =>
  query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,$3,$4)", [req.tenantId, req.user?.id ?? null, event, JSON.stringify(metadata)]);
const changed = (req, contactIds = []) => req.app.get("io")?.to(`tenant:${req.tenantId}`).emit("contact:changed", { contactId: contactIds[0] || null, contactIds, labels: true });

// Everyone on the team can see and use the company's labels, and add a new one while tagging.
router.get(
  "/",
  route(async (req, res) => {
    res.json({ status: "success", labels: await listLabels(req.tenantId), colors: LABEL_COLORS });
  }),
);
router.post(
  "/",
  route(async (req, res) => {
    const label = await createLabel(req.tenantId, req.body || {}, req.user?.id);
    res.status(201).json({ status: "success", label });
  }),
);
// Tag or untag many contacts at once.
router.post(
  "/apply",
  route(async (req, res) => {
    const result = await applyLabels(req.tenantId, req.body || {});
    await audit(req, "labels.applied", { contacts: result.updated, added: result.added.map((l) => l.name), removed: result.removed.map((l) => l.name) });
    changed(req, (req.body.contactIds || []).slice(0, 50));
    res.json({ status: "success", ...result });
  }),
);
// Renaming, recolouring and deleting change what everyone sees, so they stay with owners and administrators.
router.patch(
  "/:id",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const result = await updateLabel(req.tenantId, req.params.id, req.body || {});
    if (result.renamedFrom) await audit(req, "label.renamed", { labelId: req.params.id, from: result.renamedFrom, to: result.label.name });
    changed(req, result.contactIds.slice(0, 50));
    res.json({ status: "success", label: result.label });
  }),
);
router.delete(
  "/:id",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    const result = await deleteLabel(req.tenantId, req.params.id);
    await audit(req, "label.deleted", { labelId: req.params.id, name: result.label.name, contacts: result.contactIds.length });
    changed(req, result.contactIds.slice(0, 50));
    res.json({ status: "success" });
  }),
);
export default router;
