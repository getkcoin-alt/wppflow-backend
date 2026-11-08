import test from "node:test";
import assert from "node:assert/strict";
import { cleanWorkflow, outlineOf, summaryOf } from "../src/services/workflow/schema.js";
import { applyEdits, questionEdits, answerName } from "../src/services/workflow/edits.js";
import { diffWorkflow } from "../src/services/workflow/compile.js";

// The flow an owner reported: a keyword workflow that says hello, asks what they need, asks the kind of business (all answers go
// on, an unclear one goes to a person), thanks them, asks when to meet, makes a follow-up, tells the owners and finishes.
const raw = {
  start: "n1",
  nodes: {
    n1: { type: "say", text: "Hi {{first_name}}! As a new user we offer a free website plus 1 month of SEO, AEO and GEO setup.", next: "n2" },
    n2: { type: "collect", question: "Could you tell us what you need for your website or marketing?", saveAs: "requirement", next: "n3" },
    n3: {
      type: "ask",
      question: "Do you sell a product, a service, or something else?",
      saveAs: "business_type",
      options: [{ key: "product", label: "Product" }, { key: "service", label: "Service" }, { key: "other", label: "Other" }],
      next: { product: "n4", service: "n4", other: "n4" },
    },
    n4: { type: "say", text: "Great, our research team will study your business and prepare a tailored solution.", next: "n5" },
    n5: { type: "meeting", question: "What day and time would suit you for a call?", next: "n6" },
    n6: { type: "task", title: "Prepare R&D for {{first_name}} ({{business_type}})", dueHours: 2, next: "n7" },
    n7: { type: "notify", who: "owners", text: "{{first_name}} requested website development. Requirement: {{requirement}}. Business type: {{business_type}}.", next: "n8" },
    n8: { type: "end" },
  },
};
const flow = async () => ({ name: "Website enquiries", trigger: { type: "keyword", keywords: ["website", "development", "marketing", "leads"] }, workflow: (await cleanWorkflow(raw)).workflow });
const clean = async (state) => (await cleanWorkflow(state.workflow)).workflow;
const order = (wf) => outlineOf(wf).map((o) => o.id);

test("Add a question without a model: it goes after the last question and the answer is added to the note to the owners", async () => {
  const current = await flow();
  const frozen = JSON.stringify(current);
  const state = applyEdits(current, questionEdits(current, { question: "Where did you hear about us?" }));
  assert.equal(JSON.stringify(current), frozen, "the flow it was given is not touched");
  const wf = await clean(state);
  const fresh = Object.keys(wf.nodes).find((id) => !current.workflow.nodes[id]);
  assert.equal(wf.nodes[fresh].type, "collect");
  assert.equal(wf.nodes[fresh].question, "Where did you hear about us?");
  assert.equal(wf.nodes[fresh].saveAs, "hear");
  // every answer of the business-type question now goes through it, and it goes on to what they led to before
  assert.deepEqual(wf.nodes.n3.next, { product: fresh, service: fresh, other: fresh });
  assert.equal(wf.nodes[fresh].next, "n4");
  assert.deepEqual(order(wf).slice(0, 5), ["n1", "n2", "n3", fresh, "n4"]);
  // the note to the owners carries the answer, so somebody reads it
  assert.match(wf.nodes.n7.text, /Business type: \{\{business_type\}\}\. Hear: \{\{hear\}\}\.$/);
  // what was not mentioned is exactly as it was, and the diff says only what happened (the question whose arrows moved is not "changed")
  assert.deepEqual(diffWorkflow(current.workflow, wf), ["Added: Where did you hear about us?", `Changed: ${summaryOf(wf.nodes.n7)}`]);
  assert.equal(wf.nodes.handoff_unclear.type, "handoff", "an unclear answer still goes to a person");
});

