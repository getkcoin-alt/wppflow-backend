// The decision core of a workflow. It is a pure function: it is given the flow, where the chat is, and what the customer said, and
// it answers with what to do (words to send, labels to put, people to tell) and where the chat is now. It never touches the
// database, WhatsApp or the model, so the live engine and the "try it" simulator run exactly the same code, and the whole thing
// can be tested with plain values.
//
//   state  { node, vars, attempts }   node is the step the chat waits on (or null when finished); vars holds what the customer
//                                      answered, and a few private markers that start with "_"
//   input  { text, choice }           what the customer wrote; `choice` is the answer to a question, already understood
//   ctx    { labels, now, withinHours }   the contact's labels (lower case), the time, and a function for opening hours
//
// Returns { actions, state, pause, done, outcome }. `pause` says what the chat now waits for: "ask", "collect" or "meeting" (the
// customer's next words), or "agent" (Riwo's turn runs next, then the customer's words again).

const MAX_STEPS = 60; // the saved flow cannot loop (it is checked), but nothing here may ever spin
const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// {{answer}} in the words of a step: what the customer said earlier. {{name}}, {{first_name}} and {{company}} are filled in later,
// by the part that knows the customer. A field with nothing in it yet is empty, never left as braces in a customer's chat.
const PERSONAL = new Set(["name", "first_name", "company", "executive"]);
export function fill(text, vars = {}) {
  return String(text ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => {
    const k = key.toLowerCase();
    if (PERSONAL.has(k)) return whole;
    const value = vars._labels?.[k] ?? vars[k];
    return value === undefined || value === null ? "" : String(value);
  });
}

// The question with its answers, as it is sent: "Is this about work…?\n\n1. Work\n2. Family or friend\nReply with the number…"
export function askText(node) {
  if (!node.showOptions) return node.question;
  const lines = node.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
  return `${node.question}\n\n${lines}\n${node.optionsHint || "Reply with the number, or just tell me."}`;
}
const retryText = (node) => `${node.retry || "Sorry, I didn't quite get that."}\n\n${askText(node)}`;

// which step comes next from a branch
function decide(node, vars, labels, ctx) {
  if (node.on === "label") return labels.has(node.label.toLowerCase()) ? node.yes : node.no;
  if (node.on === "hours") return ctx.withinHours?.(node.hours, ctx.now) ? node.yes : node.no;
  const value = vars[node.var];
  return (value !== undefined && Object.hasOwn(node.cases, value) ? node.cases[value] : null) ?? node.otherwise;
}

// Runs from `from` until the chat has to wait for the customer, hands over, or ends.
function run(workflow, from, state, ctx) {
  const vars = { ...state.vars };
  const labels = new Set((ctx.labels || []).map((l) => String(l).toLowerCase()));
  const actions = [];
  let told = Boolean(vars._told);
  let id = from;
  const say = (node, text) => {
    const last = actions.at(-1);
    // two messages in a row are one message: nobody wants a burst of three
    if (last?.do === "say") actions[actions.length - 1] = { ...last, node, text: `${last.text}\n\n${text}` };
    else actions.push({ do: "say", node, text });
    // the first thing the flow ever says in a chat carries the line that a machine is writing, and how to reach a person
    if (!vars._said) {
      actions[actions.length - 1].disclose = true;
      vars._said = true;
    }
  };
  const result = (pause, done, outcome, node = null, attempts = 0) => {
    vars._told = told;
    return { actions, state: { node, vars, attempts }, pause, done, outcome };
  };

  for (let steps = 0; id; steps++) {
    if (steps > MAX_STEPS) throw new Error("The workflow ran for too many steps");
    const n = workflow.nodes[id];
    if (!n) {
      actions.push({ do: "end", node: id, outcome: "completed" });
      return result(null, true, "completed");
    }
    switch (n.type) {
      case "say":
        say(id, fill(n.text, vars));
        id = n.next;
        break;
      case "label":
        actions.push({ do: "label", node: id, add: n.add });
        labels.add(n.add.toLowerCase());
        id = n.next;
        break;
      case "notify":
        actions.push({ do: "notify", node: id, who: n.who, channels: n.channels, title: fill(n.title, vars), text: fill(n.text, vars) });
        told = true;
        id = n.next;
        break;
      case "assign":
        actions.push({ do: "assign", node: id, teammate: n.teammate });
        told = true;
        id = n.next;
        break;
      case "lead":
        actions.push({ do: "lead", node: id, stageName: n.stageName });
        told = true;
        id = n.next;
        break;
      case "task":
        actions.push({ do: "task", node: id, title: fill(n.title, vars), dueHours: n.dueHours });
        told = true;
        id = n.next;
        break;
      case "branch":
        id = decide(n, vars, labels, ctx);
        break;
      case "ask":
        say(id, askText(n));
        return result("ask", false, null, id, 0);
      case "collect":
        say(id, fill(n.question, vars));
        return result("collect", false, null, id, 0);
      case "meeting":
        say(id, fill(n.question, vars));
        return result("meeting", false, null, id, 0);
      case "agent":
        told = true; // a person takes over when Riwo is done, with a summary
        return result("agent", false, null, id, 0);
      case "handoff":
        actions.push({ do: "handoff", node: id, reason: n.reason });
        told = true;
        return result(null, true, "handed_off");
      default: {
        // the end. A flow that finished without anyone being told is not left silent: the owners get a short note
        if (!told && !workflow.quiet) {
          actions.push({ do: "notify", node: id, who: "owners", channels: ["app"], title: "{{name}} wrote to you", text: fill("The automatic flow finished. Their last message: {{last_message}}", vars), implicit: true });
          told = true;
        }
        actions.push({ do: "end", node: id, outcome: "completed" });
        return result(null, true, "completed");
      }
    }
  }
  actions.push({ do: "end", node: from, outcome: "completed" });
  return result(null, true, "completed");
}

