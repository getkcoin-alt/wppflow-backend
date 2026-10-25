import { fail } from "../middleware/http.js";

// The plans on the public pricing page, and what each one includes. A company whose plan is not one of
// these names (the original "Workspace" plan, platform test companies) keeps every feature, so nothing
// that is working today stops working. Changing what a plan includes is a change to this table.
export const FEATURE_LABELS = {
  broadcasts: "Broadcasts",
  automations: "Automations",
  leads: "The sales pipeline",
  audit: "The audit log",
  api: "API keys and webhooks",
  ai: "The AI assistant",
};
const GROWTH = ["broadcasts", "automations", "leads", "audit", "ai"];
// `numbers` is how many WhatsApp numbers the plan includes (null: agreed per company). `seats` is how many
// people it is for (null: no limit).
const TIERS = {
  free: { name: "Free", numbers: 1, seats: 1, features: [] },
  starter: { name: "Starter", numbers: 3, seats: null, features: [] },
  growth: { name: "Growth", numbers: 10, seats: null, features: GROWTH },
  business: { name: "Business", numbers: 25, seats: null, features: [...GROWTH, "api"] },
  enterprise: { name: "Enterprise", numbers: null, seats: null, features: [...GROWTH, "api"] },
};

export function planOf(value) {
  const id = String(value || "").trim().toLowerCase();
  const tier = TIERS[id];
  if (tier) return { id, name: tier.name, features: tier.features, seats: tier.seats, numbers: tier.numbers, restricted: true };
  return {
    id: null,
    name: String(value || "Workspace"),
    features: Object.keys(FEATURE_LABELS),
    seats: null,
    numbers: null,
    restricted: false,
  };
}

// The five plans, as the platform admin picks them when creating a company or changing its plan.
export const planCatalogue = () =>
  Object.entries(TIERS).map(([id, t]) => ({
    id,
    name: t.name,
    numbers: t.numbers,
    seats: t.seats,
    features: Object.entries(FEATURE_LABELS).map(([key, label]) => ({ key, label, included: t.features.includes(key) })),
  }));

// Validates a plan chosen by the platform admin and returns it. Only the five plans can be chosen: the
// original "Workspace" plan is kept for companies that already have it, but nobody new is put on it.
export function choosePlan(value) {
  const plan = planOf(value);
  if (!plan.id)
    throw fail(400, `Choose a plan: ${Object.values(TIERS).map((t) => t.name).join(", ")}`);
  return plan;
}
export const planAllows = (value, feature) => planOf(value).features.includes(feature);

export const notIncluded = (value, feature) =>
  fail(
    403,
    `${FEATURE_LABELS[feature] || "This"} isn't included in your ${planOf(value).name} plan. Ask the Scriwo team to move your company to a plan that has it.`,
  );

// Route guard: the company's plan must include the feature.
export const requireFeature = (feature) => (req, res, next) =>
  planAllows(req.tenant?.plan, feature) ? next() : next(notIncluded(req.tenant?.plan, feature));

// What the browser needs to show a feature as locked instead of letting people hit an error.
export const planView = (value) => {
  const plan = planOf(value);
  return {
    id: plan.id,
    name: plan.name,
    restricted: plan.restricted,
    numbers: plan.numbers,
    seats: plan.seats,
    features: Object.fromEntries(Object.keys(FEATURE_LABELS).map((f) => [f, plan.features.includes(f)])),
  };
};
