import express from "express";
import crypto from "node:crypto";
import { query } from "../db/index.js";
import { ENV } from "../config/env.js";
import { route, fail, text } from "../middleware/http.js";
import { contactFormLimiter, contactFormCeiling, checkoutOrderLimiter, checkoutReadLimiter, checkoutOrderCeiling } from "../middleware/rateLimiter.js";
import { sendLeadNotification } from "../services/mailer.js";
import { publicPlans } from "../services/plans.js";
import { billingSettings } from "../services/billingSettings.js";
import { websiteCheckoutOptions, websiteQuote, createWebsiteOrder, verifyWebsiteCheckout, websiteCheckoutStatus } from "../services/websiteCheckout.js";

// Endpoints the public website calls without signing in.
const router = express.Router();

const INTERESTS = ["demo", "pricing", "starter", "growth", "business", "enterprise", "partner", "support", "general"];
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const optional = (value, name, max) => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > max)
    throw fail(400, `${name} must be at most ${max} characters`);
  return value.trim();
};

// The plans for sale and their prices, as the server holds them: the website and the app read the same numbers.
// The GST rate comes with them so a price list never says "18%" after the rate has been changed.
router.get("/plans", (req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  res.json({ status: "success", plans: publicPlans(), gstRate: billingSettings().gstRate });
});

// ── Buying a plan from the website, before there is an account ────────────────────────────────────────────
// What the checkout page needs: whether buying works, the plans, the states and the tax rate.
router.get("/checkout/options", checkoutReadLimiter, (req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  res.json({ status: "success", ...websiteCheckoutOptions() });
});
// The exact price, with the tax split, for a plan, billing period and the buyer's state.
router.post("/checkout/quote", checkoutReadLimiter, route(async (req, res) => {
  res.json({ status: "success", quote: websiteQuote({ plan: req.body?.plan, interval: req.body?.interval, stateCode: req.body?.stateCode }) });
}));
router.post(
  "/checkout/order",
  checkoutOrderCeiling,
  checkoutOrderLimiter,
  route(async (req, res) => {
    // Hidden field only bots fill in.
    if (req.body?.website) throw fail(400, "We could not start the payment. Please try again.");
    const visitor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
    res.status(201).json({ status: "success", ...(await createWebsiteOrder({ body: req.body, ip: visitor })) });
  }),
);
router.post(
  "/checkout/verify",
  checkoutOrderLimiter,
  route(async (req, res) => {
    res.json({ status: "success", ...(await verifyWebsiteCheckout({ body: req.body, io: req.app.get("io") })) });
  }),
);
router.get(
  "/checkout/status",
  checkoutReadLimiter,
  route(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ status: "success", ...(await websiteCheckoutStatus({ orderRef: req.query.order, token: req.query.token })) });
  }),
);

router.post(
  "/contact",
  contactFormCeiling,
  contactFormLimiter,
  route(async (req, res) => {
    const body = req.body || {};
    // Hidden field only bots fill in. Answer as if it worked so they learn nothing.
    if (body.website) return res.status(201).json({ status: "success" });
    const lead = {
      name: text(body.name, "Your name", 120),
      email: text(body.email, "Email", 200).toLowerCase(),
      phone: optional(body.phone, "Phone", 40),
      company: optional(body.company, "Company", 160),
      country: optional(body.country, "Country", 40),
      teamSize: optional(body.teamSize, "Team size", 20),
      interest: INTERESTS.includes(body.interest) ? body.interest : "general",
      plan: optional(body.plan, "Plan", 40),
      message: optional(body.message, "Message", 4000),
      sourcePage: optional(body.sourcePage, "Page", 300),
    };
    if (!EMAIL.test(lead.email)) throw fail(400, "Please enter a valid email address");
    if (lead.phone && !/^[+\d][\d\s()-]{5,}$/.test(lead.phone))
      throw fail(400, "Please enter a valid phone number, with country code");

    const id = crypto.randomUUID();
    await query(
      `INSERT INTO website_leads (id,name,email,phone,company,country,team_size,interest,plan,message,source_page)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, lead.name, lead.email, lead.phone, lead.company, lead.country, lead.teamSize, lead.interest, lead.plan, lead.message, lead.sourcePage],
    );
    // The enquiry is saved either way; mail only tells the team about it. Nothing is mailed to the
    // address typed into the form, so the form cannot be used to send mail to strangers.
    const notified = await sendLeadNotification({ to: ENV.LEADS_EMAIL, lead });
    await query("UPDATE website_leads SET email_status=$2 WHERE id=$1", [
      id,
      notified.sent ? "sent" : notified.reason === "not_configured" ? "not_configured" : "failed",
    ]);
    res.status(201).json({ status: "success", id });
  }),
);

export default router;
