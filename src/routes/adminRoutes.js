import express from "express";
import { authenticateToken, requireSuperAdmin } from "../middleware/auth.js";
import { query } from "../db/index.js";
import { route, fail, text } from "../middleware/http.js";
import { createCompany, resendOwnerSetupLink } from "../services/adminService.js";
const router = express.Router();
router.use(authenticateToken, requireSuperAdmin);
const companyView = (r) => ({
  id: r.id,
  name: r.name,
  plan: r.plan,
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
  const n = Number(value ?? 5);
  if (!Number.isInteger(n) || n < 1 || n > 500)
    throw fail(400, "Sessions limit must be a whole number from 1 to 500");
  return n;
};
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
    const result = await createCompany({
      actorId: req.user.id,
      companyName: text(req.body.companyName, "Company name", 255),
      ownerName: text(req.body.ownerName, "Owner name", 255),
      ownerEmail,
      sessionsLimit: limitOf(req.body.sessionsLimit),
      plan: req.body.plan ? text(req.body.plan, "Plan", 50) : undefined,
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
    if (req.body.sessionsLimit !== undefined)
      set("sessions_limit", limitOf(req.body.sessionsLimit));
    if (req.body.name !== undefined) set("name", text(req.body.name, "Name", 255));
    if (!fields.length) throw fail(400, "Nothing to update");
    params.push(req.params.id);
    const { rowCount } = await query(
      `UPDATE tenants SET ${fields.join(",")},updated_at=now() WHERE id=$${params.length}`,
      params,
    );
    if (!rowCount) throw fail(404, "Company not found");
    if (req.body.status === "suspended")
      req.app.get("io")?.in(`tenant:${req.params.id}`).disconnectSockets();
    await query(
      "INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'company.updated',$3)",
      [req.params.id, req.user.id, JSON.stringify(req.body)],
    );
    const { rows } = await query(`${COMPANY_SQL} WHERE t.id=$1`, [req.params.id]);
    res.json({ status: "success", company: companyView(rows[0]) });
  }),
);
export default router;
