import { fail } from "../../middleware/http.js";
import { NODE_TYPES, WORKFLOW, edgesOf, mapEdges, outlineOf, slug, summaryOf } from "./schema.js";

// Changing a workflow that already exists, a small edit at a time. Riwo (or a person filling in a form) says "put this step in
// front of that one", "change these words", "take that step out", "send this answer there"; this file does it to a copy of the
// flow and hands the result to the same checker as everything else. The model never has to write the whole flow again, so it
// cannot lose a step, reconnect an arrow wrongly or run out of room halfway, and what it did not mention stays exactly as it was.

const clone = (v) => structuredClone(v);
// steps that go on to exactly one other step
const ONE_WAY = new Set(["say", "collect", "meeting", "label", "notify", "assign", "lead", "task"]);
const ENDS = new Set(["agent", "handoff", "end"]);
// what a change may set on each kind of step (the arrows have their own change, "link")
const FIELDS = {
  say: ["text"],
  collect: ["question", "saveAs"],
  meeting: ["question", "confirm", "taskTitle", "notifyText"],
  ask: ["question", "saveAs", "options", "next", "onUnsure", "retry", "showOptions"],
  branch: ["label", "var", "hours"],
  agent: ["goal", "playbook", "closeWith", "pricing", "maxReplies"],
  label: ["add"],
  notify: ["who", "channels", "title", "text"],
  assign: ["teammate"],
  lead: ["stageName"],
  task: ["title", "dueHours"],
  handoff: ["reason"],
  end: [],
};
const TRIGGERS = ["first_message", "returning", "foreign_number", "keyword", "after_hours"];
// what a model tends to call the same things
const OPS = { insert: "insert", add: "insert", insert_before: "insert", insert_after: "insert", append: "insert", change: "change", update: "change", edit: "change", modify: "change", set: "change", remove: "remove", delete: "remove", link: "link", connect: "link", rewire: "link", trigger: "trigger", rename: "rename" };

const listing = (nodes) =>
  Object.entries(nodes)
    .filter(([id]) => !/^(end_auto|handoff_unclear)\d*$/.test(id))
    .slice(0, 16)
    .map(([id, n]) => `${id} (${summaryOf(n).replace(/\s+/g, " ").slice(0, 40)})`)
    .join("; ");

function need(nodes, id, what = "step") {
  const key = String(id ?? "").toLowerCase();
  if (!key || !nodes[key]) throw fail(400, `There is no ${what} "${id ?? ""}". The steps are: ${listing(nodes)}.`);
  return key;
}
const freshId = (nodes, wanted) => {
  const w = String(wanted ?? "").toLowerCase();
  if (/^[a-z][a-z0-9_]{0,23}$/.test(w) && !nodes[w]) return w;
  for (let i = 1; ; i++) if (!nodes[`n${i}`]) return `n${i}`;
};
// every arrow that pointed at `from` now points at `to`
function redirect(state, from, to) {
  const { nodes } = state.workflow;
  for (const [id, n] of Object.entries(nodes)) nodes[id] = mapEdges(n, (v) => (v === from ? to : v));
  if (state.workflow.start === from) state.workflow.start = to;
}

function insert(state, op) {
  const { nodes } = state.workflow;
  const raw = op.step && typeof op.step === "object" ? op.step : null;
  if (!raw) throw fail(400, "A new step needs its details (its kind and its words)");
  const type = String(raw.type ?? "");
  if (!NODE_TYPES.includes(type)) throw fail(400, `"${type}" isn't a kind of step. Use one of: ${NODE_TYPES.join(", ")}`);
  if (ENDS.has(type)) throw fail(400, `A step that ends the chat (${type}) can't be put in the middle of the flow. Change where an answer goes instead.`);
  if (Object.keys(nodes).length >= WORKFLOW.maxNodes) throw fail(400, `A workflow can have up to ${WORKFLOW.maxNodes} steps`);
  const id = freshId(nodes, op.id ?? raw.id);
  const step = { ...raw };
  delete step.id;
  if (op.before !== undefined && op.before !== null && op.before !== "") {
    const target = need(nodes, op.before);
    redirect(state, target, id);
    withEdges(step, target);
  } else if (op.after !== undefined && op.after !== null && op.after !== "") {
    const from = need(nodes, op.after);
    if (!ONE_WAY.has(nodes[from].type)) throw fail(400, `Step "${from}" sends the chat different ways (or ends it), so say which step the new one goes before, not after`);
    withEdges(step, nodes[from].next);
    nodes[from] = { ...nodes[from], next: id };
  } else {
    throw fail(400, 'Say where the new step goes: "before" or "after" one of the steps');
  }
  nodes[id] = step;
}
// where a new step goes on to: the step it was put in front of (or null, which ends the chat there)
function withEdges(step, to) {
  const next = to ?? null;
  if (step.type === "branch") {
    for (const k of step.on === "var" ? ["otherwise"] : ["yes", "no"]) if (step[k] === undefined) step[k] = next;
  } else step.next = next;
}

