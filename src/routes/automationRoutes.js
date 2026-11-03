import crypto from "node:crypto";
import express from "express";
import {
  authenticateToken,
  requireTenantContext,
  requireRole,
} from "../middleware/auth.js";
import { route, fail } from "../middleware/http.js";
import { query } from "../db/index.js";
import { automationView } from "../services/automationService.js";
import { cleanRule } from "../services/automationRules.js";
import { AUTOMATION_TEMPLATES } from "../services/automationTemplates.js";
import { requireFeature } from "../services/plans.js";
import { callingCodeOf, COUNTRIES } from "../services/countries.js";
import { unavailableReason } from "../services/aiService.js";
import { AUTO_CHAT, DEFAULT_SOURCES, SALES } from "../services/automationRules.js";
import rateLimit from "express-rate-limit";
import { readWebsite } from "../services/websiteReader.js";
import { draftAgentFromWords, draftBusinessProfile } from "../services/aiService.js";
import { hasKnowledge } from "../services/knowledgeService.js";
import { draftWorkflow, reviseWorkflow, checkRule, present } from "../services/workflow/compile.js";
import { simulateTurn } from "../services/workflow/simulate.js";
import { recipeList } from "../services/workflow/recipes.js";
const router = express.Router();
router.use(
  authenticateToken,
  requireTenantContext,
  requireRole("owner", "admin"),
  requireFeature("automations"),
);
router.get(
  "/",
  route(async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM automations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100",
      [req.tenantId],
    );
    res.json({ status: "success", automations: rows.map(automationView) });
  }),
);
// The ready-made rules, so the screen doesn't carry its own copy.
router.get("/templates", (req, res) => res.json({ status: "success", templates: AUTOMATION_TEMPLATES }));

// What the "other countries" recipe needs to be easy: the countries to choose from, a guess at the company's own (from the
// WhatsApp numbers it has linked), and whether Riwo can answer for it.
router.get(
  "/context",
  route(async (req, res) => {
    const { rows } = await query(
      "SELECT phone FROM whatsapp_sessions WHERE tenant_id=$1 AND phone IS NOT NULL AND phone<>'' ORDER BY (status='CONNECTED') DESC, created_at LIMIT 10",
      [req.tenantId],
    );
    const counts = new Map();
    for (const { phone } of rows) {
      const code = callingCodeOf(phone);
      if (code) counts.set(code, (counts.get(code) || 0) + 1);
    }
    const suggested = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code).slice(0, 1);
    res.json({
      status: "success",
      countries: COUNTRIES,
      homeCodes: suggested,
      homeFrom: suggested.length ? "the WhatsApp number you linked" : "",
      riwo: { available: unavailableReason(req.tenant) === null, reason: unavailableReason(req.tenant) },
      chat: { defaultReplies: AUTO_CHAT.defaultReplies, maxReplies: AUTO_CHAT.maxReplies, sources: DEFAULT_SOURCES, handoff: AUTO_CHAT.handoff, sales: { maxQuestions: SALES.maxQuestions, questions: SALES.defaultQuestions, formal: SALES.formal, followUpHours: SALES.followUpHours } },
    });
  }),
);

// Reads the company's own website and drafts what Riwo may say about the business, and the questions to ask. The person reads
// and edits it before saving; nothing is stored here.
const websiteLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.tenantId}:${req.user?.id ?? "api"}`,
  validate: false,
  message: { status: "error", message: "You're going a little fast. Wait a moment and try again." },
});
router.post(
  "/about-from-website",
  websiteLimit,
  route(async (req, res) => {
    const site = await readWebsite(req.body?.url);
    const draft = await draftBusinessProfile({ tenant: req.tenant, site });
    res.json({ status: "success", url: site.url, pages: site.pages.length, ...draft });
  }),
);

// "Describe it in your own words": Riwo asks what it still needs to know, or drafts the agent. The draft is checked by the same
// rules as one made by hand and returned for the owner to read, change and save; nothing is saved or switched on here.
const draftLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.tenantId}:draft`,
  validate: false,
  message: { status: "error", message: "You've asked Riwo to draft a lot just now. Please try again in a while." },
});
router.post(
  "/draft",
  draftLimit,
  route(async (req, res) => {
    const instruction = String(req.body?.instruction ?? "").trim();
    if (instruction.length < 10) throw fail(400, "Describe in a sentence or two what Riwo should do.");
    if (instruction.length > 2000) throw fail(400, "Please keep it under 2,000 characters.");
    const known = await hasKnowledge(req.tenantId);
    const out = await draftAgentFromWords({ tenant: req.tenant, instruction, answers: req.body?.answers, hasKnowledge: known });
    if (out.clarify) return res.json({ status: "success", clarify: out.clarify });
    const d = out.draft;
    const rule = {
      name: d.name,
      triggerType: d.trigger,
      triggerCondition: "",
      actionType: "ai_chat",
      actionSummary: "",
      config: {
        reply: "",
        useKnowledge: known,
        knowledge: "",
        handoff: d.handoff || undefined,
        agent: { enabled: true, goal: d.goal, playbook: d.playbook, closeWith: d.closeWith, pricing: d.pricing },
        sales: { enabled: true, questions: [], formal: d.formal || undefined, followUpHours: d.followUpHours, stageName: d.stageName },
        homeCodes: d.trigger === "foreign_number" ? [] : undefined,
      },
    };
    // checked by the same rules as any rule; a missing knowledge base is reported, not an error, so the owner can add it
    let problem = "";
    try {
      await cleanRule({ ...rule, config: { ...rule.config, knowledge: known ? "" : "placeholder text so the rest can be checked", homeCodes: d.trigger === "foreign_number" ? ["971"] : undefined } }, { teammate: async () => true });
    } catch (e) {
      problem = e.message;
    }
    res.json({ status: "success", draft: rule, understood: d.understood, needs: known ? [] : ["knowledge"], problem });
  }),
);

