import { query } from "../../db/index.js";
import { findLead } from "../../services/leadService.js";
import { getProfile } from "./profile.js";
import { matchesForLead } from "./properties.js";

// What to do next with a lead, worked out from its own records by fixed rules: no model, so it is the same every time and
// always says why. At most four, most useful first.
export function suggest({ lead, profile, missing, matches, viewings, openTasks, now = Date.now() }) {
  if (lead.status !== "open") return [];
  const out = [];
  const add = (code, text, why) => out.push({ code, text, why });
  if (!profile) {
    add("qualify", "Find out what they are looking for", "No qualification has been recorded for this lead.");
  } else if (profile.qualificationStatus === "disqualified") {
    return [{ code: "closed", text: "Close this lead as lost", why: `It was marked not a fit: ${profile.disqualifiedReason}` }];
  } else if (profile.qualificationStatus !== "qualified" && missing.length) {
    add("ask", `Ask for: ${missing.join(", ")}`, "These are needed before the lead can be qualified.");
  }
  const active = viewings.filter((v) => ["scheduled", "confirmed"].includes(v.status));
  const soon = active.find((v) => v.status === "scheduled" && new Date(v.starts_at).getTime() - now < 24 * 3600000);
  if (soon) add("confirm_viewing", `Confirm the viewing of ${soon.reference} with the client`, "It is within 24 hours and hasn't been confirmed.");
  if (matches?.eligible) {
    if (matches.total > 0 && !viewings.some((v) => v.status !== "cancelled")) {
      const refs = matches.matches.slice(0, 3).map((m) => m.property.reference).join(", ");
      add("offer_viewing", `Offer a viewing: ${refs}`, `${matches.total} available listing${matches.total === 1 ? " fits" : "s fit"} what they asked for, and no viewing has been booked.`);
    } else if (matches.total === 0 && profile?.qualificationStatus === "qualified") {
      const top = Object.entries(matches.leftOut).sort((a, b) => b[1] - a[1])[0];
      add("widen", "Ask whether they would widen their search", top ? `No listing fits. Most were left out because of the ${{ budget: "budget", bedrooms: "bedrooms", type: "property type", area: "area", currency: "currency" }[top[0]]} (${top[1]}).` : "No available listing fits what they asked for.");
    }
  }
  if (viewings.some((v) => v.status === "completed") && !active.length) add("after_viewing", "Ask how the viewing went and what they want to do next", "They have seen a property and nothing else is booked.");
  if (!openTasks && !active.length) add("follow_up", "Add a follow-up so this lead doesn't go quiet", "There is no follow-up and no viewing planned.");
  return out.slice(0, 4);
}

export async function nextActions(req, leadId) {
  const lead = await findLead(req, leadId);
  const { profile, missing } = await getProfile(req, leadId);
  const matches = profile ? await matchesForLead(req, leadId, { limit: 5 }) : null;
  const viewings = (await query("SELECT v.status,v.starts_at,p.reference FROM re_viewings v JOIN re_properties p ON p.id=v.property_id WHERE v.lead_id=$1 AND v.tenant_id=$2 ORDER BY v.starts_at", [lead.id, req.tenantId])).rows;
  const openTasks = (await query("SELECT count(*)::int AS n FROM lead_tasks WHERE lead_id=$1 AND tenant_id=$2 AND done_at IS NULL", [lead.id, req.tenantId])).rows[0].n;
  return suggest({ lead, profile, missing, matches, viewings, openTasks });
}
