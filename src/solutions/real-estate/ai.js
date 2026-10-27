import { query } from "../../db/index.js";
import { fail, failWith } from "../../middleware/http.js";
import { askAboutConversation } from "../../services/aiService.js";
import { assertConversationAccess } from "../../services/access.js";
import { findLead } from "../../services/leadService.js";
import { normalizeText, amountsIn, money } from "./text.js";
import { FIELDS, validateProfile, missingForQualified, profileView, BLANK_PROFILE } from "./profile.js";
import { matchesForLead, listingLine } from "./properties.js";

// Riwo for real estate. It reads a chat and proposes; a person decides. Nothing here saves, sends or books anything, and
// everything the model says is checked against the chat and the company's own records before it is shown.
export const EXTRACTABLE = ["leadType", "intent", "budgetMin", "budgetMax", "currency", "communities", "propertyTypes", "bedroomsMin", "bedroomsMax", "timeline"];

// The model is asked for JSON; it sometimes wraps it in a code fence or a sentence. Take the first complete object.
export function parseJsonObject(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const TYPE_WORDS = {
  apartment: ["apartment", "apartments", "flat", "flats", "apt"], villa: ["villa", "villas"], townhouse: ["townhouse", "townhouses", "town house"],
  penthouse: ["penthouse"], duplex: ["duplex"], studio: ["studio", "studios"], office: ["office", "offices"], shop: ["shop", "retail"], warehouse: ["warehouse"], land: ["land", "plot"],
};
const CURRENCY_WORDS = { AED: ["aed", "dirham", "dirhams", "درهم"], USD: ["usd", "dollar", "dollars", "$"], EUR: ["eur", "euro", "euros"], GBP: ["gbp", "pound", "pounds"], INR: ["inr", "rupee", "rupees", "rs"] };
const NUMBER_WORDS = { studio: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const has = (haystack, needle) => ` ${haystack} `.includes(` ${normalizeText(needle)} `);

// Checks every field the model proposed against what the customer actually wrote. A field is kept only if the quote the
// model gave appears in a customer message and supports the value. Anything else is set aside with the reason.
export function validateExtraction(raw, lines, current = null) {
  const customer = normalizeText(lines.filter((l) => l.startsWith("Customer:")).map((l) => l.slice("Customer:".length)).join("\n"));
  const fields = raw && typeof raw.fields === "object" && raw.fields ? raw.fields : {};
  const accepted = {};
  const evidence = {};
  const rejected = [];
  const reject = (field, reason) => rejected.push({ field, reason });
  for (const key of EXTRACTABLE) {
    const entry = fields[key];
    if (entry === undefined || entry === null) continue;
    const value = typeof entry === "object" && !Array.isArray(entry) && "value" in entry ? entry.value : undefined;
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
    const quote = String(entry.evidence ?? "").trim().slice(0, 240);
    const q = normalizeText(quote);
    if (!q) {
      reject(key, "No quote from the customer was given");
      continue;
    }
    if (!` ${customer} `.includes(` ${q} `)) {
      reject(key, "The quote isn't in the customer's messages");
      continue;
    }
    let clean;
    try {
      clean = FIELDS[key](value);
    } catch (e) {
      reject(key, e.message);
      continue;
    }
    if (key === "budgetMin" || key === "budgetMax") {
      if (clean === null || !amountsIn(quote).some((n) => Math.abs(n - clean) <= clean * 0.005)) {
        reject(key, "That amount isn't in the quote");
        continue;
      }
    } else if (key === "bedroomsMin" || key === "bedroomsMax") {
      const digits = (quote.match(/\d+/g) || []).map(Number);
      const words = q.split(" ").filter((w) => w in NUMBER_WORDS).map((w) => NUMBER_WORDS[w]);
      if (clean === null || ![...digits, ...words].includes(clean)) {
        reject(key, "That number of bedrooms isn't in the quote");
        continue;
      }
    } else if (key === "communities") {
      const kept = clean.filter((c) => has(q, c));
      if (kept.length < clean.length) reject(key, `The quote doesn't name: ${clean.filter((c) => !kept.includes(c)).join(", ")}`);
      if (!kept.length) continue;
      clean = kept;
    } else if (key === "propertyTypes") {
      const kept = clean.filter((t) => (TYPE_WORDS[t] || []).some((w) => has(q, w)));
      if (kept.length < clean.length) reject(key, `The quote doesn't mention: ${clean.filter((t) => !kept.includes(t)).join(", ")}`);
      if (!kept.length) continue;
      clean = kept;
    } else if (key === "currency") {
      if (!(CURRENCY_WORDS[clean] || []).some((w) => q.includes(normalizeText(w)) || quote.includes(w))) {
        reject(key, "The quote doesn't mention that currency");
        continue;
      }
    }
    accepted[key] = clean;
    evidence[key] = quote;
  }
  // what was proposed must make sense together, and with what is already on the lead
  let conflict = null;
  try {
    validateProfile(accepted, current ? { ...BLANK_PROFILE, ...current } : null);
  } catch (e) {
    conflict = e.message;
  }
  const merged = { ...BLANK_PROFILE, ...(current || {}), ...(conflict ? {} : accepted) };
  const changes = Object.keys(accepted).filter((k) => JSON.stringify(current ? current[k] : BLANK_PROFILE[k]) !== JSON.stringify(accepted[k]));
  const notes = (Array.isArray(raw?.uncertain) ? raw.uncertain : []).map((n) => String(n?.note ?? n ?? "").trim().slice(0, 200)).filter(Boolean).slice(0, 8);
  return {
    proposal: conflict ? {} : accepted,
    evidence: conflict ? {} : evidence,
    changes: conflict ? [] : changes,
    rejected,
    conflict,
    // the server decides what is missing, not the model
    missing: missingForQualified(merged),
    uncertain: notes,
    summary: String(raw?.summary ?? "").trim().slice(0, 400),
  };
}

const EXTRACT_TASK = `Read the customer's messages and extract what they have said about the property they want, or the one they are offering.
Reply with one JSON object and nothing else, in exactly this shape:
{"fields":{"leadType":{"value":"buyer|tenant|landlord|seller|investor","evidence":"exact quote"},"intent":{"value":"buy|rent","evidence":"exact quote"},"budgetMax":{"value":1500000,"evidence":"exact quote"},"budgetMin":{"value":0,"evidence":"exact quote"},"currency":{"value":"AED","evidence":"exact quote"},"communities":{"value":["Dubai Marina"],"evidence":"exact quote"},"propertyTypes":{"value":["apartment"],"evidence":"exact quote"},"bedroomsMin":{"value":2,"evidence":"exact quote"},"bedroomsMax":{"value":3,"evidence":"exact quote"},"timeline":{"value":"immediate|1_month|3_months|6_months|later","evidence":"exact quote"}},"uncertain":["short note about anything vague or contradictory"],"summary":"one or two sentences"}
Rules:
- Include a field only if the customer clearly said it. Leave out every field you are unsure of. Never guess a budget, an area or a property type.
- "evidence" must be a short quote (under 160 characters) copied exactly from one of the customer's messages. Staff messages are not evidence.
- Amounts are plain numbers with no symbol: 1.5M is 1500000. A studio has 0 bedrooms.
- Write area names exactly as the customer wrote them.
- buyer wants to buy to live in; tenant wants to rent; landlord owns a property to rent out; seller owns a property to sell; investor is buying to earn a return.`;

// Proposes the qualification details found in a chat. Saves nothing.
export async function extractQualification(req, leadId) {
  const lead = await findLead(req, leadId);
  const conversationId = lead.conversation_id;
  if (!conversationId) throw fail(422, "This lead has no chat to read.");
  await assertConversationAccess(req, conversationId);
  const row = (await query("SELECT * FROM re_lead_profiles WHERE lead_id=$1 AND tenant_id=$2", [lead.id, req.tenantId])).rows[0];
  const current = profileView(row);
  const answer = await askAboutConversation({ tenant: req.tenant, conversationId, task: EXTRACT_TASK });
  const parsed = parseJsonObject(answer.text);
  if (!parsed) throw failWith(502, "Riwo's answer couldn't be read. Try again, or fill the details in by hand.", { model: answer.model });
  return { ...validateExtraction(parsed, answer.lines, current), model: answer.model, status: "proposal", note: "Nothing is saved until you apply it." };
}

// ── Drafting a reply that can only mention approved listings ─────────────────────────────────────
const MARKER = /\[\[REF:([^\]\n]{1,60})\]\]/g;

// The model may write only [[REF:xyz]] where a listing belongs. The server swaps each marker for the listing's details from
// the company's record, and refuses a draft that names a reference it was not given, or that states a price, a figure or a
// web address of its own.
export function composeDraft(text, allowed) {
  const refs = new Map(allowed.map((a) => [a.reference, a]));
  let bad = null;
  const body = String(text ?? "").trim();
  const used = new Set();
  body.replace(MARKER, (_, ref) => {
    if (!refs.has(ref.trim())) bad = `It mentioned a listing (${ref.trim()}) that is not one of the approved ones.`;
    else used.add(ref.trim());
    return "";
  });
  const bare = body.replace(MARKER, " ");
  if (!bad && /https?:\/\/|www\./i.test(bare)) bad = "It included a web address of its own.";
  if (!bad && (bare.match(/\d[\d,.\s]*\d|\d/g) || []).some((n) => n.replace(/\D/g, "").length >= 4)) bad = "It stated a price or figure of its own.";
  if (!bad && !used.size) bad = "It didn't offer any of the approved listings.";
  if (bad) return { ok: false, reason: bad };
  const filled = body.replace(MARKER, (_, ref) => {
    const a = refs.get(ref.trim());
    return `${a.reference} (${a.summary})${a.listingUrl ? `\n${a.listingUrl}\n` : ""}`;
  });
  return { ok: true, text: filled.replace(/\n{3,}/g, "\n\n").trim(), references: [...used] };
}

const DRAFT_TASK = (tone, missing) => `Write one short WhatsApp reply to the customer's latest message, as the property consultant.
- Offer the listings in <approved_listings> that suit what the customer wants. Where a listing belongs in your reply write its marker exactly as given, for example [[REF:ABC-1]]. The marker is replaced with the listing's details, so do not describe the listing, and do not write any price, size, address, date or web address yourself.
- Do not promise availability or a viewing time. Suggest arranging a viewing and ask which time suits them.
${missing.length ? `- We still need to know: ${missing.join(", ")}. Ask for the most useful one, in a friendly way.` : ""}
- Tone: ${tone}. Reply in the language the customer used.`;

export async function draftReply(req, leadId, { tone = "friendly" } = {}) {
  const lead = await findLead(req, leadId);
  if (!lead.conversation_id) throw fail(422, "This lead has no chat to reply in.");
  await assertConversationAccess(req, lead.conversation_id);
  const result = await matchesForLead(req, leadId, { limit: 20 });
  if (!result.eligible) throw fail(422, result.reason);
  const fresh = result.matches.filter((m) => m.verification === "fresh").slice(0, 3);
  if (!fresh.length) {
    const hasAny = result.matches.length > 0;
    throw failWith(422, hasAny
      ? `${result.matches.length} listing${result.matches.length === 1 ? " fits" : "s fit"}, but none was confirmed available in the last ${result.freshnessDays} days. Confirm availability on the property first, then draft again.`
      : "No available listing fits what this customer asked for yet.", { matches: result.matches.length });
  }
  const allowed = fresh.map((m) => ({
    reference: m.property.reference,
    listingUrl: m.property.listingUrl,
    summary: `${m.property.bedrooms === 0 ? "Studio" : m.property.bedrooms === null ? "" : `${m.property.bedrooms} bed `}${m.property.propertyType}${m.property.community ? `, ${m.property.community}` : ""}, ${money(m.property.price, m.property.currency)}${m.property.purpose === "rent" && m.property.rentPeriod ? ` a ${m.property.rentPeriod}` : ""}`.trim(),
  }));
  const profile = profileView((await query("SELECT * FROM re_lead_profiles WHERE lead_id=$1 AND tenant_id=$2", [lead.id, req.tenantId])).rows[0]);
  const data = `<approved_listings>\n${allowed.map((a) => `[[REF:${a.reference}]] ${a.summary}`).join("\n")}\n</approved_listings>`;
  const answer = await askAboutConversation({ tenant: req.tenant, conversationId: lead.conversation_id, data, task: DRAFT_TASK(["friendly", "professional", "brief"].includes(tone) ? tone : "friendly", missingForQualified(profile || BLANK_PROFILE)), maxTokens: 2048 });
  const composed = composeDraft(answer.text, allowed);
  if (!composed.ok)
    throw failWith(502, `Riwo's draft was set aside: ${composed.reason} Share the listings by hand instead.`, { fallback: fresh.map((m) => listingLine(m.property)).join("\n\n"), model: answer.model });
  return { status: "draft", text: composed.text, references: composed.references, model: answer.model, note: "A draft for you to read and edit. Nothing has been sent." };
}

