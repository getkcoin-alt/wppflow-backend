import { fail } from "../middleware/http.js";
import { unknownVariables, VARIABLES } from "./templating.js";
import { cleanHomeCodes } from "./countries.js";

// What a rule is made of. A rule starts on a TRIGGER and does one ACTION; it can also send a confirmation reply.
export const TRIGGERS = ["keyword", "first_message", "after_hours", "foreign_number"];
export const ACTIONS = ["reply_text", "assign_agent", "add_tag", "opt_in", "opt_out", "create_lead", "ai_chat"];

// "Let Riwo chat": a fixed welcome, then short answers from text the company wrote, until a person replies. These are the
// limits the rule is saved within, and the words used when the company has not written its own.
export const AUTO_CHAT = {
  defaultReplies: 5,
  maxReplies: 10,
  knowledgeMin: 20,
  knowledgeMax: 3000,
  maxOptions: 6,
  maxOptionLength: 30,
  handoff: "Thanks! I've passed this to our team and someone will get back to you soon.",
  triggers: ["first_message", "foreign_number"],
};
export const DEFAULT_SOURCES = ["AI", "Website", "Social media", "Word of mouth"];
export const MATCHES = ["contains", "word", "exact"];

// ── Keywords ─────────────────────────────────────────────────────────────────────────────────────
export const keywordsOf = (condition) =>
  String(condition || "")
    .split(/[\n,;،]+/)
    .map((k) => k.trim())
    .filter(Boolean);

// Case, accents' width, punctuation and extra spaces don't matter: "Price?" matches "price".
const plain = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export function matchesKeywords(condition, text, match = "contains") {
  const raw = String(text ?? "").toLowerCase();
  const said = plain(text);
  if (!said && !raw) return false;
  return keywordsOf(condition).some((keyword) => {
    const k = plain(keyword);
    if (match === "exact") return !!k && said === k;
    if (match === "word") return !!k && ` ${said} `.includes(` ${k} `);
    // "contains" is the original behaviour, so a rule saved before this existed matches exactly as it did.
    return raw.includes(keyword.toLowerCase()) || (!!k && said.includes(k));
  });
}

// ── Business hours ───────────────────────────────────────────────────────────────────────────────
const DAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

// Is this moment (seconds since 1970) inside the company's opening hours, in the hours' own time zone?
export function withinHours(hours, epochSeconds) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: hours.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const day = DAYS[get("weekday")];
  const now = Number(get("hour")) * 60 + Number(get("minute"));
  return hours.days.includes(day) && now >= minutes(hours.start) && now < minutes(hours.end);
}

function cleanHours(value) {
  const h = value || {};
  const timezone = String(h.timezone || "").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw fail(400, "Choose a time zone for your opening hours");
  }
  const days = [...new Set((Array.isArray(h.days) ? h.days : []).map(Number))].sort();
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
    throw fail(400, "Choose the days you are open");
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(String(h.start)) || !time.test(String(h.end)))
    throw fail(400, "Opening and closing times must look like 09:00");
  if (minutes(h.start) >= minutes(h.end)) throw fail(400, "Closing time must be after opening time");
  return { timezone, days, start: h.start, end: h.end };
}

// ── Checking a rule before it is saved ───────────────────────────────────────────────────────────
const words = (value, label, max) => {
  const s = String(value ?? "").trim();
  if (!s) throw fail(400, `${label} is required`);
  if (s.length > max) throw fail(400, `${label} is too long`);
  return s;
};
function checkText(value, label, max) {
  const s = words(value, label, max);
  const bad = unknownVariables(s);
  if (bad.length)
    throw fail(400, `${label}: ${bad.join(", ")} isn't a field. Use ${VARIABLES.map((v) => `{{${v}}}`).join(", ")}.`);
  return s;
}

