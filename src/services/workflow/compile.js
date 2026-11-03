import { fail } from "../../middleware/http.js";
import { cleanRule, cleanHours } from "../automationRules.js";
import { draftWorkflowFromWords, reviseWorkflowFromWords, unavailableReason } from "../aiService.js";
import { cleanWorkflow, guardrailsOf, outlineOf, summaryOf } from "./schema.js";
import { recipeById, recipeFor, recipeList } from "./recipes.js";

// From the owner's words to a workflow that can be shown, tried and saved. The model writes a draft; this file turns it into the
// body of a rule, checks it with exactly the code that checks a rule saved by hand (repairing once if that finds a mistake), and
// adds what the owner is shown: when it starts, the safety it carries, the steps, and what still needs the owner's attention.

const PLACEHOLDER = "placeholder text so the rest can be checked and saved";
const DEFAULT_HOURS = { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
const nodesOf = (wf) => (Array.isArray(wf?.nodes) ? wf.nodes : Object.values(wf?.nodes || {}));

// the draft as the body of a rule (the same fields the screen sends when it saves)
export function ruleBodyOf(draft, { hasKnowledge = false, keep = {} } = {}) {
  const t = draft.trigger || { type: "first_message" };
  return {
    name: draft.name,
    triggerType: t.type,
    triggerCondition: t.type === "keyword" ? (t.keywords || []).join(", ") : "",
    actionType: "workflow",
    actionSummary: "",
    config: {
      workflow: draft.workflow,
      useKnowledge: hasKnowledge,
      knowledge: "",
      // changing a workflow in words never rewrites the owner's formal message, hand-over words or pipeline step
      handoff: (keep.handoff ?? draft.handoff) || undefined,
      sales: keep.sales || { formal: draft.formal || undefined, followUpHours: draft.followUpHours, stageName: draft.stageName },
      ...(t.type === "returning" ? { silentDays: t.silentDays, includeNew: t.includeNew !== false } : {}),
      ...(t.type === "after_hours" ? { hours: t.hours } : {}),
      ...(t.type === "foreign_number" ? { homeCodes: t.homeCodes || [] } : {}),
      ...(keep.pilot ? { pilot: keep.pilot } : {}),
    },
  };
}

// "When it starts", in a sentence
export function whenOf(rule) {
  const c = rule.config || {};
  switch (rule.triggerType) {
    case "returning":
      return `Starts when someone writes after ${c.silentDays} quiet day${c.silentDays === 1 ? "" : "s"}${c.includeNew === false ? "." : ", or for the first time."}`;
    case "first_message":
      return "Starts when someone writes to you for the first time.";
    case "foreign_number":
      return "Starts when someone writes from another country.";
    case "keyword":
      return `Starts when a message contains: ${rule.triggerCondition}.`;
    case "after_hours":
      return "Starts when someone writes outside your opening hours.";
    default:
      return "";
  }
}

// Checks a rule body the way a saved rule is checked. Returns the rule as it would be stored, and what still needs the owner (words
// for Riwo to talk from, the countries, the opening hours). Throws the plain sentence about what cannot be saved, so it can be
// handed back to the model. The needs do not stop the rest from being checked, so the owner sees everything at once.
export async function checkRule(body, { teammate = async () => true } = {}) {
  const needs = [];
  const check = { ...body, config: { ...body.config } };
  const talks = nodesOf(check.config.workflow).some((n) => n?.type === "agent");
  if (talks && check.config.useKnowledge !== true && String(check.config.knowledge || "").trim().length < 20) {
    needs.push("knowledge");
    check.config.useKnowledge = false;
    check.config.knowledge = PLACEHOLDER;
  }
  if (check.triggerType === "foreign_number" && !(check.config.homeCodes || []).length) {
    needs.push("countries");
    check.config.homeCodes = ["971"];
  }
  if (check.triggerType === "after_hours" && !check.config.hours) {
    needs.push("hours");
    check.config.hours = DEFAULT_HOURS;
  }
  const warnings = (await cleanWorkflow(check.config.workflow, { teammate, cleanHours })).warnings;
  const rule = await cleanRule(check, { teammate });
  if (check.config.knowledge === PLACEHOLDER) rule.config.knowledge = "";
  if (needs.includes("countries")) rule.config.homeCodes = [];
  return { rule, needs, warnings };
}

export const checkDraft = (draft, { hasKnowledge = false, teammate, keep = {} } = {}) => checkRule(ruleBodyOf(draft, { hasKnowledge, keep }), { teammate });

export function present(checked, { understood = "", source = "ai", note = "" } = {}) {
  const { rule, needs, warnings } = checked;
  return {
    rule,
    when: whenOf(rule),
    understood,
    guardrails: guardrailsOf(rule.config.workflow, rule.config),
    outline: outlineOf(rule.config.workflow),
    warnings,
    needs,
    source,
    note,
  };
}

// a model that wrote nothing usable is asked once more; one that is not there at all is not asked again
const unreadable = (e) => e?.status === 502 && /couldn't turn that/.test(e.message || "");

async function viaModel(ask, ctx) {
  let repair = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let out;
    try {
      out = await ask(repair);
    } catch (error) {
      if (unreadable(error) && attempt === 0) {
        repair = "It was not the JSON object described.";
        continue;
      }
      return { failed: error.message };
    }
    if (out.clarify) return { clarify: out.clarify };
    try {
      return { checked: await checkDraft(out.draft, ctx), understood: out.draft.understood };
    } catch (error) {
      repair = error.message;
    }
  }
  return { failed: repair };
}

