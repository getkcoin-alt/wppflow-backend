import crypto from "node:crypto";
import { query } from "../../db/index.js";
import { fail, failWith } from "../../middleware/http.js";
import { isManager } from "../../services/access.js";
import { PROPERTY_TYPES, matchProperties } from "./matching.js";
import { BUDGET_CURRENCIES } from "./profile.js";
import { findLead } from "../../services/leadService.js";
import { profileView } from "./profile.js";
import { settingsOf } from "../entitlements.js";
import { money } from "./text.js";

// The company's own listings. A property exists only because someone at the company entered it, and it can be shown to a
// prospect only while the company says it is available.
export const STATUSES = ["draft", "available", "reserved", "sold", "rented", "withdrawn"];
const NEEDS_BEDROOMS = new Set(["apartment", "villa", "townhouse", "penthouse", "duplex", "studio"]);
const MEDIA_KINDS = ["photo", "floorplan", "brochure", "video"];
const FURNISHED = ["furnished", "partly", "unfurnished"];

export const propertyView = (r, freshnessDays = 14, now = Date.now()) => {
  const verifiedDaysAgo = r.last_verified_at ? Math.max(0, Math.floor((now - new Date(r.last_verified_at).getTime()) / 86400000)) : null;
  return {
    id: r.id,
    reference: r.reference,
    title: r.title,
    purpose: r.purpose,
    status: r.status,
    price: r.price === null ? null : Number(r.price),
    currency: r.currency,
    rentPeriod: r.rent_period,
    community: r.community,
    propertyType: r.property_type,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    sizeSqft: r.size_sqft === null ? null : Number(r.size_sqft),
    furnished: r.furnished,
    availableFrom: r.available_from ? new Date(r.available_from).toISOString().slice(0, 10) : null,
    listingUrl: r.listing_url,
    permitNumber: r.permit_number,
    media: r.media || [],
    agentUserId: r.agent_user_id,
    agentName: r.agent_name || "",
    lastVerifiedAt: r.last_verified_at,
    verification: verifiedDaysAgo === null ? "never" : verifiedDaysAgo > freshnessDays ? "stale" : "fresh",
    verifiedDaysAgo,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

// The shape the pure matcher works on.
export const forMatching = (r) => ({
  id: r.id,
  reference: r.reference,
  title: r.title,
  status: r.status,
  purpose: r.purpose,
  price: r.price === null ? null : Number(r.price),
  currency: r.currency,
  rentPeriod: r.rent_period,
  community: r.community,
  propertyType: r.property_type,
  bedrooms: r.bedrooms,
  availableFrom: r.available_from ? new Date(r.available_from).toISOString().slice(0, 10) : null,
  lastVerifiedAt: r.last_verified_at,
  listingUrl: r.listing_url,
});

const httpsUrl = (label, v) => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  let u;
  try {
    u = new URL(s);
  } catch {
    throw fail(400, `${label} must be a full web address starting with https://`);
  }
  if (u.protocol !== "https:" || s.length > 2000) throw fail(400, `${label} must be a full web address starting with https://`);
  return u.toString();
};
const wholeOrNull = (label, max) => (v) => {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw fail(400, `${label} must be a whole number from 0 to ${max}`);
  return n;
};
const textOf = (label, max, { required = false } = {}) => (v) => {
  const s = String(v ?? "").trim();
  if (required && !s) throw fail(400, `${label} is required`);
  if (s.length > max) throw fail(400, `${label} can be up to ${max} characters`);
  return s;
};
const choice = (label, list) => (v) => {
  if (!list.includes(v)) throw fail(400, `${label} must be one of: ${list.join(", ")}`);
  return v;
};

const CHECKS = {
  reference: (v) => {
    const s = String(v ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,39}$/.test(s)) throw fail(400, "The reference is 1 to 40 letters, numbers, spaces or . _ / -");
    return s;
  },
  title: textOf("The title", 160),
  purpose: choice("Purpose", ["sale", "rent"]),
  price: (v) => {
    if (v === null || v === "" || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 9_999_999_999) throw fail(400, "The price must be more than 0 and under 10 billion");
    return Math.round(n * 100) / 100;
  },
  currency: choice("Currency", BUDGET_CURRENCIES),
  rentPeriod: (v) => (v === null || v === "" || v === undefined ? null : choice("Rent period", ["year", "month"])(v)),
  community: textOf("The community", 120),
  propertyType: choice("Property type", PROPERTY_TYPES),
  bedrooms: wholeOrNull("Bedrooms", 20),
  bathrooms: wholeOrNull("Bathrooms", 20),
  sizeSqft: (v) => {
    if (v === null || v === "" || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) throw fail(400, "The size must be a positive number of square feet");
    return n;
  },
  furnished: (v) => (v === null || v === "" || v === undefined ? null : choice("Furnishing", FURNISHED)(v)),
  availableFrom: (v) => {
    if (v === null || v === "" || v === undefined) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw fail(400, "Use a date like 2026-12-31");
    return v;
  },
  listingUrl: (v) => httpsUrl("The listing address", v),
  permitNumber: textOf("The permit number", 60),
  media: (v) => {
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v) || v.length > 20) throw fail(400, "Media is a list of up to 20 items");
    return v.map((m) => {
      if (!MEDIA_KINDS.includes(m?.kind)) throw fail(400, `Each media item is one of: ${MEDIA_KINDS.join(", ")}`);
      const url = httpsUrl("A media address", m.url);
      if (!url) throw fail(400, "Each media item needs an https address");
      return { kind: m.kind, url, caption: textOf("A caption", 120)(m.caption) };
    });
  },
};
const COLUMN = { rentPeriod: "rent_period", propertyType: "property_type", sizeSqft: "size_sqft", availableFrom: "available_from", listingUrl: "listing_url", permitNumber: "permit_number", agentUserId: "agent_user_id" };
const col = (k) => COLUMN[k] || k;

