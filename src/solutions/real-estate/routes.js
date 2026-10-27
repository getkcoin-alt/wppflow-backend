import express from "express";
import { authenticateToken, requireTenantContext, requireRole, requireWriteAccess } from "../../middleware/auth.js";
import { route, fail } from "../../middleware/http.js";
import { requireSolution } from "../entitlements.js";
import { query } from "../../db/index.js";
import { findLead, leadView } from "../../services/leadService.js";
import { getProfile, saveProfile, createLeadWithProfile, LEAD_TYPES, BUDGET_CURRENCIES, STATUSES as QUALIFICATION_STATUSES } from "./profile.js";
import { PROPERTY_TYPES, TIMELINES } from "./matching.js";
import { createProperty, getProperty, listProperties, updateProperty, verifyProperty, deleteProperty, matchesForLead, STATUSES as PROPERTY_STATUSES } from "./properties.js";
import { createViewing, listViewings, findViewing, viewingView, confirmViewing, completeViewing, cancelViewing, noShowViewing, rescheduleViewing, confirmationText, viewingIcs } from "./viewings.js";
import { listAlerts, resolveAlert, dismissAlert, snoozeAlert, overview, scanTenant } from "./leaks.js";
import { extractQualification, draftReply } from "./ai.js";
import { nextActions } from "./actions.js";
import { settingsOf } from "../entitlements.js";
import rateLimit from "express-rate-limit";

