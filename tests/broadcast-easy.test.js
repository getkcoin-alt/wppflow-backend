import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { pumpCampaigns } from "../src/services/campaignService.js";
import { CAMPAIGN_TEMPLATES, unfilledBlanks } from "../src/services/campaignTemplates.js";
import { unknownVariables } from "../src/services/templating.js";
import { closeSessions } from "../src/services/sessionService.js";

test("the ready-made broadcasts only use fields that exist and say what to fill in", () => {
  assert.ok(CAMPAIGN_TEMPLATES.length >= 8);
  assert.equal(new Set(CAMPAIGN_TEMPLATES.map((t) => t.id)).size, CAMPAIGN_TEMPLATES.length);
  for (const t of CAMPAIGN_TEMPLATES) {
    assert.deepEqual(unknownVariables(t.text), [], t.id);
    assert.ok(t.text.length < 700, `${t.id} is short enough to read on a phone`);
    assert.deepEqual(unfilledBlanks(t.text).sort(), [...t.blanks].sort(), t.id);
  }
  assert.deepEqual(unfilledBlanks("Hi {{first_name}}, our offer is 20% off until Friday."), []);
  assert.deepEqual(unfilledBlanks("Offer: [your offer] ends [date]"), ["[your offer]", "[date]"]);
});