const teammateOf = (tenantId) => async (name) =>
  (
    await query(
      "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND u.name=$2",
      [tenantId, name],
    )
  ).rowCount > 0;

// ── Workflows: describe, change, check and try ─────────────────────────────────────────────────
// None of these saves or switches anything on. The screen keeps the draft and the person saves it when they are happy.
const workflowLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.tenantId}:workflow`,
  validate: false,
  message: { status: "error", message: "You've asked Riwo to build a lot just now. Please try again in a while." },
});
const tryLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.tenantId}:try`,
  validate: false,
  message: { status: "error", message: "You've tried the workflow a lot just now. Please try again in a while." },
});
router.get("/workflow/recipes", (req, res) => res.json({ status: "success", recipes: recipeList() }));

router.post(
  "/workflow/draft",
  workflowLimit,
  route(async (req, res) => {
    const recipe = String(req.body?.recipe ?? "");
    const instruction = String(req.body?.instruction ?? "").trim();
    if (!recipe && instruction.length < 10) throw fail(400, "Describe in a sentence or two what should happen.");
    if (instruction.length > 2000) throw fail(400, "Please keep it under 2,000 characters.");
    const out = await draftWorkflow({ tenant: req.tenant, instruction, answers: req.body?.answers, hasKnowledge: await hasKnowledge(req.tenantId), teammate: teammateOf(req.tenantId), recipe });
    res.json({ status: "success", ...out });
  }),
);
router.post(
  "/workflow/revise",
  workflowLimit,
  route(async (req, res) => {
    const instruction = String(req.body?.instruction ?? "").trim();
    if (instruction.length < 3) throw fail(400, "Say what to change.");
    if (instruction.length > 1000) throw fail(400, "Please keep it under 1,000 characters.");
    const teammate = teammateOf(req.tenantId);
    const { rule } = await checkRule(req.body?.rule || {}, { teammate });
    const out = await reviseWorkflow({ tenant: req.tenant, rule, instruction, hasKnowledge: await hasKnowledge(req.tenantId), teammate });
    res.json({ status: "success", ...out });
  }),
);
// The workflow as the screen has it (after the person edited a step), checked and completed: the same view as a draft.
router.post(
  "/workflow/check",
  route(async (req, res) => {
    const checked = await checkRule(req.body?.rule || {}, { teammate: teammateOf(req.tenantId) });
    res.json({ status: "success", draft: present(checked) });
  }),
);
router.post(
  "/workflow/simulate",
  tryLimit,
  route(async (req, res) => {
    const { rule } = await checkRule(req.body?.rule || {}, { teammate: teammateOf(req.tenantId) });
    const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
    const transcript = list(req.body?.transcript, 30).map((i) => ({ from: i?.from === "customer" ? "customer" : "riwo", text: String(i?.text ?? "").slice(0, 900) }));
    const out = await simulateTurn({
      tenant: req.tenant,
      rule,
      state: req.body?.state || null,
      text: String(req.body?.text ?? "").slice(0, 500),
      labels: list(req.body?.labels, 20).map((l) => String(l).slice(0, 50)),
      transcript,
      name: String(req.body?.name || "Asha Rao").slice(0, 60),
    });
    res.json({ status: "success", ...out });
  }),
);

router.post(
  "/",
  route(async (req, res) => {
    const rule = await cleanRule(req.body, { teammate: teammateOf(req.tenantId) });
    // A new rule never goes live by itself: the person reads it first.
    const { rows } = await query(
      `INSERT INTO automations(id,tenant_id,name,trigger_type,trigger_condition,action_type,action_summary,config,template_id,is_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false) RETURNING *`,
      [crypto.randomUUID(), req.tenantId, rule.name, rule.triggerType, rule.triggerCondition, rule.actionType, rule.actionSummary, JSON.stringify(rule.config), rule.templateId],
    );
    res.status(201).json({ status: "success", automation: automationView(rows[0]) });
  }),
);
// Changing a saved rule keeps whether it is live and how often it has run.
router.put(
  "/:id",
  route(async (req, res) => {
    const rule = await cleanRule(req.body, { teammate: teammateOf(req.tenantId) });
    const { rows } = await query(
      `UPDATE automations SET name=$3,trigger_type=$4,trigger_condition=$5,action_type=$6,action_summary=$7,config=$8,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [req.params.id, req.tenantId, rule.name, rule.triggerType, rule.triggerCondition, rule.actionType, rule.actionSummary, JSON.stringify(rule.config)],
    );
    if (!rows[0]) throw fail(404, "Automation not found");
    res.json({ status: "success", automation: automationView(rows[0]) });
  }),
);
router.patch(
  "/:id/toggle",
  route(async (req, res) => {
    const { rows } = await query(
      "UPDATE automations SET is_enabled=NOT is_enabled,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *",
      [req.params.id, req.tenantId],
    );
    if (!rows[0]) throw fail(404, "Automation not found");
    res.json({ status: "success", automation: automationView(rows[0]) });
  }),
);
router.delete(
  "/:id",
  route(async (req, res) => {
    await query(
      "DELETE FROM automation_executions WHERE automation_id=$1 AND tenant_id=$2",
      [req.params.id, req.tenantId],
    );
    await query("DELETE FROM automations WHERE id=$1 AND tenant_id=$2", [
      req.params.id,
      req.tenantId,
    ]);
    res.json({ status: "success" });
  }),
);
export default router;
