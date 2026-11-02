import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { setAiClient, tidyDraft } from "../src/services/aiService.js";
import { cleanRule } from "../src/services/automationRules.js";
import { closeSessions } from "../src/services/sessionService.js";

test("What Riwo returns is cut down to what an agent rule can hold", () => {
  assert.deepEqual(tidyDraft(JSON.stringify({ clarify: ["What do you sell?", "x", "Who are your customers?", "Should it quote prices?", "Fourth question here?"] })), { clarify: ["What do you sell?", "Who are your customers?", "Should it quote prices?"] });
  assert.equal(tidyDraft(JSON.stringify({ clarify: [] })), null);
  const d = tidyDraft(JSON.stringify({ rule: { name: "Demo <b>booker</b>", trigger: "keyword", goal: "Book demos", playbook: "Be brief.", close_with: "teleport", pricing: "always", follow_up_hours: 500, handoff_message: "Passing you on.", formal_message: "Thanks {{first_name}}, {{executive}} will call.", stage_name: "Proposal", understood: "You want demos." } })).draft;
  assert.deepEqual([d.name, d.trigger, d.closeWith, d.pricing, d.followUpHours], ["Demo booker", "first_message", "handoff", "handoff", 2], "anything Riwo makes up falls back to the safe choice");
  assert.equal(tidyDraft(JSON.stringify({ rule: { name: "x" } })), null, "a rule with no goal and no playbook is nothing");
  assert.equal(tidyDraft("not json"), null);
});

test("Describe it in your own words: Riwo asks what it needs, then drafts an agent the owner can edit", async (t) => {
  const key = process.env.ANTHROPIC_API_KEY;
  const or = process.env.OPENROUTER_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  const asked = [];
  let reply = () => ({ clarify: ["Which of your products should it talk about?", "Should it quote prices, or pass price questions to your team?"] });
  const respond = async (params) => {
    asked.push(params);
    return { content: [{ type: "text", text: JSON.stringify(reply(params)) }], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 120 } };
  };
  setAiClient({ messages: { create: respond }, beta: { messages: { create: respond } } });
  t.after(async () => {
    setAiClient(undefined);
    key === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = key);
    if (or !== undefined) process.env.OPENROUTER_API_KEY = or;
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@draft.test", password: "Password@123", companyName: "Scriza" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  const agent = (await registerTenantAndUser({ name: "Sam", email: "sam@draft.test", password: "Password@123", companyName: "Sam's" })).user;
  await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, agent.id]);
  const post = (body, who = owner) => request(app).post("/api/automations/draft").set(who).send(body);

  await t.test("a vague request gets a few short questions, and nothing is saved", async () => {
    const res = await post({ instruction: "Reply to people who message us and sell our products" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.clarify, ["Which of your products should it talk about?", "Should it quote prices, or pass price questions to your team?"]);
    assert.equal((await query("SELECT count(*)::int AS n FROM automations WHERE tenant_id=$1", [tenantId])).rows[0].n, 0);
    assert.match(asked.at(-1).messages[0].content, /<owner_words>\nReply to people who message us/);
    assert.match(asked.at(-1).messages[0].content, /The company has no knowledge base yet\./);
  });

  await t.test("with the owner's answers it drafts an agent, checked by the same rules, and says what it understood", async () => {
    reply = (p) => {
      assert.match(p.messages[0].content, /Q: Which of your products should it talk about\?\nA: All of them, mostly the CRM/);
      return { rule: { name: "Scriza sales agent", trigger: "first_message", goal: "Find out what the customer needs, recommend the right Scriza product and book a demo", playbook: "Warm and brief. Ask one question at a time. Never quote a price.", close_with: "book_demo", pricing: "handoff", handoff_message: "Thanks, I've passed this to our team.", formal_message: "Thank you, {{first_name}}. {{executive}} will confirm your demo shortly.", follow_up_hours: 1, stage_name: "Proposal", understood: "You want Riwo to qualify new customers, recommend a product and book a demo, and leave prices to your team." } };
    };
    const res = await post({ instruction: "Reply to people who message us and sell our products", answers: [{ question: "Which of your products should it talk about?", answer: "All of them, mostly the CRM" }, { question: "Should it quote prices, or pass price questions to your team?", answer: "Pass them to the team" }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.problem, "");
    assert.deepEqual(res.body.needs, ["knowledge"], "there is no knowledge base yet, so the screen asks for one");
    assert.match(res.body.understood, /qualify new customers/);
    const d = res.body.draft;
    assert.deepEqual([d.triggerType, d.actionType, d.name], ["first_message", "ai_chat", "Scriza sales agent"]);
    assert.deepEqual(d.config.agent, { enabled: true, goal: "Find out what the customer needs, recommend the right Scriza product and book a demo", playbook: "Warm and brief. Ask one question at a time. Never quote a price.", closeWith: "book_demo", pricing: "handoff" });
    assert.deepEqual([d.config.sales.followUpHours, d.config.sales.stageName], [1, "Proposal"]);
    // and it is a rule the app can save as it is, once there is something to talk from
    const saved = await cleanRule({ ...d, config: { ...d.config, knowledge: "Scriza builds business software for companies in the UAE and India." } }, { teammate: async () => true });
    assert.equal(saved.config.agent.closeWith, "book_demo");
    assert.equal((await query("SELECT count(*)::int AS n FROM automations WHERE tenant_id=$1", [tenantId])).rows[0].n, 0, "drafting saves nothing");
  });

  await t.test("with a knowledge base the draft uses it", async () => {
    await query("INSERT INTO knowledge_profile(tenant_id,overview) VALUES($1,'Scriza builds business software for companies.')", [tenantId]);
    await query("INSERT INTO knowledge_sources(tenant_id,url,status,pages) VALUES($1,'https://scriza.example','ready',1)", [tenantId]);
    reply = () => ({ rule: { name: "Demo agent", trigger: "first_message", goal: "Answer product questions and book a demo", playbook: "Friendly.", close_with: "book_demo", pricing: "handoff", understood: "ok" } });
    const res = await post({ instruction: "Answer product questions and book a demo with anyone who asks" });
    assert.deepEqual(res.body.needs, []);
    assert.equal(res.body.draft.config.useKnowledge, true);
    assert.match(asked.at(-1).messages[0].content, /already has a knowledge base/);
  });

  await t.test("it refuses what it cannot use, and who may ask", async () => {
    assert.equal((await post({ instruction: "hi" })).status, 400);
    assert.equal((await post({ instruction: "x".repeat(2001) })).status, 400);
    assert.equal((await post({ instruction: "Sell our products and book demos" }, { Authorization: `Bearer ${generateAccessToken(agent, tenantId, "agent")}` })).status, 403);
    reply = () => ({ nonsense: true });
    assert.equal((await post({ instruction: "Sell our products and book demos" })).status, 502);
    await query("UPDATE tenants SET ai_enabled=false WHERE id=$1", [tenantId]);
    assert.equal((await post({ instruction: "Sell our products and book demos" })).status, 403);
    await query("UPDATE tenants SET ai_enabled=true WHERE id=$1", [tenantId]);
  });

  await t.test("after three rounds it stops asking and writes the rule", async () => {
    const qa = [1, 2, 3].map((i) => ({ question: `Question ${i}?`, answer: `Answer ${i}` }));
    reply = () => ({ rule: { name: "Agent", trigger: "first_message", goal: "Help customers", playbook: "", close_with: "handoff", pricing: "handoff", understood: "ok" } });
    await post({ instruction: "Sell our products and book demos", answers: qa });
    assert.match(asked.at(-1).messages[0].content, /Do not ask more questions: write the rule now\./);
  });
});
