import { query, withTransaction } from "../../db/index.js";
import { fail, failWith } from "../../middleware/http.js";
import { findLead, record, createLeadFromChat } from "../../services/leadService.js";
import { assertConversationAccess } from "../../services/access.js";
import { normalizeText } from "./text.js";
import { PROPERTY_TYPES, DEMAND_TYPES, TIMELINES } from "./matching.js";

// What a prospect is looking for, or what an owner is offering. One profile per lead, kept apart from the lead itself so
// the universal pipeline never needs to know about it.
export const LEAD_TYPES = ["buyer", "tenant", "landlord", "seller", "investor"];
// A buyer, an investor and a seller deal in sales; a tenant and a landlord deal in rentals.
export const INTENT_OF = { buyer: "buy", investor: "buy", seller: "buy", tenant: "rent", landlord: "rent" };
export const STATUSES = ["new", "in_progress", "qualified", "disqualified"];
export const BUDGET_CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR"];
const MAX_MONEY = 9_999_999_999;

const oneOf = (label, list) => (v) => {
  if (!list.includes(v)) throw fail(400, `${label} must be one of: ${list.join(", ")}`);
  return v;
};
const money = (label) => (v) => {
  if (v === null || v === "") return null;
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) throw fail(400, `${label} must be a number from 0 to 9,999,999,999`);
  return Math.round(n * 100) / 100;
};
const bedrooms = (label) => (v) => {
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 20) throw fail(400, `${label} must be a whole number from 0 (a studio) to 20`);
  return n;
};
const text = (label, max) => (v) => {
  const s = String(v ?? "").trim();
  if (s.length > max) throw fail(400, `${label} can be up to ${max} characters`);
  return s;
};
const list = (label, max, each) => (v) => {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw fail(400, `${label} must be a list of up to ${max}`);
  const seen = new Set();
  const out = [];
  for (const item of v) {
    const s = each(item);
    const key = normalizeText(s);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
};

// One checker per field. The same checkers validate what a person types and what Riwo proposes.
export const FIELDS = {
  leadType: oneOf("Lead type", LEAD_TYPES),
  intent: oneOf("Intent", ["buy", "rent"]),
  budgetMin: money("The lowest budget"),
  budgetMax: money("The budget"),
  currency: oneOf("Currency", BUDGET_CURRENCIES),
  communities: list("Areas", 10, (c) => {
    const s = String(c ?? "").trim();
    if (!s || s.length > 80) throw fail(400, "An area is a name of up to 80 characters");
    return s;
  }),
  propertyTypes: list("Property types", 10, (t) => oneOf("A property type", PROPERTY_TYPES)(String(t ?? "").trim().toLowerCase())),
  bedroomsMin: bedrooms("Bedrooms"),
  bedroomsMax: bedrooms("Bedrooms"),
  timeline: oneOf("Timeline", TIMELINES),
  sourceDetail: text("The source", 60),
  qualificationStatus: oneOf("Status", STATUSES),
  disqualifiedReason: text("The reason", 255),
  nextAction: text("The next action", 255),
  notes: text("Notes", 2000),
};
const NULLABLE = new Set(["leadType", "intent", "budgetMin", "budgetMax", "currency", "bedroomsMin", "bedroomsMax", "timeline"]);
const BLANK = {
  leadType: null, intent: null, budgetMin: null, budgetMax: null, currency: null, communities: [], propertyTypes: [], bedroomsMin: null, bedroomsMax: null,
  timeline: null, sourceDetail: "", qualificationStatus: "new", disqualifiedReason: "", nextAction: "", notes: "",
};

export const profileView = (r) =>
  !r ? null : {
    leadId: r.lead_id,
    leadType: r.lead_type,
    intent: r.intent,
    budgetMin: r.budget_min === null ? null : Number(r.budget_min),
    budgetMax: r.budget_max === null ? null : Number(r.budget_max),
    currency: r.currency,
    communities: r.communities || [],
    propertyTypes: r.property_types || [],
    bedroomsMin: r.bedrooms_min,
    bedroomsMax: r.bedrooms_max,
    timeline: r.timeline,
    sourceDetail: r.source_detail,
    qualificationStatus: r.qualification_status,
    disqualifiedReason: r.disqualified_reason,
    nextAction: r.next_action,
    notes: r.notes,
    qualifiedAt: r.qualified_at,
    updatedAt: r.updated_at,
  };

// What is still needed before someone can honestly be called qualified.
export function missingForQualified(p) {
  const missing = [];
  if (!p.leadType) missing.push("lead type");
  if (!p.intent) missing.push("buy or rent");
  if (p.leadType && DEMAND_TYPES.includes(p.leadType)) {
    if (p.budgetMax === null) missing.push("budget");
    else if (!p.currency) missing.push("budget currency");
    if (!p.communities.length && !p.propertyTypes.length) missing.push("an area or a property type");
    if (!p.timeline || p.timeline === "unknown") missing.push("timeline");
  }
  return missing;
}

// Applies a change to a profile and checks the whole. `current` is the profile as it is now (or null).
export function validateProfile(input, current = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail(400, "Send the details to save");
  const next = { ...BLANK, ...(current ? Object.fromEntries(Object.keys(BLANK).map((k) => [k, current[k]])) : {}) };
  for (const [k, v] of Object.entries(input)) {
    if (!(k in FIELDS)) throw fail(400, `Unknown field: ${k}`);
    next[k] = v === null && NULLABLE.has(k) ? null : FIELDS[k](v);
  }
  // the type decides whether it is a sale or a rental: changing the type changes the intent with it, unless both are given
  if (next.leadType && (!next.intent || (input.leadType !== undefined && input.intent === undefined))) next.intent = INTENT_OF[next.leadType];
  if (next.leadType && next.intent && INTENT_OF[next.leadType] !== next.intent)
    throw fail(400, `A ${next.leadType} deals in ${INTENT_OF[next.leadType] === "buy" ? "sales, not rentals" : "rentals, not sales"}.`);
  if ((next.budgetMin !== null || next.budgetMax !== null) && !next.currency) throw fail(400, "Say which currency the budget is in");
  if (next.budgetMin !== null && next.budgetMax !== null && next.budgetMin > next.budgetMax) throw fail(400, "The lowest budget is above the highest");
  if (next.bedroomsMin !== null && next.bedroomsMax !== null && next.bedroomsMin > next.bedroomsMax) throw fail(400, "The fewest bedrooms is above the most");
  if (next.qualificationStatus === "disqualified" && !next.disqualifiedReason) throw fail(400, "Say why this lead is not a fit");
  if (next.qualificationStatus !== "disqualified") next.disqualifiedReason = "";
  if (next.qualificationStatus === "qualified") {
    const missing = missingForQualified(next);
    if (missing.length) throw failWith(422, `Before this lead can be marked qualified, add: ${missing.join(", ")}.`, { missing });
  }
  return next;
}

const COLUMNS = {
  leadType: "lead_type", intent: "intent", budgetMin: "budget_min", budgetMax: "budget_max", currency: "currency", communities: "communities",
  propertyTypes: "property_types", bedroomsMin: "bedrooms_min", bedroomsMax: "bedrooms_max", timeline: "timeline", sourceDetail: "source_detail",
  qualificationStatus: "qualification_status", disqualifiedReason: "disqualified_reason", nextAction: "next_action", notes: "notes",
};

export async function getProfile(req, leadId) {
  const lead = await findLead(req, leadId);
  const row = (await query("SELECT * FROM re_lead_profiles WHERE lead_id=$1 AND tenant_id=$2", [lead.id, req.tenantId])).rows[0];
  const profile = profileView(row);
  return { profile, missing: missingForQualified(profile || BLANK), lead };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Saves what a person typed or approved. The change is written to the lead's own history, in the core activity log.
export async function saveProfile(req, leadId, input, { assisted = false } = {}) {
  const lead = await findLead(req, leadId);
  const saved = await withTransaction(async (c) => {
    const row = (await c.query("SELECT * FROM re_lead_profiles WHERE lead_id=$1 AND tenant_id=$2 FOR UPDATE", [lead.id, req.tenantId])).rows[0];
    const before = profileView(row);
    const next = validateProfile(input, before);
    const changed = Object.keys(COLUMNS).filter((k) => !same(before ? before[k] : BLANK[k], next[k]));
    if (before && !changed.length) return { view: before, changed: [] };
    const params = [lead.id, req.tenantId, ...Object.keys(COLUMNS).map((k) => next[k]), req.user.id];
    const cols = Object.values(COLUMNS);
    const wasQualified = before?.qualificationStatus === "qualified";
    const qualifiedAt = next.qualificationStatus === "qualified" ? (wasQualified ? before.qualifiedAt : new Date().toISOString()) : null;
    params.push(qualifiedAt);
    await c.query(
      `INSERT INTO re_lead_profiles(lead_id,tenant_id,${cols.join(",")},updated_by,qualified_at) VALUES(${params.map((_, i) => `$${i + 1}`).join(",")})
       ON CONFLICT (lead_id) DO UPDATE SET ${cols.map((col) => `${col}=EXCLUDED.${col}`).join(",")},updated_by=EXCLUDED.updated_by,qualified_at=EXCLUDED.qualified_at,updated_at=now()`,
      params,
    );
    await record(c, lead, req.user, "qualification", {
      changed,
      status: next.qualificationStatus,
      ...(changed.includes("qualificationStatus") && next.qualificationStatus === "disqualified" ? { reason: next.disqualifiedReason } : {}),
      ...(assisted ? { assisted: true } : {}),
    });
    const fresh = (await c.query("SELECT * FROM re_lead_profiles WHERE lead_id=$1", [lead.id])).rows[0];
    return { view: profileView(fresh), changed };
  });
  return { profile: saved.view, changed: saved.changed, missing: missingForQualified(saved.view) };
}

// A lead made from a chat and qualified in one step. The details are checked first, so nothing is made if they are wrong.
export async function createLeadWithProfile(req, { conversationId, title, value, profile }) {
  const input = profile || {};
  validateProfile(input, null);
  await assertConversationAccess(req, conversationId);
  const conversation = (await query("SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2", [conversationId, req.tenantId])).rows[0];
  if (!conversation) throw fail(404, "Conversation not found");
  const made = await createLeadFromChat({ tenantId: req.tenantId, conversation, actor: req.user, source: "chat", title, value, io: req.app.get("io") });
  if (Object.keys(input).length) await saveProfile(req, made.id, input);
  return made;
}

export { BLANK as BLANK_PROFILE };
