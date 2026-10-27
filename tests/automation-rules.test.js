import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { pumpAutomations } from "../src/services/automationService.js";
import { cleanRule, keywordsOf, matchesKeywords, withinHours } from "../src/services/automationRules.js";
import { AUTOMATION_TEMPLATES } from "../src/services/automationTemplates.js";
import { personalise, unknownVariables } from "../src/services/templating.js";
import { closeSessions } from "../src/services/sessionService.js";

test("matching words, opening hours and fields", () => {
  assert.deepEqual(keywordsOf("price, cost\nرسوم،  rate ;  "), ["price", "cost", "رسوم", "rate"]);
  // The original behaviour: any message that contains the word, in any case.
  assert.equal(matchesKeywords("pricelist", "Send me the PRICELIST please"), true);
  assert.equal(matchesKeywords("price", "What's the Price?"), true);
  assert.equal(matchesKeywords("cat", "I love my category", "word"), false);
  assert.equal(matchesKeywords("cat", "Is the cat. ok?", "word"), true);
  assert.equal(matchesKeywords("stop", "Stop.", "exact"), true);
  assert.equal(matchesKeywords("stop", "  STOP!! ", "exact"), true);
  assert.equal(matchesKeywords("stop", "please stop sending price lists", "exact"), false);
  assert.equal(matchesKeywords("سعر, price", "كم السعر؟ سعر المنتج"), true);
  assert.equal(matchesKeywords("", "anything"), false);
  const hours = { timezone: "Asia/Dubai", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
  const at = (iso) => Date.parse(iso) / 1000;
  assert.equal(withinHours(hours, at("2026-10-19T06:00:00Z")), true, "Monday 10:00 in Dubai");
  assert.equal(withinHours(hours, at("2026-10-19T04:59:00Z")), false, "Monday 08:59 in Dubai");
  assert.equal(withinHours(hours, at("2026-10-19T14:00:00Z")), false, "Monday 18:00 in Dubai: closed");
  assert.equal(withinHours(hours, at("2026-10-24T06:00:00Z")), false, "Saturday");
  assert.equal(personalise("Hi {{first_name}}, {{name}} from {{ company }} {{nope}}", { name: "Aisha Khan", company: "Acme" }), "Hi Aisha, Aisha Khan from Acme {{nope}}");
  assert.equal(personalise("Hi {{first_name}}", { name: "971501234567" }), "Hi there", "a phone number is not a name");
  assert.deepEqual(unknownVariables("Hi {{name}} {{Colour}} {{ first_name }}"), ["{{Colour}}"]);
});

test("every ready-made rule is valid once its blanks are filled in", async () => {
  const yes = async () => true;
  assert.ok(AUTOMATION_TEMPLATES.length >= 12);
  assert.equal(new Set(AUTOMATION_TEMPLATES.map((t) => t.id)).size, AUTOMATION_TEMPLATES.length, "ids are unique");
  for (const t of AUTOMATION_TEMPLATES) {
    const rule = { ...t.rule, config: { ...t.rule.config } };
    if (t.needs.includes("reply")) rule.actionSummary = "Our prices start at AED 50.";
    if (t.needs.includes("teammate")) rule.actionSummary = "Sam";
    if (t.needs.includes("country")) rule.config.homeCodes = ["971"];
    if (t.needs.includes("about")) rule.config.knowledge = "We are a property brokerage in Dubai Marina. We help people buy, sell and rent apartments.";
    const clean = await cleanRule({ name: t.name, templateId: t.id, ...rule }, { teammate: yes });
    assert.equal(clean.templateId, t.id);
    // What a person must fill in is exactly what would stop the rule being saved.
    if (["reply", "teammate", "country", "about"].some((n) => t.needs.includes(n)))
      await assert.rejects(cleanRule({ name: t.name, ...t.rule }, { teammate: yes }), (e) => e.status === 400, `${t.id} needs a blank filled`);
  }
  for (const id of ["welcome", "after-hours", "stop", "subscribe"]) assert.equal(AUTOMATION_TEMPLATES.find((t) => t.id === id).recommended, true);
});

test("Automation rules: what they can start on, what they do, and the limits that keep them safe", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@rules.test", password: "Password@123", companyName: "Rules Co" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id) VALUES(gen_random_uuid()::text,$1,'rules-line',$2)", [tenantId, o.user.id]);
  const sam = (await registerTenantAndUser({ name: "Sam Agent", email: "sam@rules.test", password: "Password@123", companyName: "Sam's own" })).user;
  await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, sam.id]);

  let n = 0;
  const hear = async (text, { from = "971555550001", epoch, name = "Zed Customer" } = {}) => {
    n += 1;
    await handleIncomingMessage({
      tenantId,
      sessionName: "rules-line",
      msg: { providerMessageId: `true_${from}@c.us_${n}`, fromMe: false, remoteId: `${from}@c.us`, rawType: "chat", type: "text", text, timestampEpoch: epoch ?? Math.floor(Date.now() / 1000) + n, senderName: name, ack: 2 },
    });
    await pumpAutomations();
  };
  const sent = async (from = "971555550001") =>
    (
      await query(
        "SELECT m.text FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.tenant_id=$1 AND c.phone=$2 AND m.sender='agent' AND m.agent_name='Automation' ORDER BY m.created_at, m.id",
        [tenantId, from],
      )
    ).rows.map((r) => r.text);
  const create = (body) => request(app).post("/api/automations").set(owner).send(body);
  const make = async (body, live = true) => {
    const res = await create({ triggerType: "keyword", ...body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    if (live) assert.equal((await request(app).patch(`/api/automations/${res.body.automation.id}/toggle`).set(owner)).status, 200);
    return res.body.automation;
  };
  const clearRules = () => query("DELETE FROM automation_executions WHERE tenant_id=$1", [tenantId]).then(() => query("DELETE FROM automations WHERE tenant_id=$1", [tenantId]));
  const consent = async (phone) => (await query("SELECT opt_in_status,source FROM consents WHERE tenant_id=$1 AND phone=$2", [tenantId, phone])).rows[0];

  await t.test("the ready-made rules are listed", async () => {
    const res = await request(app).get("/api/automations/templates").set(owner);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.templates.map((x) => x.id), AUTOMATION_TEMPLATES.map((x) => x.id));
    assert.deepEqual([...new Set(res.body.templates.map((x) => x.group))], ["People from other countries", "Start here", "Answer common questions", "Send to your team", "Organise leads"]);
  });

  await t.test("a rule is checked before it is saved, and says what is wrong", async () => {
    const bad = async (body, pattern) => {
      const res = await create(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.message, pattern);
    };
    const base = { name: "R", triggerType: "keyword", triggerCondition: "price", actionType: "reply_text", actionSummary: "Hi" };
    await bad({ ...base, triggerCondition: " , " }, /at least one word/);
    await bad({ ...base, actionType: "shout" }, /what the rule does/);
    await bad({ ...base, triggerType: "whenever" }, /when the rule starts/);
    await bad({ ...base, actionSummary: "" }, /The reply is required/);
    await bad({ ...base, actionSummary: "Hi {{nickname}}" }, /\{\{nickname\}\} isn't a field/);
    await bad({ ...base, actionType: "assign_agent", actionSummary: "Nobody Here" }, /Nobody Here isn't an active teammate/);
    await bad({ ...base, actionType: "add_tag", actionSummary: "a,b" }, /can't contain commas/);
    await bad({ ...base, triggerType: "after_hours", config: { hours: { timezone: "Mars/Base", days: [1], start: "09:00", end: "18:00" } } }, /time zone/);
    await bad({ ...base, triggerType: "after_hours", config: { hours: { timezone: "UTC", days: [], start: "09:00", end: "18:00" } } }, /days you are open/);
    await bad({ ...base, triggerType: "after_hours", config: { hours: { timezone: "UTC", days: [1], start: "18:00", end: "09:00" } } }, /Closing time must be after/);
    await bad({ ...base, config: { cooldownHours: 999 } }, /0 to 168 hours/);
    assert.equal((await query("SELECT count(*)::int AS n FROM automations WHERE tenant_id=$1", [tenantId])).rows[0].n, 0, "nothing bad was saved");
  });

  await t.test("a new rule is paused; editing keeps it as it was", async () => {
    const rule = await make({ name: "Price", triggerCondition: "price", actionType: "reply_text", actionSummary: "AED 50" }, false);
    assert.equal(rule.isEnabled, false);
    await request(app).patch(`/api/automations/${rule.id}/toggle`).set(owner);
    const edit = await request(app).put(`/api/automations/${rule.id}`).set(owner).send({ name: "Price list", triggerType: "keyword", triggerCondition: "price, cost", actionType: "reply_text", actionSummary: "AED 60", config: { match: "word" } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.deepEqual([edit.body.automation.name, edit.body.automation.isEnabled, edit.body.automation.actionSummary, edit.body.automation.config.match], ["Price list", true, "AED 60", "word"]);
    assert.equal((await request(app).put("/api/automations/missing").set(owner).send({ name: "x", triggerCondition: "x", actionType: "reply_text", actionSummary: "x" })).status, 404);
    await clearRules();
  });

  await t.test("keywords: any of several, in any case, with the match the rule asks for", async () => {
    await make({ name: "Price", triggerCondition: "price, how much, سعر", actionType: "reply_text", actionSummary: "AED 50 for {{first_name}} at {{company}}" });
    await hear("How MUCH is it?");
    await hear("كم سعر المنتج");
    await hear("good morning");
    assert.deepEqual(await sent(), ["AED 50 for Zed at Rules Co", "AED 50 for Zed at Rules Co"]);
    await clearRules();
    await make({ name: "Hi", triggerCondition: "hi", actionType: "reply_text", actionSummary: "Hello", config: { match: "word" } });
    await hear("this is nothing", { from: "971555550002" });
    await hear("hi there", { from: "971555550002" });
    assert.deepEqual(await sent("971555550002"), ["Hello"], "'this' contains 'hi' but is not the word");
    await clearRules();
  });

  await t.test("a welcome goes to a new contact once, not to someone already talking to you", async () => {
    await make({ name: "Welcome", triggerType: "first_message", actionType: "reply_text", actionSummary: "Hi {{first_name}}, welcome to {{company}}!" });
    await hear("hello", { from: "971555550003", name: "Nadia Ali" });
    await hear("are you there?", { from: "971555550003", name: "Nadia Ali" });
    assert.deepEqual(await sent("971555550003"), ["Hi Nadia, welcome to Rules Co!"]);
    // someone who was already in the chat (an earlier message of theirs exists) is not new
    const old = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND phone='971555550003'", [tenantId])).rows[0].id;
    assert.ok(old);
    await clearRules();
  });

  await t.test("an away message goes to someone writing after hours, once an evening", async () => {
    const hours = { timezone: "UTC", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
    await make({ name: "Away", triggerType: "after_hours", actionType: "reply_text", actionSummary: "We're closed. Back at 9.", config: { hours } });
    const monday = (h) => Date.parse(`2026-10-19T${h}:00Z`) / 1000;
    await hear("hello?", { from: "971555550004", epoch: monday("10:00") });
    assert.deepEqual(await sent("971555550004"), [], "open at 10:00");
    await hear("anyone there?", { from: "971555550004", epoch: monday("22:00") });
    await hear("hello???", { from: "971555550004", epoch: monday("22:05") });
    assert.deepEqual(await sent("971555550004"), ["We're closed. Back at 9."], "told once, not for every message");
    await hear("hi on saturday", { from: "971555550005", epoch: Date.parse("2026-10-24T11:00:00Z") / 1000 });
    assert.deepEqual(await sent("971555550005"), ["We're closed. Back at 9."], "a different customer, on a weekend");
    await clearRules();
  });

  await t.test("STOP withdraws permission for broadcasts, confirms, and does not silence the chat", async () => {
    await make({ name: "Stop", triggerCondition: "stop, unsubscribe", actionType: "opt_out", config: { match: "exact", reply: "You're unsubscribed from {{company}}." } });
    await query("INSERT INTO contacts(id,tenant_id,name,phone) VALUES('c-opt',$1,'Opt Person','971555550006') ON CONFLICT DO NOTHING", [tenantId]);
    await query("INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,'971555550006',true,'workspace_recorded')", [tenantId]);
    await hear("please stop sending me price lists", { from: "971555550006" });
    assert.equal((await consent("971555550006")).opt_in_status, true, "a sentence is not a request to unsubscribe");
    await hear("STOP", { from: "971555550006" });
    assert.deepEqual(await consent("971555550006"), { opt_in_status: false, source: "customer_message" });
    assert.deepEqual(await sent("971555550006"), ["You're unsubscribed from Rules Co."]);
    assert.equal((await query("SELECT count(*)::int AS n FROM suppressions WHERE tenant_id=$1", [tenantId])).rows[0].n, 0, "the chat is not blocked");
    const conv = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND phone='971555550006'", [tenantId])).rows[0].id;
    const reply = await request(app).post(`/api/conversations/${conv}/messages`).set(owner).send({ text: "Sorry to see you go", idempotencyKey: "staff-after-stop" });
    assert.equal(reply.status, 201, "staff can still answer them");
    await clearRules();
  });

  await t.test("SUBSCRIBE records permission, even for someone who was off the list", async () => {
    await make({ name: "Subscribe", triggerCondition: "subscribe", actionType: "opt_in", config: { match: "exact", reply: "You're in!" } });
    await hear("subscribe", { from: "971555550007" });
    assert.deepEqual(await consent("971555550007"), { opt_in_status: true, source: "customer_message" });
    await query("UPDATE consents SET opt_in_status=false WHERE tenant_id=$1 AND phone='971555550007'", [tenantId]);
    await hear("Subscribe!", { from: "971555550007" });
    assert.equal((await consent("971555550007")).opt_in_status, true);
    await clearRules();
  });

  await t.test("tagging a customer, once", async () => {
    await make({ name: "Interested", triggerCondition: "demo, quote", actionType: "add_tag", actionSummary: "interested" });
    await hear("can I get a demo", { from: "971555550008" });
    await hear("and a quote", { from: "971555550008" });
    const tags = (await query("SELECT tags FROM contacts WHERE tenant_id=$1 AND phone='971555550008'", [tenantId])).rows[0].tags;
    assert.deepEqual(tags, ["interested"]);
    const labelled = await query("SELECT l.name FROM contact_labels cl JOIN labels l ON l.id=cl.label_id JOIN contacts c ON c.id=cl.contact_id WHERE c.tenant_id=$1 AND c.phone='971555550008'", [tenantId]);
    assert.deepEqual(labelled.rows.map((r) => r.name), ["interested"], "the tag is a label too");
    assert.deepEqual(await sent("971555550008"), [], "no reply was asked for");
    await clearRules();
  });

  await t.test("handing a chat to a teammate, with a confirmation", async () => {
    await make({ name: "Human", triggerCondition: "agent", actionType: "assign_agent", actionSummary: "Sam Agent", config: { match: "word", reply: "A person is coming." } });
    await hear("I want to talk to an agent", { from: "971555550009" });
    assert.equal((await query("SELECT assigned_to FROM conversations WHERE tenant_id=$1 AND phone='971555550009'", [tenantId])).rows[0].assigned_to, "Sam Agent");
    assert.deepEqual(await sent("971555550009"), ["A person is coming."]);
    await clearRules();
  });

  await t.test("a customer gets one automatic reply per message, the most specific first", async () => {
    await make({ name: "Stop", triggerCondition: "stop", actionType: "opt_out", config: { match: "exact", reply: "Unsubscribed." } });
    await make({ name: "A price", triggerCondition: "price", actionType: "reply_text", actionSummary: "Price answer" });
    await make({ name: "B cost", triggerCondition: "price", actionType: "reply_text", actionSummary: "Cost answer" });
    await hear("price", { from: "971555550010" });
    assert.deepEqual(await sent("971555550010"), ["Price answer"]);
    const skipped = (await query("SELECT error FROM automation_executions WHERE tenant_id=$1 AND status='skipped'", [tenantId])).rows;
    assert.deepEqual(skipped.map((r) => r.error), ["Another rule already replied to this message"]);
    await clearRules();
  });

  await t.test("a reply is not sent over and over to the same chat", async () => {
    await make({ name: "Echo", triggerCondition: "ping", actionType: "reply_text", actionSummary: "pong" });
    for (let i = 0; i < 9; i++) await hear(`ping ${i}`, { from: "971555550011" });
    assert.equal((await sent("971555550011")).length, 6, "six an hour is the most");
    await clearRules();
  });

  await t.test("a rule can ask to wait before it repeats", async () => {
    await make({ name: "Thanks", triggerCondition: "thanks", actionType: "reply_text", actionSummary: "You're welcome", config: { match: "exact", cooldownHours: 1 } });
    await hear("thanks", { from: "971555550012" });
    await hear("thanks!", { from: "971555550012" });
    assert.equal((await sent("971555550012")).length, 1);
    await clearRules();
  });

  await t.test("group chats are never answered by a rule", async () => {
    await make({ name: "Price", triggerCondition: "price", actionType: "reply_text", actionSummary: "AED 50" });
    n += 1;
    await handleIncomingMessage({
      tenantId,
      sessionName: "rules-line",
      msg: { providerMessageId: `true_group_${n}`, fromMe: false, remoteId: "120363000000000001@g.us", isGroup: true, groupName: "Friends", rawType: "chat", type: "text", text: "what is the price", timestampEpoch: Math.floor(Date.now() / 1000), senderName: "Zed", ack: 2 },
    });
    await pumpAutomations();
    const group = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND is_group", [tenantId])).rows[0];
    assert.ok(group, "the group chat was stored");
    const replies = (await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender='agent'", [group.id])).rows[0].n;
    assert.equal(replies, 0);
    assert.equal((await query("SELECT count(*)::int AS n FROM automation_executions WHERE tenant_id=$1", [tenantId])).rows[0].n, 0, "the rule was not even tried");
    await clearRules();
  });

  await t.test("rules written before this existed behave as they always did", async () => {
    await query(
      "INSERT INTO automations(id,tenant_id,name,trigger_type,trigger_condition,action_type,action_summary,is_enabled) VALUES(gen_random_uuid()::text,$1,'Old rule','keyword','pricelist','reply_text','Here is our price list',true)",
      [tenantId],
    );
    await hear("send me the pricelist please", { from: "971555550013" });
    assert.deepEqual(await sent("971555550013"), ["Here is our price list"]);
    await clearRules();
  });
});