function change(state, op) {
  const { nodes } = state.workflow;
  const id = need(nodes, op.id);
  const node = nodes[id];
  const set = op.set && typeof op.set === "object" && !Array.isArray(op.set) ? op.set : null;
  if (!set || !Object.keys(set).length) throw fail(400, `Say what to change in step "${id}"`);
  const allowed = FIELDS[node.type] || [];
  const next = { ...node };
  for (const [k, v] of Object.entries(set)) {
    if (k === "type") throw fail(400, `Step "${id}" can't turn into another kind of step. Put a new one in and take this one out.`);
    if (!allowed.includes(k)) throw fail(400, `Step "${id}" is a "${node.type}" step; what can be changed on it is: ${allowed.join(", ") || "nothing"}`);
    next[k] = v;
  }
  if (node.type === "ask" && set.options && !set.next) {
    // new answers go where the old ones went; an answer that is kept keeps its own way
    const first = Object.values(node.next).find(Boolean) ?? null;
    next.next = Object.fromEntries(
      (Array.isArray(set.options) ? set.options : []).map((o, i) => {
        const key = /^[a-z][a-z0-9_]{0,23}$/.test(String(o?.key ?? "")) ? String(o.key) : slug(o?.label ?? o, `option_${i + 1}`);
        return [key, node.next[key] ?? first];
      }),
    );
  }
  nodes[id] = next;
}

function remove(state, op) {
  const { nodes } = state.workflow;
  const id = need(nodes, op.id);
  const node = nodes[id];
  if (node.type === "ask" || node.type === "branch") throw fail(400, `Step "${id}" sends the chat different ways, so it can't simply be taken out. Change its question, or change where the steps before it go.`);
  if (node.type === "agent" || node.type === "handoff") throw fail(400, `Step "${id}" hands the chat to a person, so it can't simply be taken out. Change it instead.`);
  const to = node.type === "end" ? null : node.next ?? null;
  if (state.workflow.start === id && !to) throw fail(400, "That is the only step, so it can't be taken out");
  redirect(state, id, to);
  delete nodes[id];
}

function link(state, op) {
  const { nodes } = state.workflow;
  const from = need(nodes, op.from, "step to start from");
  const to = op.to === null || op.to === "" || op.to === "end" ? null : need(nodes, op.to, "step to go to");
  const node = nodes[from];
  const via = String(op.via ?? "next");
  const ways = (() => {
    switch (node.type) {
      case "ask":
        return [...node.options.map((o) => o.key), "unsure"];
      case "branch":
        return node.on === "var" ? [...Object.keys(node.cases), "otherwise"] : ["yes", "no"];
      default:
        return ENDS.has(node.type) ? [] : ["next"];
    }
  })();
  if (!ways.includes(via)) throw fail(400, ways.length ? `Step "${from}" can go on in these ways: ${ways.join(", ")}. "${via}" isn't one of them.` : `Step "${from}" ends the chat, so nothing can follow it`);
  const n = { ...node };
  if (node.type === "ask") {
    if (via === "unsure") n.onUnsure = to;
    else n.next = { ...node.next, [via]: to };
  } else if (node.type === "branch") {
    if (node.on === "var") {
      if (via === "otherwise") n.otherwise = to;
      else n.cases = { ...node.cases, [via]: to };
    } else n[via] = to;
  } else n.next = to;
  nodes[from] = n;
}

function retrigger(state, op) {
  const t = op.trigger && typeof op.trigger === "object" ? op.trigger : null;
  if (!t || !TRIGGERS.includes(t.type)) throw fail(400, `Say when it starts: one of ${TRIGGERS.join(", ")}`);
  state.trigger = {
    type: t.type,
    silent_days: t.silent_days ?? t.silentDays,
    include_new: t.include_new ?? t.includeNew,
    keywords: Array.isArray(t.keywords) ? t.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 30) : t.type === "keyword" ? state.trigger?.keywords : undefined,
    hours: t.hours && typeof t.hours === "object" ? t.hours : t.type === "after_hours" ? state.trigger?.hours : undefined,
  };
}

/**
 * The flow with the edits applied: { name, trigger, workflow }. `current` is the same, as it is stored. Throws one plain sentence about
 * the first edit that cannot be made (so it can be handed back to the model), and changes nothing it was given.
 */
