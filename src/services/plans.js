import { fail } from "../middleware/http.js";
import { query, withTransaction } from "../db/index.js";
import { dateOnly, daysBetween, todayUtc } from "./dates.js";

// The plans on the public pricing page, and what each one includes. A company whose plan is not one of
// these names (the original "Workspace" plan, platform test companies) keeps every feature, so nothing
// that is working today stops working.
//
// The plans live in the database (migration 018) so the platform admin can change a price or a limit without a
// release. The server keeps them in memory, so every check stays instant, and reads them again after an edit and
// every minute. These built-in values are what is used until the first read, and in a process with no database.
export const FEATURE_LABELS = {
  broadcasts: "Broadcasts",
  automations: "Automations",
  leads: "The sales pipeline",
  audit: "The audit log",
  api: "API keys and webhooks",
  ai: "The AI assistant",
};
export const CURRENCIES = ["INR", "AED"];
export const INTERVALS = ["monthly", "annual"];
// A company that has not paid keeps everything for this many days after its renewal date; then the paid
// features are switched off (nothing is deleted) until a payment is recorded.
export const GRACE_DAYS = 7;

const GROWTH = ["broadcasts", "automations", "leads", "audit", "ai"];
const BUILT_IN = [
  ["free", "Free", 1, 1, []],
  ["starter", "Starter", 3, null, []],
  ["growth", "Growth", 10, null, GROWTH],
  ["business", "Business", 25, null, [...GROWTH, "api"]],
  ["enterprise", "Enterprise", null, null, [...GROWTH, "api"]],
];
const entry = (code, name, numbers, seats, features, extra = {}) => ({
  code,
  name,
  sortOrder: 0,
  isActive: true,
  numbers,
  seats,
  features,
  maxContacts: null,
  maxBroadcasts: null,
  trialDays: 0,
  taxMode: "exclusive",
  prices: [],
  ...extra,
});
const builtIn = () => new Map(BUILT_IN.map(([code, name, numbers, seats, features], i) => [code, entry(code, name, numbers, seats, features, { sortOrder: i })]));
let plans = builtIn();

// Reads the plans and their prices from the database. A failure keeps what is already in memory.
export async function loadPlans() {
  const [rows, prices] = await Promise.all([
    query("SELECT * FROM plans ORDER BY sort_order,code"),
    query("SELECT plan_code,billing_interval,currency,amount_minor FROM plan_prices ORDER BY plan_code,billing_interval,currency"),
  ]);
  if (!rows.rows.length) return;
  const next = new Map();
  for (const r of rows.rows)
    next.set(
      r.code,
      entry(r.code, r.name, r.numbers, r.seats, Array.isArray(r.features) ? r.features : [], {
        sortOrder: r.sort_order,
        isActive: r.is_active,
        maxContacts: r.max_contacts,
        maxBroadcasts: r.max_broadcasts_per_month ?? null,
        trialDays: r.trial_days,
        taxMode: r.tax_mode,
        prices: prices.rows
          .filter((p) => p.plan_code === r.code)
          .map((p) => ({ interval: p.billing_interval, currency: p.currency, amountMinor: Number(p.amount_minor) })),
      }),
    );
  plans = next;
}
let refresher;
export function keepPlansFresh(everyMs = 60000) {
  clearInterval(refresher);
  refresher = setInterval(() => loadPlans().catch((e) => console.error("Plan refresh:", e.message)), everyMs);
  refresher.unref();
}