const activeMember = async (tenantId, userId) =>
  (await query(`SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND u.id=$2`, [tenantId, Number(userId) || 0])).rows[0];

// What must be recorded before a listing can be offered to anyone.
export function readyToList(p) {
  const missing = [];
  if (p.price === null) missing.push("a price");
  if (!p.community) missing.push("the community");
  if (p.purpose === "rent" && !p.rentPeriod) missing.push("whether the rent is per year or per month");
  if (NEEDS_BEDROOMS.has(p.propertyType) && p.bedrooms === null) missing.push("the number of bedrooms");
  return missing;
}

const SELECT = `SELECT p.*,u.name AS agent_name FROM re_properties p LEFT JOIN users u ON u.id=p.agent_user_id`;

export async function findProperty(req, id) {
  const row = (await query(`${SELECT} WHERE p.id=$1 AND p.tenant_id=$2`, [String(id), req.tenantId])).rows[0];
  if (!row) throw fail(404, "Property not found");
  return row;
}
const canEdit = (req, row) => isManager(req) || row.agent_user_id === req.user.id;

export async function listProperties(req, f = {}) {
  const { freshnessDays } = await settingsOf(req.tenantId, "real_estate");
  const params = [req.tenantId];
  const where = ["p.tenant_id=$1"];
  if (f.status && STATUSES.includes(f.status)) where.push(`p.status=$${params.push(f.status)}`);
  if (f.purpose && ["sale", "rent"].includes(f.purpose)) where.push(`p.purpose=$${params.push(f.purpose)}`);
  if (f.q) {
    params.push(`%${String(f.q).slice(0, 80)}%`);
    where.push(`(p.reference ILIKE $${params.length} OR p.title ILIKE $${params.length} OR p.community ILIKE $${params.length})`);
  }
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 100);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const total = (await query(`SELECT count(*)::int AS n FROM re_properties p WHERE ${where.join(" AND ")}`, params)).rows[0].n;
  const { rows } = await query(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY p.updated_at DESC, p.reference LIMIT ${limit} OFFSET ${offset}`, params);
  const counts = Object.fromEntries((await query("SELECT status,count(*)::int AS n FROM re_properties WHERE tenant_id=$1 GROUP BY status", [req.tenantId])).rows.map((r) => [r.status, r.n]));
  return { properties: rows.map((r) => propertyView(r, freshnessDays)), total, limit, offset, counts };
}

export async function getProperty(req, id) {
  const { freshnessDays } = await settingsOf(req.tenantId, "real_estate");
  return propertyView(await findProperty(req, id), freshnessDays);
}

function check(input, existing) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail(400, "Send the details to save");
  const next = { ...(existing || {}) };
  for (const [k, v] of Object.entries(input)) {
    if (k === "status" || k === "agentUserId") continue;
    if (!(k in CHECKS)) throw fail(400, `Unknown field: ${k}`);
    next[k] = CHECKS[k](v);
  }
  return next;
}

const fromRow = (r) => ({
  reference: r.reference, title: r.title, purpose: r.purpose, price: r.price === null ? null : Number(r.price), currency: r.currency, rentPeriod: r.rent_period,
  community: r.community, propertyType: r.property_type, bedrooms: r.bedrooms, bathrooms: r.bathrooms, sizeSqft: r.size_sqft === null ? null : Number(r.size_sqft),
  furnished: r.furnished, availableFrom: r.available_from ? new Date(r.available_from).toISOString().slice(0, 10) : null, listingUrl: r.listing_url,
  permitNumber: r.permit_number, media: r.media || [],
});

async function writeProperty(req, id, input, existingRow) {
  const next = check(input, existingRow ? fromRow(existingRow) : { title: "", price: null, rentPeriod: null, bedrooms: null, bathrooms: null, sizeSqft: null, furnished: null, availableFrom: null, listingUrl: "", permitNumber: "", media: [], community: "" });
  for (const need of ["reference", "purpose", "currency", "propertyType"]) if (!next[need]) throw fail(400, `${need === "propertyType" ? "Property type" : need[0].toUpperCase() + need.slice(1)} is required`);
  if (next.purpose === "sale") next.rentPeriod = null;
  let status = existingRow?.status || "draft";
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw fail(400, `Status must be one of: ${STATUSES.join(", ")}`);
    status = input.status;
  }
  if (status === "available" || status === "reserved") {
    const missing = readyToList(next);
    if (missing.length) throw failWith(422, `Before this property can be ${status === "available" ? "offered" : "reserved"}, add ${missing.join(", ")}.`, { missing });
  }
  let agent = existingRow?.agent_user_id ?? null;
  if (input.agentUserId !== undefined) {
    if (input.agentUserId === null) agent = null;
    else {
      const m = await activeMember(req.tenantId, input.agentUserId);
      if (!m) throw fail(400, "The listing agent isn't an active teammate");
      agent = m.id;
    }
  }
  // Marking a property available is the moment a person says it is: the check is recorded with who made it.
  const becomesAvailable = status === "available" && existingRow?.status !== "available";
  const keys = Object.keys(CHECKS);
  const values = keys.map((k) => (k === "media" ? JSON.stringify(next[k]) : next[k] ?? null));
  try {
    await query(
      existingRow
        ? `UPDATE re_properties SET ${keys.map((k, i) => `${col(k)}=$${i + 3}`).join(",")},status=$${keys.length + 3},agent_user_id=$${keys.length + 4},
             last_verified_at=CASE WHEN $${keys.length + 5}::boolean THEN now() ELSE last_verified_at END,verified_by=CASE WHEN $${keys.length + 5}::boolean THEN $${keys.length + 6}::int ELSE verified_by END,updated_at=now()
           WHERE id=$1 AND tenant_id=$2`
        : `INSERT INTO re_properties(id,tenant_id,${keys.map(col).join(",")},status,agent_user_id,last_verified_at,verified_by,created_by)
           VALUES($1,$2,${keys.map((_, i) => `$${i + 3}`).join(",")},$${keys.length + 3},$${keys.length + 4},CASE WHEN $${keys.length + 5}::boolean THEN now() END,CASE WHEN $${keys.length + 5}::boolean THEN $${keys.length + 6}::int END,$${keys.length + 6})`,
      [id, req.tenantId, ...values, status, agent, becomesAvailable, req.user.id],
    );
  } catch (e) {
    if (e.code === "23505") throw fail(409, `The reference ${next.reference} is already used by another property`);
    throw e;
  }
}

export async function createProperty(req, input) {
  if (!isManager(req)) throw fail(403, "Only an owner or administrator can add properties");
  const id = crypto.randomUUID();
  await writeProperty(req, id, input, null);
  return getProperty(req, id);
}

export async function updateProperty(req, id, input) {
  const row = await findProperty(req, id);
  if (!canEdit(req, row)) throw fail(403, "Only an owner, an administrator or the listing agent can change this property");
  // only managers decide who the listing agent is and which media is approved
  if (!isManager(req) && (input.agentUserId !== undefined || input.media !== undefined)) throw fail(403, "Only an owner or administrator can change the listing agent or the approved media");
  await writeProperty(req, row.id, input, row);
  return getProperty(req, row.id);
}

// "Yes, this is still available": the company's own statement, with its date and who made it.
export async function verifyProperty(req, id) {
  const row = await findProperty(req, id);
  if (!canEdit(req, row)) throw fail(403, "Only an owner, an administrator or the listing agent can confirm availability");
  if (!["available", "reserved"].includes(row.status)) throw fail(409, `A ${row.status} property can't be confirmed as available`);
  await query("UPDATE re_properties SET last_verified_at=now(),verified_by=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2", [row.id, req.tenantId, req.user.id]);
  return getProperty(req, row.id);
}

