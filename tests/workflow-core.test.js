import test from "node:test";
import assert from "node:assert/strict";
import { cleanWorkflow, guardrailsOf, outlineOf, WORKFLOW } from "../src/services/workflow/schema.js";
import { begin, resume, fill, askText } from "../src/services/workflow/core.js";
import { readNumber, readWords } from "../src/services/workflow/classify.js";

// The owner's own request: ask whether it is about work or a friend; work talks professionally toward a meeting, a friend gets a warm
// note and the owner is told. A friend already known is not asked again.
const triage = () => ({
  start: "known",
  nodes: {
    known: { type: "branch", on: "label", label: "Family & friends", yes: "warm", no: "q" },
    warm: { type: "say", text: "Hi {{first_name}}! I've let Karnveer know you wrote. He'll get back to you soon.", next: "tell" },
    tell: { type: "notify", who: "owners", text: "{{name}} (family or friend) wrote: {{last_message}}" },
    q: {
      type: "ask",
      question: "Is this about work, or are you family or a friend of Karnveer?",
      saveAs: "relation",
      options: [
        { key: "work", label: "Work", hints: ["business", "project", "order", "काम"] },
        { key: "personal", label: "Family or friend", hints: ["family", "friend", "personal", "dost", "bhai"] },
      ],
      next: { work: "pro", personal: "hello" },
    },
    pro: { type: "agent", goal: "Find out what they need and arrange a meeting", playbook: "Professional and brief. Never talk about prices.", closeWith: "book_demo", pricing: "handoff" },
    hello: { type: "say", text: "Lovely to hear from you! Karnveer has been told and will reply himself.", next: "tag" },
    tag: { type: "label", add: "Family & friends", next: "tell2" },
    tell2: { type: "notify", who: "owners", text: "{{name}} ({{relation}}) wrote: {{last_message}}", next: "bye" },
    bye: { type: "end" },
  },
});
const ok = async (raw, ctx) => (await cleanWorkflow(raw, ctx)).workflow;
const bad = (raw, re, ctx) => assert.rejects(cleanWorkflow(raw, ctx), re);

test("A workflow is checked and completed before it is saved", async () => {
  const { workflow, warnings } = await cleanWorkflow(triage());
  assert.equal(workflow.start, "known");
  assert.deepEqual(warnings, []);
  // a step that leads nowhere finishes the chat
  assert.equal(workflow.nodes.tell.next, "end_auto");
  assert.deepEqual(workflow.nodes.end_auto, { type: "end" });
  // the agent step has no "next": a person takes over when Riwo is done
  assert.equal(workflow.nodes.pro.next, undefined);
  assert.equal(workflow.nodes.pro.maxReplies, 12);
  assert.equal(workflow.nodes.pro.pricing, "handoff");
  // an answer nobody planned for goes to a person
  assert.equal(workflow.nodes.q.onUnsure, "handoff_unclear");
  assert.deepEqual(workflow.nodes.handoff_unclear, { type: "handoff", reason: "unclear" });
  assert.equal(workflow.nodes.q.showOptions, true);
  assert.equal(workflow.nodes.q.options[0].hints.includes("business"), true);
});