// Turns what the browser sent into what is stored, or says exactly what is wrong. `teammate` answers
// whether a name belongs to an active teammate.
export async function cleanRule(body, { teammate }) {
  const triggerType = body.triggerType || "keyword";
  if (!TRIGGERS.includes(triggerType)) throw fail(400, "Choose when the rule starts");
  const actionType = body.actionType;
  if (!ACTIONS.includes(actionType)) throw fail(400, "Choose what the rule does");
  const input = body.config || {};
  const config = {};

  let triggerCondition = "";
  if (triggerType === "keyword") {
    const list = keywordsOf(body.triggerCondition);
    if (!list.length) throw fail(400, "Add at least one word or phrase to look for");
    if (list.length > 30 || list.some((k) => k.length > 100)) throw fail(400, "Use up to 30 keywords, each under 100 characters");
    triggerCondition = list.join(", ");
    config.match = MATCHES.includes(input.match) ? input.match : "contains";
  }
  if (triggerType === "after_hours") config.hours = cleanHours(input.hours);
  if (triggerType === "foreign_number") {
    const home = cleanHomeCodes(input.homeCodes);
    if (home.error) throw fail(400, home.error);
    config.homeCodes = home.codes;
    // by default only a first message counts: a customer who has been chatting for months is not greeted as a stranger
    config.onlyNew = input.onlyNew !== false;
  }

  let actionSummary;
  if (actionType === "reply_text") actionSummary = checkText(body.actionSummary, "The reply", 4000);
  else if (actionType === "assign_agent") {
    actionSummary = words(body.actionSummary, "Teammate", 255);
    if (!(await teammate(actionSummary))) throw fail(400, `${actionSummary} isn't an active teammate of this company`);
  } else if (actionType === "add_tag") {
    actionSummary = words(body.actionSummary, "Tag", 50);
    if (/[,;]/.test(actionSummary)) throw fail(400, "A tag can't contain commas");
  } else actionSummary = "";

  if (actionType === "ai_chat") {
    if (!AUTO_CHAT.triggers.includes(triggerType))
      throw fail(400, "Riwo can chat when someone writes for the first time, or when a number from another country writes");
    config.reply = checkText(input.reply, "The welcome message", 1000);
    const knowledge = words(input.knowledge, "What Riwo may talk about", AUTO_CHAT.knowledgeMax);
    if (knowledge.length < AUTO_CHAT.knowledgeMin)
      throw fail(400, "Write a few sentences about your business for Riwo to answer from. It will not answer anything that is not in them.");
    config.knowledge = knowledge;
    config.handoff = String(input.handoff ?? "").trim() ? checkText(input.handoff, "The hand-over message", 500) : AUTO_CHAT.handoff;
    const replies = input.maxReplies === undefined || input.maxReplies === "" ? AUTO_CHAT.defaultReplies : Number(input.maxReplies);
    if (!Number.isInteger(replies) || replies < 1 || replies > AUTO_CHAT.maxReplies)
      throw fail(400, `Riwo can reply 1 to ${AUTO_CHAT.maxReplies} times in a chat`);
    config.maxReplies = replies;
    const options = [];
    for (const raw of Array.isArray(input.sourceOptions) ? input.sourceOptions : []) {
      const option = String(raw ?? "").trim();
      if (!option) continue;
      if (option.length > AUTO_CHAT.maxOptionLength || /[\n,;]/.test(option))
        throw fail(400, `Each answer to “where did you find us” must be under ${AUTO_CHAT.maxOptionLength} characters, with no commas`);
      if (!options.some((o) => o.toLowerCase() === option.toLowerCase())) options.push(option);
    }
    if (options.length > AUTO_CHAT.maxOptions) throw fail(400, `Use up to ${AUTO_CHAT.maxOptions} answers to “where did you find us”`);
    config.sourceOptions = options;
  }

  // A confirmation sent in addition to the action ("You're unsubscribed", "A manager will call you").
  if (actionType !== "reply_text" && actionType !== "ai_chat" && String(input.reply ?? "").trim())
    config.reply = checkText(input.reply, "The confirmation", 4000);
  if (actionType === "ai_chat") {
    // the chat itself says when it starts and ends, so there is nothing to wait for
  } else if (input.cooldownHours !== undefined && input.cooldownHours !== null && input.cooldownHours !== "") {
    const hours = Number(input.cooldownHours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 168) throw fail(400, "Wait between repeats must be 0 to 168 hours");
    config.cooldownHours = hours;
  } else if (triggerType === "after_hours") config.cooldownHours = 12; // once per evening, not once per message
  else if (triggerType === "foreign_number" && !config.onlyNew) config.cooldownHours = 24; // not a greeting for every message

  return {
    name: words(body.name, "Rule name", 255),
    triggerType,
    triggerCondition,
    actionType,
    actionSummary,
    config,
    templateId: body.templateId ? String(body.templateId).slice(0, 64) : null,
  };
}

// Does this rule send something to the customer?
export const sendsReply = (rule) => rule.action_type === "reply_text" || rule.action_type === "ai_chat" || Boolean(rule.config?.reply);
