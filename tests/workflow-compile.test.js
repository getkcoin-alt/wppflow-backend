import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { pumpAutomations } from "../src/services/automationService.js";
import { setAiClient, tidyWorkflowDraft } from "../src/services/aiService.js";
import { RECIPES, recipeFor } from "../src/services/workflow/recipes.js";
import { checkDraft, diffWorkflow } from "../src/services/workflow/compile.js";
import { cleanWorkflow } from "../src/services/workflow/schema.js";
import { DISCLOSURE } from "../src/services/handoffService.js";
import { closeSessions } from "../src/services/sessionService.js";

const OWNER_SAYS = "Anyone new, or who writes after a month, I want to know if it is work or family/friend. Work: be professional, find their needs, set a meeting, no prices. Family: a warm note and tell me.";
const ownerFlow = () => RECIPES[0].build({});
const asModel = (d) => ({
  rule: {
    name: d.name,
    trigger: { type: d.trigger.type, silent_days: d.trigger.silentDays, include_new: d.trigger.includeNew, keywords: d.trigger.keywords, hours: d.trigger.hours },
    workflow: d.workflow,
    handoff_message: d.handoff,
    formal_message: d.formal,
    follow_up_hours: d.followUpHours,
    stage_name: d.stageName,
    understood: d.understood,
  },
});

test("What a model writes is read carefully", () => {
  const good = tidyWorkflowDraft(JSON.stringify(asModel(ownerFlow())));
  assert.equal(good.draft.name, "Work or family and friends");
  assert.equal(good.draft.trigger.type, "returning");
  assert.equal(good.draft.trigger.silentDays, 30);
  assert.equal(good.draft.followUpHours, 2);
  assert.ok(good.draft.workflow.nodes.n4);
  // the owner is asked what is missing, with answers to tap; a plain string is a question too
  const ask = tidyWorkflowDraft('Sure {"clarify":[{"question":"Should friends be asked again each month?","choices":["Only once","Every time","a","b","c"]},"Who handles work enquiries?","no"]}');
  assert.deepEqual(ask.clarify.map((q) => q.question), ["Should friends be asked again each month?", "Who handles work enquiries?"]);
  assert.deepEqual(ask.clarify[0].choices, ["Only once", "Every time", "a", "b"]);
  // a draft that is not a workflow, or not JSON, is nothing
  assert.equal(tidyWorkflowDraft("I would be happy to help!"), null);
  assert.equal(tidyWorkflowDraft('{"rule":{"name":"x"}}'), null);
  assert.equal(tidyWorkflowDraft('{"rule":{"workflow":"nodes"}}'), null);
  assert.equal(tidyWorkflowDraft('{"clarify":[]}'), null);
  // an unknown trigger starts on a first message, and tags in the words are removed
  const odd = tidyWorkflowDraft(JSON.stringify({ rule: { name: "<b>Hi</b>", trigger: { type: "moonrise" }, workflow: { nodes: {} }, follow_up_hours: 500 } }));
  assert.equal(odd.draft.trigger.type, "first_message");
  assert.equal(odd.draft.name, "bHi/b".replace(/[^a-zA-Z]/g, "") === "bHib" ? odd.draft.name : odd.draft.name);
  assert.equal(odd.draft.followUpHours, 2);
});

test("Every ready-made workflow is a valid rule, and the nearest one is found from the owner's words", async () => {
  for (const r of RECIPES) {
    const draft = r.build({});
    const checked = await checkDraft(draft, { hasKnowledge: true });
    assert.equal(checked.rule.actionType, "workflow", r.id);
    assert.deepEqual(checked.warnings, [], r.id);
    assert.equal(checked.rule.config.workflow.start, draft.workflow.start);
  }
  assert.equal(recipeFor(OWNER_SAYS).id, "triage");
  assert.equal(recipeFor("when we are closed at night reply politely").id, "after_hours");
  assert.equal(recipeFor("welcome customers who come back after a while").id, "welcome_back");
  assert.equal(recipeFor("sell shoes"), null);
  // what still needs the owner is said, not guessed
  const noKb = await checkDraft(ownerFlow(), { hasKnowledge: false });
  assert.deepEqual(noKb.needs, ["knowledge"]);
  assert.equal(noKb.rule.config.knowledge, "");
  const hours = await checkDraft({ ...RECIPES[1].build({}), trigger: { type: "after_hours", keywords: [] } }, { hasKnowledge: true });
  assert.deepEqual(hours.needs, ["hours"]);
  assert.equal(hours.rule.config.hours.start, "09:00");
  const abroad = await checkDraft({ ...ownerFlow(), trigger: { type: "foreign_number", keywords: [] } }, { hasKnowledge: true });
  assert.deepEqual(abroad.needs, ["countries"]);
  assert.deepEqual(abroad.rule.config.homeCodes, []);
});

