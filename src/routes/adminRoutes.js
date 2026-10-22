import express from "express";
import { authenticateToken, requireSuperAdmin } from "../middleware/auth.js";
import { query } from "../db/index.js";
import { route, fail, text } from "../middleware/http.js";
import { createCompany, resendOwnerSetupLink } from "../services/adminService.js";
import { choosePlan, planCatalogue, planOf } from "../services/plans.js";
const router = express.Router();
router.use(authenticateToken, requireSuperAdmin);
const companyView = (r) => ({
  id: r.id,
  name: r.name,
  plan: r.plan,
  planId: planOf(r.plan).id,
  status: r.status,
  sessionsLimit: r.sessions_limit,
  createdAt: r.created_at,
  owner: r.owner_email
    ? { name: r.owner_name, email: r.owner_email, activated: !r.owner_pending }
    : null,
  staffCount: r.staff_count,
  sessionsCount: r.sessions_count,
  connectedSessions: r.connected_sessions,
});
const COMPANY_SQL = `SELECT t.*,u.name AS owner_name,u.email AS owner_email,u.must_change_password AS owner_pending,
  (SELECT count(*)::int FROM memberships WHERE tenant_id=t.id AND role<>'owner' AND status='active') AS staff_count,
  (SELECT count(*)::int FROM whatsapp_sessions WHERE tenant_id=t.id) AS sessions_count,
  (SELECT count(*)::int FROM whatsapp_sessions WHERE tenant_id=t.id AND status='CONNECTED') AS connected_sessions
  FROM tenants t LEFT JOIN LATERAL (SELECT u.* FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=t.id AND m.role='owner' ORDER BY m.id LIMIT 1) u ON true`;
// Shown to the platform admin only, so they can fix the mail setup.
const mailHint = (error) =>
  error ? ` Reason: ${error}. Check RESEND_API_KEY and that MAIL_FROM/RESEND_FROM_EMAIL uses a domain verified in Resend (the default sender is noreply@scriwo.com, so scriwo.com must stay verified in Resend).` : "";