const sorted = (all = false) => [...plans.values()].filter((p) => all || p.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
const planShape = (p) => ({ id: p.code, name: p.name, features: p.features, seats: p.seats, numbers: p.numbers, maxContacts: p.maxContacts ?? null, maxBroadcasts: p.maxBroadcasts ?? null, restricted: true });

// A company keeps the plan it pays for by name ("Growth"), and the platform admin may rename a plan, so a plan is found by
// its code or by its name as it stands now. A name that was never a code or a current name is the original "Workspace" plan.
const findPlan = (id) => plans.get(id) || [...plans.values()].find((p) => p.name.trim().toLowerCase() === id);
export function planOf(value) {
  const id = String(value || "").trim().toLowerCase();
  const found = findPlan(id);
  if (found) return planShape(found);
  return {
    id: null,
    name: String(value || "Workspace"),
    features: Object.keys(FEATURE_LABELS),
    seats: null,
    numbers: null,
    maxContacts: null,
    maxBroadcasts: null,
    restricted: false,
  };
}

// Has this company gone more than the grace period past its renewal date without a payment being recorded? A company
// with no recorded period, on the Free plan or on the original Workspace plan, never lapses. A change waiting for the
// end of the period is applied by a job, so it does not count as lapsing.
export function isLapsed(tenant, now = todayUtc()) {
  if (!tenant || typeof tenant !== "object") return false;
  const plan = planOf(tenant.plan);
  if (!plan.restricted || plan.id === "free") return false;
  const end = dateOnly(tenant.period_end);
  if (!end || tenant.scheduled_plan) return false;
  return daysBetween(end, now) > GRACE_DAYS;
}
// The plan whose features and limits apply to this company today: the one it pays for, or Free once it has lapsed.
export const entitledPlan = (tenant, now) => (isLapsed(tenant, now) ? planOf("free") : planOf(tenant?.plan));

// The plans, as the platform admin picks them when creating a company or changing its plan.
export const planCatalogue = ({ all = false } = {}) =>
  sorted(all).map((p) => ({
    id: p.code,
    name: p.name,
    numbers: p.numbers,
    seats: p.seats,
    isActive: p.isActive,
    trialDays: p.trialDays,
    maxContacts: p.maxContacts,
    maxBroadcasts: p.maxBroadcasts,
    taxMode: p.taxMode,
    prices: p.prices,
    features: Object.entries(FEATURE_LABELS).map(([key, label]) => ({ key, label, included: p.features.includes(key) })),
  }));

// What a visitor or a signed-in owner sees when comparing plans: only what is for sale, with prices.
export const publicPlans = () =>
  planCatalogue().map((p) => ({ id: p.id, name: p.name, numbers: p.numbers, seats: p.seats, taxMode: p.taxMode, prices: p.prices, features: p.features }));

// The price of a plan in one currency for one billing interval, or null when it has none (Free, Enterprise).
export function priceOf(code, interval, currency) {
  const price = plans.get(String(code || "").toLowerCase())?.prices.find((p) => p.interval === interval && p.currency === currency);
  return price ? price.amountMinor : null;
}

// Validates a plan chosen by the platform admin and returns it. Only plans for sale can be chosen: the original
// "Workspace" plan is kept for companies that already have it, but nobody new is put on it.
export function choosePlan(value) {
  const plan = planOf(value);
  if (!plan.id || !plans.get(plan.id)?.isActive)
    throw fail(400, `Choose a plan: ${sorted().map((p) => p.name).join(", ")}`);
  return plan;
}

// `value` is a plan name, or a company (which may have lapsed to Free).
export const planAllows = (value, feature) =>
  (value && typeof value === "object" ? entitledPlan(value) : planOf(value)).features.includes(feature);

export const notIncluded = (value, feature) => {
  const label = FEATURE_LABELS[feature] || "This";
  if (value && typeof value === "object" && isLapsed(value))
    return fail(
      403,
      `${label} is switched off because payment for your ${planOf(value.plan).name} plan is overdue. Pay the invoice or message the Scriwo team and it comes back at once. Nothing has been deleted.`,
    );
  return fail(
    403,
    `${label} isn't included in your ${planOf(value && typeof value === "object" ? value.plan : value).name} plan. Ask the Scriwo team to move your company to a plan that has it.`,
  );
};

// Route guard: the company's plan must include the feature.
export const requireFeature = (feature) => (req, res, next) =>
  planAllows(req.tenant, feature) ? next() : next(notIncluded(req.tenant, feature));

// What the browser needs to show a feature as locked instead of letting people hit an error.
export const planView = (value) => {
  const lapsed = isLapsed(value);
  const plan = value && typeof value === "object" ? entitledPlan(value) : planOf(value);
  const bought = value && typeof value === "object" ? planOf(value.plan) : plan;
  return {
    id: bought.id,
    name: bought.name,
    restricted: bought.restricted,
    numbers: plan.numbers,
    seats: plan.seats,
    // paid features are off because the payment is more than the grace period overdue
    lapsed,
    features: Object.fromEntries(Object.keys(FEATURE_LABELS).map((f) => [f, plan.features.includes(f)])),
  };
};

// ── Editing a plan (platform admin) ──────────────────────────────────────────────────────────────
const whole = (value, label, { min = 0, max = 1000000, nullable = false } = {}) => {
  if (nullable && (value === null || value === "")) return null;
  const n = Number(value);
  if (value === null || value === "" || !Number.isInteger(n) || n < min || n > max)
    throw fail(400, `${label} must be a whole number from ${min} to ${max}${nullable ? ", or blank" : ""}`);
  return n;
};

// Applies a change to one plan: its name, limits, features, whether it is for sale, and its prices. Every change is
// recorded with what it was before. Companies on the plan feel the change at once; nothing they have is deleted.
export async function updatePlan(code, patch, actorId) {
  const id = String(code || "").toLowerCase();
  const before = plans.get(id);
  if (!before) throw fail(404, "Plan not found");
  const next = { ...before };
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name || name.length > 60) throw fail(400, "A plan needs a name of up to 60 characters");
    // two plans with one name, or a name that is another plan's code, would make a company's plan ambiguous
    const clash = [...plans.values()].find((p) => p.code !== id && (p.name.trim().toLowerCase() === name.toLowerCase() || p.code === name.toLowerCase()));
    if (clash) throw fail(400, `Another plan is already called ${clash.name}. Choose a different name.`);
    next.name = name;
  }
  if (patch.numbers !== undefined) next.numbers = whole(patch.numbers, "WhatsApp numbers", { min: 1, max: 500, nullable: true });
  if (patch.seats !== undefined) next.seats = whole(patch.seats, "People", { min: 1, max: 1000, nullable: true });
  if (patch.maxContacts !== undefined) next.maxContacts = whole(patch.maxContacts, "Contacts", { min: 1, max: 100000000, nullable: true });
  if (patch.maxBroadcasts !== undefined) next.maxBroadcasts = whole(patch.maxBroadcasts, "Broadcasts a month", { min: 1, max: 100000, nullable: true });
  if (patch.taxMode !== undefined) {
    if (!["exclusive", "inclusive"].includes(patch.taxMode)) throw fail(400, "Tax is either added to the price (exclusive) or already in it (inclusive)");
    next.taxMode = patch.taxMode;
  }
  if (patch.trialDays !== undefined) next.trialDays = whole(patch.trialDays, "Trial days", { min: 0, max: 90 });
  if (patch.isActive !== undefined) {
    if (typeof patch.isActive !== "boolean") throw fail(400, "isActive must be true or false");
    if (!patch.isActive && id === "free") throw fail(400, "The Free plan can't be taken off sale");
    next.isActive = patch.isActive;
  }
  if (patch.features !== undefined) {
    if (!Array.isArray(patch.features) || patch.features.some((f) => !(f in FEATURE_LABELS)))
      throw fail(400, `Features must be some of: ${Object.keys(FEATURE_LABELS).join(", ")}`);
    next.features = [...new Set(patch.features)];
  }
  if (patch.prices !== undefined) {
    if (!Array.isArray(patch.prices)) throw fail(400, "Prices must be a list");
    const seen = new Set();
    next.prices = patch.prices.map((p) => {
      if (!INTERVALS.includes(p?.interval) || !CURRENCIES.includes(p?.currency))
        throw fail(400, "A price is for monthly or annual billing, in INR or AED");
      const key = `${p.interval}:${p.currency}`;
      if (seen.has(key)) throw fail(400, `There are two ${p.interval} ${p.currency} prices`);
      seen.add(key);
      return { interval: p.interval, currency: p.currency, amountMinor: whole(p.amountMinor, "A price", { min: 0, max: 10000000000 }) };
    });
    if (id === "free" && next.prices.some((p) => p.amountMinor > 0)) throw fail(400, "The Free plan has no price");
  }
  const snapshot = (p) => ({ name: p.name, numbers: p.numbers, seats: p.seats, features: p.features, isActive: p.isActive, maxContacts: p.maxContacts, maxBroadcasts: p.maxBroadcasts, trialDays: p.trialDays, taxMode: p.taxMode, prices: p.prices });
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE plans SET name=$2,numbers=$3,seats=$4,features=$5,is_active=$6,max_contacts=$7,trial_days=$8,max_broadcasts_per_month=$9,tax_mode=$10,updated_at=now() WHERE code=$1`,
      [id, next.name, next.numbers, next.seats, JSON.stringify(next.features), next.isActive, next.maxContacts, next.trialDays, next.maxBroadcasts, next.taxMode],
    );
    if (patch.prices !== undefined) {
      await client.query("DELETE FROM plan_prices WHERE plan_code=$1", [id]);
      for (const p of next.prices)
        await client.query("INSERT INTO plan_prices(plan_code,billing_interval,currency,amount_minor) VALUES($1,$2,$3,$4)", [id, p.interval, p.currency, p.amountMinor]);
    }
    await client.query("INSERT INTO plan_changes(plan_code,actor_id,before,after) VALUES($1,$2,$3,$4)", [id, actorId ?? null, JSON.stringify(snapshot(before)), JSON.stringify(snapshot(next))]);
  });
  await loadPlans();
  return planCatalogue({ all: true }).find((p) => p.id === id);
}

// Who changed which plan and when, newest first, with what the plan said before and after.
const PLAN_FIELDS = { name: "Name", numbers: "WhatsApp numbers", seats: "People", maxContacts: "Contacts", maxBroadcasts: "Broadcasts a month", isActive: "On sale", taxMode: "Tax", trialDays: "Trial days" };
const said = (v) => (v === null || v === undefined ? "no limit" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));
export async function planChanges(limit = 100) {
  const { rows } = await query(
    `SELECT c.id,c.plan_code,c.before,c.after,c.created_at,u.name AS actor FROM plan_changes c LEFT JOIN users u ON u.id=c.actor_id ORDER BY c.id DESC LIMIT $1`,
    [limit],
  );
  const minor = (p) => `${p.currency} ${(p.amountMinor / 100).toLocaleString("en-IN")} ${p.interval === "annual" ? "a year" : "a month"}`;
  return rows.map((r) => {
    const b = r.before || {},
      a = r.after || {};
    const changes = [];
    for (const [k, label] of Object.entries(PLAN_FIELDS)) if (said(b[k]) !== said(a[k])) changes.push({ field: label, from: said(b[k]), to: said(a[k]) });
    const was = new Set((b.features || []).map(String)),
      is = new Set((a.features || []).map(String));
    const nice = (f) => {
      const bare = (FEATURE_LABELS[f] || f).replace(/^The /, "");
      return bare.charAt(0).toUpperCase() + bare.slice(1);
    };
    for (const f of is) if (!was.has(f)) changes.push({ field: nice(f), from: "not included", to: "included" });
    for (const f of was) if (!is.has(f)) changes.push({ field: nice(f), from: "included", to: "not included" });
    const price = (list) => new Map((list || []).map((p) => [`${p.currency}:${p.interval}`, p]));
    const pb = price(b.prices),
      pa = price(a.prices);
    for (const key of new Set([...pb.keys(), ...pa.keys()])) {
      const x = pb.get(key),
        y = pa.get(key);
      if (x?.amountMinor !== y?.amountMinor) changes.push({ field: `Price, ${key.replace(":", " ")}`, from: x ? minor(x) : "none", to: y ? minor(y) : "none" });
    }
    return { id: r.id, plan: r.plan_code, name: a.name || b.name || r.plan_code, actor: r.actor, at: r.created_at, changes };
  });
}