export function applyEdits(current, edits) {
  const ops = Array.isArray(edits) ? edits : [];
  if (!ops.length) throw fail(400, "There is nothing to change");
  if (ops.length > 12) throw fail(400, "That is a lot of changes at once. Make them a few at a time.");
  const state = { name: current.name, trigger: clone(current.trigger || { type: "first_message" }), workflow: clone(current.workflow) };
  for (const raw of ops) {
    const kind = OPS[String(raw?.op ?? raw?.action ?? "").toLowerCase()];
    if (!kind) throw fail(400, `"${raw?.op ?? raw?.action ?? ""}" isn't a change Riwo can make. Use insert, change, remove, link, trigger or rename.`);
    const op = { ...raw };
    // "insert_after" and "append" say where in their name; the step they name is then in "id" or "at"
    const said = String(raw.op ?? raw.action).toLowerCase();
    if (kind === "insert" && /after|append/.test(said) && op.after === undefined && op.before === undefined) {
      op.after = op.at ?? op.id;
      delete op.id;
    } else if (kind === "insert" && /before/.test(said) && op.before === undefined && op.after === undefined) {
      op.before = op.at;
    }
    if (kind === "insert") insert(state, op);
    else if (kind === "change") change(state, op);
    else if (kind === "remove") remove(state, op);
    else if (kind === "link") link(state, op);
    else if (kind === "trigger") retrigger(state, op);
    else if (kind === "rename") {
      const name = String(op.name ?? "").replace(/<\/?[a-z_]+>/gi, "").trim().slice(0, 60);
      if (name) state.name = name;
    }
  }
  return state;
}

// ── "Add a question" without a model ─────────────────────────────────────────────────────────────
const STOP = new Set("a an the and or of to in on at for from with about do does did is are was were be you your yours we our us me my they their them it its this that these those what which where when who whom how why can could would should will please tell let know also ask any some more".split(" "));
const RESERVED = new Set(["name", "first_name", "company", "last_message", "answer", "meeting", "executive"]);
// a short name for what the answer is kept as: "Which city are you in?" -> city
export function answerName(question, workflow) {
  const taken = new Set(Object.values(workflow.nodes).filter((n) => n.saveAs).map((n) => n.saveAs));
  const words = String(question || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  let base = (words.slice(0, 2).join("_") || "detail").slice(0, 20).replace(/_+$/, "");
  if (!/^[a-z]/.test(base) || RESERVED.has(base)) base = `answer_${base}`.replace(/^answer_answer/, "answer").slice(0, 20);
  let name = base;
  for (let i = 2; taken.has(name) || RESERVED.has(name); i++) name = `${base}_${i}`;
  return name;
}

// Where a new question goes by default: right after the last question already in the flow, before what follows it. Without any
// question: before the first step that tells the team or hands over.
function defaultSpot(workflow) {
  const order = outlineOf(workflow).map((o) => o.id);
  const nodes = workflow.nodes;
  const questions = order.filter((id) => nodes[id].type === "ask" || nodes[id].type === "collect");
  const last = questions.at(-1);
  if (last) {
    const n = nodes[last];
    const targets = n.type === "collect" ? [n.next] : Object.values(n.next).filter(Boolean);
    const same = targets.length && targets.every((t) => t === targets[0]) ? targets[0] : null;
    if (same && nodes[same]) return same;
  }
  const closing = order.find((id) => ["notify", "task", "lead", "assign", "meeting", "handoff", "agent", "end"].includes(nodes[id].type));
  return closing || workflow.start;
}

const label = (name) => name.replace(/_\d+$/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const withField = (text, name) => {
  const base = String(text).replace(/\s+$/, "");
  return `${base}${/[.!?]$/.test(base) ? " " : ". "}${label(name)}: {{${name}}}.`;
};

/**
 * The edits for "add this question": a step that asks it and keeps the answer, put where asked (or after the last question), and,
 * if wanted, the answer added to the notes that tell the team, so the answer is where somebody will read it.
 */
export function questionEdits(current, { question, before, tell = true } = {}) {
  const q = String(question ?? "").replace(/\s+/g, " ").trim();
  if (q.length < 3) throw fail(400, "Write the question to ask");
  if (q.length > WORKFLOW.maxQuestion) throw fail(400, `A question can be up to ${WORKFLOW.maxQuestion} characters`);
  const workflow = current.workflow;
  const spot = before ? need(workflow.nodes, before, "step to put it before") : defaultSpot(workflow);
  const name = answerName(q, workflow);
  const ops = [{ op: "insert", before: spot, step: { type: "collect", question: q, saveAs: name } }];
  if (tell)
    for (const [id, n] of Object.entries(workflow.nodes)) {
      if (n.type !== "notify") continue;
      const text = withField(n.text, name);
      if (text.length <= 300) ops.push({ op: "change", id, set: { text } });
    }
  return ops;
}