export async function deleteProperty(req, id) {
  if (!isManager(req)) throw fail(403, "Only an owner or administrator can delete properties");
  const row = await findProperty(req, id);
  const used = (await query("SELECT count(*)::int AS n FROM re_viewings WHERE property_id=$1 AND tenant_id=$2", [row.id, req.tenantId])).rows[0].n;
  if (used) throw fail(409, "This property has viewings on record. Withdraw it instead of deleting it.");
  await query("DELETE FROM re_properties WHERE id=$1 AND tenant_id=$2", [row.id, req.tenantId]);
}

// Text for a person to send: what a listing is, from the record, with nothing added.
export function listingLine(p) {
  const bits = [p.bedrooms === null ? null : p.bedrooms === 0 ? "Studio" : `${p.bedrooms} bed`, p.propertyType, p.community || null].filter(Boolean);
  const price = p.price === null ? "" : `, ${money(p.price, p.currency)}${p.purpose === "rent" && p.rentPeriod ? ` a ${p.rentPeriod}` : ""}`;
  return `${p.reference}: ${bits.join(", ")}${price}${p.listingUrl ? `\n${p.listingUrl}` : ""}`;
}

// The listings that fit one lead's stated requirements, each with the reasons.
export async function matchesForLead(req, leadId, { limit = 20 } = {}) {
  const lead = await findLead(req, leadId);
  const profileRow = (await query("SELECT * FROM re_lead_profiles WHERE lead_id=$1 AND tenant_id=$2", [lead.id, req.tenantId])).rows[0];
  const profile = profileView(profileRow);
  const { freshnessDays } = await settingsOf(req.tenantId, "real_estate");
  const wanted = profile?.intent === "rent" ? "rent" : "sale";
  const { rows } = await query("SELECT * FROM re_properties WHERE tenant_id=$1 AND status='available' AND purpose=$2 LIMIT 5000", [req.tenantId, wanted]);
  const result = matchProperties(profile && { ...profile }, rows.map(forMatching), { freshnessDays, limit });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  return {
    eligible: result.eligible,
    reason: result.reason || null,
    requirements: result.requirements || [],
    total: result.total || 0,
    candidates: result.candidates || 0,
    leftOut: result.leftOut,
    freshnessDays,
    matches: result.matches.map((m) => ({
      property: propertyView(byId[m.property.id], freshnessDays),
      reasons: m.reasons,
      warnings: m.warnings,
      verification: m.verification,
      shareText: listingLine(m.property),
    })),
  };
}