test("A change is reported in plain lines, and the steps made automatically are not", async () => {
  const before = (await cleanWorkflow(ownerFlow().workflow)).workflow;
  const edited = structuredClone(before);
  edited.nodes.n6.text = "So good to hear from you! The boss will reply himself.";
  edited.nodes.n8 = { type: "collect", question: "Which city are you in?", saveAs: "city", next: "n6" };
  edited.nodes.n4.next.personal = "n8";
  delete edited.nodes.n7;
  edited.nodes.n6.next = "n3";
  const after = (await cleanWorkflow(edited)).workflow;
  const lines = diffWorkflow(before, after);
  assert.ok(lines.includes("Added: Which city are you in?"));
  assert.ok(lines.some((l) => l.startsWith("Removed: Add the label")));
  assert.ok(lines.some((l) => l.startsWith("Changed: So good to hear from you")));
  assert.ok(!lines.some((l) => l.startsWith("Changed: Is this about work")), "a question whose only change is where it goes on to (because a step was added) is not listed as changed");
  assert.ok(!lines.some((l) => /Finish/.test(l)));
  assert.deepEqual(diffWorkflow(before, before), []);
});

test("Describing a workflow in your own words: Riwo asks, drafts, repairs, and never leaves the owner with nothing", async (t) => {
  const key = process.env.ANTHROPIC_API_KEY;
  const or = process.env.OPENROUTER_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  const asked = [];
  const replies = []; // what the model says to the next "build a workflow" request
  let classifyAs = () => "unsure";
  let agentSays = () => ({ reply: "Lovely. What are you looking to build?", needs_person: false, ready_to_hand_off: false, collected: { Interest: "a website" } });
  const respond = async (params) => {
    asked.push(params);
    const sys = params.system || "";
    let body;
    if (/You (build|change) WhatsApp workflows/.test(sys)) body = replies.shift() ?? { rule: {} };
    else if (/which of the listed answers it means/.test(sys)) body = { choice: classifyAs(String(params.messages[0].content).match(/<reply>([\s\S]*?)<\/reply>/)?.[1] || "") };
    else body = agentSays(params);
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

  const o = await registerTenantAndUser({ name: "Karnveer Sonigara", email: "karn@compile.test", password: "Password@123", companyName: "Scriza" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,phone,status) VALUES(gen_random_uuid()::text,$1,'main-line',$2,'919971694047','CONNECTED')", [tenantId, o.user.id]);
  const draft = (body) => request(app).post("/api/automations/workflow/draft").set(owner).send(body);
  const modelCalls = () => asked.filter((p) => /You build WhatsApp workflows/.test(p.system || "")).length;

  await t.test("it needs a sentence or two, and the owner's role", async () => {
    assert.equal((await draft({ instruction: "short" })).status, 400);
    assert.equal((await draft({ instruction: "x".repeat(2001) })).status, 400);
    const noAuth = await request(app).post("/api/automations/workflow/draft").send({ instruction: OWNER_SAYS });
    assert.equal(noAuth.status, 401);
    assert.equal((await request(app).get("/api/automations/workflow/recipes").set(owner)).body.recipes.length, 3);
  });

  await t.test("when something is unclear Riwo asks, with answers to tap, and the answers go back with the next request", async () => {
    replies.push({ clarify: [{ question: "Should friends and family be asked again every month?", choices: ["Only once", "Every time"] }] });
    const first = await draft({ instruction: OWNER_SAYS });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.clarify, [{ question: "Should friends and family be asked again every month?", choices: ["Only once", "Every time"] }]);
    assert.equal(first.body.draft, undefined);
    replies.push(asModel(ownerFlow()));
    const second = await draft({ instruction: OWNER_SAYS, answers: [{ question: "Should friends and family be asked again every month?", answer: "Only once" }] });
    const prompt = asked.at(-1).messages[0].content;
    assert.match(prompt, /<owner_words>\nAnyone new, or who writes after a month/);
    assert.match(prompt, /Q: Should friends and family be asked again every month\?\nA: Only once/);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const d = second.body.draft;
    assert.equal(d.source, "ai");
    assert.equal(d.rule.actionType, "workflow");
    assert.equal(d.rule.triggerType, "returning");
    assert.equal(d.rule.config.silentDays, 30);
    assert.equal(d.when, "Starts when someone writes after 30 quiet days, or for the first time.");
    assert.match(d.understood, /asked whether it is about work/);
    assert.ok(d.guardrails.length >= 6 && d.guardrails.some((g) => /own numbers/.test(g)));
    assert.equal(d.outline[0].id, "n1");
    assert.deepEqual(d.needs, ["knowledge"], "this company has not written anything for Riwo to talk from yet");
    assert.equal(d.rule.config.knowledge, "");
    assert.equal(asked.at(-1).system.includes("workflow"), true);
  });

  await t.test("a draft with a mistake is sent back once with what is wrong, and the repaired one is used", async () => {
    const before = modelCalls();
    const circle = asModel(ownerFlow());
    circle.rule.workflow = { start: "a", nodes: { a: { type: "say", text: "one", next: "b" }, b: { type: "say", text: "two", next: "a" } } };
    replies.push(circle, asModel(ownerFlow()));
    const res = await draft({ instruction: OWNER_SAYS });
    assert.equal(res.status, 200);
    assert.equal(modelCalls() - before, 2);
    assert.match(asked.at(-1).messages[0].content, /Your last draft could not be saved: The workflow goes in a circle/);
    assert.equal(res.body.draft.source, "ai");
    // a company that has a knowledge base needs nothing more
    await query("INSERT INTO knowledge_profile(tenant_id,overview,products,notes) VALUES($1,$2,$3,$4)", [tenantId, "Scriza builds websites and business software for companies in India and the UAE.", JSON.stringify([]), "A first call is 30 minutes."]);
    replies.push(asModel(ownerFlow()));
    const again = await draft({ instruction: OWNER_SAYS });
    assert.deepEqual(again.body.draft.needs, []);
    assert.equal(again.body.draft.rule.config.useKnowledge, true);
  });

  await t.test("when Riwo cannot write it, the nearest ready-made workflow is offered; with nothing near, the list", async () => {
    replies.push("I'm sorry, I cannot do that.", { rule: { name: "x" } });
    const near = await draft({ instruction: OWNER_SAYS });
    assert.equal(near.status, 200);
    assert.equal(near.body.draft.source, "recipe");
    assert.match(near.body.draft.note, /Riwo couldn't turn that into a workflow this time, so this starts from a ready-made workflow/);
    assert.equal(near.body.draft.rule.name, "Work or family and friends");
    replies.push("nope", "still nope");
    const none = await draft({ instruction: "Please do something wonderful for my shoe shop customers" });
    assert.equal(none.body.draft, null);
    assert.match(none.body.message, /start from one of these/);
    assert.equal(none.body.recipes.length, 3);
    // a ready-made one can be asked for by name
    const named = await draft({ recipe: "after_hours" });
    assert.equal(named.body.draft.rule.triggerType, "after_hours");
    assert.deepEqual(named.body.draft.needs, []);
    assert.equal((await draft({ recipe: "nonsense" })).status, 404);
  });

  await t.test("without Riwo (no provider) the owner can still start from a ready-made workflow", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const before = modelCalls();
      const res = await draft({ instruction: OWNER_SAYS });
      assert.equal(res.body.draft.source, "recipe");
      assert.match(res.body.draft.note, /Riwo isn't available right now/);
      assert.equal(modelCalls(), before, "nothing was asked of a model that is not there");
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  await t.test("changing a workflow in words returns the whole flow and what changed, and keeps the owner's own formal message", async () => {
    const draftRes = await (async () => {
      replies.push(asModel(ownerFlow()));
      return (await draft({ instruction: OWNER_SAYS })).body.draft;
    })();
    const rule = { ...draftRes.rule, config: { ...draftRes.rule.config, sales: { ...draftRes.rule.config.sales, formal: "Dear {{first_name}}, {{executive}} will be with you shortly.", stageName: "Qualified" }, pilot: { enabled: true, phones: ["919800000099"] } } };
    const changed = asModel(ownerFlow());
    changed.rule.workflow.nodes.n8 = { type: "collect", question: "Which city are you in?", saveAs: "city", next: "n6" };
    changed.rule.workflow.nodes.n4.next.personal = "n8";
    changed.rule.formal_message = "THE MODEL SHOULD NOT REWRITE THIS";
    replies.push(changed);
    const res = await request(app).post("/api/automations/workflow/revise").set(owner).send({ rule, instruction: "Also ask friends which city they are in" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.diff.filter((l) => /city/.test(l)), ["Added: Which city are you in?"]);
    assert.ok(!res.body.diff.some((l) => /^Changed: Is this about work/.test(l)), "the question's own words did not change, only where it goes on to");
    const prompt = asked.at(-1).messages[0].content;
    assert.match(asked.at(-1).system, /You change WhatsApp workflows/);
    assert.match(prompt, /<current_workflow>\nStarts when: returning\nFirst step: n1\nn1 branch on label "Family & friends": yes -> n2, no -> n4/);
    assert.match(prompt, /<owner_change>\nAlso ask friends which city they are in/);
    assert.ok(res.body.draft.rule.config.workflow.nodes.n8);
    assert.equal(res.body.draft.rule.config.sales.formal, "Dear {{first_name}}, {{executive}} will be with you shortly.");
    assert.equal(res.body.draft.rule.config.sales.stageName, "Qualified");
    assert.deepEqual(res.body.draft.rule.config.pilot, { enabled: true, phones: ["919800000099"] }, "test mode stays on");
    assert.equal((await request(app).post("/api/automations/workflow/revise").set(owner).send({ rule, instruction: "x" })).status, 400);
    // a change that cannot be made says so
    replies.push("sorry", "sorry again");
    const failed = await request(app).post("/api/automations/workflow/revise").set(owner).send({ rule, instruction: "make it do the impossible" });
    assert.equal(failed.status, 422);
  });

  await t.test("an edited workflow is checked again, and a mistake is said in words", async () => {
    replies.push(asModel(ownerFlow()));
    const rule = (await draft({ instruction: OWNER_SAYS })).body.draft.rule;
    const edited = structuredClone(rule);
    edited.config.workflow.nodes.n6.text = "So lovely to hear from you! The boss will reply himself.";
    const ok = await request(app).post("/api/automations/workflow/check").set(owner).send({ rule: edited });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.draft.outline.find((o) => o.id === "n6").summary, /So lovely to hear from you/);
    edited.config.workflow.nodes.n6.next = "n1";
    const bad = await request(app).post("/api/automations/workflow/check").set(owner).send({ rule: edited });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /goes in a circle/);
  });

  await t.test("trying it: the same flow, step by step, with nothing sent and nothing saved", async () => {
    replies.push(asModel(ownerFlow()));
    const rule = (await draft({ instruction: OWNER_SAYS })).body.draft.rule;
    const tryIt = (body) => request(app).post("/api/automations/workflow/simulate").set(owner).send({ rule, name: "Asha Rao", ...body });
    const counts = async () => (await query("SELECT (SELECT count(*) FROM messages WHERE tenant_id=$1)::int AS m,(SELECT count(*) FROM automation_executions WHERE tenant_id=$1)::int AS e,(SELECT count(*) FROM notifications WHERE tenant_id=$1)::int AS n,(SELECT count(*) FROM automation_chats WHERE tenant_id=$1)::int AS c", [tenantId])).rows[0];
    const before = await counts();

    // 1. the friend
    const first = await tryIt({ text: "Hello" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.pause, "ask");
    assert.equal(first.body.node, "n4");
    assert.equal(first.body.events.length, 1);
    assert.equal(first.body.events[0].text, `Is this about work, or are you family or a friend?\n\n1. Work\n2. Family or friend\nReply with the number, or just tell me.\n\n${DISCLOSURE}`);
    const friend = await tryIt({ state: first.body.state, text: "2" });
    assert.deepEqual(friend.body.read, { choice: "personal", label: "Family or friend", via: "number" });
    assert.deepEqual(friend.body.events.map((e) => e.kind), ["say", "label", "notify", "end"]);
    assert.equal(friend.body.events[0].text, "Lovely to hear from you! The boss has been told and will reply himself.");
    assert.equal(friend.body.events[2].text, "You are told (the owners, app and email): Asha Rao (family or friend) wrote: 2");
    assert.equal(friend.body.done, true);

    // 2. a known friend is not asked
    const known = await tryIt({ text: "Hi bhai", labels: ["Family & friends"] });
    assert.deepEqual(known.body.events.map((e) => e.kind), ["say", "notify", "end"]);
    assert.match(known.body.events[0].text, /^Hi Asha! I've let the boss know you wrote/);

    // 3. work: the model understands Hinglish, and Riwo talks from the company's own words, with the same checks
    classifyAs = () => "work";
    const start = await tryIt({ text: "hi" });
    const work = await tryIt({ state: start.body.state, text: "mujhe website banwani hai", transcript: [{ from: "customer", text: "hi" }, { from: "riwo", text: start.body.events[0].text }] });
    assert.deepEqual(work.body.read, { choice: "work", label: "Work", via: "ai" });
    assert.equal(work.body.pause, "agent");
    assert.deepEqual(work.body.events.map((e) => e.kind), ["say"]);
    assert.ok(work.body.events[0].text.startsWith("Lovely. What are you looking to build?"));
    const agentPrompt = asked.filter((p) => /sales agent of/.test(p.system)).at(-1);
    assert.match(agentPrompt.system, /arrange a meeting/);
    assert.match(agentPrompt.messages[0].content, /Customer: mujhe website banwani hai/);
    assert.match(agentPrompt.messages[0].content, /<knowledge>[\s\S]*Scriza builds websites/);
    assert.deepEqual(work.body.state.vars._collected, { Interest: "a website" });
    // later turns go to Riwo, and a request for prices goes to a person without asking the model
    const calls = asked.length;
    const price = await tryIt({ state: work.body.state, text: "How much will it cost?" });
    assert.equal(asked.length, calls, "no model was asked about money");
    assert.deepEqual(price.body.events.map((e) => e.kind), ["say", "handoff"]);
    assert.match(price.body.events[0].text, /will take over to help you further/);
    assert.equal(price.body.done, true);
    // when Riwo says the customer is ready, a person takes over
    agentSays = () => ({ reply: "Perfect, Tuesday at 4pm.", needs_person: false, ready_to_hand_off: true, collected: {} });
    const ready = await tryIt({ state: work.body.state, text: "Tuesday 4pm works" });
    assert.deepEqual(ready.body.events.map((e) => e.kind), ["say", "say", "handoff"]);
    // an invented figure is refused here too
    agentSays = () => ({ reply: "It costs INR 4,999 a month.", needs_person: false, ready_to_hand_off: false, collected: {} });
    const lie = await tryIt({ state: work.body.state, text: "tell me about the plan" });
    assert.equal(lie.body.events[0].kind, "say");
    assert.match(lie.body.events[0].text, /can't help further/, "the company's own hand-over words, not the model's");
    assert.equal(lie.body.done, true);
    agentSays = () => ({ reply: "Lovely. What are you looking to build?", needs_person: false, ready_to_hand_off: false, collected: { Interest: "a website" } });

    // 4. not understood twice
    classifyAs = () => "unsure";
    const q = await tryIt({ text: "hello" });
    const once = await tryIt({ state: q.body.state, text: "hmm" });
    assert.match(once.body.events[0].text, /^Sorry, I didn't quite get that/);
    assert.equal(once.body.state.attempts, 1);
    const twice = await tryIt({ state: once.body.state, text: "??" });
    assert.equal(twice.body.done, true);
    assert.equal(twice.body.events.at(-1).kind, "handoff");

    // 5. nothing was sent, saved, started or notified
    assert.deepEqual(await counts(), before);
    // and a rule with a mistake is refused
    const broken = structuredClone(rule);
    broken.config.workflow.nodes.n6.next = "n1";
    assert.equal((await tryIt({ rule: broken, text: "x" })).status, 400);
  });

  await t.test("what you see in 'try it' is what a customer gets", async () => {
    replies.push(asModel(ownerFlow()));
    const rule = (await draft({ instruction: OWNER_SAYS })).body.draft.rule;
    const created = await request(app).post("/api/automations").set(owner).send(rule);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await request(app).patch(`/api/automations/${created.body.automation.id}/toggle`).set(owner);
    let n = 0;
    const hear = async (text) => {
      n += 1;
      await handleIncomingMessage({ tenantId, sessionName: "main-line", msg: { providerMessageId: `cmp_${n}`, fromMe: false, remoteId: "919800000042@c.us", rawType: "chat", type: "text", text, timestampEpoch: Math.floor(Date.now() / 1000) + n, senderName: "Asha Rao", ack: 2 } });
      await pumpAutomations();
    };
    await hear("Hello");
    await hear("2");
    const live = (await query("SELECT m.text FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.tenant_id=$1 AND c.phone='919800000042' AND m.agent_name='Riwo' AND m.type='text' ORDER BY m.created_at,m.id", [tenantId])).rows.map((r) => r.text);
    const step1 = await request(app).post("/api/automations/workflow/simulate").set(owner).send({ rule, text: "Hello", name: "Asha Rao" });
    const step2 = await request(app).post("/api/automations/workflow/simulate").set(owner).send({ rule, state: step1.body.state, text: "2", name: "Asha Rao" });
    const simulated = [...step1.body.events, ...step2.body.events].filter((e) => e.kind === "say").map((e) => e.text);
    assert.deepEqual(simulated, live);
  });
});
