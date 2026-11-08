import { fail } from "../../middleware/http.js";
import { VARIABLES } from "../templating.js";
import { WORKFLOW_MESSAGES_PER_HOUR } from "../personGuard.js";

// A workflow is data: a handful of whitelisted steps joined by arrows. Nothing in it is code and nothing a customer writes can
// change it. This file says what a workflow may contain, checks one before it is saved, and completes it: a step that leads
// nowhere ends the chat, an answer nobody planned for goes to a person, a flow that goes in a circle is refused.
//
//   say      send fixed words                          ask      ask a question with a few answers, understand the reply, branch
//   collect  ask one open question, keep the answer    meeting  ask when suits, tell the team, confirm to the customer
//   branch   go one way or another (a label, an answer, opening hours)
//   agent    Riwo talks from the knowledge base toward a goal (then a person takes over)
//   label    put a label on the contact                notify   tell the owners or the chat's owner (app and e-mail)
//   assign   give the chat to a teammate               lead     make a lead in the pipeline          task  a follow-up for the team
//   handoff  the formal message, then a person         end      finish

export const WORKFLOW = {
  maxNodes: 20,
  maxText: 1000,
  maxQuestion: 300,
  maxOptions: 6,
  minOptions: 2,
  maxHints: 8,
  maxLabel: 50,
  silentDays: { min: 1, max: 365, default: 30 },
  closes: ["handoff", "collect_details", "book_demo", "send_link"],
  reasons: ["qualified", "unclear", "pricing"],
};
export const NODE_TYPES = ["say", "ask", "collect", "meeting", "branch", "agent", "label", "notify", "assign", "lead", "task", "handoff", "end"];
// types after which the run is over: nothing follows them
const TERMINAL = new Set(["agent", "handoff", "end"]);
// what a person has been told or given once one of these has run
export const TELLS = new Set(["notify", "handoff", "agent", "task", "lead", "assign", "meeting"]);
// fields available inside the words of any step, besides the ones a question saves
export const RUNTIME_VARS = ["last_message", "answer", "meeting"];
export const AUTO_END = "end_auto";
export const AUTO_UNCLEAR = "handoff_unclear";

const ID = /^[a-z][a-z0-9_]{0,23}$/;
const KEY = ID;

function text(value, label, max, { required = false } = {}) {
  const t = String(value ?? "").replace(/\r/g, "").trim();
  if (!t) {
    if (required) throw fail(400, `${label} is required`);
    return "";
  }
  if (t.length > max) throw fail(400, `${label} can be up to ${max} characters`);
  if (/<\/?[a-z_]+>/i.test(t)) throw fail(400, `${label} can't contain tags`);
  return t;
}

