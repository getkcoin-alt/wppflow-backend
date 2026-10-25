import express from "express";
import crypto from "node:crypto";
import { query } from "../db/index.js";
import { ENV } from "../config/env.js";
import { route, fail, text } from "../middleware/http.js";
import { contactFormLimiter, contactFormCeiling } from "../middleware/rateLimiter.js";
import { sendLeadNotification } from "../services/mailer.js";
import { publicPlans } from "../services/plans.js";

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
router.get("/plans", (req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  res.json({ status: "success", plans: publicPlans() });
});

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