const limitOf = (value) => {
  const n = Number(value);
  if (value === null || value === "" || !Number.isInteger(n) || n < 1 || n > 500)
    throw fail(400, "Sessions limit must be a whole number from 1 to 500");
  return n;
};
// The number limit of a company: what the admin typed, or else what the plan includes.
const limitFor = (plan, typed) => {
  if (typed !== undefined) return limitOf(typed);
  if (plan.numbers) return plan.numbers;
  throw fail(400, `${plan.name} has a custom number limit: enter how many WhatsApp numbers this company gets`);
};
router.get("/plans", (req, res) => res.json({ status: "success", plans: planCatalogue() }));
router.get(
  "/companies",
  route(async (req, res) => {
    const { rows } = await query(`${COMPANY_SQL} ORDER BY t.created_at DESC`);
    res.json({ status: "success", companies: rows.map(companyView) });
  }),
);
router.post(
  "/companies",
  route(async (req, res) => {
    const ownerEmail = text(req.body.ownerEmail, "Owner email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail))
      throw fail(400, "Invalid owner email");
    const plan = choosePlan(req.body.plan);
    const result = await createCompany({
      actorId: req.user.id,
      companyName: text(req.body.companyName, "Company name", 255),
      ownerName: text(req.body.ownerName, "Owner name", 255),
      ownerEmail,
      sessionsLimit: limitFor(plan, req.body.sessionsLimit),
      plan: plan.name,
    });
    const { rows } = await query(`${COMPANY_SQL} WHERE t.id=$1`, [result.tenant.id]);
    res.status(201).json({
      status: "success",
      company: companyView(rows[0]),
      emailSent: result.emailSent,
      emailError: result.emailError,
      message: result.emailSent
        ? `Company created. A link to set the password was emailed to ${ownerEmail}.`
        : `Company created but the email could not be delivered.${mailHint(result.emailError)} Then use "Resend setup link".`,
    });
  }),
);
router.post(
  "/companies/:id/resend-credentials",
  route(async (req, res) => {
    const result = await resendOwnerSetupLink(req.params.id);
    res.json({
      status: "success",
      ...result,
      message: result.emailSent
        ? `A new set-password link was emailed to ${result.ownerEmail}. Earlier links no longer work.`
        : `Email delivery failed; no link was sent.${mailHint(result.emailError)}`,
    });
  }),
);
router.patch(
  "/companies/:id",
  route(async (req, res) => {
    const before = (await query(`${COMPANY_SQL} WHERE t.id=$1`, [req.params.id])).rows[0];
    if (!before) throw fail(404, "Company not found");
    const fields = [],
      params = [];
    const set = (col, value) => {
      params.push(value);
      fields.push(`${col}=$${params.length}`);
    };
    if (req.body.status !== undefined) {
      if (!["active", "suspended"].includes(req.body.status))
        throw fail(400, "Invalid status");
      set("status", req.body.status);
    }
    // Moving a company to another plan also gives it that plan's number limit, unless one is typed.
    let plan = null;
    if (req.body.plan !== undefined) {
      plan = choosePlan(req.body.plan);
      set("plan", plan.name);
    }
    if (req.body.sessionsLimit !== undefined) set("sessions_limit", limitOf(req.body.sessionsLimit));
    else if (plan?.numbers) set("sessions_limit", plan.numbers);
    if (req.body.name !== undefined) set("name", text(req.body.name, "Name", 255));
    if (!fields.length) throw fail(400, "Nothing to update");
    params.push(req.params.id);
    await query(`UPDATE tenants SET ${fields.join(",")},updated_at=now() WHERE id=$${params.length}`, params);
    if (req.body.status === "suspended")
      req.app.get("io")?.in(`tenant:${req.params.id}`).disconnectSockets();
    await query(
      "INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'company.updated',$3)",
      [req.params.id, req.user.id, JSON.stringify({ ...req.body, ...(plan ? { previousPlan: before.plan } : {}) })],
    );
    const { rows } = await query(`${COMPANY_SQL} WHERE t.id=$1`, [req.params.id]);
    const company = companyView(rows[0]);
    // Moving to a smaller plan never removes anything; say what the company has beyond it.
    const warnings = [];
    const after = planOf(company.plan);
    if (plan) {
      const people = company.staffCount + 1;
      if (after.seats && people > after.seats)
        warnings.push(`${after.name} is for ${after.seats === 1 ? "one person" : `${after.seats} people`}, but ${company.name} has ${people}. They keep their access; no one new can be added.`);
      if (company.sessionsCount > company.sessionsLimit)
        warnings.push(`${company.name} has ${company.sessionsCount} numbers linked, above the new limit of ${company.sessionsLimit}. They keep working; no new number can be linked.`);
    }
    res.json({ status: "success", company, warnings });
  }),
);
// Enquiries from the public website's contact form, newest first.
router.get(
  "/leads",
  route(async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM website_leads ORDER BY created_at DESC LIMIT 500",
    );
    res.json({
      status: "success",
      leads: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        company: r.company,
        country: r.country,
        teamSize: r.team_size,
        interest: r.interest,
        plan: r.plan,
        message: r.message,
        sourcePage: r.source_page,
        status: r.status,
        emailStatus: r.email_status,
        createdAt: r.created_at,
      })),
    });
  }),
);
router.patch(
  "/leads/:id",
  route(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw fail(404, "Enquiry not found");
    if (!["new", "contacted", "won", "lost"].includes(req.body.status))
      throw fail(400, "Status must be new, contacted, won or lost");
    const { rowCount } = await query(
      "UPDATE website_leads SET status=$2 WHERE id=$1",
      [req.params.id, req.body.status],
    );
    if (!rowCount) throw fail(404, "Enquiry not found");
    res.json({ status: "success" });
  }),
);
export default router;
