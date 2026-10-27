import { fail } from "../../middleware/http.js";

// What the platform knows about the real-estate solution without loading any of its code: its name, what it needs from
// the universal product, and the settings a company may change. The registry reads this; the core never imports the rest.
export const isTimezone = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const whole = (label, min, max) => (value) => {
  const n = Number(value);
  if (value === "" || value === null || !Number.isInteger(n) || n < min || n > max) throw fail(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
};

// Every setting has a default, so a company that never opens the settings screen works.
export const SETTINGS = {
  timezone: { default: "Asia/Dubai", label: "Time zone", check: (v) => { if (!isTimezone(v)) throw fail(400, "Choose a valid time zone, such as Asia/Dubai"); return v.trim(); } },
  freshnessDays: { default: 14, label: "Days before a listing needs checking again", check: whole("Days before a listing needs checking again", 1, 365) },
  viewingMinutes: { default: 45, label: "Length of a viewing, in minutes", check: whole("Length of a viewing", 10, 480) },
  unassignedMinutes: { default: 15, label: "Minutes a new lead may wait for an owner", check: whole("Minutes a new lead may wait for an owner", 1, 10080) },
  overdueFollowupMinutes: { default: 60, label: "Minutes a follow-up may be overdue before it is flagged", check: whole("Minutes a follow-up may be overdue", 1, 10080) },
  missingNextActionHours: { default: 4, label: "Hours a lead may have no next action", check: whole("Hours a lead may have no next action", 1, 720) },
  stalledDays: { default: 7, label: "Days without any activity before a lead is stalled", check: whole("Days without any activity", 1, 365) },
};

export const manifest = {
  key: "real_estate",
  name: "Scriwo Real Estate",
  version: 1,
  summary: "Lead qualification, property inventory with matching, viewings and a revenue leak detector for brokerages and agents.",
  // Features of the universal product this solution is built on. A company without them cannot use the solution.
  requires: ["leads"],
  settings: SETTINGS,
};