export const begin = (workflow, ctx = {}, vars = {}) => run(workflow, workflow.start, { vars: { ...vars } }, ctx);

// What the chat is waiting for: the step it is on, or null when it is finished.
export const awaiting = (workflow, state) => (state?.node ? workflow.nodes[state.node] || null : null);

export function resume(workflow, state, input = {}, ctx = {}) {
  const n = awaiting(workflow, state);
  const vars = { ...state.vars, last_message: clip(input.text, 300) };
  if (!n) return run(workflow, null, { vars }, ctx);
  const attempts = Number(state.attempts) || 0;
  switch (n.type) {
    case "ask": {
      const option = n.options.find((o) => o.key === input.choice);
      if (option) {
        vars[n.saveAs] = option.key;
        vars._labels = { ...vars._labels, [n.saveAs]: option.label };
        vars.answer = option.label;
        return run(workflow, n.next[option.key], { vars }, ctx);
      }
      // not understood: one more try with the answers spelled out, then a person
      if (attempts < 1) {
        const last = { do: "say", node: state.node, text: fill(retryText(n), vars) };
        return { actions: [last], state: { node: state.node, vars: { ...vars, _told: Boolean(vars._told) }, attempts: attempts + 1 }, pause: "ask", done: false, outcome: null };
      }
      return run(workflow, n.onUnsure, { vars }, ctx);
    }
    case "collect": {
      const answer = clip(input.text, 300);
      vars[n.saveAs] = answer;
      vars.answer = answer;
      return run(workflow, n.next, { vars }, ctx);
    }
    case "meeting": {
      const when = clip(input.text, 200);
      vars.meeting = when;
      vars.answer = when;
      vars._told = true; // the team is told below, so the end of the flow adds nothing
      const first = run(workflow, n.next, { vars }, ctx);
      // the customer is thanked and the team told before anything the flow does next
      const mine = [
        { do: "task", node: state.node, title: fill(n.taskTitle, vars), dueHours: 2 },
        { do: "notify", node: state.node, who: "owners", channels: ["app", "email"], title: "{{name}} asked for a meeting", text: fill(n.notifyText, vars) },
        { do: "say", node: state.node, text: fill(n.confirm, vars) },
      ];
      const merged = [...mine, ...first.actions];
      // a "say" that follows the confirmation joins it
      const actions = merged.reduce((out, a) => {
        const last = out.at(-1);
        if (a.do === "say" && last?.do === "say") out[out.length - 1] = { ...last, node: a.node, text: `${last.text}\n\n${a.text}`, disclose: last.disclose || a.disclose };
        else out.push(a);
        return out;
      }, []);
      return { ...first, actions };
    }
    default:
      // an agent step: Riwo's own turn runs, and the flow has nothing to add
      return { actions: [], state: { node: state.node, vars, attempts }, pause: "agent", done: false, outcome: null };
  }
}