test("The question can go before any step, and the owners' note can be left alone", async () => {
  const current = await flow();
  const state = applyEdits(current, questionEdits(current, { question: "Which city are you in?", before: "n5", tell: false }));
  const wf = await clean(state);
  const fresh = Object.keys(wf.nodes).find((id) => !current.workflow.nodes[id]);
  assert.deepEqual(order(wf).slice(2, 7), ["n3", "n4", fresh, "n5", "n6"]);
  assert.equal(wf.nodes.n4.next, fresh);
  assert.equal(wf.nodes.n7.text, current.workflow.nodes.n7.text);
  assert.equal(wf.nodes[fresh].saveAs, "city");
  // at the very start
  const first = await clean(applyEdits(current, questionEdits(current, { question: "What is your name?", before: "n1", tell: false })));
  assert.equal(first.start, Object.keys(first.nodes).find((id) => !current.workflow.nodes[id]));
  assert.equal(first.nodes[first.start].next, "n1");
});

test("Without any question in the flow the new one goes before the step that tells the team", async () => {
  const simple = (await cleanWorkflow({ start: "a", nodes: { a: { type: "say", text: "Hello!", next: "b" }, b: { type: "notify", who: "owners", text: "{{name}} wrote", next: "c" }, c: { type: "end" } } })).workflow;
  const wf = await clean(applyEdits({ name: "x", trigger: { type: "first_message" }, workflow: simple }, questionEdits({ workflow: simple }, { question: "How many people are you?", tell: false })));
  assert.deepEqual(order(wf).slice(0, 3), ["a", Object.keys(wf.nodes).find((id) => !simple.nodes[id]), "b"]);
});

test("A question that cannot be added says why", async () => {
  const current = await flow();
  assert.throws(() => questionEdits(current, { question: "?" }), /Write the question/);
  assert.throws(() => questionEdits(current, { question: "x".repeat(400) }), /up to 300/);
  assert.throws(() => questionEdits(current, { question: "Which city?", before: "zzz" }), /There is no step to put it before "zzz"\. The steps are: n1/);
  const full = structuredClone(current);
  for (let i = 0; Object.keys(full.workflow.nodes).length < 20; i++) full.workflow.nodes[`pad${i}`] = { type: "end" };
  assert.throws(() => applyEdits(full, questionEdits(full, { question: "Which city are you in?" })), /up to 20 steps/);
});

test("The name an answer is kept under is short, readable and never clashes", async () => {
  const current = await flow();
  assert.equal(answerName("Which city are you in?", current.workflow), "city");
  assert.equal(answerName("What is your budget?", current.workflow), "budget");
  assert.equal(answerName("Where did you get our reference?", current.workflow), "get_reference");
  assert.equal(answerName("What do you sell?", current.workflow), "sell");
  assert.equal(answerName("Which business type?", current.workflow), "business_type_2", "business_type is taken");
  assert.equal(answerName("आप कहाँ से हैं?", current.workflow), "detail", "a question with no Latin words gets a plain name the owner can change");
  assert.equal(answerName("What is your name?", current.workflow), "answer_name", "name is a field of its own");
});

