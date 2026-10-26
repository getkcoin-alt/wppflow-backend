import { query } from "../db/index.js";
import { FEATURE_LABELS, planCatalogue, isLapsed } from "./plans.js";
import { tell } from "./subscriptionService.js";

// When the platform admin switches a module on or off for a plan, every company on that plan has to find out:
// its screens lock or unlock at once (the server checks the plan on every request), the open browsers are told to
// look again, and its owners and administrators get a notification saying what changed and what to do about it.

// How a module is named to people. These are the screens they see in the app, not the internal feature keys.
export const MODULE_NAMES = {
  broadcasts: "Broadcasts",
  automations: "Automations",
  leads: "Sales pipeline",
  audit: "Audit log",
  api: "Developers (API keys, webhooks, API tester)",
  ai: "Riwo, the AI assistant",
};
const nameOf = (f) => MODULE_NAMES[f] || FEATURE_LABELS[f] || f;
const list = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

export const featureChanges = (before = [], after = []) => ({
  added: after.filter((f) => !before.includes(f)),
  removed: before.filter((f) => !after.includes(f)),
});

// The first plan for sale that has a module: what a company has to choose to get it back.
const firstPlanWith = (feature) => planCatalogue().find((p) => p.features.some((f) => f.key === feature && f.included))?.name || null;

// "Choose Growth or above to use it again." — or one clause per module when they sit on different plans.
function wayBack(removed) {
  const where = removed.map((f) => [f, firstPlanWith(f)]);
  const plans = new Set(where.map(([, p]) => p));
  const them = removed.length > 1 ? "them" : "it";
  if (plans.size === 1 && [...plans][0]) return `Choose ${[...plans][0]} or above to use ${them} again.`;
  if (where.every(([, p]) => !p)) return "Ask the Scriwo team about getting it back.";
  return `To use ${them} again: ${where.map(([f, p]) => `${nameOf(f)} needs ${p ? `${p} or above` : "a plan the Scriwo team can set up"}`).join("; ")}.`;
}

// What a company on the plan is told. One notification per change, however many modules moved.
export function noticeFor({ planName, added, removed }) {
  const a = added.map(nameOf),
    r = removed.map(nameOf);
  if (a.length && !r.length)
    return {
      title: `${list(a)} ${a.length > 1 ? "are" : "is"} now included in your ${planName} plan`,
      body: `${a.length > 1 ? "They are" : "It is"} switched on for your company now.`,
    };
  if (r.length && !a.length)
    return {
      title: `${list(r)} ${r.length > 1 ? "are" : "is"} no longer included in your ${planName} plan`,
      body: `${r.length > 1 ? "They are" : "It is"} locked now. Nothing has been deleted. ${wayBack(removed)}`,
    };
  return {
    title: `Your ${planName} plan changed`,
    body: `Now included: ${list(a)}. No longer included: ${list(r)}, locked now, and nothing has been deleted. ${wayBack(removed)}`,
  };
}

// The companies this change reaches: active, on this plan, and not switched back to Free by a late payment (their
// access did not change, so there is nothing to tell them).
export async function companiesOnPlan(planId) {
  const { rows } = await query("SELECT * FROM tenants WHERE status='active' AND lower(plan)=$1", [planId]);
  return rows.filter((t) => !isLapsed(t));
}

// Tells the companies on a plan that its modules changed. A failure for one company never stops the others, and
// never fails the save: the plan is already changed.
export async function announceFeatureChange({ io = null, planId, planName, before, after }) {
  const { added, removed } = featureChanges(before, after);
  const result = { companies: 0, told: 0, added: added.map(nameOf), removed: removed.map(nameOf) };
  if (!added.length && !removed.length) return result;
  const { title, body } = noticeFor({ planName, added, removed });
  const stamp = Date.now();
  let companies = [];
  try {
    companies = await companiesOnPlan(planId);
  } catch (e) {
    console.error("Plan change: could not list the companies on the plan:", e.message);
    return result;
  }
  result.companies = companies.length;
  for (const t of companies) {
    try {
      const sent = await tell(io, t.id, `plan-modules:${planId}:${stamp}`, title, body);
      result.told += sent.length;
      // every open browser of the company, managers or not, looks again at what its plan includes
      io?.to(`tenant:${t.id}`).emit("plan:changed", { plan: planId, added, removed });
    } catch (e) {
      console.error(`Plan change: could not tell ${t.id}:`, e.message);
    }
  }
  return result;
}
