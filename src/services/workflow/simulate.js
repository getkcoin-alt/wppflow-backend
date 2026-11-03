import { personalise } from "../templating.js";
import { withDisclosure } from "../handoffService.js";
import { unavailableReason, usageOf, chatAsAgent } from "../aiService.js";
import { asksForCommercial, withFacts } from "../salesAssistant.js";
import { knowledgeOf, checkAnswer } from "../autoChat.js";
import { withinHours } from "../automationRules.js";
import { begin, resume, awaiting } from "./core.js";
import { classifyAnswer } from "./classify.js";

// "Try it": the owner plays the customer and sees what the workflow would do, step by step, without anything being sent to
// WhatsApp or saved. It runs the same core as the live engine (core.js), with the real reading of answers and, for a step where
// Riwo talks, the real model and the company's own knowledge base. It counts against the company's Riwo allowance like any use.
// Nothing is stored: the screen keeps the place and the conversation and sends them back with each turn.

const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function describe(action, { name, company, rule }) {
  const say = (t) => personalise(String(t), { name, company });
  switch (action.do) {
    case "say":
      return [{ kind: "say", text: action.disclose ? withDisclosure(say(action.text)) : say(action.text), node: action.node }];
    case "label":
      return [{ kind: "label", text: `The label “${action.add}” is put on the contact`, node: action.node }];
    case "notify":
      return [{ kind: "notify", text: `You are told (${action.who === "assignee" ? "whoever has the chat" : "the owners"}, ${action.channels.join(" and ")}): ${say(action.text)}`, node: action.node }];
    case "assign":
      return [{ kind: "assign", text: `The chat is given to ${action.teammate}`, node: action.node }];
    case "lead":
      return [{ kind: "lead", text: action.stageName ? `A lead is made in “${action.stageName}”` : "A lead is made in your pipeline", node: action.node }];
    case "task":
      return [{ kind: "task", text: `A follow-up for your team, due in ${action.dueHours} hour${action.dueHours === 1 ? "" : "s"}: ${say(action.title)}`, node: action.node }];
    case "handoff": {
      const formal = personalise(String(rule.config.sales?.formal || "").replace(/\{\{\s*executive\s*\}\}/gi, "your teammate"), { name, company });
      return [{ kind: "say", text: withDisclosure(formal), node: action.node }, { kind: "handoff", text: "A person takes over, with a lead, a summary and a follow-up for your team", node: action.node }];
    }
    default:
      return [{ kind: "end", text: "The flow finishes", node: action.node }];
  }
}

// Riwo's own turn in a step where it talks: the real model, the company's knowledge, and every check the live engine makes.
async function agentTurn({ tenant, rule, node, text, transcript, collected, name, company }) {
  const config = rule.config;
  if (node.pricing !== "knowledge" && asksForCommercial(text)) return { events: describe({ do: "handoff", node: "agent" }, { name, company, rule }), handoff: "pricing", collected };
  if (unavailableReason(tenant) || (await usageOf(tenant)).remaining <= 0) return { events: [{ kind: "note", text: "Riwo isn't available right now, so this step can't be tried here. Customers would be handed to a person." }], handoff: "unavailable", collected };
  const knowledge = await knowledgeOf(config, tenant.id, text);
  const agent = { enabled: true, goal: node.goal, playbook: node.playbook, closeWith: node.closeWith, pricing: node.pricing };
  const lines = [...(Array.isArray(transcript) ? transcript : []).slice(-20), { from: "customer", text }];
  let answer = null;
  let correction = "";
  let facts = collected || {};
  for (let attempt = 0; attempt < 2 && !answer; attempt++) {
    const result = await chatAsAgent({ tenant, knowledge, agent, collected: Object.fromEntries(withFacts([], facts).map((r) => [r.question, r.answer])), correction, transcript: lines });
    const checked = checkAnswer(result.text, { knowledge, options: [], maxLength: 500 });
    if (!checked.invalid) answer = checked;
    else correction = checked.invalid.endsWith(".") ? checked.invalid : `${checked.invalid}.`;
  }
  if (!answer || answer.needsPerson) return { events: [{ kind: "say", text: withDisclosure(personalise(config.handoff, { name, company })), node: "agent" }, { kind: "note", text: "Riwo could not answer this from what you wrote. Your team is told." }], handoff: "needs_person", collected: facts };
  facts = { ...facts, ...(answer.collected || {}) };
  if (answer.ready) return { events: [...(answer.reply ? [{ kind: "say", text: withDisclosure(answer.reply), node: "agent" }] : []), ...describe({ do: "handoff", node: "agent" }, { name, company, rule })], handoff: "ready", collected: facts };
  return { events: [{ kind: "say", text: withDisclosure(answer.reply), node: "agent" }], handoff: null, collected: facts };
}

// One turn. `state` is null for the first message. Returns what happened, where the chat is now, and what Riwo understood.
export async function simulateTurn({ tenant, rule, state = null, text = "", labels = [], transcript = [], name = "Asha Rao" }) {
  const flow = rule.config.workflow;
  const company = tenant.name;
  const ctx = { labels, now: Math.floor(Date.now() / 1000), withinHours };
  const said = clip(text, 400);
  let made;
  let read = null;
  const place = state && typeof state === "object" ? { node: state.node || null, vars: state.vars || {}, attempts: Number(state.attempts) || 0 } : null;
  if (!place || !place.node) made = begin(flow, ctx, { last_message: said });
  else {
    const node = awaiting(flow, place);
    if (node?.type === "agent") made = { actions: [], state: { ...place, vars: { ...place.vars, last_message: said } }, pause: "agent", done: false, outcome: null };
    else {
      const input = { text: said };
      if (node?.type === "ask") {
        const seen = await classifyAnswer({ tenant, node, text: said });
        input.choice = seen.choice;
        read = { choice: seen.choice, label: node.options.find((o) => o.key === seen.choice)?.label || null, via: seen.via };
      }
      made = resume(flow, place, input, ctx);
    }
  }
  let events = made.actions.flatMap((a) => describe(a, { name, company, rule }));
  let { pause, done, outcome } = made;
  const vars = { ...made.state.vars };
  if (pause === "agent") {
    const node = flow.nodes[made.state.node];
    const turn = await agentTurn({ tenant, rule, node, text: said, transcript, collected: vars._collected, name, company });
    events = [...events, ...turn.events];
    vars._collected = turn.collected;
    if (turn.handoff) {
      pause = null;
      done = true;
      outcome = "handed_off";
    }
  }
  return { events, state: { node: done ? null : made.state.node, vars, attempts: made.state.attempts || 0 }, pause, done, outcome, read, node: made.state.node };
}