test("Riwo's edits: insert before or after, change words, take a step out, send an answer somewhere else", async () => {
  const current = await flow();
  // insert after a one-way step
  let wf = await clean(applyEdits(current, [{ op: "insert", after: "n2", step: { type: "say", text: "Thanks!" } }]));
  const thanks = Object.keys(wf.nodes).find((id) => !current.workflow.nodes[id]);
  assert.equal(wf.nodes.n2.next, thanks);
  assert.equal(wf.nodes[thanks].next, "n3");
  // "insert_after" with the anchor in "id" is read the way it was meant
  wf = await clean(applyEdits(current, [{ op: "insert_after", id: "n2", step: { type: "say", text: "Thanks!" } }]));
  assert.equal(wf.nodes.n2.next, Object.keys(wf.nodes).find((id) => !current.workflow.nodes[id]));
  // after a step that leads different ways: it says to name the step it goes before
  assert.throws(() => applyEdits(current, [{ op: "insert", after: "n3", step: { type: "say", text: "x" } }]), /different ways.*before, not after/);
  // change words; fields that do not belong, and a change of kind, are refused with what can be changed
  wf = await clean(applyEdits(current, [{ op: "change", id: "n1", set: { text: "Hello {{first_name}}!" } }]));
  assert.equal(wf.nodes.n1.text, "Hello {{first_name}}!");
  assert.throws(() => applyEdits(current, [{ op: "change", id: "n1", set: { question: "x" } }]), /"say" step; what can be changed on it is: text/);
  assert.throws(() => applyEdits(current, [{ op: "change", id: "n1", set: { type: "ask" } }]), /can't turn into another kind/);
  // take a step out: what led to it now leads on
  wf = await clean(applyEdits(current, [{ op: "remove", id: "n4" }]));
  assert.equal(wf.nodes.n4, undefined);
  assert.deepEqual(wf.nodes.n3.next, { product: "n5", service: "n5", other: "n5" });
  // ... but not a question that sends the chat different ways, nor a hand-over
  assert.throws(() => applyEdits(current, [{ op: "remove", id: "n3" }]), /different ways/);
  assert.throws(() => applyEdits(current, [{ op: "remove", id: "handoff_unclear" }]), /hands the chat to a person/);
  // an answer sent somewhere else, or the unclear answer to a person
  wf = await clean(applyEdits(current, [{ op: "link", from: "n3", via: "other", to: "n7" }]));
  assert.equal(wf.nodes.n3.next.other, "n7");
  assert.equal(wf.nodes.n3.next.product, "n4");
  assert.throws(() => applyEdits(current, [{ op: "link", from: "n3", via: "maybe", to: "n7" }]), /can go on in these ways: product, service, other, unsure/);
  assert.throws(() => applyEdits(current, [{ op: "link", from: "n8", to: "n1" }]), /ends the chat/);
  // a rewire between steps that already exist says so, since nothing was added or removed
  assert.deepEqual(diffWorkflow(current.workflow, wf), ["Changed where this goes next: Do you sell a product, a service, or something else?"]);
  // a link that makes a circle is caught by the same check as everything else
  await assert.rejects(clean(applyEdits(current, [{ op: "link", from: "n6", to: "n1" }])), /goes in a circle/);
});

test("Edits can change when it starts and what it is called, and a mistake in one says which", async () => {
  const current = await flow();
  const state = applyEdits(current, [{ op: "trigger", trigger: { type: "keyword", keywords: ["website", "seo"] } }, { op: "rename", name: "  Website and SEO enquiries " }]);
  assert.deepEqual(state.trigger.keywords, ["website", "seo"]);
  assert.equal(state.name, "Website and SEO enquiries");
  assert.throws(() => applyEdits(current, [{ op: "trigger", trigger: { type: "moonrise" } }]), /Say when it starts/);
  assert.throws(() => applyEdits(current, [{ op: "fly" }]), /isn't a change Riwo can make/);
  assert.throws(() => applyEdits(current, []), /nothing to change/);
  assert.throws(() => applyEdits(current, Array.from({ length: 13 }, () => ({ op: "rename", name: "x" }))), /a few at a time/);
  assert.throws(() => applyEdits(current, [{ op: "change", id: "n99", set: { text: "x" } }]), /There is no step "n99"\. The steps are: n1 \(Hi/);
  assert.throws(() => applyEdits(current, [{ op: "insert", step: { type: "say", text: "x" } }]), /"before" or "after"/);
  assert.throws(() => applyEdits(current, [{ op: "insert", before: "n2", step: { type: "end" } }]), /ends the chat \(end\) can't be put in the middle/);
  assert.throws(() => applyEdits(current, [{ op: "insert", before: "n2", step: { type: "teleport" } }]), /isn't a kind of step/);
});

test("A question put in front of the first step of a branch, and answers of a new question, keep working", async () => {
  const current = await flow();
  // inserting a question that has answers: all of them go on to the step it was put in front of
  const wf = await clean(applyEdits(current, [{ op: "insert", before: "n4", step: { type: "ask", question: "Is it urgent?", saveAs: "urgent", options: [{ label: "Yes" }, { label: "No" }] } }]));
  const fresh = Object.keys(wf.nodes).find((id) => !current.workflow.nodes[id]);
  assert.deepEqual(wf.nodes[fresh].next, { yes: "n4", no: "n4" });
  assert.equal(wf.nodes[fresh].onUnsure, "handoff_unclear");
});
