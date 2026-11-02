import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { pumpAutomations } from "../src/services/automationService.js";
import { setWebsiteIO, setCrawlPause } from "../src/services/websiteReader.js";
import { setAiClient, tidyKnowledge } from "../src/services/aiService.js";
import { addSource, pumpKnowledge, knowledgeFor, pickPages, wordsOf, statusOf, KNOWLEDGE } from "../src/services/knowledgeService.js";
import { closeSessions } from "../src/services/sessionService.js";

const page = (title, body, links = []) => ({ status: 200, location: "", type: "text/html", body: `<html><head><title>${title}</title><meta name="description" content="${title} by Scriza."></head><body><nav>${links.map((l) => `<a href="${l}">x</a>`).join("")}</nav><h1>${title}</h1><p>${body}</p></body></html>` });
const SITE = {
  "https://scriza.example/": page("Scriza | Software and services", "Scriza builds business software and runs digital projects for companies in the UAE and India. Contact us at hello@scriza.example.", ["/products/crm", "/products/erp", "/portfolio", "/about", "/private/admin"]),
  "https://scriza.example/products/crm": page("Scriza CRM", "Scriza CRM is a sales CRM for teams of 5 to 200 people. Plans start at AED 299 a month. It includes pipelines, reminders and WhatsApp.", ["/products/crm/pricing"]),
  "https://scriza.example/products/erp": page("Scriza ERP", "Scriza ERP runs inventory, purchasing and accounts for manufacturers. Implementation takes about six weeks."),
  "https://scriza.example/products/hrms": page("Scriza HRMS", "Scriza HRMS handles payroll and leave for companies with 20 to 500 staff."),
  "https://scriza.example/portfolio": page("Our portfolio", "We built the booking platform for Marina Tours and the stock system for Gulf Steel Traders."),
  "https://scriza.example/about": page("About Scriza", "Scriza was founded in 2014 in Udaipur and Dubai. Our team of 60 builds software."),
  "https://scriza.example/private/admin": page("Admin", "secret staff-only page that robots.txt asks robots to leave alone"),
  "https://scriza.example/robots.txt": { status: 200, location: "", type: "text/plain", body: "User-agent: *\nDisallow: /private\n" },
  "https://scriza.example/sitemap.xml": { status: 200, location: "", type: "application/xml", body: "<urlset><url><loc>https://scriza.example/products/hrms</loc></url><url><loc>https://other.example/x</loc></url></urlset>" },
};

test("Words are cut into what matters, and the right pages are picked", () => {
  assert.deepEqual(wordsOf("Hello! Do you have a CRM for my team of 20?"), ["crm", "team"]);
  const pages = [
    { url: "https://s/crm", title: "Scriza CRM", text: "A sales CRM for teams with pipelines." },
    { url: "https://s/erp", title: "Scriza ERP", text: "Inventory and purchasing for manufacturers." },
  ];
  assert.deepEqual(pickPages(pages, wordsOf("tell me about the crm")).map((p) => p.url), ["https://s/crm"]);
  assert.deepEqual(pickPages(pages, wordsOf("what is the weather")), [], "nothing matches, so nothing is added");
  assert.deepEqual(pickPages(pages, []), []);
});

test("The model's profile keeps real product pages only, no markup, and needs a real overview", () => {
  const out = tidyKnowledge(JSON.stringify({ overview: "Scriza builds <b>software</b> for **companies** in the UAE and India.", products: [{ name: "Scriza CRM", summary: "A sales CRM.", url: "https://s/crm" }, { name: "scriza crm", summary: "dup", url: "" }, { name: "Ghost", summary: "x", url: "https://invented.example/" }] }), ["https://s/crm"]);
  assert.equal(out.overview, "Scriza builds software for companies in the UAE and India.");
  assert.deepEqual(out.products.map((p) => [p.name, p.url]), [["Scriza CRM", "https://s/crm"], ["Ghost", ""]], "an address the model made up is dropped");
  assert.equal(tidyKnowledge("nope", []), null);
  assert.equal(tidyKnowledge(JSON.stringify({ overview: "short", products: [] }), []), null);
});

