import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage, sendTextMessage } from "../src/services/messageService.js";
import { pumpAutomations } from "../src/services/automationService.js";
import { cleanRule } from "../src/services/automationRules.js";
import { assignConversation } from "../src/services/assignmentService.js";
import { asksForCommercial, nextQuestion, withAnswer } from "../src/services/salesAssistant.js";
import { setAiClient } from "../src/services/aiService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { DISCLOSURE } from "../src/services/handoffService.js";

const KNOWLEDGE = "Chat Co is a property brokerage in Dubai Marina. We help people buy, sell and rent apartments. We are open Sunday to Thursday.";
const QUESTIONS = ["What are you looking for?", "How many do you need, and where?", "When do you need it by?"];
const FORMAL = "Thank you for your interest, {{first_name}}. Our executive {{executive}} has been assigned to review your requirements and will share the proposal and pricing with you shortly.";

test("Words that ask for a price, a quote or a proposal, in four languages, and the answers that are not requests", () => {
  for (const text of [
    "What are your prices?",
    "Can you send me a quotation",
    "I need a proposal for 3 flats",
    "how much does it cost",
    "please share the price list",
    "ما هي الأسعار؟",
    "أحتاج عرض سعر",
    "कीमत क्या है",
    "mujhe quotation chahiye",
    "rate kya hai bhai",
    "kitna lagega?",
  ])
    assert.equal(asksForCommercial(text), true, text);
  for (const text of ["Hello", "I am looking for a 2 bedroom apartment", "Next month please", "Thanks, that is great", "", null, "x".repeat(700) + " price"])
    assert.equal(asksForCommercial(text), false, String(text).slice(0, 40));
  // the company asked about budget, so "around 5000" answers it; only a request hands over
  assert.equal(asksForCommercial("around 5000 AED", { lastQuestion: "Do you have a budget range in mind?" }), false);
  assert.equal(asksForCommercial("price is not a problem, maybe 5000", { lastQuestion: "Do you have a budget range in mind?" }), false);
  assert.equal(asksForCommercial("can you send me the price list?", { lastQuestion: "Do you have a budget range in mind?" }), true);
  assert.equal(asksForCommercial("what is the price?", { lastQuestion: "When do you need it by?" }), true);
});

test("Answers are kept per question, once, in order", () => {
  let r = [];
  r = withAnswer(r, QUESTIONS, 2, "3 flats, Marina");
  assert.deepEqual(r.map((x) => x.n), [2]);
  assert.equal(nextQuestion(QUESTIONS, r), 1, "the first question without an answer");
  r = withAnswer(r, QUESTIONS, 1, "  buy\n an apartment ");
  assert.equal(r[0].answer, "buy an apartment");
  r = withAnswer(r, QUESTIONS, 2, "changed my mind");
  assert.equal(r.find((x) => x.n === 2).answer, "3 flats, Marina", "an answer already kept is not overwritten");
  assert.deepEqual(withAnswer(r, QUESTIONS, 9, "nonsense"), r, "a question that does not exist is ignored");
  assert.deepEqual(withAnswer(r, QUESTIONS, 3, "   "), r);
  assert.equal(nextQuestion(QUESTIONS, withAnswer(r, QUESTIONS, 3, "March")), 0, "none left");
});

