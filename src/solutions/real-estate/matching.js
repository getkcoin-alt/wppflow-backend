import { normalizeText, money } from "./text.js";

// Deterministic matching of a prospect's stated requirements against the company's own listings. No scoring model, no
// guessing: a property either meets every requirement the prospect stated, or it is left out. Each match says why.
export const PROPERTY_TYPES = ["apartment", "villa", "townhouse", "penthouse", "duplex", "studio", "office", "shop", "warehouse", "land"];
export const DEMAND_TYPES = ["buyer", "tenant", "investor"]; // people who are looking for a property; landlords and sellers are offering one
export const TIMELINES = ["immediate", "1_month", "3_months", "6_months", "later", "unknown"];
// How far away an availability date may be before it is flagged against the prospect's timeline.
const TIMELINE_DAYS = { immediate: 30, "1_month": 30, "3_months": 90, "6_months": 180 };
const DAY = 86400000;

const bedLabel = (n) => (n === 0 ? "Studio" : `${n} bedroom${n === 1 ? "" : "s"}`);
const range = (lo, hi) => (lo !== null && hi !== null ? (lo === hi ? bedLabel(lo) : `${lo} to ${hi} bedrooms`) : lo !== null ? `${lo} or more bedrooms` : `up to ${hi} bedrooms`);
const daysAgo = (at, now) => Math.max(0, Math.floor((now - new Date(at).getTime()) / DAY));
const ago = (n) => (n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`);

// What a prospect has stated that can be matched on. Used to refuse a search that would match everything.
export const requirementsOf = (p) =>
  [p.budgetMax !== null && "budget", p.communities.length && "area", p.propertyTypes.length && "property type", (p.bedroomsMin !== null || p.bedroomsMax !== null) && "bedrooms"].filter(Boolean);

export function matchability(profile) {
  if (!profile) return { ok: false, reason: "Qualify this lead first: say what they are looking for." };
  if (!DEMAND_TYPES.includes(profile.leadType)) return { ok: false, reason: "Matching is for buyers, tenants and investors. Landlords and sellers are offering a property, not looking for one." };
  if (!profile.intent) return { ok: false, reason: "Say whether they want to buy or to rent." };
  if (profile.budgetMax !== null && !profile.currency) return { ok: false, reason: "Say which currency the budget is in." };
  if (!requirementsOf(profile).length) return { ok: false, reason: "Add at least one requirement (a budget, an area, a property type or bedrooms): without one, every listing would match." };
  return { ok: true };
}

// One property against one prospect. Returns the first requirement it fails, or its reasons and warnings.
export function evaluate(profile, p, { now = Date.now(), freshnessDays = 14 } = {}) {
  const reasons = [];
  const warnings = [];
  const fail = (code, message) => ({ ok: false, code, message });
  if (p.status !== "available") return fail("status", `Not available (${p.status})`);
  const wanted = profile.intent === "buy" ? "sale" : "rent";
  if (p.purpose !== wanted) return fail("purpose", `For ${p.purpose}, not ${wanted}`);
  reasons.push(profile.intent === "buy" ? "For sale" : "For rent");

  if (p.price === null) return fail("price", "No price recorded");
  if (profile.budgetMax !== null || profile.budgetMin !== null) {
    if (p.currency !== profile.currency) return fail("currency", `Priced in ${p.currency}, budget is in ${profile.currency}`);
    if (profile.budgetMax !== null) {
      if (p.price > profile.budgetMax) return fail("budget", `${money(p.price, p.currency)} is over the ${money(profile.budgetMax, profile.currency)} budget`);
      reasons.push(`${money(p.price, p.currency)}${p.purpose === "rent" ? ` a ${p.rentPeriod}` : ""} is within the ${money(profile.budgetMax, profile.currency)} budget`);
    }
    if (profile.budgetMin !== null && p.price < profile.budgetMin)
      warnings.push(`Below the ${money(profile.budgetMin, profile.currency)} the prospect said they would spend`);
  }
  if (profile.bedroomsMin !== null || profile.bedroomsMax !== null) {
    if (p.bedrooms === null) return fail("bedrooms", "Bedrooms not recorded");
    if ((profile.bedroomsMin !== null && p.bedrooms < profile.bedroomsMin) || (profile.bedroomsMax !== null && p.bedrooms > profile.bedroomsMax))
      return fail("bedrooms", `${bedLabel(p.bedrooms)}, wanted ${range(profile.bedroomsMin, profile.bedroomsMax)}`);
    reasons.push(`${bedLabel(p.bedrooms)} (wanted ${range(profile.bedroomsMin, profile.bedroomsMax)})`);
  }
  if (profile.propertyTypes.length) {
    if (!profile.propertyTypes.includes(p.propertyType)) return fail("type", `Type is ${p.propertyType}, wanted ${profile.propertyTypes.join(" or ")}`);
    reasons.push(`Type is ${p.propertyType}, as wanted`);
  }
  if (profile.communities.length) {
    const here = normalizeText(p.community);
    const hit = profile.communities.find((c) => normalizeText(c) === here && here !== "");
    if (!hit) return fail("area", `In ${p.community || "an unrecorded area"}, wanted ${profile.communities.join(" or ")}`);
    reasons.push(`In ${p.community}, as wanted`);
  }

  const window = TIMELINE_DAYS[profile.timeline];
  if (window && p.availableFrom) {
    const from = new Date(`${p.availableFrom}T00:00:00Z`).getTime();
    if (from > now + window * DAY) warnings.push(`Available from ${p.availableFrom}, later than the prospect's timeline`);
  }
  let verification = "never";
  let verifiedDaysAgo = null;
  if (p.lastVerifiedAt) {
    verifiedDaysAgo = daysAgo(p.lastVerifiedAt, now);
    verification = verifiedDaysAgo > freshnessDays ? "stale" : "fresh";
    if (verification === "fresh") reasons.push(`Availability checked ${ago(verifiedDaysAgo)}`);
    else warnings.push(`Availability last checked ${ago(verifiedDaysAgo)}: confirm it before sharing`);
  } else warnings.push("Availability has never been checked: confirm it before sharing");
  return { ok: true, reasons, warnings, verification, verifiedDaysAgo };
}