test("A company's knowledge base: read the site, keep it fresh, and answer from it", async (t) => {
  const key = process.env.ANTHROPIC_API_KEY;
  const or = process.env.OPENROUTER_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  setCrawlPause(0);
  const site = { ...SITE };
  const hits = [];
  setWebsiteIO({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    get: async (url) => {
      hits.push(url.href);
      return site[url.href] || { status: 404, location: "", type: "text/html", body: "" };
    },
  });
  const asked = [];
  let profileAnswer = () => ({ overview: "Scriza builds business software and runs digital projects for companies in the UAE and India.", products: [{ name: "Scriza CRM", summary: "A sales CRM for teams.", url: "https://scriza.example/products/crm" }, { name: "Scriza ERP", summary: "Inventory, purchasing and accounts.", url: "https://scriza.example/products/erp" }, { name: "Scriza HRMS", summary: "Payroll and leave.", url: "https://scriza.example/products/hrms" }] });
  let chatAnswer = () => ({ reply: "Yes, Scriza CRM is built for sales teams.", needs_person: false, heard_from: null });
  const respond = async (params) => {
    asked.push(params);
    const isProfile = /AI sales agent on its WhatsApp number/.test(String(params.system));
    return { content: [{ type: "text", text: JSON.stringify(isProfile ? profileAnswer() : chatAnswer(params)) }], stop_reason: "end_turn", usage: { input_tokens: 200, output_tokens: 80 } };
  };
  setAiClient({ messages: { create: respond }, beta: { messages: { create: respond } } });
  t.after(async () => {
    setWebsiteIO(null);
    setAiClient(undefined);
    setCrawlPause(250);
    key === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = key);
    if (or !== undefined) process.env.OPENROUTER_API_KEY = or;
    await closeSessions(io);
    io.close();
  });

  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@kb.test", password: "Password@123", companyName: "Scriza" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  const agent = (await registerTenantAndUser({ name: "Sam", email: "sam@kb.test", password: "Password@123", companyName: "Sam's" })).user;
  await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, agent.id]);
  const agentAuth = { Authorization: `Bearer ${generateAccessToken(agent, tenantId, "agent")}` };
  const sourceOf = async () => (await query("SELECT * FROM knowledge_sources WHERE tenant_id=$1 ORDER BY created_at", [tenantId])).rows[0];
  const profileCalls = () => asked.filter((p) => /AI sales agent on its WhatsApp number/.test(String(p.system))).length;

  await t.test("the owner adds the website; it is read, page by page, within the rules of the site", async () => {
    const res = await request(app).post("/api/knowledge/sources").set(owner).send({ url: "scriza.example" });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.sources[0].status, "queued");
    assert.equal(await pumpKnowledge({ force: true, wait: true }), 1);
    const src = await sourceOf();
    assert.equal(src.status, "ready");
    const urls = (await query("SELECT url FROM knowledge_pages WHERE tenant_id=$1 ORDER BY url", [tenantId])).rows.map((r) => r.url);
    assert.deepEqual(urls, ["https://scriza.example/", "https://scriza.example/about", "https://scriza.example/portfolio", "https://scriza.example/products/crm", "https://scriza.example/products/erp", "https://scriza.example/products/hrms"], "the sitemap's page is included, other sites and the pages robots.txt forbids are not");
    assert.ok(!hits.some((h) => h.includes("/private/admin")), "the forbidden page was never fetched");
    assert.equal(src.pages, 6);
  });

  await t.test("Riwo writes what the company is and sells, with real addresses, and the owner sees it", async () => {
    const st = await request(app).get("/api/knowledge").set(owner);
    assert.equal(st.body.writtenByRiwo, true);
    assert.match(st.body.overview, /business software/);
    assert.deepEqual(st.body.products.map((p) => p.name), ["Scriza CRM", "Scriza ERP", "Scriza HRMS"]);
    assert.equal(st.body.products[0].url, "https://scriza.example/products/crm");
    assert.equal(st.body.ready, true);
    assert.equal(profileCalls(), 1);
  });

  await t.test("a refresh with nothing changed asks Riwo for nothing; a changed page, a new page and a removed page change what it knows", async () => {
    const id = (await sourceOf()).id;
    assert.equal((await request(app).post(`/api/knowledge/sources/${id}/refresh`).set(owner)).status, 202);
    await pumpKnowledge({ force: true, wait: true });
    assert.equal(profileCalls(), 1, "nothing changed, so no new request to Riwo");
    const unchangedAt = (await sourceOf()).last_changed_at;
    // the website changes: the CRM page has a new price, the ERP page is gone, a new page appears
    site["https://scriza.example/products/crm"] = page("Scriza CRM", "Scriza CRM is a sales CRM for teams of 5 to 200 people. Plans start at AED 349 a month.", []);
    delete site["https://scriza.example/products/erp"];
    site["https://scriza.example/"] = page("Scriza | Software and services", "Scriza builds business software.", ["/products/crm", "/portfolio", "/about", "/products/analytics"]);
    site["https://scriza.example/products/analytics"] = page("Scriza Analytics", "Dashboards for operations teams, with live charts for every plant, branch and shift, built on the same data as the ERP.");
    await request(app).post(`/api/knowledge/sources/${id}/refresh`).set(owner);
    await pumpKnowledge({ force: true, wait: true });
    assert.equal(profileCalls(), 2, "something changed, so the profile is written again");
    const urls = (await query("SELECT url FROM knowledge_pages WHERE tenant_id=$1", [tenantId])).rows.map((r) => r.url);
    assert.ok(urls.includes("https://scriza.example/products/analytics"));
    assert.ok(!urls.includes("https://scriza.example/products/erp"), "a page taken down is no longer something Riwo knows");
    const crm = (await query("SELECT text FROM knowledge_pages WHERE url='https://scriza.example/products/crm'")).rows[0].text;
    assert.match(crm, /AED 349/);
    assert.ok(new Date((await sourceOf()).last_changed_at) > new Date(unchangedAt));
  });

  await t.test("a site that has not been read for a day is read again by itself", async () => {
    const before = hits.length;
    await query("UPDATE knowledge_sources SET last_read_at=now() - interval '25 hours' WHERE tenant_id=$1", [tenantId]);
    assert.equal(await pumpKnowledge({ force: true, wait: true }), 1);
    assert.ok(hits.length > before);
    await query("UPDATE knowledge_sources SET auto_refresh=false, last_read_at=now() - interval '3 days' WHERE tenant_id=$1", [tenantId]);
    assert.equal(await pumpKnowledge({ force: true, wait: true }), 0, "a source set not to refresh is left alone");
    await query("UPDATE knowledge_sources SET auto_refresh=true WHERE tenant_id=$1", [tenantId]);
  });

  await t.test("what Riwo is given for a customer: the profile, the notes, and only the pages that match the question", async () => {
    await request(app).put("/api/knowledge/notes").set(owner).send({ notes: "We reply on WhatsApp from 9am to 6pm UAE time. Demos are free." });
    const crm = await knowledgeFor(tenantId, "Do you have a CRM for my sales team?");
    assert.match(crm, /About the company:/);
    assert.match(crm, /What the company offers:\n- Scriza CRM: A sales CRM for teams\./);
    assert.match(crm, /Notes from the company:\nWe reply on WhatsApp from 9am to 6pm/);
    assert.match(crm, /Pages that match what the customer asked:\n\[Scriza CRM\]/);
    assert.match(crm, /AED 349/);
    assert.ok(!/Dashboards for operations teams/.test(crm), "the analytics page does not match a CRM question");
    const none = await knowledgeFor(tenantId, "hello");
    assert.ok(!/Pages that match/.test(none));
    assert.ok((await knowledgeFor(tenantId, "crm erp hrms analytics portfolio team")).length <= KNOWLEDGE.context + 600);
    assert.equal(await knowledgeFor("no-such-company", "crm"), "");
  });

  await t.test("a rule that uses the knowledge base needs no text of its own, and Riwo answers customers from it", async () => {
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,phone,status) VALUES(gen_random_uuid()::text,$1,'kb-line',$2,'971500000000','CONNECTED')", [tenantId, o.user.id]);
    const made = await request(app).post("/api/automations").set(owner).send({
      name: "Riwo from my website",
      triggerType: "first_message",
      actionType: "ai_chat",
      config: { reply: "Hi {{first_name}}, welcome to {{company}}!", useKnowledge: true, knowledge: "" },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.automation.config.useKnowledge, true);
    await request(app).patch(`/api/automations/${made.body.automation.id}/toggle`).set(owner);
    const refused = await request(app).post("/api/automations").set(owner).send({ name: "x", triggerType: "first_message", actionType: "ai_chat", config: { reply: "Hi", useKnowledge: false, knowledge: "" } });
    assert.equal(refused.status, 400, "no text and no knowledge base is still refused");

    let n = 0;
    const hear = async (text) => {
      n += 1;
      await handleIncomingMessage({ tenantId, sessionName: "kb-line", msg: { providerMessageId: `kb_${n}`, fromMe: false, remoteId: "919800000001@c.us", rawType: "chat", type: "text", text, timestampEpoch: Math.floor(Date.now() / 1000) + n, senderName: "Asha", ack: 2 } });
      await pumpAutomations();
    };
    await hear("Hi");
    asked.length = 0;
    chatAnswer = () => ({ reply: "Scriza CRM plans start at AED 349 a month.", needs_person: false, heard_from: null });
    await hear("What does your CRM cost?");
    const prompt = asked.at(-1).messages[0].content;
    assert.match(prompt, /Scriza CRM is a sales CRM/, "the CRM page was given to Riwo");
    assert.ok(!/Dashboards for operations teams/.test(prompt), "and not the pages that have nothing to do with the question");
    const said = async () => (await query("SELECT text FROM messages WHERE tenant_id=$1 AND agent_name='Riwo' ORDER BY created_at DESC LIMIT 1", [tenantId])).rows[0]?.text || "";
    assert.match(await said(), /AED 349 a month/, "a figure that is on the website may be repeated");
    // a figure that is nowhere in the knowledge base is not sent
    chatAnswer = () => ({ reply: "Scriza CRM plans start at AED 199 a month.", needs_person: false, heard_from: null });
    await hear("And the cheapest plan?");
    assert.ok(!/AED 199/.test(await said()), "an invented price is never sent");
  });

  await t.test("only owners and administrators, only on plans with automations, and each company sees only its own", async () => {
    assert.equal((await request(app).get("/api/knowledge").set(agentAuth)).status, 403);
    assert.equal((await request(app).get("/api/knowledge")).status, 401);
    await query("UPDATE tenants SET plan='Starter' WHERE id=$1", [tenantId]);
    assert.equal((await request(app).get("/api/knowledge").set(owner)).status, 403);
    await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
    const other = await registerTenantAndUser({ name: "Otto", email: "otto@kb.test", password: "Password@123", companyName: "Other" });
    await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [other.tenant.id]);
    const otherAuth = { Authorization: `Bearer ${generateAccessToken(other.user, other.tenant.id, "owner")}` };
    assert.equal((await request(app).get("/api/knowledge").set(otherAuth)).body.sources.length, 0);
    assert.equal((await request(app).delete(`/api/knowledge/sources/${(await sourceOf()).id}`).set(otherAuth)).status, 404);
    assert.equal((await request(app).post("/api/knowledge/sources").set(owner).send({ url: "http://169.254.169.254/" })).status, 400);
    assert.equal((await request(app).post("/api/knowledge/sources").set(owner).send({ url: "" })).status, 400);
  });

  await t.test("there is a limit on websites, and removing one removes what was learned from it", async () => {
    for (let i = 1; i < KNOWLEDGE.maxSources; i++) await addSource(tenantId, `https://extra${i}.example`);
    await assert.rejects(addSource(tenantId, "https://onetoomany.example"), (e) => e.status === 400 && /up to 5/.test(e.message));
    const id = (await sourceOf()).id;
    assert.equal((await request(app).delete(`/api/knowledge/sources/${id}`).set(owner)).status, 200);
    assert.equal((await query("SELECT count(*)::int AS n FROM knowledge_pages WHERE tenant_id=$1", [tenantId])).rows[0].n, 0);
    assert.equal((await statusOf(tenantId)).products.length, 0, "the profile no longer lists what the site sold");
  });

  await t.test("a site that cannot be read says why, and without Riwo the profile is built from the pages' own words", async () => {
    await query("DELETE FROM knowledge_sources WHERE tenant_id=$1", [tenantId]);
    await addSource(tenantId, "https://down.example");
    await pumpKnowledge({ force: true, wait: true });
    const failed = await sourceOf();
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /couldn't open that website|error \(404\)/);
    await query("DELETE FROM knowledge_sources WHERE tenant_id=$1", [tenantId]);
    await query("UPDATE tenants SET ai_enabled=false WHERE id=$1", [tenantId]);
    await addSource(tenantId, "scriza.example");
    await pumpKnowledge({ force: true, wait: true });
    const st = await statusOf(tenantId);
    assert.equal(st.writtenByRiwo, false);
    assert.match(st.overview, /Scriza/);
    assert.ok(st.products.length >= 3 && st.products.every((p) => p.name));
    await query("UPDATE tenants SET ai_enabled=true WHERE id=$1", [tenantId]);
  });
});