export const slug = (v, fallback) => {
  const s = String(v ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
  return ID.test(s) ? s : fallback;
};

// {{fields}} in a step's words: the usual ones, the few that exist while it runs, and any a question of this flow saves
function checkFields(value, label, allowed) {
  for (const [, key] of String(value).matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const k = key.toLowerCase();
    if (!allowed.has(k) && k !== "executive") throw fail(400, `${label}: {{${key}}} isn't a field. Use ${[...allowed].map((v) => `{{${v}}}`).join(", ")}.`);
  }
}

// ── one step ─────────────────────────────────────────────────────────────────────────────────────
// Returns the cleaned step. `edges` lists where it can go, so the flow can be checked as a whole.
function cleanNode(id, raw, { allowed, cleanHours }) {
  const type = String(raw?.type ?? "");
  if (!NODE_TYPES.includes(type)) throw fail(400, `Step "${id}" has a type Riwo doesn't know (${type || "none"})`);
  const where = `Step "${id}"`;
  const words = (v, max, what = "The words", opts = {}) => {
    const t = text(v, `${where}: ${what}`, max, opts);
    if (t) checkFields(t, `${where}: ${what}`, allowed);
    return t;
  };
  const edge = (v) => (v === undefined || v === null || v === "" ? null : String(v));
  const next = () => edge(raw.next);
  const node = { type };
  switch (type) {
    case "say":
      node.text = words(raw.text, WORKFLOW.maxText, "The message", { required: true });
      node.next = next();
      break;
    case "collect":
      node.question = words(raw.question, WORKFLOW.maxQuestion, "The question", { required: true });
      node.saveAs = slug(raw.saveAs, `answer_${id}`);
      node.next = next();
      break;
    case "meeting":
      node.question = words(raw.question, WORKFLOW.maxQuestion, "The question") || "What day and time would suit you for a call?";
      node.confirm = words(raw.confirm, WORKFLOW.maxQuestion, "The confirmation") || "Thank you. I've passed your preferred time ({{meeting}}) to our team and they will confirm it with you shortly.";
      node.taskTitle = words(raw.taskTitle, 120, "The follow-up") || "Confirm the meeting with {{name}}: {{meeting}}";
      node.notifyText = words(raw.notifyText, 300, "The note to the team") || "{{name}} would like a meeting: {{meeting}}";
      node.next = next();
      break;
    case "ask": {
      node.question = words(raw.question, WORKFLOW.maxQuestion, "The question", { required: true });
      const options = [];
      for (const o of Array.isArray(raw.options) ? raw.options : []) {
        const label = text(o?.label ?? o, `${where}: An answer`, 40, { required: true });
        const key = KEY.test(String(o?.key ?? "")) ? String(o.key) : slug(label, `option_${options.length + 1}`);
        if (options.some((x) => x.key === key)) throw fail(400, `${where}: two answers share the name "${key}"`);
        const hints = [...new Set((Array.isArray(o?.hints) ? o.hints : []).map((h) => String(h ?? "").toLowerCase().replace(/<\/?[a-z_]+>/gi, "").trim()).filter((h) => h.length >= 2 && h.length <= 30))].slice(0, WORKFLOW.maxHints);
        options.push({ key, label, hints });
      }
      if (options.length < WORKFLOW.minOptions || options.length > WORKFLOW.maxOptions) throw fail(400, `${where}: give ${WORKFLOW.minOptions} to ${WORKFLOW.maxOptions} answers to choose from`);
      node.options = options;
      node.saveAs = slug(raw.saveAs, `choice_${id}`);
      node.showOptions = raw.showOptions !== false;
      node.retry = words(raw.retry, WORKFLOW.maxQuestion, "The second try");
      // `next` is an answer -> step map; a single step name means every answer goes on to that step
      const same = typeof raw.next === "string" && raw.next ? raw.next : null;
      const map = raw.next && typeof raw.next === "object" ? raw.next : {};
      node.next = Object.fromEntries(options.map((o) => [o.key, map[o.key] ? String(map[o.key]) : same]));
      node.onUnsure = raw.onUnsure ? String(raw.onUnsure) : null;
      break;
    }
    case "branch": {
      const on = ["label", "var", "hours"].includes(raw.on) ? raw.on : "";
      if (!on) throw fail(400, `${where}: choose what to look at (a label, an answer or the opening hours)`);
      node.on = on;
      if (on === "label") {
        node.label = text(raw.label, `${where}: The label`, WORKFLOW.maxLabel, { required: true });
        if (/[,;]/.test(node.label)) throw fail(400, `${where}: a label can't contain commas`);
        node.yes = edge(raw.yes ?? raw.then);
        node.no = edge(raw.no ?? raw.else);
      } else if (on === "hours") {
        node.hours = cleanHours(raw.hours);
        node.yes = edge(raw.yes ?? raw.then);
        node.no = edge(raw.no ?? raw.else);
      } else {
        node.var = slug(raw.var, "");
        if (!node.var) throw fail(400, `${where}: choose which answer to look at`);
        const cases = raw.cases && typeof raw.cases === "object" ? raw.cases : {};
        node.cases = Object.fromEntries(Object.entries(cases).slice(0, 12).map(([k, v]) => [String(k).slice(0, 40), edge(v)]));
        node.otherwise = edge(raw.otherwise ?? raw.else);
      }
      break;
    }
    case "agent": {
      node.goal = text(raw.goal, `${where}: The goal`, 300);
      node.playbook = text(raw.playbook, `${where}: How Riwo should talk`, 2000);
      if (!node.goal && !node.playbook) throw fail(400, `${where}: tell Riwo what it should achieve in the chat`);
      node.closeWith = WORKFLOW.closes.includes(raw.closeWith) ? raw.closeWith : "handoff";
      node.pricing = raw.pricing === "knowledge" ? "knowledge" : "handoff";
      const replies = raw.maxReplies === undefined || raw.maxReplies === "" ? 12 : Number(raw.maxReplies);
      if (!Number.isInteger(replies) || replies < 1 || replies > 20) throw fail(400, `${where}: Riwo can reply 1 to 20 times`);
      node.maxReplies = replies;
      break;
    }
    case "label":
      node.add = text(raw.add, `${where}: The label`, WORKFLOW.maxLabel, { required: true });
      if (/[,;]/.test(node.add)) throw fail(400, `${where}: a label can't contain commas`);
      node.next = next();
      break;
    case "notify": {
      node.who = raw.who === "assignee" ? "assignee" : "owners";
      const channels = [...new Set((Array.isArray(raw.channels) ? raw.channels : ["app", "email"]).filter((c) => c === "app" || c === "email"))];
      node.channels = channels.length ? channels : ["app"];
      node.title = words(raw.title, 80, "The title") || "{{name}} wrote to you";
      node.text = words(raw.text, 300, "The note", { required: true });
      node.next = next();
      break;
    }
    case "assign":
      node.teammate = text(raw.teammate, `${where}: The teammate`, 255, { required: true }); // checked as a whole in cleanWorkflow
      node.next = next();
      break;
    case "lead":
      node.stageName = text(raw.stageName, `${where}: The pipeline step`, 40);
      node.next = next();
      break;
    case "task": {
      node.title = words(raw.title, 120, "The follow-up", { required: true });
      const hours = raw.dueHours === undefined || raw.dueHours === "" ? 2 : Number(raw.dueHours);
      if (!Number.isInteger(hours) || hours < 0 || hours > 168) throw fail(400, `${where}: the follow-up is due in 0 to 168 hours`);
      node.dueHours = hours;
      node.next = next();
      break;
    }
    case "handoff":
      node.reason = WORKFLOW.reasons.includes(raw.reason) ? raw.reason : "qualified";
      break;
    case "end":
      break;
    default:
      break;
  }
  return node;
}
// where a step can go
export function edgesOf(node) {
  switch (node.type) {
    case "ask":
      return [...Object.values(node.next), node.onUnsure];
    case "branch":
      return node.on === "var" ? [...Object.values(node.cases), node.otherwise] : [node.yes, node.no];
    default:
      return TERMINAL.has(node.type) ? [] : [node.next];
  }
}
// the same step with every place it can go passed through `f` (used to fill gaps and to rename)
export function mapEdges(node, f) {
  const n = { ...node };
  switch (node.type) {
    case "ask":
      n.next = Object.fromEntries(Object.entries(node.next).map(([k, v]) => [k, f(v, k)]));
      n.onUnsure = f(node.onUnsure, "unsure");
      break;
    case "branch":
      if (node.on === "var") {
        n.cases = Object.fromEntries(Object.entries(node.cases).map(([k, v]) => [k, f(v, k)]));
        n.otherwise = f(node.otherwise, "otherwise");
      } else {
        n.yes = f(node.yes, "yes");
        n.no = f(node.no, "no");
      }
      break;
    default:
      if (!TERMINAL.has(node.type)) n.next = f(node.next, "next");
  }
  return n;
}

// ── the whole flow ───────────────────────────────────────────────────────────────────────────────
// Returns { workflow, warnings }. Throws a plain sentence about the first thing that cannot be saved. What can be repaired is
// repaired (and reported as a warning) so a draft written by a model is rarely thrown away for a small slip.
export async function cleanWorkflow(raw, { teammate = async () => true, cleanHours = (h) => h } = {}) {
  if (!raw || typeof raw !== "object") throw fail(400, "Describe what the workflow should do");
  const source = Array.isArray(raw.nodes) ? Object.fromEntries(raw.nodes.map((n, i) => [n?.id ?? `n${i + 1}`, n])) : raw.nodes;
  if (!source || typeof source !== "object") throw fail(400, "The workflow has no steps");
  const entries = Object.entries(source);
  if (!entries.length) throw fail(400, "The workflow has no steps");
  if (entries.length > WORKFLOW.maxNodes) throw fail(400, `A workflow can have up to ${WORKFLOW.maxNodes} steps`);
  const warnings = [];

  // the fields the words of a step may use: the usual ones, the runtime ones and every answer this flow saves
  const saved = new Set();
  for (const [, n] of entries) if ((n?.type === "ask" || n?.type === "collect") && n.saveAs) saved.add(slug(n.saveAs, ""));
  const allowed = new Set([...VARIABLES, ...RUNTIME_VARS, ...[...saved].filter(Boolean)]);

  const nodes = {};
  for (const [rawId, rawNode] of entries) {
    const id = String(rawId).toLowerCase();
    if (!ID.test(id)) throw fail(400, `A step has an invalid name ("${rawId}")`);
    if (nodes[id]) throw fail(400, `Two steps share the name "${id}"`);
    const node = cleanNode(id, rawNode, { allowed, cleanHours });
    // lower-case every place it can go, so "N2" and "n2" are the same step
    nodes[id] = mapEdges(node, (v) => (v ? String(v).toLowerCase() : null));
  }
  for (const [id, n] of Object.entries(nodes))
    if (n.type === "assign" && !(await teammate(n.teammate))) throw fail(400, `Step "${id}": ${n.teammate} isn't an active teammate of this company`);

  const start = String(raw.start ?? entries[0][0]).toLowerCase();
  if (!nodes[start]) throw fail(400, "The workflow has no first step");

  // every arrow must point at a step that exists; one that doesn't is repaired below
  const missing = (v) => v && !nodes[v];
  for (const [id, n] of Object.entries(nodes)) {
    for (const to of edgesOf(n)) if (missing(to)) warnings.push(`Step "${id}" pointed to a step that doesn't exist; it now ends there.`);
    nodes[id] = mapEdges(n, (v) => (missing(v) ? null : v));
  }

  // gaps: a step that leads nowhere finishes the chat; an answer nobody planned for goes to a person. The steps made for this are
  // named end_auto and handoff_unclear, and a saved flow that already has them (it was cleaned before) keeps them as they are.
  const freeId = (base, type, extra = {}) => {
    let id = base;
    for (let i = 2; nodes[id] && (nodes[id].type !== type || Object.entries(extra).some(([k, v]) => nodes[id][k] !== v)); i++) id = `${base}${i}`;
    return id;
  };
  const endId = freeId(AUTO_END, "end");
  const unclearId = freeId(AUTO_UNCLEAR, "handoff", { reason: "unclear" });
  let needEnd = false;
  let needUnclear = false;
  for (const [id, n] of Object.entries(nodes)) {
    nodes[id] = mapEdges(n, (v) => {
      if (v) return v;
      if (n.type === "ask") {
        needUnclear = true;
        return unclearId;
      }
      needEnd = true;
      return endId;
    });
  }
  if (needEnd && !nodes[endId]) nodes[endId] = { type: "end" };
  if (needUnclear && !nodes[unclearId]) nodes[unclearId] = { type: "handoff", reason: "unclear" };

  // cycles: a flow that can come back to a step it has already been through never ends
  const state = {};
  const walk = (id, trail) => {
    if (state[id] === 2) return;
    if (state[id] === 1) throw fail(400, `The workflow goes in a circle (step "${trail[trail.length - 1]}" leads back to "${id}"). Each path must end.`);
    state[id] = 1;
    for (const to of edgesOf(nodes[id])) if (to) walk(to, [...trail, id]);
    state[id] = 2;
  };
  walk(start, []);

  // unreachable steps are dropped: nothing could ever run them
  for (const id of Object.keys(nodes))
    if (!state[id]) {
      warnings.push(`Step "${id}" could never be reached, so it was left out.`);
      delete nodes[id];
    }
  return { workflow: { version: 1, start, nodes, ...(raw.quiet === true ? { quiet: true } : {}) }, warnings };
}

// ── what the owner is shown ──────────────────────────────────────────────────────────────────────
// Plain lines about the safety every workflow carries, for the "Safety Riwo added" chips.
export function guardrailsOf(workflow, config = {}) {
  const nodes = Object.values(workflow.nodes);
  const has = (t) => nodes.some((n) => n.type === t);
  const lines = ["Never answers groups, or your own numbers", "Stops the moment a teammate replies", `Says it is automated, and “human” brings a person; a runaway loop is cut off at ${WORKFLOW_MESSAGES_PER_HOUR} automatic messages an hour in one chat`];
  if (has("ask") || has("collect") || has("meeting")) lines.push("A question nobody answers within a day is let go, not repeated");
  if (has("ask")) lines.push("Understands answers in any language or by number; an unclear answer is asked once more, then a person is told");
  if (has("agent")) {
    const knowledge = nodes.some((n) => n.type === "agent" && n.pricing === "knowledge");
    lines.push(knowledge ? "Riwo only repeats prices that are written on your website, never invents a figure or a link" : "Riwo never invents a price, a link or a figure, and prices and proposals go to a person");
    lines.push("When Riwo has what it needs, a person takes over with a summary, a lead and a follow-up");
  }
  if (!nodes.some((n) => TELLS.has(n.type)) && !workflow.quiet) lines.push("You get a notification when the flow ends, so nobody is missed");
  if (config.pilot?.enabled) lines.push("Test mode: it only runs for the numbers you listed");
  return lines;
}

// The flow as an ordered outline, depth first from the first step: what the confirmation card shows and what a screen reader reads.
export function outlineOf(workflow) {
  const seen = new Set();
  const out = [];
  const visit = (id, via = "") => {
    const n = workflow.nodes[id];
    if (!n || seen.has(id)) return;
    seen.add(id);
    out.push({ id, via, type: n.type, summary: summaryOf(n), goes: goesOf(n) });
    for (const g of goesOf(n)) visit(g.to, g.label);
  };
  visit(workflow.start);
  return out;
}
function goesOf(n) {
  const arrows = (pairs) => pairs.filter(([, to]) => to).map(([label, to]) => ({ label, to }));
  switch (n.type) {
    case "ask":
      return arrows([...n.options.map((o) => [o.label, n.next[o.key]]), ["not understood", n.onUnsure]]);
    case "branch":
      return n.on === "var" ? arrows([...Object.entries(n.cases), ["otherwise", n.otherwise]]) : arrows([[n.on === "hours" ? "open" : "has the label", n.yes], ["otherwise", n.no]]);
    default:
      return TERMINAL.has(n.type) ? [] : arrows([["", n.next]]);
  }
}
export function summaryOf(n) {
  switch (n.type) {
    case "say":
      return n.text;
    case "ask":
    case "collect":
    case "meeting":
      return n.question;
    case "branch":
      return n.on === "label" ? `Does the contact have the label “${n.label}”?` : n.on === "hours" ? "Is it inside your opening hours?" : `What did they answer to “${n.var}”?`;
    case "agent":
      return n.goal || n.playbook.slice(0, 120);
    case "label":
      return `Add the label “${n.add}”`;
    case "notify":
      return `${n.who === "assignee" ? "Tell whoever has the chat" : "Tell the owners"}: ${n.text}`;
    case "assign":
      return `Give the chat to ${n.teammate}`;
    case "lead":
      return n.stageName ? `Make a lead in “${n.stageName}”` : "Make a lead in the pipeline";
    case "task":
      return `Follow-up: ${n.title}`;
    case "handoff":
      return "Send your formal message and hand the chat to a person";
    default:
      return "Finish";
  }
}
