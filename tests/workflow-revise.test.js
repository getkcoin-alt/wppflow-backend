import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { setAiClient, tidyRevision, tidyWorkflowDraft, listSteps } from "../src/services/aiService.js";
import { closeSessions } from "../src/services/sessionService.js";

// "Change something" on a workflow that already exists, with the flow an owner reported: a keyword workflow of nine steps. The
// change asked for was "also ask where they got the reference"; Riwo's answer came back in a shape the reader refused, twice.
const KEYWORDS = ["website", "development", "marketing", "leads"];
const FLOW = {
  start: "n1",
  nodes: {
    n1: { type: "say", text: "Hi {{first_name}}! As a new user we offer a free website plus 1 month of SEO, AEO and GEO setup.", next: "n2" },
    n2: { type: "collect", question: "Could you tell us what you need for your website or marketing?", saveAs: "requirement", next: "n3" },
    n3: { type: "ask", question: "Do you sell a product, a service, or something else?", saveAs: "business_type", options: [{ key: "product", label: "Product" }, { key: "service", label: "Service" }, { key: "other", label: "Other" }], next: { product: "n4", service: "n4", other: "n4" } },
    n4: { type: "say", text: "Great, our research team will study your business and prepare a tailored solution.", next: "n5" },
    n5: { type: "meeting", question: "What day and time would suit you for a call?", next: "n6" },
    n6: { type: "task", title: "Prepare R&D for {{first_name}} ({{business_type}})", dueHours: 2, next: "n7" },
    n7: { type: "notify", who: "owners", text: "{{first_name}} requested website development. Requirement: {{requirement}}. Business type: {{business_type}}.", next: "n8" },
    n8: { type: "end" },
  },
};
const ruleBody = () => ({
  name: "Website enquiries",
  triggerType: "keyword",
  triggerCondition: KEYWORDS.join(", "),
  actionType: "workflow",
  actionSummary: "",
  config: { workflow: structuredClone(FLOW), useKnowledge: false, knowledge: "", sales: { formal: "Dear {{first_name}}, {{executive}} will be with you shortly." }, pilot: { enabled: true, phones: ["919800000099"] } },
});
const referral = { type: "collect", question: "Where did you get our reference from?", saveAs: "referral", next: "n4" };

