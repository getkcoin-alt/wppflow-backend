import { fail } from "../middleware/http.js";

// The plans on the public pricing page, and what each one includes. A company whose plan is not one of
// these names (the original "Workspace" plan, platform test companies) keeps every feature, so nothing
// that is working today stops working. Changing what a plan includes is a change to this table.
export const FEATURE_LABELS = {
  broadcasts: "Broadcasts",
  automations: "Automations",
  audit: "The audit log",
  api: "API keys and webhooks",
  ai: "The AI assistant",
};
const GROWTH = ["broadcasts", "automations", "audit", "ai"];
const TIERS = {
  free: { name: "Free", seats: 1, features: [] },
  starter: { name: "Starter", seats: null, features: [] },
  growth: { name: "Growth", seats: null, features: GROWTH },
  business: { name: "Business", seats: null, features: [...GROWTH, "api"] },
  enterprise: { name: "Enterprise", seats: null, features: [...GROWTH, "api"] },
};

export function planOf(value) {
  const id = String(value || "").trim().toLowerCase();
  const tier = TIERS[id];
  if (tier) return { id, name: tier.name, features: tier.features, seats: tier.seats, restricted: true };
  return {
    id: null,
    name: String(value || "Workspace"),
    features: Object.keys(FEATURE_LABELS),
    seats: null,
    restricted: false,
  };
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
    features: Object.fromEntries(Object.keys(FEATURE_LABELS).map((f) => [f, plan.features.includes(f)])),
  };
};