const RANK = { fresh: 0, stale: 1, never: 2 };
const FIRST_FAILURES = ["currency", "budget", "bedrooms", "type", "area"]; // the checks that say why a candidate was left out

// All of a company's listings against one prospect. `matches` are the properties that meet every stated requirement,
// best-verified first, then cheapest, then by reference. `leftOut` says how many otherwise-possible listings failed which requirement.
export function matchProperties(profile, properties, { now = Date.now(), freshnessDays = 14, limit = 20 } = {}) {
  const gate = matchability(profile);
  if (!gate.ok) return { eligible: false, reason: gate.reason, matches: [], candidates: 0, leftOut: {} };
  const matches = [];
  const leftOut = {};
  let candidates = 0;
  for (const p of properties) {
    const r = evaluate(profile, p, { now, freshnessDays });
    if (r.ok) {
      candidates++;
      matches.push({ property: p, reasons: r.reasons, warnings: r.warnings, verification: r.verification, verifiedDaysAgo: r.verifiedDaysAgo });
    } else if (FIRST_FAILURES.includes(r.code)) {
      candidates++;
      leftOut[r.code] = (leftOut[r.code] || 0) + 1;
    }
  }
  matches.sort((a, b) => RANK[a.verification] - RANK[b.verification] || a.property.price - b.property.price || a.property.reference.localeCompare(b.property.reference, "en", { numeric: true }));
  return { eligible: true, matches: matches.slice(0, limit), total: matches.length, candidates, leftOut, requirements: requirementsOf(profile) };
}