// Scriwo Real Estate. Everything here is reached only by a company that has been given the solution and whose plan still
// includes the pipeline it is built on (requireSolution). Every record is looked up with the company's id from the signed
// session, never from the request.
const router = express.Router();
router.use(authenticateToken, requireTenantContext, requireSolution("real_estate"), requireWriteAccess);
const manager = requireRole("owner", "admin");
const perPerson = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.tenantId}:${req.user?.id ?? "api"}:re-ai`,
  validate: false,
  message: { status: "error", message: "You're going a little fast. Wait a moment and try again." },
});

// What the screens need to draw their forms: the allowed choices, so the browser never has its own copy.
router.get(
  "/meta",
  route(async (req, res) =>
    res.json({
      status: "success",
      leadTypes: LEAD_TYPES,
      qualificationStatuses: QUALIFICATION_STATUSES,
      propertyTypes: PROPERTY_TYPES,
      propertyStatuses: PROPERTY_STATUSES,
      timelines: TIMELINES,
      currencies: BUDGET_CURRENCIES,
      settings: await settingsOf(req.tenantId, "real_estate"),
    }),
  ),
);

// ── Revenue ──────────────────────────────────────────────────────────────────────────────────────
router.get("/overview", route(async (req, res) => res.json({ status: "success", ...(await overview(req, { days: req.query.days })) })));
router.get("/alerts", route(async (req, res) => res.json({ status: "success", alerts: await listAlerts(req, { status: req.query.status, kind: req.query.kind, limit: req.query.limit }) })));
router.post("/alerts/scan", manager, route(async (req, res) => res.json({ status: "success", ...(await scanTenant(req.tenantId, { io: req.app.get("io") })) })));
router.post("/alerts/:id/resolve", route(async (req, res) => res.json({ status: "success", alert: await resolveAlert(req, req.params.id) })));
router.post("/alerts/:id/dismiss", route(async (req, res) => res.json({ status: "success", alert: await dismissAlert(req, req.params.id) })));
router.post("/alerts/:id/snooze", route(async (req, res) => res.json({ status: "success", alert: await snoozeAlert(req, req.params.id, req.body?.hours) })));

// ── Leads ────────────────────────────────────────────────────────────────────────────────────────
router.post(
  "/leads",
  route(async (req, res) => {
    const made = await createLeadWithProfile(req, req.body || {});
    const lead = await findLead(req, made.id).catch(() => null);
    res.status(made.existing ? 200 : 201).json({ status: "success", existing: made.existing, lead: lead ? leadView(lead) : null, ...(await getProfile(req, made.id).then(({ profile, missing }) => ({ profile, missing })).catch(() => ({}))) });
  }),
);
router.get("/leads/:id/profile", route(async (req, res) => {
  const { profile, missing, lead } = await getProfile(req, req.params.id);
  res.json({ status: "success", profile, missing, lead: leadView(lead) });
}));
router.put("/leads/:id/profile", route(async (req, res) => res.json({ status: "success", ...(await saveProfile(req, req.params.id, req.body || {}, { assisted: req.body?.assisted === true && Object.keys(req.body).length > 1 })) })));
router.get("/leads/:id/matches", route(async (req, res) => res.json({ status: "success", ...(await matchesForLead(req, req.params.id)) })));
router.get("/leads/:id/next-actions", route(async (req, res) => res.json({ status: "success", actions: await nextActions(req, req.params.id) })));
router.get(
  "/leads/:id/viewings",
  route(async (req, res) => {
    await findLead(req, req.params.id);
    res.json({ status: "success", viewings: await listViewings(req, { lead: req.params.id, from: "2000-01-01", to: "2100-01-01" }) });
  }),
);
router.post("/leads/:id/ai/qualification", perPerson, route(async (req, res) => res.json({ status: "success", ...(await extractQualification(req, req.params.id)) })));
router.post("/leads/:id/ai/draft", perPerson, route(async (req, res) => res.json({ status: "success", ...(await draftReply(req, req.params.id, { tone: req.body?.tone })) })));

// ── Properties ───────────────────────────────────────────────────────────────────────────────────
router.get("/properties", route(async (req, res) => res.json({ status: "success", ...(await listProperties(req, req.query)) })));
router.post("/properties", route(async (req, res) => res.status(201).json({ status: "success", property: await createProperty(req, req.body) })));
router.get("/properties/:id", route(async (req, res) => res.json({ status: "success", property: await getProperty(req, req.params.id) })));
router.patch("/properties/:id", route(async (req, res) => res.json({ status: "success", property: await updateProperty(req, req.params.id, req.body) })));
router.post("/properties/:id/verify", route(async (req, res) => res.json({ status: "success", property: await verifyProperty(req, req.params.id) })));
router.delete("/properties/:id", route(async (req, res) => {
  await deleteProperty(req, req.params.id);
  res.json({ status: "success" });
}));

// ── Viewings ─────────────────────────────────────────────────────────────────────────────────────
router.get("/viewings", route(async (req, res) => res.json({ status: "success", viewings: await listViewings(req, req.query) })));
router.post(
  "/viewings",
  route(async (req, res) => {
    const made = await createViewing(req, req.body);
    res.status(made.existing ? 200 : 201).json({ status: "success", existing: made.existing, viewing: made.viewing, suggestedStage: made.suggestedStage, confirmationText: confirmationText(made.viewing) });
  }),
);
router.get("/viewings/:id", route(async (req, res) => {
  const viewing = viewingView(await findViewing(req, req.params.id));
  res.json({ status: "success", viewing, confirmationText: confirmationText(viewing) });
}));
router.get("/viewings/:id/calendar.ics", route(async (req, res) => {
  const row = await findViewing(req, req.params.id);
  const url = (await query("SELECT listing_url FROM re_properties WHERE id=$1 AND tenant_id=$2", [row.property_id, req.tenantId])).rows[0]?.listing_url || "";
  res.set("Content-Type", "text/calendar; charset=utf-8").set("Content-Disposition", `attachment; filename="viewing-${row.property_reference.replace(/[^\w.-]+/g, "_")}.ics"`).send(viewingIcs(viewingView(row), { listingUrl: url }));
}));
const act = (fn) => route(async (req, res) => {
  const viewing = await fn(req, req.params.id, req.body || {});
  res.json({ status: "success", viewing, confirmationText: confirmationText(viewing) });
});
router.post("/viewings/:id/confirm", act((req, id) => confirmViewing(req, id)));
router.post("/viewings/:id/complete", act((req, id) => completeViewing(req, id)));
router.post("/viewings/:id/no-show", act((req, id) => noShowViewing(req, id)));
router.post("/viewings/:id/cancel", act((req, id, body) => cancelViewing(req, id, body)));
router.post("/viewings/:id/reschedule", act((req, id, body) => rescheduleViewing(req, id, body)));

export default router;