test("A sales rule is checked before it is saved", async () => {
  const yes = async () => true;
  const base = { name: "Sales", triggerType: "first_message", actionType: "ai_chat", config: { reply: "Welcome {{first_name}}", knowledge: KNOWLEDGE } };
  const withSales = (sales, extra = {}) => cleanRule({ ...base, config: { ...base.config, ...extra, sales } }, { teammate: yes });
  const ok = await withSales({ enabled: true, questions: QUESTIONS, formal: FORMAL, followUpHours: 3 });
  assert.deepEqual(ok.config.sales, { enabled: true, questions: QUESTIONS, formal: FORMAL, followUpHours: 3, stageName: "" });
  assert.equal(ok.config.maxReplies, 6, "room for every question and a few answers");
  const plain = await withSales({ enabled: false, questions: QUESTIONS });
  assert.equal(plain.config.sales, undefined, "switched off, nothing is stored");
  const defaults = await withSales({ enabled: true, questions: ["Your name?", "your name?"] });
  assert.deepEqual(defaults.config.sales.questions, ["Your name?"], "the same question twice is one");
  assert.match(defaults.config.sales.formal, /\{\{executive\}\}/, "the company's usual formal message");
  assert.equal(defaults.config.sales.followUpHours, 2);
  await assert.rejects(withSales({ enabled: true, questions: [] }), /at least one question/);
  await assert.rejects(withSales({ enabled: true, questions: ["Q1 here", "Q2 here", "Q3 here", "Q4 here", "Q5 here", "Q6 here", "Q7 here"] }), /up to 6 questions/);
  await assert.rejects(withSales({ enabled: true, questions: ["Tell me <about_business> things"] }), /tags/);
  await assert.rejects(withSales({ enabled: true, questions: ["x"] }), /3 to 200/);
  await assert.rejects(withSales({ enabled: true, questions: QUESTIONS, formal: "Hello {{nonsense}}" }), /isn't a field/);
  await assert.rejects(withSales({ enabled: true, questions: QUESTIONS, followUpHours: 100 }), /0 to 72/);
  await assert.rejects(cleanRule({ ...base, triggerType: "keyword", triggerCondition: "price", config: { ...base.config, sales: { enabled: true, questions: QUESTIONS } } }, { teammate: yes }), /first time|another country/);
});

test("The sales assistant asks, remembers, hands pricing to an executive, and opens the pipeline", async (t) => {
  const key = process.env.ANTHROPIC_API_KEY;
  const or = process.env.OPENROUTER_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  const asked = [];
  let answer = () => ({ reply: "", needs_person: false, heard_from: null, answers: {} });
  const respond = async (params) => {
    asked.push(params);
    return { content: [{ type: "text", text: JSON.stringify(answer(params)) }], stop_reason: "end_turn", usage: { input_tokens: 90, output_tokens: 30 } };
  };
  setAiClient({ messages: { create: respond }, beta: { messages: { create: respond } } });
  t.after(async () => {
    setAiClient(undefined);
    key === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = key);
    if (or !== undefined) process.env.OPENROUTER_API_KEY = or;
    await closeSessions(io);
    io.close();
  });

  const o = await registerTenantAndUser({ name: "Olivia Owner", email: "olivia@sales.test", password: "Password@123", companyName: "Chat Co" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,phone,status) VALUES(gen_random_uuid()::text,$1,'sales-line',$2,'971500000000','CONNECTED')", [tenantId, o.user.id]);
  const sam = (await registerTenantAndUser({ name: "Sam Executive", email: "sam@sales.test", password: "Password@123", companyName: "Sam's own" })).user;
  await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, sam.id]);

  let n = 0;
  const hear = async (text, from, name = "Amelia Stone") => {
    n += 1;
    await handleIncomingMessage({
      tenantId,
      sessionName: "sales-line",
      msg: { providerMessageId: `true_${from}@c.us_${n}`, fromMe: false, remoteId: `${from}@c.us`, rawType: "chat", type: "text", text, timestampEpoch: Math.floor(Date.now() / 1000) + n, senderName: name, ack: 2 },
    });
    await pumpAutomations();
  };
  const chatOf = async (phone) => (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND phone=$2", [tenantId, phone])).rows[0];
  const said = async (phone, who) =>
    (
      await query(
        "SELECT m.text FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.tenant_id=$1 AND c.phone=$2 AND m.sender='agent' AND m.agent_name=$3 AND m.type='text' ORDER BY m.created_at, m.id",
        [tenantId, phone, who],
      )
    ).rows.map((r) => (who === "Riwo" && r.text.endsWith(`\n\n${DISCLOSURE}`) ? r.text.slice(0, -(DISCLOSURE.length + 2)) : r.text));
  const notes = async (phone) =>
    (await query("SELECT m.text FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.tenant_id=$1 AND c.phone=$2 AND m.type='internal_note'", [tenantId, phone])).rows.map((r) => r.text);
  const state = async (phone) => (await query("SELECT s.* FROM automation_chats s JOIN conversations c ON c.id=s.conversation_id WHERE s.tenant_id=$1 AND c.phone=$2", [tenantId, phone])).rows[0];
  const leadOf = async (phone) => (await query("SELECT l.*,s.name AS stage FROM leads l JOIN pipeline_stages s ON s.id=l.stage_id WHERE l.tenant_id=$1 AND l.phone=$2", [tenantId, phone])).rows;
  const welcome = "Hi {{first_name}}, welcome to {{company}}! I'll ask a few quick questions.";
  const makeRule = async (sales = {}) => {
    await query("DELETE FROM automation_chats WHERE tenant_id=$1", [tenantId]);
    await query("DELETE FROM automation_executions WHERE tenant_id=$1", [tenantId]);
    await query("DELETE FROM automations WHERE tenant_id=$1", [tenantId]);
    const res = await request(app).post("/api/automations").set(owner).send({
      name: "Sales assistant",
      triggerType: "first_message",
      actionType: "ai_chat",
      config: { reply: welcome, knowledge: KNOWLEDGE, sales: { enabled: true, questions: QUESTIONS, formal: FORMAL, followUpHours: 2, ...sales } },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await request(app).patch(`/api/automations/${res.body.automation.id}/toggle`).set(owner)).status, 200);
    return res.body.automation;
  };

  await t.test("the first message gets the welcome and the first question in one message, and nothing is spent on the model", async () => {
    await makeRule();
    await hear("Hi, I am interested", "447700900001");
    assert.deepEqual(await said("447700900001", "Automation"), [`Hi Amelia, welcome to Chat Co! I'll ask a few quick questions.\n\n${QUESTIONS[0]}`]);
    assert.deepEqual(await said("447700900001", "Riwo"), []);
    const s = await state("447700900001");
    assert.deepEqual([s.status, s.step, s.requirements], ["active", 1, []]);
    assert.equal(asked.length, 0);
    assert.deepEqual(await leadOf("447700900001"), [], "no lead until the customer has told us something");
  });

  await t.test("what the customer says is read as answers; the next question is asked word for word; a lead appears in the first step", async () => {
    answer = () => ({ reply: "", needs_person: false, heard_from: null, answers: { 1: "Buy a 2 bedroom apartment" } });
    await hear("I want to buy a 2 bedroom apartment", "447700900001");
    assert.deepEqual(await said("447700900001", "Riwo"), [QUESTIONS[1]]);
    const s = await state("447700900001");
    assert.deepEqual([s.status, s.step], ["active", 2]);
    assert.deepEqual(s.requirements, [{ n: 1, question: QUESTIONS[0], answer: "Buy a 2 bedroom apartment" }]);
    const leads = await leadOf("447700900001");
    assert.equal(leads.length, 1);
    assert.equal(leads[0].stage, "New");
    assert.equal(leads[0].source, "automation");
    assert.match(leads[0].title, /Amelia Stone: Buy a 2 bedroom apartment/);
    // the model was told which questions exist and which are answered, and never asked to ask them
    assert.match(asked.at(-1).messages[0].content, /<questions>\n1\. What are you looking for\?\n2\. How many do you need, and where\?\n3\. When/);
    assert.equal((await chatOf("447700900001")).needs_human_since, null);
  });

  await t.test("a question from the customer is answered from the company's text, and the next question follows it", async () => {
    answer = () => ({ reply: "We are open Sunday to Thursday.", needs_person: false, heard_from: null, answers: { 2: "2 units in Dubai Marina" } });
    await hear("2 units in the Marina. Are you open on Sundays?", "447700900001");
    assert.deepEqual((await said("447700900001", "Riwo")).slice(-1), [`We are open Sunday to Thursday.\n\n${QUESTIONS[2]}`]);
    assert.equal((await state("447700900001")).step, 3);
    // the model is told what is already answered, and that it must not ask the questions itself
    assert.match(asked.at(-1).messages[0].content, /<questions>\n1\. What are you looking for\? \(already answered\)\n2\. How many do you need, and where\?\n3\./);
    assert.match(asked.at(-1).system, /Do not ask those questions yourself/);
  });

  await t.test("an answer with a figure the company never wrote is not sent, but the question still goes out", async () => {
    answer = () => ({ reply: "Our fee is 5%.", needs_person: false, heard_from: null, answers: {} });
    const before = (await said("447700900001", "Riwo")).length;
    await hear("Sorry, what was that?", "447700900001");
    const after = await said("447700900001", "Riwo");
    assert.equal(after.length, before + 1);
    assert.equal(after.at(-1), QUESTIONS[2], "only the company's own question");
    assert.ok(!after.some((m) => m.includes("5%")));
  });

  await t.test("a request for pricing is handed to an executive without asking the model", async () => {
    await assignConversation({ tenantId, conversationId: (await chatOf("447700900001")).id, userId: sam.id });
    const calls = asked.length;
    const riwoBefore = (await said("447700900001", "Riwo")).length;
    await hear("Can you send me the price list and a proposal?", "447700900001");
    assert.equal(asked.length, calls, "the model was not asked");
    const riwo = await said("447700900001", "Riwo");
    assert.equal(riwo.length, riwoBefore + 1);
    assert.equal(riwo.at(-1), "Thank you for your interest, Amelia. Our executive Sam Executive has been assigned to review your requirements and will share the proposal and pricing with you shortly.");
    assert.ok(!/\d/.test(riwo.at(-1)), "no figure in it");
    const chat = await chatOf("447700900001");
    assert.ok(chat.needs_human_since, "the chat is first on the team's list");
    assert.equal(chat.needs_human_reason, "pricing");
    assert.ok(chat.awaiting_since, "and the customer is still waiting for a person");
    const s = await state("447700900001");
    assert.deepEqual([s.status, s.outcome], ["handed_off", "pricing"]);
    // the pipeline
    const leads = await leadOf("447700900001");
    assert.equal(leads.length, 1, "the same lead, not another");
    assert.equal(leads[0].stage, "Proposal");
    assert.equal(leads[0].owner_user_id, sam.id);
    const history = (await query("SELECT type,actor_name,detail FROM lead_activities WHERE lead_id=$1 ORDER BY id", [leads[0].id])).rows;
    assert.deepEqual(history.map((h) => h.type), ["created", "owner", "stage", "requirements"], "the owner follows the assignment");
    assert.equal(history[2].actor_name, "Riwo");
    assert.deepEqual(history[2].detail, { from: "New", to: "Proposal", reason: "asked for pricing or a proposal" });
    assert.equal(history[3].detail.items.length, 2);
    // what the executive sees
    const note = (await notes("447700900001"))[0];
    assert.match(note, /asked for pricing or a proposal/);
    assert.match(note, /Buy a 2 bedroom apartment/);
    assert.match(note, /2 units in Dubai Marina/);
    assert.match(note, /Last message: “Can you send me the price list/);
    const bell = (await query("SELECT user_id,title,body,type FROM notifications WHERE tenant_id=$1 AND title LIKE '%wants pricing'", [tenantId])).rows;
    assert.ok(bell.some((b) => b.user_id === sam.id && b.type === "handoff"), "the executive is told");
    assert.ok(bell.some((b) => b.user_id === o.user.id), "and the owner");
    assert.match(bell[0].body, /Buy a 2 bedroom apartment/);
    // a follow-up so the customer is not left waiting
    const task = (await query("SELECT * FROM lead_tasks WHERE tenant_id=$1 AND lead_id=$2", [tenantId, leads[0].id])).rows;
    assert.equal(task.length, 1);
    assert.match(task[0].title, /Send pricing \/ proposal to Amelia Stone/);
    assert.equal(task[0].assigned_user_id, sam.id);
    const due = new Date(task[0].due_at).getTime() - Date.now();
    assert.ok(due > 1.9 * 3600_000 && due <= 2 * 3600_000 + 5000, `due in two hours: ${due}`);
    assert.equal(task[0].created_by, null);
  });

  await t.test("after the hand-off Riwo says nothing more, until a teammate has answered", async () => {
    const before = (await said("447700900001", "Riwo")).length;
    const calls = asked.length;
    await hear("Hello? Anyone there?", "447700900001");
    assert.equal((await said("447700900001", "Riwo")).length, before);
    assert.equal(asked.length, calls);
    const chat = await chatOf("447700900001");
    await sendTextMessage({ tenantId, conversationId: chat.id, text: "Hi Amelia, it's Sam. Sending the proposal now.", idempotencyKey: "sam-reply-1", agentName: "Sam Executive", sentByUserId: sam.id, io });
    const after = await chatOf("447700900001");
    assert.equal(after.needs_human_since, null, "a person answered, so it is no longer waiting for one");
    assert.equal(after.awaiting_since, null);
  });

  await t.test("someone who asks for pricing in their very first message gets the formal message instead of the welcome", async () => {
    await makeRule();
    asked.length = 0;
    await hear("Hello, what are your prices for a 1 bedroom?", "447700900002", "Omar Khan");
    assert.deepEqual(await said("447700900002", "Automation"), [], "no welcome");
    const riwo = await said("447700900002", "Riwo");
    assert.equal(riwo.length, 1);
    assert.match(riwo[0], /^Thank you for your interest, Omar\. Our executive has been assigned to review your requirements/, "no teammate yet, so no name and no double space");
    assert.equal(asked.length, 0);
    const leads = await leadOf("447700900002");
    assert.deepEqual([leads.length, leads[0].stage], [1, "Proposal"]);
    assert.equal((await chatOf("447700900002")).needs_human_reason, "pricing");
    assert.match((await notes("447700900002"))[0], /No questions were answered yet/);
  });

  await t.test("without a model the questions and the pricing hand-off still work: each message answers the question just asked", async () => {
    await makeRule();
    await query("UPDATE tenants SET ai_enabled=false WHERE id=$1", [tenantId]);
    asked.length = 0;
    await hear("Hi", "447700900003", "Noor Ali");
    await hear("a villa to rent", "447700900003", "Noor Ali");
    await hear("one, in Jumeirah", "447700900003", "Noor Ali");
    assert.deepEqual(await said("447700900003", "Riwo"), [QUESTIONS[1], QUESTIONS[2]]);
    const s = await state("447700900003");
    assert.deepEqual(s.requirements.map((r) => [r.n, r.answer]), [[1, "a villa to rent"], [2, "one, in Jumeirah"]]);
    await hear("price please", "447700900003", "Noor Ali");
    assert.match((await said("447700900003", "Riwo")).at(-1), /^Thank you for your interest, Noor/);
    assert.equal(asked.length, 0, "the model was never asked");
    assert.equal((await leadOf("447700900003"))[0].stage, "Proposal");
    await query("UPDATE tenants SET ai_enabled=true WHERE id=$1", [tenantId]);
  });

  await t.test("when every question is answered the chat goes to an executive, in the Qualified step", async () => {
    await makeRule();
    answer = () => ({ reply: "", needs_person: false, heard_from: null, answers: { 1: "Rent a studio", 2: "1 unit in Business Bay", 3: "Next month" } });
    await hear("Hi", "447700900004", "Lina Park");
    await hear("Studio, one, Business Bay, next month", "447700900004", "Lina Park");
    const riwo = await said("447700900004", "Riwo");
    assert.equal(riwo.length, 1);
    assert.match(riwo[0], /^Thank you for your interest, Lina\./);
    const chat = await chatOf("447700900004");
    assert.equal(chat.needs_human_reason, "qualified");
    assert.deepEqual([(await state("447700900004")).outcome, (await leadOf("447700900004"))[0].stage], ["qualified", "Qualified"]);
    assert.equal((await query("SELECT count(*)::int AS n FROM lead_tasks WHERE tenant_id=$1 AND lead_id=$2", [tenantId, (await leadOf("447700900004"))[0].id])).rows[0].n, 1);
    assert.match((await notes("447700900004"))[0], /answered all the questions/);
  });

  await t.test("a company can choose the pipeline step, the follow-up time and switch the follow-up off", async () => {
    await makeRule({ stageName: "Negotiation", followUpHours: 0 });
    await hear("how much is a flat?", "447700900005", "Ravi Shah");
    const lead = (await leadOf("447700900005"))[0];
    assert.equal(lead.stage, "Negotiation");
    assert.equal((await query("SELECT count(*)::int AS n FROM lead_tasks WHERE tenant_id=$1 AND lead_id=$2", [tenantId, lead.id])).rows[0].n, 0);
  });

  await t.test("a lead that is already further along is not moved back, and a customer with no free reply left still gets the hand-off", async () => {
    await makeRule();
    const first = await request(app).post("/api/leads").set(owner).send({ contactName: "Zed", phone: "447700900006", title: "Existing" });
    // an existing contact with an open lead in Negotiation
    await hear("Hi", "447700900006", "Zed Hall");
    const contactId = (await chatOf("447700900006")).contact_id;
    const lead = await query("SELECT id,pipeline_id FROM leads WHERE tenant_id=$1 AND contact_id=$2", [tenantId, contactId]);
    let leadId = lead.rows[0]?.id;
    if (!leadId) {
      const pipeline = (await query("SELECT id FROM pipelines WHERE tenant_id=$1", [tenantId])).rows[0];
      const stage = (await query("SELECT id FROM pipeline_stages WHERE pipeline_id=$1 AND name='Negotiation'", [pipeline.id])).rows[0];
      leadId = (await query(
        "INSERT INTO leads(id,tenant_id,pipeline_id,stage_id,contact_id,contact_name,phone,title,value,source,rank) VALUES(gen_random_uuid()::text,$1,$2,$3,$4,'Zed Hall','447700900006','Existing',0,'manual',0) RETURNING id",
        [tenantId, pipeline.id, stage.id, contactId],
      )).rows[0].id;
    } else await query("UPDATE leads SET stage_id=(SELECT id FROM pipeline_stages WHERE pipeline_id=$1 AND name='Negotiation') WHERE id=$2", [lead.rows[0].pipeline_id, leadId]);
    await hear("send me a quote", "447700900006", "Zed Hall");
    const after = await leadOf("447700900006");
    assert.equal(after.length, 1);
    assert.equal(after[0].stage, "Negotiation", "never moved back to Proposal");
    assert.match((await said("447700900006", "Riwo")).at(-1), /^Thank you for your interest/);
    void first;
  });

  await t.test("a group is never answered", async () => {
    await makeRule();
    n += 1;
    await handleIncomingMessage({
      tenantId,
      sessionName: "sales-line",
      msg: { providerMessageId: `true_120363000000000001@g.us_${n}`, fromMe: false, remoteId: "120363000000000001@g.us", rawType: "chat", type: "text", text: "what are your prices", timestampEpoch: Math.floor(Date.now() / 1000) + n, senderName: "A member", ack: 2 },
    });
    await pumpAutomations();
    assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND sender='agent' AND text LIKE '%Thank you for your interest%'", [tenantId])).rows[0].n > 0, true, "earlier customers were answered");
    assert.equal((await query("SELECT count(*)::int AS n FROM automation_chats s JOIN conversations c ON c.id=s.conversation_id WHERE s.tenant_id=$1 AND c.is_group", [tenantId])).rows[0].n, 0);
  });
});
