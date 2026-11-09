import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ENV } from "../src/config/env.js";
import { ensureSuperAdmin } from "../src/services/adminService.js";
import { generateAccessToken, generateRefreshToken } from "../src/services/authService.js";
import { setMailTransport } from "../src/services/mailer.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { deleteTenantMedia, setMediaSend } from "../src/services/mediaService.js";

const KEYS = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT", "S3_REGION"];

test("the platform admin deletes a company, and everything of it goes", async (t) => {
  setMailTransport({ sendMail: async () => {} });
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const realProvider = { logoutSession: provider.logoutSession, closeSession: provider.closeSession, deleteTokens: provider.deleteTokens };
  t.after(async () => {
    for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    Object.assign(provider, realProvider);
    setMediaSend(undefined);
    setMailTransport(undefined);
    await closeSessions(io);
    io.close();
  });
  // storage that is not real: what is listed, and what was asked of it
  process.env.S3_BUCKET = "scriwo-media";
  process.env.S3_ACCESS_KEY_ID = "id";
  process.env.S3_SECRET_ACCESS_KEY = "secret";
  process.env.S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  const stored = new Map(); // key -> true
  const asked = [];
  let storageFails = false;
  setMediaSend(async (command) => {
    const kind = command.constructor.name;
    const input = command.input;
    asked.push({ kind, ...input });
    if (storageFails) throw new Error("storage is down");
    if (kind === "ListObjectsV2Command") {
      // two at a time, to make it page. As on real storage, the token says where to carry on (after which key), so deleting what was listed
      // does not move the next page
      const keys = [...stored.keys()].filter((k) => k.startsWith(input.Prefix) && (!input.ContinuationToken || k > input.ContinuationToken)).sort();
      const page = keys.slice(0, 2);
      return { Contents: page.map((Key) => ({ Key })), IsTruncated: keys.length > 2, NextContinuationToken: page.at(-1) };
    }
    if (kind === "DeleteObjectCommand") {
      stored.delete(input.Key);
      return {};
    }
    return {};
  });
  // WhatsApp, as the phones would answer
  const unlinked = [];
  let logout = async () => true;
  provider.logoutSession = async (tenantId, name) => {
    unlinked.push(`${tenantId}:${name}`);
    return logout(tenantId, name);
  };
  provider.closeSession = async () => {};
  provider.deleteTokens = () => {};

  ENV.SUPERADMIN_EMAIL = "root@delete.test";
  ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
  await ensureSuperAdmin();
  const sa = await request(app).post("/api/auth/login").send({ email: ENV.SUPERADMIN_EMAIL, password: ENV.SUPERADMIN_PASSWORD });
  assert.equal(sa.status, 200, JSON.stringify(sa.body));
  const admin = { Authorization: `Bearer ${sa.body.token}` };
  const superRow = (await query("SELECT * FROM users WHERE email=$1", [ENV.SUPERADMIN_EMAIL])).rows[0];

  const makeCompany = async (name, email, plan = "Growth") => {
    const r = await request(app).post("/api/admin/companies").set(admin).send({ companyName: name, ownerName: `${name} Owner`, ownerEmail: email, plan });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const tenantId = r.body.company.id;
    const ownerRow = (await query("SELECT * FROM users WHERE email=$1", [email])).rows[0];
    return { tenantId, name, ownerRow, owner: { Authorization: `Bearer ${generateAccessToken(ownerRow, tenantId, "owner")}` } };
  };
  let n = 0;
  // a company with something in nearly every drawer, including every table that does not follow it out by itself
  const fill = async (c, { files = 0 } = {}) => {
    const { tenantId, owner, ownerRow } = c;
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,status,phone) VALUES(gen_random_uuid()::text,$1,'main-line','CONNECTED','971500000000')", [tenantId]);
    for (const phone of ["971501110001", "971501110002"]) {
      await handleIncomingMessage({ tenantId, sessionName: "main-line", msg: { providerMessageId: `del_${tenantId}_${phone}_${++n}`, fromMe: false, remoteId: `${phone}@c.us`, rawType: "chat", type: "text", text: "hello", timestampEpoch: Math.floor(Date.now() / 1000) + n, senderName: `Cust ${phone.slice(-3)}`, ack: 2 } });
    }
    assert.equal((await request(app).post("/api/contacts").set(owner).send({ name: "Added By Hand", phone: "+971501110003" })).status, 201);
    const made = await request(app).post("/api/automations").set(owner).send({ name: "Greeter", triggerType: "keyword", triggerCondition: "hello", actionType: "reply_text", actionSummary: "Say hi" });
    assert.ok(made.status < 300, JSON.stringify(made.body));
    const automationId = made.body.automation?.id ?? made.body.id;
    const messageId = (await query("SELECT id FROM messages WHERE tenant_id=$1 ORDER BY created_at LIMIT 1", [tenantId])).rows[0].id;
    const conversationId = (await query("SELECT id FROM conversations WHERE tenant_id=$1 LIMIT 1", [tenantId])).rows[0].id;
    // the eight tables that refer to a company without cascading
    await query("INSERT INTO automation_executions(id,tenant_id,automation_id,message_id,status) VALUES(gen_random_uuid(),$1,$2,$3,'done')", [tenantId, automationId, messageId]);
    await query("INSERT INTO canned_replies(id,tenant_id,shortcut,title,text) VALUES(gen_random_uuid(),$1,'/hi','Hello','Hello there')", [tenantId]);
    await query("INSERT INTO early_receipts(tenant_id,provider_message_id,ack) VALUES($1,'early-1',2)", [tenantId]);
    await query("INSERT INTO api_keys(id,tenant_id,name,key_hash,prefix,scopes) VALUES(gen_random_uuid(),$1,'k',$2,'wpf_x','[\"inbox\"]')", [tenantId, crypto.randomUUID()]);
    const endpoint = crypto.randomUUID();
    await query("INSERT INTO webhook_endpoints(id,tenant_id,url,secret) VALUES($1,$2,'https://example.com/hook','s')", [endpoint, tenantId]);
    await query("INSERT INTO webhook_deliveries(id,tenant_id,endpoint_id,event,payload) VALUES(gen_random_uuid(),$1,$2,'message.received','{}')", [tenantId, endpoint]);
    await generateRefreshToken(ownerRow.id, tenantId);
    // Free OTP, the newest tables
    assert.equal((await request(app).put("/api/otp-setup/settings").set(owner).send({ template: "delivery" })).status, 200);
    assert.equal((await request(app).post("/api/otp-setup/keys").set(owner).send({ name: "k", kind: "secret", mode: "test" })).status, 201);
    for (let i = 0; i < files; i++) {
      const key = `${tenantId}/file-${i}`;
      stored.set(key, true);
      stored.set(`${key}.preview`, true);
      await query("INSERT INTO attachments(id,tenant_id,conversation_id,storage_key,original_name,mime_type,byte_size,upload_status) VALUES(gen_random_uuid(),$1,$2,$3,'a.png','image/png',10,'ready')", [tenantId, conversationId, key]);
    }
  };
  const everywhere = async (tenantId) => {
    const tables = (await query("SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name<>'deleted_companies' ORDER BY 1")).rows.map((r) => r.table_name);
    const left = {};
    for (const table of tables) {
      const count = (await query(`SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id=$1`, [tenantId])).rows[0].n;
      if (count) left[table] = count;
    }
    return { tables: tables.length, left };
  };
  const preview = (id) => request(app).get(`/api/admin/companies/${id}/deletion`).set(admin);
  const remove = (id, body) => request(app).post(`/api/admin/companies/${id}/delete`).set(admin).send(body);

  await t.test("it shows what would go, and changes nothing", async () => {
    const c = await makeCompany("Preview Co", "owner@preview.test");
    await fill(c, { files: 3 });
    const r = await preview(c.tenantId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.canDelete, true);
    assert.deepEqual(r.body.blockers, []);
    assert.equal(r.body.company.name, "Preview Co");
    assert.deepEqual(r.body.company.owner, { name: "Preview Co Owner", email: "owner@preview.test" });
    assert.deepEqual({ people: r.body.counts.people, numbers: r.body.counts.numbers, connectedNumbers: r.body.counts.connectedNumbers, contacts: r.body.counts.contacts, files: r.body.counts.files, automations: r.body.counts.automations }, { people: 1, numbers: 1, connectedNumbers: 1, contacts: 3, files: 3, automations: 1 });
    assert.ok(r.body.counts.messages >= 2 && r.body.counts.conversations >= 2);
    assert.equal((await query("SELECT status FROM tenants WHERE id=$1", [c.tenantId])).rows[0].status, "active", "looking is not doing");
    assert.equal(stored.size, 6);
  });

  await t.test("only the platform administrator may look or delete", async () => {
    const c = await makeCompany("Guarded Co", "owner@guarded.test");
    for (const [headers, want] of [[c.owner, 403], [{}, 401]]) {
      assert.equal((await request(app).get(`/api/admin/companies/${c.tenantId}/deletion`).set(headers)).status, want);
      assert.equal((await request(app).post(`/api/admin/companies/${c.tenantId}/delete`).set(headers).send({ confirmName: "Guarded Co" })).status, want);
      assert.equal((await request(app).get("/api/admin/deleted-companies").set(headers)).status, want);
    }
    assert.equal((await query("SELECT count(*)::int AS n FROM tenants WHERE id=$1", [c.tenantId])).rows[0].n, 1);
  });

  await t.test("the name has to be typed, exactly, or nothing happens", async () => {
    const c = await makeCompany("Careful Co", "owner@careful.test");
    for (const confirmName of [undefined, "", "   ", "Careful", "Careful Co Ltd", "someone else", 42]) {
      const r = await remove(c.tenantId, { confirmName });
      assert.equal(r.status, 400, `"${confirmName}"`);
    }
    assert.equal((await remove(c.tenantId, undefined)).status, 400);
    assert.equal((await query("SELECT status FROM tenants WHERE id=$1", [c.tenantId])).rows[0].status, "active", "a wrong name does not even suspend it");
    // spaces and capitals do not matter
    const ok = await remove(c.tenantId, { confirmName: "  careful CO " });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  await t.test("everything of the company is gone, from every table, and the others are untouched", async () => {
    const doomed = await makeCompany("Doomed Co", "owner@doomed.test");
    const stays = await makeCompany("Stays Co", "owner@stays.test");
    await fill(doomed, { files: 5 });
    await fill(stays, { files: 2 });
    // one person is in both companies
    const shared = (await query("INSERT INTO users(email,password_hash,name,status) VALUES('shared@both.test','x','Shared Person','active') RETURNING *")).rows[0];
    for (const c of [doomed, stays]) await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [c.tenantId, shared.id]);
    const before = { stays: await everywhere(stays.tenantId) };
    const withData = await everywhere(doomed.tenantId);
    assert.ok(Object.keys(withData.left).length >= 15, `the company really had data: ${Object.keys(withData.left).length} tables`);
    for (const table of ["api_keys", "automation_executions", "canned_replies", "early_receipts", "invitations", "refresh_tokens", "webhook_deliveries", "webhook_endpoints", "otp_settings", "otp_keys", "attachments", "messages", "contacts"])
      assert.ok(withData.left[table], `${table} had rows to delete`);

    const r = await remove(doomed.tenantId, { confirmName: "Doomed Co" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.deleted.name, "Doomed Co");
    assert.equal(r.body.removed.files, 10, "the files and their previews");
    assert.equal(r.body.removed.contacts, 3);
    assert.deepEqual(r.body.numbersNotUnlinked, []);
    assert.equal(r.body.peopleRemoved, 1, "the owner was in no other company; the shared person was");

    const after = await everywhere(doomed.tenantId);
    assert.deepEqual(after.left, {}, `nothing left in any of the ${after.tables} tables that have a company column`);
    assert.equal((await query("SELECT count(*)::int AS n FROM tenants WHERE id=$1", [doomed.tenantId])).rows[0].n, 0);
    assert.equal((await query("SELECT count(*)::int AS n FROM users WHERE email='owner@doomed.test'")).rows[0].n, 0, "the owner who belonged to nothing else is gone");
    assert.equal((await query("SELECT count(*)::int AS n FROM users WHERE email=$1", [ENV.SUPERADMIN_EMAIL])).rows[0].n, 1, "the platform administrator is never touched");
    const sharedStill = await query("SELECT (SELECT count(*)::int FROM memberships WHERE user_id=$1) AS memberships FROM users WHERE id=$1", [shared.id]);
    assert.equal(sharedStill.rows[0].memberships, 1, "someone in another company stays, in that company");
    assert.deepEqual(await everywhere(stays.tenantId), before.stays, "the other company has every row it had");
    assert.deepEqual([...stored.keys()].filter((k) => k.startsWith(doomed.tenantId)), []);
    assert.equal([...stored.keys()].filter((k) => k.startsWith(stays.tenantId)).length, 4, "the other company's files are all still there");
    assert.ok(unlinked.includes(`${doomed.tenantId}:main-line`), "its number was unlinked from the phone");
    // the owner's session no longer works
    assert.equal((await request(app).get("/api/workspace/capabilities").set(doomed.owner)).status >= 400, true);
    // the second time, there is nothing to delete
    assert.equal((await remove(doomed.tenantId, { confirmName: "Doomed Co" })).status, 404);
    assert.equal((await preview(doomed.tenantId)).status, 404);
  });

  await t.test("a short record of it stays: the name, the owner, the numbers, who did it and when", async () => {
    const list = await request(app).get("/api/admin/deleted-companies").set(admin);
    assert.equal(list.status, 200);
    const record = list.body.companies.find((x) => x.name === "Doomed Co");
    assert.ok(record, JSON.stringify(list.body.companies.map((x) => x.name)));
    assert.deepEqual(record.owner, { name: "Doomed Co Owner", email: "owner@doomed.test" });
    assert.equal(record.plan, "Growth");
    assert.equal(record.deletedBy, ENV.SUPERADMIN_EMAIL);
    assert.equal(record.counts.contacts, 3);
    assert.equal(record.counts.files, 10);
    assert.ok(Math.abs(Date.now() - new Date(record.deletedAt).getTime()) < 120_000);
    // what it holds is numbers and a name, never a message, a contact or a file
    assert.deepEqual(Object.keys(record).sort(), ["companyId", "counts", "createdAt", "deletedAt", "deletedBy", "id", "name", "owner", "plan"]);
    // and the platform's own log has a line about it
    const line = (await query("SELECT * FROM audit_events WHERE event_type='company.deleted' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(line.actor_id, superRow.id);
    assert.equal(line.metadata.name, "Doomed Co");
    assert.equal(line.tenant_id, "tenant_scriza");
  });

  await t.test("a number that cannot be unlinked, or stopped, is said so and never stops the deletion", async () => {
    const c = await makeCompany("Offline Co", "owner@offline.test");
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,status,phone) VALUES(gen_random_uuid()::text,$1,'line-a','DISCONNECTED','971500000001')", [c.tenantId]);
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,status,phone) VALUES(gen_random_uuid()::text,$1,'line-b','CONNECTED','971500000002')", [c.tenantId]);
    logout = async (tenantId, name) => {
      if (name === "line-b") throw new Error("the phone is not answering");
      return false; // could not unlink it from the phone
    };
    try {
      const r = await remove(c.tenantId, { confirmName: "Offline Co" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([...r.body.numbersNotUnlinked].sort(), ["line-a", "line-b"]);
      assert.equal((await query("SELECT count(*)::int AS n FROM tenants WHERE id=$1", [c.tenantId])).rows[0].n, 0);
    } finally {
      logout = async () => true;
    }
  });

  await t.test("if the files cannot be removed, nothing else is deleted, it is suspended, and it can be tried again", async () => {
    const c = await makeCompany("Stuck Co", "owner@stuck.test");
    await fill(c, { files: 2 });
    storageFails = true;
    const first = await remove(c.tenantId, { confirmName: "Stuck Co" });
    assert.equal(first.status, 502, JSON.stringify(first.body));
    assert.match(first.body.message, /could not be removed from storage/);
    assert.match(first.body.message, /Nothing else was deleted/);
    assert.equal((await query("SELECT count(*)::int AS n FROM contacts WHERE tenant_id=$1", [c.tenantId])).rows[0].n, 3, "its records are all still there");
    assert.equal((await query("SELECT status FROM tenants WHERE id=$1", [c.tenantId])).rows[0].status, "suspended", "meanwhile nobody can work in it");
    storageFails = false;
    const again = await remove(c.tenantId, { confirmName: "Stuck Co" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual((await everywhere(c.tenantId)).left, {});
    assert.deepEqual([...stored.keys()].filter((k) => k.startsWith(c.tenantId)), []);
  });

  await t.test("a company with payments on record is kept: billing records have to be, so it can be suspended but not deleted", async () => {
    const c = await makeCompany("Paying Co", "owner@paying.test");
    const paid = await request(app).post(`/api/admin/companies/${c.tenantId}/subscription/payment`).set(admin).send({ plan: "growth", cycle: "monthly", amount: 8258.82, currency: "INR", reference: "NEFT-1" });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    const r = await preview(c.tenantId);
    assert.equal(r.body.canDelete, false);
    assert.match(r.body.blockers[0], /1 payment recorded by hand on record/);
    assert.match(r.body.blockers[0], /can be suspended but not deleted/);
    const refused = await remove(c.tenantId, { confirmName: "Paying Co" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /payment recorded by hand/);
    assert.equal((await query("SELECT status FROM tenants WHERE id=$1", [c.tenantId])).rows[0].status, "active", "refused before anything was touched");
    assert.equal((await query("SELECT count(*)::int AS n FROM subscription_payments WHERE tenant_id=$1", [c.tenantId])).rows[0].n, 1);
    assert.equal((await request(app).patch(`/api/admin/companies/${c.tenantId}`).set(admin).send({ status: "suspended" })).status, 200, "suspending is still possible");
  });

  await t.test("the company that runs the platform, and any company the platform administrator is in, cannot be deleted", async () => {
    const scriza = await preview("tenant_scriza");
    assert.equal(scriza.status, 200);
    assert.equal(scriza.body.canDelete, false);
    assert.match(scriza.body.blockers[0], /runs the platform/);
    assert.equal((await remove("tenant_scriza", { confirmName: scriza.body.company.name })).status, 409);
    const c = await makeCompany("Admin Inside Co", "owner@inside.test");
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [c.tenantId, superRow.id]);
    const r = await preview(c.tenantId);
    assert.equal(r.body.canDelete, false);
    assert.equal((await remove(c.tenantId, { confirmName: "Admin Inside Co" })).status, 409);
    assert.equal((await query("SELECT count(*)::int AS n FROM tenants WHERE id IN ('tenant_scriza',$1)", [c.tenantId])).rows[0].n, 2);
    assert.equal((await query("SELECT count(*)::int AS n FROM users WHERE id=$1", [superRow.id])).rows[0].n, 1);
  });

  await t.test("an unknown company is not found", async () => {
    assert.equal((await preview("tenant_nope")).status, 404);
    assert.equal((await remove("tenant_nope", { confirmName: "x" })).status, 404);
  });

  await t.test("stored files: only the company's own folder, in pages, and never a neighbour's", async () => {
    stored.clear();
    asked.length = 0;
    for (const key of ["t1/a", "t1/b", "t1/c", "t1/c.preview", "t1/_check/x", "t10/a", "t10/b", "t2/a"]) stored.set(key, true);
    const removed = await deleteTenantMedia("t1");
    assert.equal(removed, 5);
    assert.deepEqual([...stored.keys()].sort(), ["t10/a", "t10/b", "t2/a"], "t10 is not t1");
    const lists = asked.filter((x) => x.kind === "ListObjectsV2Command");
    assert.ok(lists.length >= 3, "it asked for the next page until there were no more");
    assert.ok(lists.every((x) => x.Prefix === "t1/"), "always with the slash");
    // a list that wrongly offers a neighbour's file does not get it deleted
    setMediaSend(async (command) => {
      if (command.constructor.name === "ListObjectsV2Command") return { Contents: [{ Key: "t1/a" }, { Key: "t10/zzz" }], IsTruncated: false };
      asked.push({ kind: command.constructor.name, Key: command.input.Key });
      return {};
    });
    asked.length = 0;
    assert.equal(await deleteTenantMedia("t1"), 1);
    assert.deepEqual(asked.map((x) => x.Key), ["t1/a"]);
    await assert.rejects(() => deleteTenantMedia("a/b"), /not a company id/);
    await assert.rejects(() => deleteTenantMedia(""), /not a company id/);
    delete process.env.S3_BUCKET;
    assert.equal(await deleteTenantMedia("t1"), 0, "with no storage set up there is nothing to remove");
  });
});
