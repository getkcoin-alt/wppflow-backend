import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { app, io as serverIo } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ensureSuperAdmin } from "../src/services/adminService.js";
import { generateAccessToken } from "../src/services/authService.js";
import { ENV } from "../src/config/env.js";
import { setMailTransport } from "../src/services/mailer.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { syncContacts } from "../src/routes/contactRoutes.js";
import { closeSessions } from "../src/services/sessionService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { limitsOf, stateOf } from "../src/services/limitsService.js";

test("what a plan allows in contacts and broadcasts", () => {
  assert.equal(stateOf(0, null), "unlimited");
  assert.equal(stateOf(79, 100), "ok");
  assert.equal(stateOf(80, 100), "near", "80% is the warning");
  assert.equal(stateOf(99, 100), "near");
  assert.equal(stateOf(100, 100), "full");
  assert.equal(stateOf(140, 100), "full", "over the limit because customers wrote in is still full, not an error");
  assert.equal(stateOf(0, 1), "ok");
  assert.equal(stateOf(1, 1), "full");
  // a company past its grace period has what Free has, so Free's limits
  assert.deepEqual(limitsOf({ plan: "Growth", period_end: "2020-01-01", scheduled_plan: null }), { plan: "Free", contacts: null, broadcasts: null });
});