export async function draftWorkflow({ tenant, instruction, answers = [], hasKnowledge = false, teammate, recipe = "" }) {
  const ctx = { hasKnowledge, teammate };
  if (recipe) {
    const r = recipeById(recipe);
    if (!r) throw fail(404, "That ready-made workflow doesn't exist");
    const draft = r.build({});
    return { draft: present(await checkDraft(draft, ctx), { understood: draft.understood, source: "recipe" }) };
  }
  const reason = unavailableReason(tenant);
  const modelResult = reason ? { failed: "Riwo isn't available right now." } : await viaModel((repair) => draftWorkflowFromWords({ tenant, instruction, answers, hasKnowledge, repair }), ctx);
  if (modelResult.clarify) return { clarify: modelResult.clarify };
  if (modelResult.checked) return { draft: present(modelResult.checked, { understood: modelResult.understood }) };
  // Riwo could not write it. The nearest ready-made workflow is offered, so the owner is never left with nothing.
  const near = recipeFor(instruction);
  const why = reason ? "Riwo isn't available right now" : "Riwo couldn't turn that into a workflow this time";
  if (near) {
    const draft = near.build({});
    return { draft: present(await checkDraft(draft, ctx), { understood: draft.understood, source: "recipe", note: `${why}, so this starts from a ready-made workflow that looks like what you described. Check each step.` }) };
  }
  return { draft: null, message: `${why}. You can start from one of these and change it.`, recipes: recipeList() };
}

const stable = (v) => (v && typeof v === "object" ? (Array.isArray(v) ? v.map(stable) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))) : v);
const isAuto = (id) => /^(end_auto|handoff_unclear)\d*$/.test(id);

// What changed between two versions of a flow, in plain lines. The steps made automatically are not listed.
export function diffWorkflow(before, after) {
  const lines = [];
  const b = before?.nodes || {};
  const a = after?.nodes || {};
  for (const id of Object.keys(a)) if (!b[id] && !isAuto(id)) lines.push(`Added: ${summaryOf(a[id])}`);
  for (const id of Object.keys(b)) if (!a[id] && !isAuto(id)) lines.push(`Removed: ${summaryOf(b[id])}`);
  for (const id of Object.keys(a)) if (b[id] && !isAuto(id) && JSON.stringify(stable(b[id])) !== JSON.stringify(stable(a[id]))) lines.push(`Changed: ${summaryOf(a[id])}`);
  if (before?.start && after?.start && before.start !== after.start) lines.push("Changed where the flow starts");
  return lines;
}

const triggerOf = (rule) => ({
  type: rule.triggerType,
  silent_days: rule.config.silentDays,
  include_new: rule.config.includeNew,
  keywords: rule.triggerType === "keyword" ? rule.triggerCondition.split(/[,;\n]+/).map((k) => k.trim()).filter(Boolean) : undefined,
  hours: rule.config.hours,
});

// "Change something": the owner says what to change, in words; Riwo returns the whole workflow again and the lines that changed.
export async function reviseWorkflow({ tenant, rule, instruction, hasKnowledge = false, teammate }) {
  const reason = unavailableReason(tenant);
  if (reason) throw fail(503, "Riwo isn't available right now, so it can't change the workflow from your words. You can still edit each step by hand.");
  const keep = { pilot: rule.config.pilot, sales: rule.config.sales, handoff: rule.config.handoff };
  const current = { name: rule.name, trigger: triggerOf(rule), workflow: rule.config.workflow };
  const out = await viaModel((repair) => reviseWorkflowFromWords({ tenant, current, instruction, hasKnowledge, repair }), { hasKnowledge, teammate, keep });
  if (out.clarify) return { clarify: out.clarify };
  if (!out.checked) throw fail(422, `Riwo couldn't make that change${out.failed ? `: ${out.failed}` : ""}. Try saying it differently.`);
  return { draft: present(out.checked, { understood: out.understood }), diff: diffWorkflow(rule.config.workflow, out.checked.rule.config.workflow) };
}
