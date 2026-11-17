import express from "express";
import { query } from "../db/index.js";
import { authenticateToken, requireTenantContext, requireRole } from "../middleware/auth.js";
import { route, fail } from "../middleware/http.js";
import { ENV } from "../config/env.js";
import { planAllows, planOf, isLapsed } from "../services/plans.js";
import { createAgentKey, listAgentKeys, updateAgentKey, revokeAgentKey, getAgentKey, agentError } from "../services/agents/keys.js";
import { listEvents } from "../services/agents/activity.js";
import { TOOLS, runTool, publicError } from "../services/agents/tools.js";
import { copyPrompt } from "../services/agents/prompt.js";
import { AGENT_FEATURE, LEVELS, LEVEL_LABELS, DEFAULTS, BOUNDS, MAX_AGENTS } from "../services/agents/config.js";

// The AI agents page in Developers: make an agent, say what it may do, see what it did, switch it off. Owners and administrators, signed in
// (an API key is refused here). The agent itself comes in by another door (routes/agentApiRoutes.js).
const router = express.Router();
router.use(authenticateToken, requireTenantContext, (req, res, next) => (req.apiKey ? next(fail(403, "Interactive workspace login required")) : next()), requireRole("owner", "admin"));

const audit = (req, event, metadata = {}) =>
  query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,$3,$4)", [req.tenantId, req.user?.id ?? null, event, JSON.stringify(metadata)]).catch((e) => console.error("Audit not written:", e.message));

// Why this company cannot have agents, or null
const planProblem = (req) => {
  if (planAllows(req.tenant, AGENT_FEATURE)) return null;
  return isLapsed(req.tenant)
    ? "AI agent access is switched off because payment for your plan is overdue. Pay the invoice or message the Scriwo team and it comes back at once."
    : `AI agent access isn't included in your ${planOf(req.tenant?.plan).name} plan. Ask the Scriwo team to move your company to a plan that has it.`;
};
const needPlan = (req, res, next) => {
  const problem = planProblem(req);
  next(problem ? agentError(403, "plan_required", problem, "Ask the Scriwo team about the plan.") : undefined);
};

const LEVEL_TEXT = {
  read: "Looks at chats, searches, reads the company's knowledge. Cannot send or change anything. Safe to start with.",
  reply: "Also answers customers on WhatsApp, leaves team notes and marks chats read.",
  full: "Also assigns chats to teammates, closes and reopens them, labels them, and makes and finishes follow-ups.",
};

router.get(
  "/",
  route(async (req, res) => {
    const [agents, numbers] = await Promise.all([
      listAgentKeys(req.tenantId),
      query("SELECT session_name,status,phone FROM whatsapp_sessions WHERE tenant_id=$1 ORDER BY created_at,session_name", [req.tenantId]),
    ]);
    const base = ENV.PUBLIC_API_URL;
    res.json({
      status: "success",
      allowed: !planProblem(req),
      reason: planProblem(req),
      agents,
      numbers: numbers.rows.map((n) => ({ name: n.session_name, phone: n.phone, connected: n.status === "CONNECTED" })),
      levels: LEVELS.map((key) => ({ key, label: LEVEL_LABELS[key], blurb: LEVEL_TEXT[key], tools: TOOLS.filter((t) => LEVELS.indexOf(t.level) <= LEVELS.indexOf(key)).map((t) => t.name) })),
      tools: TOOLS.map((t) => ({ name: t.name, title: t.title, level: t.level, readOnly: Boolean(t.annotations.readOnlyHint) })),
      defaults: DEFAULTS,
      bounds: BOUNDS,
      maxAgents: MAX_AGENTS,
      endpoints: { mcp: `${base}/mcp`, rest: `${base}/api/agent/v1`, openapi: `${base}/api/agent/v1/openapi.json` },
    });
  }),
);

router.post(
  "/",
  needPlan,
  route(async (req, res) => {
    const agent = await createAgentKey({ tenantId: req.tenantId, userId: req.user.id, ...req.body });
    await audit(req, "agent.created", { agentId: agent.id, name: agent.name, level: agent.level, numbers: agent.numbers });
    res.status(201).json({ status: "success", agent, message: "Copy the key now. It is shown only once." });
  }),
);

router.get(
  "/activity",
  route(async (req, res) => {
    const events = await listEvents(req.tenantId, { agentId: req.query.agentId ? String(req.query.agentId) : null, limit: req.query.limit, beforeId: req.query.beforeId, onlyChanges: req.query.changes === "true" });
    res.json({ status: "success", events });
  }),
);

router.patch(
  "/:id",
  needPlan,
  route(async (req, res) => {
    const agent = await updateAgentKey(req.tenantId, req.params.id, req.body);
    await audit(req, "agent.updated", { agentId: agent.id, name: agent.name, level: agent.level, changed: Object.keys(req.body || {}) });
    res.json({ status: "success", agent });
  }),
);

router.delete(
  "/:id",
  route(async (req, res) => {
    const current = await getAgentKey(req.tenantId, req.params.id);
    const revoked = await revokeAgentKey(req.tenantId, req.params.id, req.user.id);
    if (!revoked) throw agentError(404, "not_found", "That agent was not found, or it is already revoked.", "Refresh the page.");
    await audit(req, "agent.revoked", { agentId: current.id, name: current.name });
    res.json({ status: "success" });
  }),
);

// A prompt to copy, for any agent. The key is never in it unless the caller gives it (the page does, right after the key was made).
router.get(
  "/:id/prompt",
  route(async (req, res) => {
    const row = await getAgentKey(req.tenantId, req.params.id);
    if (!row) throw agentError(404, "not_found", "That agent was not found.", "Refresh the page.");
    const agent = { ...row, tenant_name: req.tenant?.name };
    const mcp = req.query.mode !== "rest";
    res.json({ status: "success", mode: mcp ? "mcp" : "rest", prompt: copyPrompt({ agent, baseUrl: ENV.PUBLIC_API_URL, mcp }) });
  }),
);

// "What will this agent see?": runs its overview as the agent, with its own rules. Nothing is sent or changed.
router.post(
  "/:id/test",
  route(async (req, res) => {
    const row = await getAgentKey(req.tenantId, req.params.id);
    if (!row) throw agentError(404, "not_found", "That agent was not found.", "Refresh the page.");
    if (row.revoked_at) throw agentError(409, "key_revoked", "This agent was revoked.", "Make a new one.");
    try {
      const overview = await runTool({ agent: { ...row, tenant_name: req.tenant?.name }, name: "get_overview", via: "test" });
      res.json({ status: "success", overview });
    } catch (error) {
      const p = publicError(error);
      res.status(p.status).json({ status: "error", code: p.code, message: p.message, fix: p.fix });
    }
  }),
);

export default router;