test("Plan limits: contacts and broadcasts a month", async (t) => {
  setMailTransport({ sendMail: async () => {} });
  const realGetContacts = provider.getContacts;
  t.after(async () => {
    provider.getContacts = realGetContacts;
    setMailTransport(undefined);
    await closeSessions(serverIo);
    serverIo.close();
  });
  ENV.SUPERADMIN_EMAIL = "root@limits.test";
  ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
  await ensureSuperAdmin();
  const sa = await request(app).post("/api/auth/login").send({ email: ENV.SUPERADMIN_EMAIL, password: ENV.SUPERADMIN_PASSWORD });
  const admin = { Authorization: `Bearer ${sa.body.token}` };
  const created = await request(app).post("/api/admin/companies").set(admin).send({ companyName: "Limits Co", ownerName: "Owner", ownerEmail: "owner@limits.test", plan: "Growth" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const tenantId = created.body.company.id;
  const ownerRow = (await query("SELECT * FROM users WHERE email='owner@limits.test'")).rows[0];
  const owner = { Authorization: `Bearer ${generateAccessToken(ownerRow, tenantId, "owner")}` };
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,status,phone) VALUES(gen_random_uuid()::text,$1,'main-line','CONNECTED','971500000000')", [tenantId]);
  const usageReset = () => `1 ${new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" })}`;
  const setPlan = (body) => request(app).put("/api/admin/plans/growth").set(admin).send(body);
  const caps = async () => (await request(app).get("/api/workspace/capabilities").set(owner)).body.usage;
  const add = (phone, name = "Person") => request(app).post("/api/contacts").set(owner).send({ name, phone });
  const count = async () => (await query("SELECT count(*)::int AS n FROM contacts WHERE tenant_id=$1", [tenantId])).rows[0].n;
  let n = 0;
  const hear = async (phone) =>
    handleIncomingMessage({ tenantId, sessionName: "main-line", msg: { providerMessageId: `lim_${phone}_${++n}`, fromMe: false, remoteId: `${phone}@c.us`, rawType: "chat", type: "text", text: "hi", timestampEpoch: Math.floor(Date.now() / 1000) + n, senderName: `Cust ${phone.slice(-3)}`, ack: 2 } });

  await t.test("the platform admin sets the limits on a plan, and bad numbers are refused", async () => {
    for (const body of [{ maxContacts: 0 }, { maxContacts: "many" }, { maxContacts: 100000001 }, { maxBroadcasts: 0 }, { maxBroadcasts: 1.5 }, { maxBroadcasts: 100001 }])
      assert.equal((await setPlan(body)).status, 400, JSON.stringify(body));
    const ok = await setPlan({ maxContacts: 3, maxBroadcasts: 2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const plan = (await request(app).get("/api/admin/plans").set(admin)).body.plans.find((p) => p.id === "growth");
    assert.deepEqual([plan.maxContacts, plan.maxBroadcasts], [3, 2]);
    assert.equal((await query("SELECT count(*)::int AS n FROM plan_changes WHERE plan_code='growth'")).rows[0].n > 0, true, "the change is on record");
    assert.deepEqual(await caps(), { plan: "Growth", contacts: { used: 0, limit: 3, state: "ok" }, broadcasts: { used: 0, limit: 2, state: "ok", resets: usageReset() } });
  });

  await t.test("a person adding contacts by hand is stopped at the limit, with the reason, and a duplicate is still a duplicate", async () => {
    assert.equal((await add("971500000101")).status, 201);
    assert.equal((await add("971500000102")).status, 201);
    assert.equal((await caps()).contacts.state, "ok", "two of three: with a limit this small the warning and the limit are the same step");
    assert.equal((await add("971500000103")).status, 201);
    assert.equal((await caps()).contacts.state, "full");
    const refused = await add("971500000104");
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "plan_limit");
    assert.equal(refused.body.limit, "contacts");
    assert.match(refused.body.message, /Your Growth plan includes up to 3 contacts and you have 3\. Remove some contacts, or move to a bigger plan/);
    assert.equal(await count(), 3, "nothing was saved");
    const dup = await add("971500000101");
    assert.equal(dup.status, 409, "someone already saved is a duplicate, not a limit");
    // deleting makes room
    const first = (await query("SELECT id FROM contacts WHERE tenant_id=$1 AND phone='971500000101'", [tenantId])).rows[0].id;
    assert.equal((await request(app).delete(`/api/contacts/${first}`).set(owner)).status, 200);
    assert.equal((await add("971500000104")).status, 201);
  });

  await t.test("a customer who writes in is never turned away, even over the limit", async () => {
    await hear("971500000201");
    await hear("971500000202");
    assert.equal(await count(), 5);
    const chat = (await query("SELECT 1 FROM conversations WHERE tenant_id=$1 AND phone='971500000201'", [tenantId])).rowCount;
    assert.equal(chat, 1, "the chat and its message are there");
    const usage = await caps();
    assert.deepEqual([usage.contacts.used, usage.contacts.limit, usage.contacts.state], [5, 3, "full"], "over the limit shows as full, nothing is deleted");
    assert.equal((await add("971500000203")).status, 403, "but the team cannot add more by hand");
  });

  await t.test("an import that would add people over the limit saves none of that batch, and one that only updates is fine", async () => {
    const before = await count();
    const refused = await request(app).post("/api/contacts/import").set(owner).send({ rows: [{ name: "New One", phone: "971500000301" }, { name: "New Two", phone: "971500000302" }] });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "plan_limit");
    assert.match(refused.body.message, /This file would add 2 more, so none of this batch was saved/);
    assert.equal(await count(), before);
    assert.equal((await query("SELECT 1 FROM contacts WHERE tenant_id=$1 AND phone='971500000301'", [tenantId])).rowCount, 0);
    // the same people renamed: nobody new, so it goes through
    const update = await request(app).post("/api/contacts/import").set(owner).send({ rows: [{ name: "Renamed", phone: "971500000102" }] });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal(update.body.imported, 1);
    assert.equal(await count(), before);
  });

  await t.test("starting a chat with a new number is stopped at the limit; chatting with someone already saved is not", async () => {
    const fresh = await request(app).post("/api/conversations").set(owner).send({ phone: "971500000401", sessionName: "main-line" });
    assert.equal(fresh.status, 403, JSON.stringify(fresh.body));
    assert.equal(fresh.body.code, "plan_limit");
    const known = await request(app).post("/api/conversations").set(owner).send({ phone: "971500000102", sessionName: "main-line" });
    assert.ok([200, 201].includes(known.status), JSON.stringify(known.body));
  });

  await t.test("copying contacts from the phone adds people only while there is room, and still updates the ones already saved", async () => {
    await query("DELETE FROM contacts WHERE tenant_id=$1", [tenantId]);
    await query("DELETE FROM conversations WHERE tenant_id=$1", [tenantId]);
    await setPlan({ maxContacts: 5 });
    await add("971500000501", "Saved Before");
    provider.getContacts = async () =>
      ["971500000501", "971500000502", "971500000503", "971500000504", "971500000505", "971500000506", "971500000507"].map((p, i) => ({ id: { _serialized: `${p}@c.us` }, name: `From phone ${i}` }));
    const added = await syncContacts(tenantId, "main-line");
    assert.equal(await count(), 5, "up to the limit and no further");
    assert.equal(added, 5);
    assert.equal((await query("SELECT whatsapp_name FROM contacts WHERE tenant_id=$1 AND phone='971500000501'", [tenantId])).rows[0].whatsapp_name, "From phone 0", "the one already saved was updated");
    // synced again at the limit: nobody new, the rest still updated
    provider.getContacts = async () => [{ id: { _serialized: "971500000501@c.us" }, name: "Changed on phone" }, { id: { _serialized: "971500000599@c.us" }, name: "Brand new" }];
    await syncContacts(tenantId, "main-line");
    assert.equal(await count(), 5);
    assert.equal((await query("SELECT whatsapp_name FROM contacts WHERE tenant_id=$1 AND phone='971500000501'", [tenantId])).rows[0].whatsapp_name, "Changed on phone");
    await setPlan({ maxContacts: null });
    assert.equal((await caps()).contacts.state, "unlimited");
    assert.equal((await add("971500000600")).status, 201, "no limit again");
  });

  await t.test("a plan with a monthly broadcast limit stops the next one, counts a restart once, ignores drafts and starts again next month", async () => {
    await setPlan({ maxBroadcasts: 2 });
    const phone = "971500000700";
    await query("INSERT INTO contacts(id,tenant_id,name,phone) VALUES(gen_random_uuid()::text,$1,'Opted In',$2) ON CONFLICT DO NOTHING", [tenantId, phone]);
    await query("INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,$2,true,'test') ON CONFLICT(tenant_id,phone) DO UPDATE SET opt_in_status=true", [tenantId, phone]);
    const make = async (name) => {
      const id = crypto.randomUUID();
      await query("INSERT INTO campaigns(id,tenant_id,name,target_segment,template_text,session_name) VALUES($1,$2,$3,'All Contacts','Hello',$4)", [id, tenantId, name, "main-line"]);
      return id;
    };
    const start = (id) => request(app).post(`/api/campaigns/${id}/start`).set(owner);
    const [a, b, c, d] = [await make("One"), await make("Two"), await make("Three"), await make("Four")];
    assert.equal((await caps()).broadcasts.used, 0, "drafts are not broadcasts");
    assert.equal((await start(a)).status, 200);
    assert.equal((await caps()).broadcasts.state, "ok", "one of two");
    assert.equal((await start(b)).status, 200);
    assert.deepEqual(await Promise.all([caps().then((u) => [u.broadcasts.used, u.broadcasts.state])]), [[2, "full"]]);
    const refused = await start(c);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "plan_limit");
    assert.equal(refused.body.limit, "broadcasts");
    assert.match(refused.body.message, /includes 2 broadcasts a month and 2 have already been started this month\. The count starts again on 1 /);
    assert.equal((await query("SELECT status FROM campaigns WHERE id=$1", [c])).rows[0].status, "draft", "it stays a draft");
    // pause and start the first again: not a new broadcast
    assert.equal((await request(app).post(`/api/campaigns/${a}/pause`).set(owner)).status, 200);
    assert.equal((await start(a)).status, 200);
    assert.equal((await caps()).broadcasts.used, 2);
    // creating one to start at once is held to the same limit
    const direct = await request(app).post("/api/campaigns").set(owner).send({ name: "Now", templateText: "Hi", sessionName: "main-line", launch: "now" });
    assert.equal(direct.status, 403);
    // a new month: last month's broadcasts no longer count
    await query("UPDATE campaigns SET started_at=now()-interval '40 days' WHERE id=ANY($1::text[])", [[a, b]]);
    assert.equal((await caps()).broadcasts.used, 0);
    assert.equal((await start(c)).status, 200);
    await setPlan({ maxBroadcasts: null });
    assert.equal((await start(d)).status, 200, "no limit again");
  });

  await t.test("companies on another plan are not held to this plan's limits", async () => {
    const other = await request(app).post("/api/admin/companies").set(admin).send({ companyName: "Elsewhere Co", ownerName: "Owner Two", ownerEmail: "owner2@limits.test", plan: "Business" });
    const id = other.body.company.id;
    const o2 = (await query("SELECT * FROM users WHERE email='owner2@limits.test'")).rows[0];
    const auth = { Authorization: `Bearer ${generateAccessToken(o2, id, "owner")}` };
    await setPlan({ maxContacts: 1 });
    for (const p of ["971500000801", "971500000802", "971500000803"]) assert.equal((await request(app).post("/api/contacts").set(auth).send({ name: "x", phone: p })).status, 201);
    assert.equal((await request(app).get("/api/workspace/capabilities").set(auth)).body.usage.contacts.limit, null);
    await setPlan({ maxContacts: null });
  });
});