test("Broadcasts: choose an audience, see who would get it, and send in one step", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@bc.test", password: "Password@123", companyName: "Bloom Florist" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  const sam = (await registerTenantAndUser({ name: "Sam", email: "sam@bc.test", password: "Password@123", companyName: "Sam's own" })).user;
  await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, sam.id]);
  const agent = { Authorization: `Bearer ${generateAccessToken(sam, tenantId, "agent")}` };
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status) VALUES(gen_random_uuid()::text,$1,'shop',$2,'CONNECTED')", [tenantId, o.user.id]);
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status) VALUES(gen_random_uuid()::text,$1,'old-phone',$2,'DISCONNECTED')", [tenantId, o.user.id]);

  // Eight contacts: three VIPs; some agreed, some said no, some were never asked, one is on the do-not-contact list.
  const people = [
    ["Aisha Khan", "971500000001", ["vip"], true],
    ["Bilal", "971500000002", ["vip"], true],
    ["971500000003", "971500000003", ["vip"], null], // named by phone number, never asked
    ["Chitra Rao", "971500000004", [], true],
    ["Dev Patel", "971500000005", [], false], // said STOP
    ["Eman", "971500000006", ["lead"], null],
    ["Farah", "971500000007", ["lead"], true],
    ["Gita", "971500000008", [], true],
  ];
  for (const [name, phone, tags, optIn] of people) {
    await query("INSERT INTO contacts(id,tenant_id,name,phone,tags) VALUES(gen_random_uuid()::text,$1,$2,$3,$4)", [tenantId, name, phone, JSON.stringify(tags)]);
    if (optIn !== null) await query("INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,$2,$3,'workspace_recorded')", [tenantId, phone, optIn]);
  }
  await query("INSERT INTO suppressions(tenant_id,phone) VALUES($1,'971500000008')", [tenantId]); // Gita: opted in, but blocked
  const audience = async (tag) => (await request(app).get("/api/campaigns/audience").query(tag ? { tag } : {}).set(owner)).body;
  const create = (body) => request(app).post("/api/campaigns").set(owner).send({ name: "Spring", templateText: "Hi {{first_name}}, spring at {{company}}!", sessionName: "shop", ...body });

  await t.test("ready-made messages are listed with their fields", async () => {
    const res = await request(app).get("/api/campaigns/templates").set(owner);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.variables, ["name", "first_name", "company"]);
    assert.equal(res.body.templates.length, CAMPAIGN_TEMPLATES.length);
    assert.deepEqual(res.body.templates.find((x) => x.id === "offer").blanks, ["[your offer]", "[date]"]);
  });

  await t.test("the audience says who would get it and who would not, and why", async () => {
    const all = await audience();
    assert.deepEqual([all.total, all.willReceive, all.notAsked, all.optedOut], [8, 4, 2, 2]);
    const vip = await audience("vip");
    assert.deepEqual([vip.total, vip.willReceive, vip.notAsked, vip.optedOut], [3, 2, 1, 0]);
    assert.deepEqual(vip.tags, [
      { tag: "vip", count: 3, willReceive: 2 },
      { tag: "lead", count: 2, willReceive: 1 },
    ]);
    assert.deepEqual(await audience("no-such-tag").then((a) => [a.total, a.willReceive]), [0, 0]);
    assert.deepEqual(all.unsubscribeRule, { exists: false, enabled: false });
  });

  await t.test("the audience says whether people can reply STOP", async () => {
    await query(
      "INSERT INTO automations(id,tenant_id,name,trigger_condition,action_type,is_enabled) VALUES('stop-rule',$1,'Stop','stop','opt_out',false)",
      [tenantId],
    );
    assert.deepEqual((await audience()).unsubscribeRule, { exists: true, enabled: false });
    await query("UPDATE automations SET is_enabled=true WHERE id='stop-rule'");
    assert.deepEqual((await audience()).unsubscribeRule, { exists: true, enabled: true });
  });

  await t.test("permission can be recorded for people nobody has asked, and only by the owner", async () => {
    const body = { tag: "vip", confirm: true };
    assert.equal((await request(app).post("/api/contacts/permission").set(agent).send(body)).status, 403);
    const unconfirmed = await request(app).post("/api/contacts/permission").set(owner).send({ tag: "vip" });
    assert.equal(unconfirmed.status, 400);
    assert.match(unconfirmed.body.message, /Confirm that these contacts agreed/);
    assert.equal((await audience("vip")).notAsked, 1, "nothing changed without a confirmation");
    const res = await request(app).post("/api/contacts/permission").set(owner).send(body);
    assert.equal(res.status, 200);
    assert.equal(res.body.recorded, 1);
    assert.deepEqual([res.body.audience.willReceive, res.body.audience.notAsked], [3, 0]);
    const everyone = await request(app).post("/api/contacts/permission").set(owner).send({ confirm: true });
    assert.equal(everyone.body.recorded, 1, "Eman was the last one nobody had asked");
    const all = await audience();
    assert.deepEqual([all.willReceive, all.notAsked, all.optedOut], [6, 0, 2], "the person who said STOP and the blocked one are left alone");
    const audit = (await query("SELECT metadata FROM audit_events WHERE tenant_id=$1 AND event_type='consent.bulk_recorded' ORDER BY id", [tenantId])).rows.map((r) => r.metadata);
    assert.deepEqual(audit, [{ audience: "vip", recorded: 1 }, { audience: "All Contacts", recorded: 1 }]);
  });

  await t.test("a message is checked before anything is created", async () => {
    const bad = async (body, status, pattern) => {
      const res = await create(body);
      assert.equal(res.status, status, JSON.stringify(res.body));
      assert.match(res.body.message, pattern);
    };
    await bad({ templateText: "Hi {{nickname}}" }, 400, /\{\{nickname\}\} isn't a field/);
    await bad({ templateText: "Offer: [your offer] ends [date]" }, 400, /Fill in \[your offer\], \[date\] before sending/);
    await bad({ launch: "now", sessionName: "elsewhere" }, 400, /Choose one of your WhatsApp numbers/);
    await bad({ launch: "now", sessionName: "old-phone" }, 400, /isn't connected right now/);
    await bad({ launch: "now", sessionName: "" }, 400, /Choose the WhatsApp number/);
    await bad({ launch: "now", targetSegment: "no-such-tag" }, 400, /Nobody in this audience has given permission/);
    await bad({ launch: "schedule", scheduledFor: "" }, 400, /future/);
    await bad({ launch: "schedule", scheduledFor: new Date(Date.now() - 3600_000).toISOString() }, 400, /future/);
    assert.equal((await query("SELECT count(*)::int AS n FROM campaigns WHERE tenant_id=$1", [tenantId])).rows[0].n, 0, "nothing was created");
  });

  await t.test("a draft is still just a draft", async () => {
    const res = await create({ sessionName: "old-phone" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.campaign.status, "draft");
    await query("DELETE FROM campaigns WHERE tenant_id=$1", [tenantId]);
  });

  let sent;
  await t.test("send now creates it and starts it in one step", async () => {
    const res = await create({ launch: "now", targetSegment: "vip", antiBanDelaySeconds: 6 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    sent = res.body.campaign;
    assert.deepEqual([sent.status, sent.totalRecipients, sent.targetSegment, sent.antiBanDelaySeconds], ["running", 3, "vip", 6]);
  });

  await t.test("each person gets the message with their own name and the company's", async () => {
    for (let i = 0; i < 4; i++) {
      await query("UPDATE campaigns SET updated_at=now()-interval '1 minute' WHERE id=$1", [sent.id]);
      await pumpCampaigns();
    }
    const texts = (
      await query("SELECT m.text FROM messages m JOIN campaign_recipients r ON r.message_id=m.id WHERE r.campaign_id=$1 ORDER BY r.id", [sent.id])
    ).rows.map((r) => r.text);
    assert.deepEqual(texts, ["Hi Aisha, spring at Bloom Florist!", "Hi Bilal, spring at Bloom Florist!", "Hi there, spring at Bloom Florist!"], "a contact named by phone number is not greeted by it");
  });

  await t.test("a broadcast can be scheduled, and waits for its time", async () => {
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    const res = await create({ launch: "schedule", scheduledFor: at, name: "Tonight" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.campaign.status, "running");
    assert.equal(res.body.campaign.scheduledFor, at);
    await query("UPDATE campaigns SET updated_at=now()-interval '1 minute' WHERE id=$1", [res.body.campaign.id]);
    await pumpCampaigns();
    const sentNow = (await query("SELECT count(*)::int AS n FROM campaign_recipients WHERE campaign_id=$1 AND status<>'pending'", [res.body.campaign.id])).rows[0].n;
    assert.equal(sentNow, 0, "nothing goes out before the start time");
  });

  await t.test("an earlier broadcast can be copied as a new draft", async () => {
    const res = await request(app).post(`/api/campaigns/${sent.id}/duplicate`).set(owner);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const copy = res.body.campaign;
    assert.notEqual(copy.id, sent.id);
    assert.deepEqual([copy.name, copy.status, copy.templateText, copy.targetSegment, copy.sessionName, copy.antiBanDelaySeconds, copy.scheduledFor, copy.sentCount], ["Spring (copy)", "draft", sent.templateText, "vip", "shop", 6, "", 0]);
    assert.equal((await request(app).post("/api/campaigns/missing/duplicate").set(owner)).status, 404);
  });

  await t.test("broadcasts stay for owners and administrators", async () => {
    for (const path of ["/api/campaigns/templates", "/api/campaigns/audience"]) assert.equal((await request(app).get(path).set(agent)).status, 403, path);
    await query("UPDATE tenants SET plan='Starter' WHERE id=$1", [tenantId]);
    assert.equal((await request(app).get("/api/campaigns/audience").set(owner)).status, 403, "and they need a plan that includes them");
    await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  });

  await t.test("a spreadsheet can say who agreed, without overriding a STOP or wiping tags", async () => {
    const rows = [
      { name: "Hana", phone: "971500000020", tags: "new;vip", optin: "yes" },
      { name: "Ivan", phone: "971500000021", optin: "no" },
      { name: "Dev Patel", phone: "971500000005", optin: "yes" }, // said STOP earlier
      { name: "Aisha Khan", phone: "971500000001", optin: "" }, // no tags in this file
    ];
    const res = await request(app).post("/api/contacts/import").set(owner).send({ rows });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const consent = async (phone) => (await query("SELECT opt_in_status,source FROM consents WHERE tenant_id=$1 AND phone=$2", [tenantId, phone])).rows[0];
    assert.deepEqual(await consent("971500000020"), { opt_in_status: true, source: "csv_import" });
    assert.deepEqual(await consent("971500000021"), { opt_in_status: false, source: "csv_import" });
    assert.equal((await consent("971500000005")).opt_in_status, false, "a customer's STOP is not undone by a file");
    assert.equal((await query("SELECT tags FROM contacts WHERE tenant_id=$1 AND phone='971500000001'", [tenantId])).rows[0].tags[0], "vip", "tags are kept when the file has none");
    assert.deepEqual((await query("SELECT tags FROM contacts WHERE tenant_id=$1 AND phone='971500000020'", [tenantId])).rows[0].tags, ["new", "vip"]);
  });
});
