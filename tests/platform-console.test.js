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
import { closeSessions } from "../src/services/sessionService.js";

test("Platform console: totals, number health, the books and logged support access", async (t) => {
  setMailTransport({ sendMail: async () => {} });
  t.after(async () => {
    setMailTransport(undefined);
    await closeSessions(serverIo);
    serverIo.close();
  });
  ENV.SUPERADMIN_EMAIL = "root@console.test";
  ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
  await ensureSuperAdmin();
  const sa = await request(app).post("/api/auth/login").send({ email: ENV.SUPERADMIN_EMAIL, password: ENV.SUPERADMIN_PASSWORD });
  assert.equal(sa.status, 200);
  const admin = { Authorization: `Bearer ${sa.body.token}` };
  const get = (path, who = admin) => request(app).get(`/api/admin${path}`).set(who);

  let n = 0;
  const company = async (plan) => {
    n++;
    const res = await request(app).post("/api/admin/companies").set(admin).send({ companyName: `Console Co ${n}`, ownerName: `Owner ${n}`, ownerEmail: `owner${n}@console.test`, plan });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const owner = (await query("SELECT * FROM users WHERE email=$1", [`owner${n}@console.test`])).rows[0];
    const id = res.body.company.id;
    const staff = (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [`Staff ${n}`, `staff${n}@console.test`])).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [id, staff.id]);
    return { id, owner: { Authorization: `Bearer ${generateAccessToken(owner, id, "owner")}` }, staff: { Authorization: `Bearer ${generateAccessToken(staff, id, "agent")}` }, ownerId: owner.id, staffId: staff.id };
  };
  const a = await company("Growth"),
    b = await company("Free");

  await t.test("only platform administrators can open any of it", async () => {
    for (const path of ["/overview", "/number-health", "/billing/audit", `/companies/${a.id}/support`, `/companies/${a.id}/support/team`]) {
      assert.equal((await request(app).get(`/api/admin${path}`)).status, 401, path);
      assert.equal((await get(path, a.owner)).status, 403, `${path} for a company owner`);
      assert.equal((await get(path, a.staff)).status, 403, `${path} for staff`);
    }
    assert.equal((await request(app).post(`/api/admin/companies/${a.id}/support`).set(a.owner).send({ reason: "let me in please" })).status, 403);
  });

  await t.test("platform totals count companies, numbers, messages, AI and money without reading anything", async () => {
    const before = (await get("/overview?fresh=1")).body.overview;
    await query(
      `INSERT INTO whatsapp_sessions(id,tenant_id,session_name,status,phone,lease_until) VALUES
       (gen_random_uuid()::text,$1,'live-line','CONNECTED','971500000001',now()+interval '1 minute'),
       (gen_random_uuid()::text,$1,'off-line','DISCONNECTED','971500000002',NULL),
       (gen_random_uuid()::text,$2,'new-line','QRCODE',NULL,NULL)`,
      [a.id, b.id],
    );
    const epoch = Math.floor(Date.now() / 1000);
    await handleIncomingMessage({ tenantId: a.id, sessionName: "live-line", msg: { providerMessageId: "c1", fromMe: false, remoteId: "971511111111@c.us", isGroup: false, rawType: "chat", type: "text", text: "hello", timestampEpoch: epoch - 60, senderName: "Cust", ack: 2 } });
    const chat = (await query("SELECT id FROM conversations WHERE tenant_id=$1", [a.id])).rows[0].id;
    const put = (status, ageSeconds, type = "text") => query("INSERT INTO messages(id,tenant_id,conversation_id,sender,agent_name,type,timestamp_epoch,status) VALUES($1,$2,$3,'agent','Sam',$4,$5,$6)", [crypto.randomUUID(), a.id, chat, type, epoch - ageSeconds, status]);
    await put("delivered", 60);
    await put("read", 3 * 86400);
    await put("sent", 20 * 86400);
    await put("failed", 120);
    await put("sent", 30, "internal_note"); // a team note is not a message sent
    await query("INSERT INTO ai_usage(tenant_id,day,requests,input_tokens,output_tokens) VALUES($1,(now() AT TIME ZONE 'UTC')::date,12,1000,500)", [a.id]);
    await query(
      "INSERT INTO subscription_payments(id,tenant_id,plan,billing_cycle,period_start,period_end,amount,currency,reference) VALUES(gen_random_uuid(),$1,'Growth','monthly','2026-10-01','2026-11-01',1000,'INR','ref1'),(gen_random_uuid(),$2,'Starter','monthly','2026-10-01','2026-11-01',250.5,'INR','ref2')",
      [a.id, b.id],
    );
    const after = (await get("/overview?fresh=1")).body.overview;
    assert.equal(after.companies.total - before.companies.total, 0, "the two companies were already counted");
    assert.equal(after.numbers.linked - before.numbers.linked, 2, "the number still being linked is not counted");
    assert.equal(after.numbers.connected - before.numbers.connected, 1);
    assert.equal(after.numbers.notConnected - before.numbers.notConnected, 1);
    assert.equal(after.messages.sentLast24h - before.messages.sentLast24h, 1);
    assert.equal(after.messages.sentLast7Days - before.messages.sentLast7Days, 2);
    assert.equal(after.messages.sentLast30Days - before.messages.sentLast30Days, 3);
    assert.equal(after.messages.failedLast7Days - before.messages.failedLast7Days, 1);
    assert.equal(after.messages.receivedLast7Days - before.messages.receivedLast7Days, 1);
    assert.ok(after.messages.activeCompaniesLast7Days >= 1);
    assert.equal(after.ai.requestsThisMonth - before.ai.requestsThisMonth, 12);
    assert.equal(after.ai.tokensThisMonth - before.ai.tokensThisMonth, 1500);
    const inr = (o) => o.payments.last30Days.find((p) => p.currency === "INR") || { payments: 0, amount: 0 };
    assert.equal(inr(after).payments - inr(before).payments, 2);
    assert.equal(inr(after).amount - inr(before).amount, 1250.5);
    assert.ok(after.companies.byPlan.Growth >= 1 && after.companies.byPlan.Free >= 1);
    assert.ok(after.people.active >= 4);
    assert.ok(!JSON.stringify(after).includes("hello"), "totals only: no message text anywhere");
    // asking again within the minute is answered from memory
    await put("sent", 5);
    assert.equal((await get("/overview")).body.overview.messages.sentLast30Days, after.messages.sentLast30Days);
    assert.equal((await get("/overview?fresh=1")).body.overview.messages.sentLast30Days, after.messages.sentLast30Days + 1);
  });

  await t.test("every company's numbers, the ones that need attention first, with phone numbers shortened", async () => {
    await query("UPDATE whatsapp_sessions SET down_since=now()-interval '3 hours' WHERE tenant_id=$1 AND session_name='off-line'", [a.id]);
    const all = (await get("/number-health")).body;
    assert.ok(all.totals.down >= 1);
    const mine = all.companies.find((c) => c.id === a.id);
    assert.deepEqual(mine.numbers.map((x) => [x.sessionName, x.level]), [["off-line", "down"], ["live-line", "ok"]], "the one that is down comes first");
    assert.equal(mine.numbers[0].phone, "…0002");
    assert.ok(!JSON.stringify(all).includes("971500000002"), "the full number is never sent");
    assert.match(mine.numbers[0].problems[0].text, /Not connected for 3 hours/);
    assert.equal(all.companies[0].counts.down > 0, true, "companies with trouble are listed first");
    const trouble = (await get("/number-health?problems=1")).body;
    assert.ok(trouble.companies.every((c) => c.numbers.every((x) => ["down", "warn"].includes(x.level))));
    assert.ok(!trouble.companies.some((c) => c.id === b.id), "a company with only a number being linked has nothing to report");
  });

  await t.test("the books: takings against invoices, and everything that does not add up", async () => {
    const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    const order = (id, status, extra = {}) =>
      query(
        `INSERT INTO payment_orders(id,tenant_id,plan_code,billing_interval,currency,base_minor,tax_minor,total_minor,status,gateway_order_id,gateway_payment_id,failure_reason,expires_at,paid_at,subscription_payment_id,updated_at)
         VALUES($1,$2,'growth','monthly','INR',100000,18000,118000,$3,$4,$5,$6,now()+interval '1 day',$7,$8,$9)`,
        [id, a.id, status, `order_${id}`, extra.payment ?? null, extra.reason ?? null, extra.paidAt ?? null, extra.subscriptionPayment ?? null, extra.updatedAt ?? new Date().toISOString()],
      );
    await order("o-ok", "paid", { payment: "pay_ok", paidAt: hoursAgo(5), subscriptionPayment: "sp-ok", updatedAt: hoursAgo(5) });
    await order("o-mismatch", "mismatch", { payment: "pay_mm", reason: "Amount paid was 100.00 but the order is 118.00", updatedAt: hoursAgo(2) });
    await order("o-stuck", "attempted", { payment: "pay_stuck", updatedAt: hoursAgo(3) });
    await order("o-fresh", "attempted", { payment: "pay_fresh", updatedAt: hoursAgo(0.1) });
    await order("o-lost", "paid", { payment: "pay_lost", paidAt: hoursAgo(4), updatedAt: hoursAgo(4) });
    await order("o-failed", "failed", { reason: "Card declined" });

    const spOk = (await query("INSERT INTO subscription_payments(id,tenant_id,plan,billing_cycle,period_start,period_end,amount,currency,reference,source) VALUES(gen_random_uuid(),$1,'Growth','monthly','2026-10-01','2026-11-01',1180,'INR','pay_ok','gateway') RETURNING id", [a.id])).rows[0].id;
    const spNo = (await query("INSERT INTO subscription_payments(id,tenant_id,plan,billing_cycle,period_start,period_end,amount,currency,reference,source) VALUES(gen_random_uuid(),$1,'Growth','monthly','2026-10-01','2026-11-01',500,'INR','cash','manual') RETURNING id", [a.id])).rows[0].id;
    await query("INSERT INTO subscription_payments(id,tenant_id,plan,billing_cycle,period_start,period_end,amount,currency,reference,source) VALUES(gen_random_uuid(),$1,'Starter','monthly','2026-10-01','2026-11-01',0,'INR','complimentary','manual')", [a.id]);
    const invoice = (seq, paymentId) =>
      query(
        `INSERT INTO invoices(id,tenant_id,number,series,seq,issue_date,subscription_payment_id,plan_name,billing_interval,period_start,period_end,currency,taxable_minor,cgst_minor,sgst_minor,igst_minor,total_minor,seller,buyer,sac_code)
         VALUES(gen_random_uuid()::text,$1,$2,'SCZ/26-27',$3,'2026-10-25',$4,'Growth','monthly','2026-10-01','2026-11-01','INR',100000,9000,9000,0,118000,'{}','{}','998439')`,
        [a.id, `SCZ/26-27/${String(seq).padStart(5, "0")}`, seq, paymentId],
      );
    await invoice(1, spOk);
    await invoice(4, null); // 2 and 3 were never issued
    await query("INSERT INTO gateway_webhook_receipts(event_id,event,payload_hash,received_at) VALUES('evt_old','payment.captured',repeat('a',64),now()-interval '2 hours'),('evt_new','payment.captured',repeat('b',64),now()),('evt_done','payment.captured',repeat('c',64),now()-interval '3 hours')");
    await query("UPDATE gateway_webhook_receipts SET processed_at=now() WHERE event_id='evt_done'");
    await query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,NULL,'payment.signature_invalid','{\"orderId\":\"o-mismatch\"}'),($1,NULL,'payment.order_created','{}'),($1,NULL,'chat.auto_assigned','{}')", [a.id]);
    await query("INSERT INTO payment_refunds(refund_id,tenant_id,gateway_payment_id,amount_minor,currency,status) VALUES('rfnd_1',$1,'pay_ok',50000,'INR','processed')", [a.id]);

    const res = await get("/billing/audit?days=30");
    assert.equal(res.status, 200);
    const { audit } = res.body;
    const x = audit.exceptions;
    assert.deepEqual(x.amountMismatch.map((o) => o.orderId), ["o-mismatch"]);
    assert.match(x.amountMismatch[0].reason, /Amount paid was 100.00/);
    assert.deepEqual(x.notSettled.map((o) => o.orderId), ["o-stuck"], "an order the gateway took a payment for and we never settled; a fresh one is given time");
    assert.deepEqual(x.paidButNoSubscriptionRecord.map((o) => o.orderId), ["o-lost"]);
    const without = x.paymentWithoutInvoice.map((p) => p.paymentId);
    assert.ok(without.includes(spNo), "a recorded payment with an amount and no invoice");
    assert.ok(!without.includes(spOk), "one with an invoice is fine");
    assert.equal(without.length, 3, "the two recorded in the totals test and this one; the complimentary one needs none");
    assert.deepEqual(x.webhooksNotProcessed.map((w) => w.eventId), ["evt_old"]);
    assert.deepEqual(x.invoiceNumberGaps, [{ series: "SCZ/26-27", missing: 2 }, { series: "SCZ/26-27", missing: 3 }]);
    assert.equal(x.invalidSignatures.length, 1);
    assert.equal(audit.exceptionCount, 1 + 1 + 1 + 3 + 1 + 2 + 1);
    // the books themselves
    const taken = audit.payments.takings.filter((r) => r.currency === "INR");
    assert.ok(taken.some((r) => r.source === "gateway" && r.amount === 1180) && taken.some((r) => r.source === "manual"));
    const inv = audit.invoices.find((r) => r.currency === "INR");
    assert.deepEqual([inv.invoices, inv.taxableMinor, inv.taxMinor, inv.totalMinor], [2, 200000, 36000, 236000]);
    assert.equal(audit.orders.paid, 2);
    assert.equal(audit.orders.mismatch, 1);
    assert.deepEqual(audit.refunds, [{ currency: "INR", refunds: 1, amountMinor: 50000 }]);
    assert.deepEqual([...new Set(audit.events.map((e) => e.type))].sort(), ["payment.order_created", "payment.signature_invalid"], "only the money events, not the chat ones");
    assert.equal(audit.range.days, 30);
    assert.equal((await get("/billing/audit?days=9999")).body.audit.range.days, 366);
    assert.equal((await get("/billing/audit?days=abc")).body.audit.range.days, 30);
  });

  await t.test("support access needs a reason, a session and leaves a record the company can read", async () => {
    const start = (body, id = a.id, who = admin) => request(app).post(`/api/admin/companies/${id}/support`).set(who).send(body);
    assert.equal((await start({ reason: "too short" })).status, 400);
    assert.equal((await start({ reason: "x".repeat(501) })).status, 400);
    assert.equal((await start({ reason: "Owner asked about a disconnected number", minutes: 2 })).status, 400);
    assert.equal((await start({ reason: "Owner asked about a disconnected number", minutes: 999 })).status, 400);
    assert.equal((await start({ reason: "Owner asked about a disconnected number" }, "no-such-company")).status, 404);

    // looking without a session is refused, and says what to do
    const refused = await get(`/companies/${a.id}/support/team`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "support_session_required");

    const opened = await start({ reason: "Owner asked about a disconnected number", minutes: 30 });
    assert.equal(opened.status, 201);
    assert.equal(opened.body.session.active, true);
    assert.equal(opened.body.session.reason, "Owner asked about a disconnected number");
    assert.equal((await get(`/companies/${a.id}/support/chats`)).status, 404, "there is no section for chats");
    assert.equal((await get(`/companies/${a.id}/support/messages`)).status, 404);

    const team = (await get(`/companies/${a.id}/support/team`)).body;
    assert.deepEqual(team.data.map((m) => m.role).sort(), ["agent", "owner"]);
    assert.ok(team.data.every((m) => m.email && m.name && !("password_hash" in m) && !("passwordHash" in m)));
    const numbers = (await get(`/companies/${a.id}/support/numbers`)).body;
    assert.ok(numbers.data.every((x) => /^…\d{4}$/.test(x.phone)));
    const activity = (await get(`/companies/${a.id}/support/activity`)).body;
    assert.ok(activity.data.some((e) => e.type === "support.session_started"), "the session itself is on the account's activity");
    for (const body of [team, numbers, activity]) {
      const text = JSON.stringify(body);
      assert.ok(!/hello|"Cust"|971511111111|conversationId|"contactName"/.test(text), "nothing from a chat: no message, no customer, no customer number");
    }
    // a session on one company is no key to another
    assert.equal((await get(`/companies/${b.id}/support/team`)).status, 403);

    // what the company sees
    const seen = (await request(app).get("/api/workspace/support-access").set(a.owner)).body.sessions;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].active, true);
    assert.equal(seen[0].reason, "Owner asked about a disconnected number");
    assert.deepEqual(seen[0].actions.map((x) => x.action), ["viewed_team", "viewed_numbers", "viewed_activity"]);
    assert.ok(!("adminEmail" in seen[0]));
    assert.equal((await request(app).get("/api/workspace/support-access").set(a.staff)).status, 403, "staff do not read it");
    assert.equal((await request(app).get("/api/workspace/support-access").set(b.owner)).body.sessions.length, 0, "another company sees nothing of it");
    // and the owner was told
    const told = (await query("SELECT title,body FROM notifications WHERE tenant_id=$1 AND type='support' AND user_id=$2", [a.id, a.ownerId])).rows;
    assert.equal(told.length, 1);
    assert.match(told[0].body, /never shows chats, contacts or files/);
    assert.equal((await query("SELECT 1 FROM audit_events WHERE tenant_id=$1 AND event_type='support.session_started'", [a.id])).rowCount, 1);

    // another platform administrator has to open their own
    const other = (await query("INSERT INTO users(name,email,password_hash,is_superadmin) VALUES('Second Admin','second@console.test','x',true) RETURNING *")).rows[0];
    const second = { Authorization: `Bearer ${generateAccessToken(other, null, "owner")}` };
    assert.equal((await get(`/companies/${a.id}/support/team`, second)).status, 403);

    // it runs out
    await query("UPDATE support_access SET expires_at=now()-interval '1 minute' WHERE tenant_id=$1", [a.id]);
    assert.equal((await get(`/companies/${a.id}/support/team`)).status, 403);
    assert.equal((await request(app).get("/api/workspace/support-access").set(a.owner)).body.sessions[0].active, false);

    // and can be ended early
    const again = await start({ reason: "Following up on the same number" });
    assert.equal(again.status, 201);
    assert.equal((await get(`/companies/${a.id}/support/team`)).status, 200);
    assert.equal((await request(app).delete(`/api/admin/companies/${a.id}/support`).set(admin)).body.ended, true);
    assert.equal((await get(`/companies/${a.id}/support/team`)).status, 403, "ended");
    assert.equal((await request(app).delete(`/api/admin/companies/${a.id}/support`).set(admin)).body.ended, false, "nothing left to end");
    // opening a second while one is open ends the first
    await start({ reason: "First of two sessions open" });
    await start({ reason: "Second of two sessions open" });
    const open = (await request(app).get("/api/workspace/support-access").set(a.owner)).body.sessions.filter((s) => s.active);
    assert.deepEqual(open.map((s) => s.reason), ["Second of two sessions open"]);
    // the platform administrator can see the same list for the company
    assert.equal((await get(`/companies/${a.id}/support`)).body.sessions.length, 4);
  });
});
