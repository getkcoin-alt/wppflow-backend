import express from "express";
import rateLimit from "express-rate-limit";
import { authenticateToken, requireTenantContext, requireRole, requireWriteAccess } from "../middleware/auth.js";
import { route, fail, failWith } from "../middleware/http.js";
import {
  billingOverview,
  getProfile,
  saveProfile,
  quoteOnly,
  createCheckout,
  verifyCheckout,
  startAutopay,
  verifyAutopay,
  cancelAutopay,
  getInvoice,
  moveToSmallerPlan,
  endSubscriptionAtPeriodEnd,
  keepSubscription,
} from "../services/billingService.js";
import { renderInvoice, invoiceFileName } from "../services/invoicePdf.js";

const router = express.Router();
// Owners and administrators pay and see invoices; everyone else gets a "not allowed".
router.use(authenticateToken, requireTenantContext, requireWriteAccess, requireRole("owner", "admin"));
const limit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.tenantId || req.ip,
  validate: { keyGeneratorIpFallback: false },
  message: { status: "error", message: "Too many payment requests. Please wait a minute." },
});
const io = (req) => req.app.get("io");

router.get(
  "/",
  route(async (req, res) => {
    res.json({ status: "success", ...(await billingOverview(req.tenantId)) });
  }),
);
router.get(
  "/profile",
  route(async (req, res) => {
    res.json({ status: "success", profile: await getProfile(req.tenantId) });
  }),
);
router.put(
  "/profile",
  route(async (req, res) => {
    res.json({ status: "success", profile: await saveProfile(req.tenantId, req.user.id, req.body || {}) });
  }),
);
// What a plan would cost this company, to show before paying.
router.get(
  "/quote",
  route(async (req, res) => {
    res.json({ status: "success", ...(await quoteOnly({ tenantId: req.tenantId, plan: String(req.query.plan || ""), interval: String(req.query.interval || "") })) });
  }),
);
router.post(
  "/checkout",
  limit,
  route(async (req, res) => {
    // Razorpay takes rupees. Dirhams are invoiced by the Scriwo team until a gateway for the UAE is switched on.
    if (req.body?.currency && String(req.body.currency).toUpperCase() !== "INR")
      throw failWith(400, "Online payment in AED is coming soon. Until then the Scriwo team sends you an AED invoice and records the payment.", { code: "currency_coming_soon" });
    const result = await createCheckout({ tenantId: req.tenantId, user: req.user, plan: req.body?.plan, interval: req.body?.interval, confirm: req.body?.confirm === true });
    res.status(201).json({ status: "success", ...result });
  }),
);
router.post(
  "/verify",
  limit,
  route(async (req, res) => {
    res.json({ status: "success", ...(await verifyCheckout({ tenantId: req.tenantId, userId: req.user.id, body: req.body, io: io(req) })) });
  }),
);
router.post(
  "/autopay",
  limit,
  route(async (req, res) => {
    res.status(201).json({ status: "success", ...(await startAutopay({ tenantId: req.tenantId, user: req.user, plan: req.body?.plan })) });
  }),
);
router.post(
  "/autopay/verify",
  limit,
  route(async (req, res) => {
    res.json({ status: "success", ...(await verifyAutopay({ tenantId: req.tenantId, body: req.body, io: io(req) })) });
  }),
);
router.delete(
  "/autopay",
  route(async (req, res) => {
    await cancelAutopay({ tenantId: req.tenantId, userId: req.user.id });
    res.json({ status: "success" });
  }),
);
// Moving to a smaller plan, ending the subscription, or changing your mind: nothing to pay, takes effect when the period ends.
router.post(
  "/downgrade",
  route(async (req, res) => {
    const plan = req.body?.plan === "free" ? await endSubscriptionAtPeriodEnd({ tenantId: req.tenantId, userId: req.user.id }) : await moveToSmallerPlan({ tenantId: req.tenantId, userId: req.user.id, plan: req.body?.plan });
    res.json({ status: "success", plan: { id: plan.id, name: plan.name } });
  }),
);
router.delete(
  "/downgrade",
  route(async (req, res) => {
    res.json({ status: "success", cleared: await keepSubscription({ tenantId: req.tenantId, userId: req.user.id }) });
  }),
);
router.get(
  "/invoices/:id/pdf",
  route(async (req, res) => {
    const invoice = await getInvoice(req.tenantId, req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${invoiceFileName(invoice.number)}"`);
    res.setHeader("Cache-Control", "private, no-store");
    renderInvoice(invoice).pipe(res);
  }),
);
router.use((req, res, next) => next(fail(404, "Not found")));
export default router;