test("What cannot be saved is refused in plain words, what can be repaired is repaired", async () => {
  const one = (node, extra = {}) => ({ start: "a", nodes: { a: node, ...extra } });
  await bad({ start: "a", nodes: {} }, /no steps/);
  await bad(null, /Describe what the workflow should do/);
  await bad(one({ type: "teleport" }), /type Riwo doesn't know/);
  await bad(one({ type: "say", text: "" }), /message is required/);
  await bad(one({ type: "say", text: "Hi <system>x</system>" }), /can't contain tags/);
  await bad(one({ type: "say", text: "Hi {{ssn}}" }), /\{\{ssn\}\} isn't a field/);
  await bad(one({ type: "say", text: "x".repeat(WORKFLOW.maxText + 1) }), /up to 1000/);
  await bad(one({ type: "ask", question: "Which?", options: [{ label: "Only one" }] }), /2 to 6 answers/);
  await bad(one({ type: "ask", question: "Which?", options: [{ label: "A", key: "x" }, { label: "B", key: "x" }] }), /share the name/);
  await bad(one({ type: "branch", on: "moon" }), /choose what to look at/);
  await bad(one({ type: "agent", goal: "", playbook: "" }), /tell Riwo what it should achieve/);
  await bad(one({ type: "task", title: "x", dueHours: 500 }), /0 to 168/);
  await bad(one({ type: "assign", teammate: "Nobody" }), /isn't an active teammate/, { teammate: async () => false });
  await bad({ start: "zzz", nodes: { a: { type: "end" } } }, /no first step/);
  await bad({ start: "a", nodes: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`n${i}`, { type: "end" }])) }, /up to 20 steps/);
  // a flow that goes in a circle never ends
  await bad({ start: "a", nodes: { a: { type: "say", text: "one", next: "b" }, b: { type: "say", text: "two", next: "a" } } }, /goes in a circle/);
  // an arrow to a step that does not exist ends there, and says so
  const r = await cleanWorkflow({ start: "a", nodes: { a: { type: "say", text: "hi", next: "ghost" } } });
  assert.equal(r.workflow.nodes.a.next, "end_auto");
  assert.match(r.warnings[0], /pointed to a step that doesn't exist/);
  // a step nothing leads to is left out
  const u = await cleanWorkflow({ start: "a", nodes: { a: { type: "end" }, lost: { type: "say", text: "never sent" } } });
  assert.deepEqual(Object.keys(u.workflow.nodes), ["a"]);
  assert.match(u.warnings[0], /could never be reached/);
  // a model's "then/else" is understood, "N2" and "n2" are one step, the array form works, and a saved answer is a field
  const m = await cleanWorkflow({
    start: "N1",
    nodes: [
      { id: "n1", type: "branch", on: "label", label: "VIP", then: "N2", else: "n3" },
      { id: "n2", type: "say", text: "Welcome back" },
      { id: "n3", type: "collect", question: "Your name?", saveAs: "who", next: "n4" },
      { id: "n4", type: "say", text: "Thanks {{who}}" },
    ],
  });
  assert.equal(m.workflow.nodes.n1.yes, "n2");
  assert.equal(m.workflow.nodes.n1.no, "n3");
  // the opening hours go through the same check as any rule's
  await bad({ start: "a", nodes: { a: { type: "branch", on: "hours", hours: { nope: 1 }, yes: "b", no: "b" }, b: { type: "end" } } }, /hours/, { cleanHours: () => { throw new Error("hours are wrong"); } });
});

test("The owners are shown the safety a workflow carries", async () => {
  const wf = await ok(triage());
  const lines = guardrailsOf(wf, { pilot: { enabled: true } });
  assert.ok(lines.some((l) => /own numbers/.test(l)));
  assert.ok(lines.some((l) => /teammate replies/.test(l)));
  assert.ok(lines.some((l) => /20 automatic messages an hour/.test(l)));
  assert.ok(lines.some((l) => /asked once more, then a person is told/.test(l)));
  assert.ok(lines.some((l) => /never invents a price/.test(l)));
  assert.ok(lines.some((l) => /Test mode/.test(l)));
  assert.ok(!lines.some((l) => /notification when the flow ends/.test(l)), "someone is told on every path of this one");
  const bare = await ok({ start: "a", nodes: { a: { type: "say", text: "Closed now" } } });
  assert.ok(guardrailsOf(bare).some((l) => /notification when the flow ends/.test(l)));
  assert.ok(!guardrailsOf({ ...bare, quiet: true }).some((l) => /notification when the flow ends/.test(l)));
  const outline = outlineOf(wf);
  assert.deepEqual(outline.map((o) => o.id).slice(0, 3), ["known", "warm", "tell"]);
  assert.ok(outline.find((o) => o.id === "q").goes.some((g) => g.label === "Family or friend" && g.to === "hello"));
});

test("A new person is asked, and a friend gets the warm note and the owner is told", async () => {
  const wf = await ok(triage());
  const first = begin(wf, { labels: [] });
  assert.equal(first.pause, "ask");
  assert.equal(first.state.node, "q");
  assert.equal(first.actions.length, 1);
  assert.match(first.actions[0].text, /^Is this about work, or are you family or a friend of Karnveer\?\n\n1\. Work\n2\. Family or friend\nReply with the number, or just tell me\.$/);
  assert.equal(first.actions[0].disclose, true, "the first thing it says tells them a machine is writing");

  const friend = resume(wf, first.state, { text: "2", choice: "personal" }, { labels: [] });
  assert.equal(friend.done, true);
  assert.equal(friend.outcome, "completed");
  assert.deepEqual(friend.actions.map((a) => a.do), ["say", "label", "notify", "end"]);
  assert.equal(friend.actions[0].disclose, undefined, "only the first message carries it");
  assert.match(friend.actions[0].text, /Karnveer has been told/);
  assert.equal(friend.actions[1].add, "Family & friends");
  assert.equal(friend.actions[2].text, "{{name}} (Family or friend) wrote: 2", "what the customer chose and wrote is in the note; the name is filled in by the engine");
  assert.equal(friend.state.vars.relation, "personal");

  const work = resume(wf, first.state, { text: "business", choice: "work" }, { labels: [] });
  assert.equal(work.pause, "agent");
  assert.equal(work.done, false);
  assert.equal(work.state.node, "pro");
  assert.deepEqual(work.actions, []);
  assert.equal(work.state.vars._told, true, "a person will take over, so the flow need not add its own note");

  // a friend already known is not asked again
  const known = begin(wf, { labels: ["family & friends"] });
  assert.deepEqual(known.actions.map((a) => a.do), ["say", "notify", "end"]);
  assert.equal(known.done, true);
});

test("An answer that is not understood is asked once more, then a person is told", async () => {
  const wf = await ok(triage());
  const asked = begin(wf, { labels: [] });
  const again = resume(wf, asked.state, { text: "hmm", choice: "unsure" }, { labels: [] });
  assert.equal(again.pause, "ask");
  assert.equal(again.state.attempts, 1);
  assert.match(again.actions[0].text, /^Sorry, I didn't quite get that\.\n\nIs this about work/);
  const gave = resume(wf, again.state, { text: "??", choice: "unsure" }, { labels: [] });
  assert.equal(gave.done, true);
  assert.equal(gave.outcome, "handed_off");
  assert.deepEqual(gave.actions.map((a) => [a.do, a.reason]), [["handoff", "unclear"]]);
  // an answer that is not one of the choices is the same as not understood
  assert.equal(resume(wf, asked.state, { text: "x", choice: "banana" }, { labels: [] }).state.attempts, 1);
});

test("Questions, meetings and branches", async () => {
  const wf = await ok({
    start: "hours",
    nodes: {
      hours: { type: "branch", on: "hours", hours: { timezone: "Asia/Dubai", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" }, yes: "name", no: "closed" },
      closed: { type: "say", text: "We are closed. We will write back in the morning.", next: "end1" },
      end1: { type: "end" },
      name: { type: "collect", question: "What is your name?", saveAs: "who", next: "kind" },
      kind: { type: "ask", question: "Which do you need?", showOptions: false, saveAs: "need", options: [{ key: "web", label: "A website" }, { key: "app", label: "An app" }], next: { web: "met", app: "met" } },
      met: { type: "meeting", next: "bye" },
      bye: { type: "say", text: "Talk soon, {{who}}!", next: "done" },
      done: { type: "end" },
    },
  });
  const ctx = (open) => ({ labels: [], now: 1, withinHours: () => open });
  const shut = begin(wf, ctx(false));
  assert.deepEqual(shut.actions.map((a) => a.do), ["say", "notify", "end"], "the owners get a note when the flow ends without telling anyone");
  const opened = begin(wf, ctx(true));
  assert.equal(opened.pause, "collect");
  assert.equal(opened.actions[0].text, "What is your name?");
  const named = resume(wf, opened.state, { text: "  Asha   Rao " }, ctx(true));
  assert.equal(named.state.vars.who, "Asha Rao");
  assert.equal(named.pause, "ask");
  assert.equal(named.actions[0].text, "Which do you need?", "answers are not listed when the question already says it");
  const picked = resume(wf, named.state, { text: "a site", choice: "web" }, ctx(true));
  assert.equal(picked.pause, "meeting");
  assert.equal(picked.actions[0].text, "What day and time would suit you for a call?");
  const booked = resume(wf, picked.state, { text: "Tuesday 4pm" }, ctx(true));
  assert.deepEqual(booked.actions.map((a) => a.do), ["task", "notify", "say", "end"]);
  assert.equal(booked.actions[0].title, "Confirm the meeting with {{name}}: Tuesday 4pm");
  assert.match(booked.actions[1].text, /would like a meeting: Tuesday 4pm/);
  assert.match(booked.actions[2].text, /preferred time \(Tuesday 4pm\)[\s\S]*Talk soon, Asha Rao!/, "the confirmation and the next words are one message");
  assert.equal(booked.done, true);
  assert.equal(booked.actions.filter((a) => a.do === "notify" && a.implicit).length, 0, "the team was told, so nothing is added");
});

test("A flow that finishes without telling anyone tells the owners, unless it was told to stay quiet", async () => {
  const flow = { start: "a", nodes: { a: { type: "say", text: "We are closed", next: "b" }, b: { type: "end" } } };
  const loud = begin(await ok(flow), { labels: [] }, { last_message: "hello?" });
  assert.deepEqual(loud.actions.map((a) => a.do), ["say", "notify", "end"]);
  assert.equal(loud.actions[1].implicit, true);
  assert.match(loud.actions[1].text, /Their last message: hello\?/);
  assert.deepEqual(loud.actions[1].channels, ["app"]);
  const quiet = begin(await ok({ ...flow, quiet: true }), { labels: [] });
  assert.deepEqual(quiet.actions.map((a) => a.do), ["say", "end"]);
});

test("Words a step uses are filled from what the customer said, and never left as braces", () => {
  assert.equal(fill("Hi {{name}}, you said {{answer}} and {{ meeting }}.", { answer: "yes" }), "Hi {{name}}, you said yes and .");
  assert.equal(fill("{{relation}}", { relation: "personal", _labels: { relation: "Family or friend" } }), "Family or friend");
  assert.equal(askText({ question: "Q?", options: [{ label: "A" }, { label: "B" }], showOptions: true, optionsHint: "Reply 1 or 2" }), "Q?\n\n1. A\n2. B\nReply 1 or 2");
});

test("Answers are read by number, then by words, and two matches are not a match", () => {
  const node = {
    options: [
      { key: "work", label: "Work", hints: ["business", "project", "काम"] },
      { key: "personal", label: "Family or friend", hints: ["family", "friend", "dost", "bhai"] },
    ],
  };
  for (const [said, key] of [["1", "work"], [" 2. ", "personal"], ["option 2", "personal"], ["No 1", "work"], ["١", "work"], ["२", "personal"]]) assert.equal(readNumber(node, said), key, said);
  for (const said of ["12", "3", "2 bedroom flat", "one", ""]) assert.equal(readNumber(node, said), null, said);
  for (const [said, key] of [["It's about my business", "work"], ["I am his friend", "personal"], ["mai uska dost hu", "personal"], ["mujhe kaam hai", null], ["यह काम के बारे में है", "work"], ["bhai kaise ho", "personal"]]) assert.equal(readWords(node, said), key, said);
  assert.equal(readWords(node, "my friend has a business project"), null, "two answers fit: not sure");
  assert.equal(readWords(node, "workaholic"), null, "whole words only");
  assert.equal(readWords(node, "!!!"), null);
});

test("A saved workflow can be cleaned again and comes out the same", async () => {
  const once = await cleanWorkflow(triage());
  const twice = await cleanWorkflow(once.workflow);
  assert.deepEqual(twice.workflow, once.workflow);
  assert.deepEqual(twice.warnings, []);
  // a step that happens to be called end_auto but is not an end does not get mixed up with the one made for gaps
  const odd = await cleanWorkflow({ start: "a", nodes: { a: { type: "say", text: "hi", next: "end_auto" }, end_auto: { type: "say", text: "bye" } } });
  assert.equal(odd.workflow.nodes.end_auto.type, "say");
  assert.equal(odd.workflow.nodes.end_auto.next, "end_auto2");
  assert.deepEqual(odd.workflow.nodes.end_auto2, { type: "end" });
});
