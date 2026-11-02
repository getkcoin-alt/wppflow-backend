import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage, sendTextMessage } from "../src/services/messageService.js";
import { recordAutomated, verifyChain, hashOf } from "../src/services/auditTrail.js";
import { csvLine } from "../src/services/dataExport.js";
import { closeSessions } from "../src/services/sessionService.js";
import { createLeadFromChat } from "../src/services/leadService.js";

test("what the machine said is recorded, cannot be changed, and every export is for the company's own data", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@acct.test", password: "Password@123", companyName: "Acct Co" });
  const tenantId = o.tenant.id;
  const other = await registerTenantAndUser({ name: "Otto", email: "otto@acct.test", password: "Password@123", companyName: "Other Co" });
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  const mk = async (name, role) => {
    const u = (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [name, `${name.toLowerCase()}@acct.test`])).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)", [tenantId, u.id, role]);
    return { user: u, auth: { Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` } };
  };
  const sam = await mk("Sam", "agent");
  const tina = await mk("Tina", "agent");
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status) VALUES(gen_random_uuid()::text,$1,'line',$2,'CONNECTED')", [tenantId, o.user.id]);
  let n = 0;
  const hear = async (phone, text, name = "Asha Rao") => {
    n += 1;
    await handleIncomingMessage({ tenantId, sessionName: "line", msg: { providerMessageId: `m_${phone}_${n}`, fromMe: false, remoteId: `${phone}@c.us`, rawType: "chat", type: "text", text, timestampEpoch: Math.floor(Date.now() / 1000) + n, senderName: name, ack: 2 } });
    return (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND phone=$2", [tenantId, phone])).rows[0];
  };
  const rows = async () => (await query("SELECT * FROM automation_audit WHERE tenant_id=$1 ORDER BY id", [tenantId])).rows;
  const chat = await hear("971500000001", "=HYPERLINK(\"http://evil\") what are your hours?");

  await t.test("a message from Riwo is recorded with its trigger, rule, model, exact words and whether it can be taken back", async () => {
    const sent = await sendTextMessage({
      tenantId, conversationId: chat.id, text: "We are open Sunday to Thursday.", idempotencyKey: "k1", agentName: "Riwo", io,
      audit: { source: "autopilot", ruleRef: "saved_replies", triggerMessageId: "trigger-1", provider: "groq", model: "llama-3.3-70b", reversible: true },
    });
    const [r] = await rows();
    assert.deepEqual(
      [r.event, r.source, r.rule_ref, r.trigger_message_id, r.message_id, r.provider, r.model, r.text, r.reversible],
      ["sent", "autopilot", "saved_replies", "trigger-1", sent.message.id, "groq", "llama-3.3-70b", "We are open Sunday to Thursday.", true],
    );
    assert.equal(r.prev_hash, "0".repeat(64), "the first row starts the chain");
    assert.equal(r.hash, hashOf(r.prev_hash, r));
    // sending the same message again records nothing new
    await sendTextMessage({ tenantId, conversationId: chat.id, text: "We are open Sunday to Thursday.", idempotencyKey: "k1", agentName: "Riwo", io, audit: { source: "autopilot" } });
    assert.equal((await rows()).length, 1);
  });

  await t.test("a message nobody labelled is still recorded; people, broadcasts and private notes are not", async () => {
    await sendTextMessage({ tenantId, conversationId: chat.id, text: "Rule says hi", idempotencyKey: "k2", agentName: "Automation", io });
    await sendTextMessage({ tenantId, conversationId: chat.id, text: "Sam here", idempotencyKey: "k3", agentName: "Sam", sentByUserId: sam.user.id, io });
    await sendTextMessage({ tenantId, conversationId: chat.id, text: "Campaign text", idempotencyKey: "k4", agentName: "Campaign", io });
    await sendTextMessage({ tenantId, conversationId: chat.id, text: "private", idempotencyKey: "k5", agentName: "Riwo", type: "internal_note", io });
    const all = await rows();
    assert.deepEqual(all.map((r) => [r.source, r.text]), [["autopilot", "We are open Sunday to Thursday."], ["unlabelled", "Rule says hi"]]);
    assert.equal(all[1].prev_hash, all[0].hash, "each row carries the one before it");
  });

  await t.test("a recorded row cannot be changed or removed, and a chain that was tampered with is found", async () => {
    await assert.rejects(query("UPDATE automation_audit SET text='something else' WHERE tenant_id=$1", [tenantId]), /append-only/);
    await assert.rejects(query("DELETE FROM automation_audit WHERE tenant_id=$1", [tenantId]), /append-only/);
    assert.deepEqual(await verifyChain(tenantId), { ok: true, checked: 2, brokenAtId: null });
    // someone with the keys to the database switches the guard off and rewrites history
    await query("ALTER TABLE automation_audit DISABLE TRIGGER automation_audit_append_only");
    const [first] = await rows();
    await query("UPDATE automation_audit SET text='We are open every day.' WHERE id=$1", [first.id]);
    const broken = await verifyChain(tenantId);
    assert.deepEqual([broken.ok, broken.brokenAtId], [false, Number(first.id)]);
    await query("UPDATE automation_audit SET text='We are open Sunday to Thursday.' WHERE id=$1", [first.id]);
    await query("ALTER TABLE automation_audit ENABLE TRIGGER automation_audit_append_only");
    assert.equal((await verifyChain(tenantId)).ok, true);
  });

  await t.test("many messages at once still make one unbroken chain, and taking something back is a new row naming it", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => recordAutomated({ tenantId, conversationId: chat.id, source: "rule", ruleRef: `r${i}`, text: `msg ${i}` })));
    const first = (await rows())[0];
    await recordAutomated({ tenantId, conversationId: chat.id, event: "undone", source: "autopilot", ruleRef: "saved_replies (taken back by Olivia)", messageId: "m", undoes: first.id });
    const all = await rows();
    assert.equal(all.length, 15);
    assert.deepEqual(await verifyChain(tenantId), { ok: true, checked: 15, brokenAtId: null });
    assert.equal(Number(all.at(-1).undoes), Number(first.id));
    // the other company's chain is its own
    assert.deepEqual(await verifyChain(other.tenant.id), { ok: true, checked: 0, brokenAtId: null });
  });

  await t.test("the list is for managers in full and for staff only on chats they may open; the check is for owners", async () => {
    const full = await request(app).get("/api/automated-messages?limit=200").set(owner);
    assert.equal(full.status, 200);
    assert.equal(full.body.rows.length, 15);
    assert.deepEqual(Object.keys(full.body.rows.at(-1)).sort(), ["at", "conversationId", "event", "id", "messageId", "model", "provider", "reversible", "rule", "source", "text", "title", "triggerMessageId", "undoes"].sort());
    assert.equal(full.body.rows.at(-1).model, "llama-3.3-70b");
    assert.equal((await request(app).get("/api/automated-messages").set(tina.auth)).body.rows.length, 0, "a teammate with no access to the chat sees nothing");
    await query("UPDATE conversations SET assigned_user_id=$2, assigned_to='Sam' WHERE id=$1", [chat.id, sam.user.id]);
    assert.equal((await request(app).get("/api/automated-messages").set(sam.auth)).body.rows.length, 15, "assigned to Sam, so Sam sees it");
    assert.equal((await request(app).get(`/api/automated-messages?conversationId=${chat.id}&limit=3`).set(owner)).body.rows.length, 3);
    const page = await request(app).get(`/api/automated-messages?limit=5&beforeId=${full.body.rows[2].id}`).set(owner);
    assert.ok(page.body.rows.every((r) => r.id < full.body.rows[2].id));
    assert.deepEqual((await request(app).get("/api/automated-messages/verify").set(owner)).body, { status: "success", ok: true, checked: 15, brokenAtId: null });
    assert.equal((await request(app).get("/api/automated-messages/verify").set(sam.auth)).status, 403);
    assert.equal((await request(app).get("/api/automated-messages")).status, 401);
  });

  await t.test("the whole company's data can be taken away: complete, only its own, for owners and administrators, and noted in the audit log", async () => {
    await query("INSERT INTO contacts(id,tenant_id,name,phone) VALUES('c-acct',$1,'Asha Rao','971500000001') ON CONFLICT DO NOTHING", [tenantId]).catch(() => {});
    await query("INSERT INTO canned_replies(id,tenant_id,shortcut,title,text) VALUES(gen_random_uuid(),$1,'/hi','Hello','Hello there')", [tenantId]);
    const fresh = (await query("SELECT * FROM conversations WHERE id=$1", [chat.id])).rows[0];
    await createLeadFromChat({ tenantId, conversation: fresh, source: "manual", title: "Flat in the Marina" });
    // another company's data that must never appear
    await query("INSERT INTO canned_replies(id,tenant_id,shortcut,title,text) VALUES(gen_random_uuid(),$1,'/secret','Secret','OTHER COMPANY ONLY')", [other.tenant.id]);

    const res = await request(app).get("/api/export").set(owner);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-disposition"], /scriwo-export-\d{4}-\d{2}-\d{2}\.json/);
    const data = JSON.parse(res.text);
    assert.equal(data.format, "scriwo-export/1");
    assert.equal(data.company.id, tenantId);
    assert.deepEqual(data.team.map((u) => u.name).sort(), ["Olivia", "Sam", "Tina"]);
    assert.ok(data.conversations.some((c) => c.phone === "971500000001" && c.assigned_to === "Sam"), "who a chat is assigned to");
    assert.equal(data.savedReplies.some((r) => r.text === "Hello there"), true);
    assert.equal(JSON.stringify(data).includes("OTHER COMPANY ONLY"), false, "nothing of another company");
    assert.equal(data.pipeline.leads.length, 1);
    assert.deepEqual([data.pipeline.leads[0].title, data.pipeline.leads[0].stage], ["Flat in the Marina", "New"]);
    assert.ok(data.pipeline.stages.length >= 6 && data.pipeline.history.length >= 1);
    assert.equal(data.automatedMessages.rows.length, 15);
    assert.equal(data.automatedMessages.chain.ok, true);
    assert.ok(!JSON.stringify(data).includes("password"), "no password hashes");
    assert.equal(data.notes.length, 2);

    assert.equal((await request(app).get("/api/export").set(sam.auth)).status, 403);
    assert.equal((await request(app).get("/api/export")).status, 401);
    const logged = (await query("SELECT metadata FROM audit_events WHERE tenant_id=$1 AND event_type='company.exported'", [tenantId])).rows;
    assert.ok(logged.length >= 1 && logged[0].metadata.what === "data");
  });

  await t.test("messages come as a CSV, all of them, with anything a spreadsheet would run as a formula made harmless", async () => {
    const res = await request(app).get("/api/export/messages.csv").set(owner).buffer(true).parse((r, cb) => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", (c) => (body += c));
      r.on("end", () => cb(null, body));
    });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/csv/);
    const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
    assert.equal(lines[0], "id,conversation_id,sender,agent_name,type,text,file_name,timestamp_epoch,status,created_at");
    const count = (await query("SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1", [tenantId])).rows[0].n;
    assert.ok(lines.length - 1 >= count, "a row for every message (a message with a line break spans lines)");
    assert.ok(res.body.includes("'=HYPERLINK"), "a customer's text that starts with = is made harmless");
    assert.equal((await request(app).get("/api/export/messages.csv").set(sam.auth)).status, 403);
  });

  await t.test("CSV cells are quoted and neutralised", () => {
    assert.equal(csvLine(["a,b", 'say "hi"', "line\nbreak", null, 7, "=1+1", "+44", "-2", "@x", "ok"]), '"a,b","say ""hi""","line\nbreak",,7,\'=1+1,\'+44,\'-2,\'@x,ok\r\n');
  });

  await t.test("deleting a company removes its record with it, but nothing else may remove a row", async () => {
    await recordAutomated({ tenantId: other.tenant.id, conversationId: "x", source: "rule", text: "gone with the company" });
    await query("DELETE FROM canned_replies WHERE tenant_id=$1", [other.tenant.id]); // this table does not cascade on its own
    await query("DELETE FROM tenants WHERE id=$1", [other.tenant.id]);
    assert.equal((await query("SELECT count(*)::int AS n FROM automation_audit WHERE tenant_id=$1", [other.tenant.id])).rows[0].n, 0);
  });
});