test("Changing a workflow in words works however Riwo answers, and there is always a way that needs no Riwo", async (t) => {
  const key = process.env.ANTHROPIC_API_KEY;
  const or = process.env.OPENROUTER_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  const asked = [];
  const replies = [];
  const respond = async (params) => {
    asked.push(params);
    const body = replies.shift() ?? "no idea";
    return { content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }], stop_reason: "end_turn", usage: { input_tokens: 400, output_tokens: 200 } };
  };
  setAiClient({ messages: { create: respond }, beta: { messages: { create: respond } } });
  t.after(async () => {
    setAiClient(undefined);
    key === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = key);
    if (or !== undefined) process.env.OPENROUTER_API_KEY = or;
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Karnveer Sonigara", email: "karn@revise.test", password: "Password@123", companyName: "Scriza" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  const revise = (body) => request(app).post("/api/automations/workflow/revise").set(owner).send({ rule: ruleBody(), ...body });
  const SAID = "Also ask from user about from where they got the reference..";
  const outlineIds = (res) => res.body.draft.outline.map((x) => x.id);
  const added = (res) => res.body.diff.find((l) => l.startsWith("Added:"));
  const keepsEverythingElse = (res) => {
    const rule = res.body.draft.rule;
    assert.equal(rule.triggerType, "keyword");
    assert.equal(rule.triggerCondition, KEYWORDS.join(", "), "it still starts on the same words");
    assert.equal(rule.name, "Website enquiries");
    assert.equal(rule.config.sales.formal, "Dear {{first_name}}, {{executive}} will be with you shortly.", "the owner's own formal message is kept");
    assert.deepEqual(rule.config.pilot, { enabled: true, phones: ["919800000099"] }, "test mode stays on");
    for (const id of ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]) assert.ok(rule.config.workflow.nodes[id], `${id} is still there`);
  };

  await t.test("the reported case: Riwo answers in the shape it was shown (no \"rule\" around it) and the change is made", async () => {
    const flow = structuredClone(FLOW);
    flow.nodes.n9 = referral;
    flow.nodes.n3.next = { product: "n9", service: "n9", other: "n9" };
    // the old reader wanted {"rule":{"workflow":...}} and refused this twice
    replies.push({ name: "Website enquiries", trigger: { type: "keyword", keywords: KEYWORDS }, workflow: flow });
    const res = await revise({ instruction: SAID });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(added(res), "Added: Where did you get our reference from?");
    assert.deepEqual(outlineIds(res).slice(0, 5), ["n1", "n2", "n3", "n9", "n4"]);
    keepsEverythingElse(res);
    assert.equal(asked.length, 1, "one question to Riwo, not two");
  });

  await t.test("the same when only the steps come back, or when its answer leaves out when the flow starts", async () => {
    const flow = structuredClone(FLOW);
    flow.nodes.n9 = referral;
    flow.nodes.n3.next = { product: "n9", service: "n9", other: "n9" };
    replies.push({ start: "n1", nodes: flow.nodes });
    const bare = await revise({ instruction: SAID });
    assert.equal(bare.status, 200, JSON.stringify(bare.body));
    keepsEverythingElse(bare);
    // a keyword trigger that came back without its words keeps the words it had
    replies.push({ rule: { name: "Something else", trigger: { type: "keyword" }, workflow: flow } });
    const dropped = await revise({ instruction: SAID });
    assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
    keepsEverythingElse(dropped);
  });

  await t.test("small edits: the question goes in, the owners' note carries the answer, and nothing else moves", async () => {
    replies.push({
      edits: [
        { op: "insert", before: "n4", step: { type: "collect", question: "Where did you hear about us?", saveAs: "heard_from" } },
        { op: "change", id: "n7", set: { text: "{{first_name}} requested website development. Requirement: {{requirement}}. Business type: {{business_type}}. Heard from: {{heard_from}}." } },
      ],
      understood: "After the business question, customers are asked where they heard about you, and you are told the answer.",
    });
    const res = await revise({ instruction: SAID });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(added(res), "Added: Where did you hear about us?");
    assert.ok(res.body.diff.some((l) => /^Changed: Tell the owners: .*Heard from: \{\{heard_from\}\}/.test(l)));
    assert.equal(res.body.diff.length, 2);
    assert.match(res.body.draft.understood, /where they heard about you/);
    keepsEverythingElse(res);
    const fresh = res.body.draft.rule.config.workflow.nodes;
    const id = Object.keys(fresh).find((k) => fresh[k].saveAs === "heard_from");
    assert.deepEqual(res.body.draft.rule.config.workflow.nodes.n3.next, { product: id, service: id, other: id });
    assert.equal(fresh[id].next, "n4");
    // what the model was shown: the steps with where each goes, and the owner's words
    const user = asked.at(-1).messages[0].content;
    assert.match(user, /^<current_workflow>\nStarts when: a message contains: website, development, marketing, leads\nFirst step: n1\nn1 say: "Hi \{\{first_name\}\}!/);
    assert.match(user, /n3 ask: "Do you sell a product, a service, or something else\?" \(saves as business_type\) answers: product -> n4, service -> n4, other -> n4, unsure -> handoff_unclear/);
    assert.match(user, /<owner_change>\nAlso ask from user about from where they got the reference\.\./);
    assert.match(asked.at(-1).system, /You change WhatsApp workflows/);
    assert.ok(asked.at(-1).max_tokens >= 1500, "room for the answer");
  });

  await t.test("a reply wrapped in words and a code fence, with a stray comma and braces after it, is still read", async () => {
    const edits = JSON.stringify({ edits: [{ op: "insert", before: "n4", step: { type: "collect", question: "Where did you hear about us?", saveAs: "heard_from" } },], understood: "Adds the question." });
    replies.push(`Sure, here you go:\n\`\`\`json\n${edits.replace("}],", "},],")}\n\`\`\`\nI used {{first_name}} where it helps.`);
    const res = await revise({ instruction: "also ask where they heard about us" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(added(res), "Added: Where did you hear about us?");
  });

  await t.test("an edit that names a step that is not there is sent back with the list of steps, and the second try is used", async () => {
    asked.length = 0;
    replies.push({ edits: [{ op: "insert", before: "n99", step: { type: "collect", question: "Where did you hear about us?", saveAs: "heard_from" } }] });
    replies.push({ edits: [{ op: "insert", before: "n4", step: { type: "collect", question: "Where did you hear about us?", saveAs: "heard_from" } }] });
    const res = await revise({ instruction: SAID });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(asked.length, 2);
    assert.match(asked[1].messages[0].content, /Your last answer could not be used: There is no step "n99"\. The steps are: n1 \(Hi/);
    assert.equal(added(res), "Added: Where did you hear about us?");
  });

  await t.test("an answer that is not JSON gets one more try that says what was wrong, then a plain message that says what to do", async () => {
    asked.length = 0;
    replies.push("I'm sorry, I can't do that.", "Still no JSON here.");
    const res = await revise({ instruction: SAID });
    assert.equal(res.status, 422);
    assert.equal(asked.length, 2);
    assert.match(asked[1].messages[0].content, /Your reply was not a JSON object in the form described/);
    assert.equal(res.body.message, "Riwo couldn't turn that into a change this time. Say it another way, or add the question yourself below.");
    // an edit that cannot be made says why, once and in a sentence
    replies.push({ edits: [{ op: "remove", id: "n3" }] }, { edits: [{ op: "remove", id: "n3" }] });
    const refused = await revise({ instruction: "remove the question about the business" });
    assert.equal(refused.status, 422);
    assert.match(refused.body.message, /^Riwo couldn't make that change: Step "n3" sends the chat different ways.* Say it another way, or add the question yourself below\.$/);
    assert.ok(!/\.\./.test(refused.body.message), "no doubled full stops");
    // an answer with no edits in it is not "done"
    replies.push({ edits: [] }, { edits: [] });
    assert.equal((await revise({ instruction: SAID })).status, 422);
  });

  await t.test("when it needs the owner to decide, Riwo asks and nothing is changed", async () => {
    replies.push({ clarify: [{ question: "Should the question also be asked of people who answered Other?", choices: ["Yes", "No"] }] });
    const res = await revise({ instruction: SAID });
    assert.equal(res.status, 200);
    assert.equal(res.body.clarify[0].choices.length, 2);
    assert.equal(res.body.draft, undefined);
  });

  await t.test("without Riwo at all, the owner can still add a question from the form", async () => {
    asked.length = 0;
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      // words need Riwo, and say so with the way out
      const words = await revise({ instruction: SAID });
      assert.equal(words.status, 503);
      assert.match(words.body.message, /add a question below/);
      // the form does not
      const res = await revise({ addQuestion: { question: "Where did you hear about us?" } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(asked.length, 0, "nothing was asked of a model");
      assert.equal(added(res), "Added: Where did you hear about us?");
      keepsEverythingElse(res);
      // after the last question (the business type), before what followed it, and the owners' note carries the answer
      const wf = res.body.draft.rule.config.workflow.nodes;
      const id = Object.keys(wf).find((k) => wf[k].saveAs === "hear");
      assert.deepEqual(outlineIds(res).slice(0, 5), ["n1", "n2", "n3", id, "n4"]);
      assert.match(wf.n7.text, /Business type: \{\{business_type\}\}\. Hear: \{\{hear\}\}\.$/);
      assert.match(res.body.draft.understood, /Adds the question “Where did you hear about us\?”/);
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  await t.test("the form can put the question anywhere, leave the note alone, and says what is wrong with a bad request", async () => {
    const placed = await revise({ addQuestion: { question: "Which city are you in?", before: "n5", tell: false } });
    assert.equal(placed.status, 200, JSON.stringify(placed.body));
    const wf = placed.body.draft.rule.config.workflow.nodes;
    const id = Object.keys(wf).find((k) => wf[k].saveAs === "city");
    assert.deepEqual(outlineIds(placed).slice(2, 7), ["n3", "n4", id, "n5", "n6"]);
    assert.equal(wf.n7.text, FLOW.nodes.n7.text);
    assert.equal((await revise({ addQuestion: { question: "Which city?", before: "nope" } })).status, 400);
    const unknown = await revise({ addQuestion: { question: "Which city?", before: "nope" } });
    assert.match(unknown.body.message, /There is no step to put it before "nope"\. The steps are: n1/);
    assert.equal((await revise({ addQuestion: { question: " " } })).status, 400);
    assert.equal((await revise({ addQuestion: { question: "x".repeat(301) } })).status, 400);
    // asking twice for the same thing makes a second step with its own name, not a clash
    const rule = placed.body.draft.rule;
    const twice = await request(app).post("/api/automations/workflow/revise").set(owner).send({ rule, addQuestion: { question: "Which city are you in?" } });
    assert.equal(twice.status, 200, JSON.stringify(twice.body));
    assert.ok(Object.values(twice.body.draft.rule.config.workflow.nodes).some((n) => n.saveAs === "city_2"));
  });

  await t.test("a workflow that is not saved yet and one with test mode on are both changed without losing either", async () => {
    const res = await revise({ addQuestion: { question: "Which city are you in?" } });
    assert.deepEqual(res.body.draft.rule.config.pilot, { enabled: true, phones: ["919800000099"] });
    assert.ok(res.body.draft.guardrails.length > 0 && res.body.draft.when.startsWith("Starts when a message contains: website"));
  });
});

test("What a model answers with is read in every shape it uses", () => {
  const flow = { start: "n1", nodes: { n1: { type: "say", text: "Hi", next: "n2" }, n2: { type: "end" } } };
  // edits, in the names models use
  for (const key of ["edits", "ops", "changes"]) assert.equal(tidyRevision(JSON.stringify({ [key]: [{ op: "rename", name: "x" }], understood: "<b>ok</b>" })).edits.length, 1);
  assert.equal(tidyRevision(JSON.stringify({ edits: [{ op: "rename" }, "junk", null, [1]] })).edits.length, 1);
  assert.deepEqual(tidyRevision('{"edits":[]}').edits, []);
  assert.equal(tidyRevision(JSON.stringify({ edits: [], understood: "<b>ok</b>" })).understood, "ok");
  // questions for the owner
  assert.equal(tidyRevision(JSON.stringify({ clarify: [{ question: "Which step should it go after?", choices: ["a", "b"] }] })).clarify.length, 1);
  // the whole flow, in the three shapes
  assert.ok(tidyRevision(JSON.stringify({ rule: { name: "x", workflow: flow } })).draft);
  const echoed = tidyRevision(JSON.stringify({ name: "x", trigger: { type: "keyword", keywords: ["a"] }, workflow: flow }));
  assert.equal(echoed.draft.trigger.type, "keyword");
  assert.equal(echoed.draft.trigger.explicit, true);
  const bare = tidyRevision(JSON.stringify(flow));
  assert.equal(bare.draft.trigger.explicit, false, "no trigger was given, so the one the flow had is kept");
  // nothing usable
  for (const bad of ["", "sorry", "{}", '{"rule":{"name":"x"}}', '{"unrelated":true}', "[1,2]"]) assert.equal(tidyRevision(bad), null, bad);
  assert.equal(tidyWorkflowDraft('{"name":"x","workflow":"nodes"}'), null);
});

test("The flow is shown to the model as plain lines it can point at", async () => {
  const { cleanWorkflow } = await import("../src/services/workflow/schema.js");
  const wf = (await cleanWorkflow(FLOW)).workflow;
  const text = listSteps({ trigger: { type: "returning" }, workflow: wf });
  assert.match(text, /^Starts when: returning\nFirst step: n1\n/);
  assert.match(text, /n2 collect: "Could you tell us what you need for your website or marketing\?" \(saves as requirement\) -> n3/);
  assert.match(text, /n5 meeting: "What day and time would suit you for a call\?" -> n6/);
  assert.match(text, /n7 notify owners: ".*" -> n8/);
  assert.match(text, /\nn8 end$|\nhandoff_unclear handoff \(unclear\)$/m);
  const long = listSteps({ trigger: { type: "first_message" }, workflow: { start: "a", nodes: { a: { type: "say", text: "x".repeat(900), next: null } } } });
  assert.ok(long.length < 500, "a long message is cut short in the list");
});
