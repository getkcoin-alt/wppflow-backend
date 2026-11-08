import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { closeSessions } from "../src/services/sessionService.js";
import { pumpOtp } from "../src/services/otp/otpService.js";
import { forgetOtpCache } from "../src/services/otp/guard.js";

// Free OTP through its real routes. WhatsApp is the only thing replaced: what would be sent is kept in `sent`.
const sent = [];
const notOnWhatsApp = new Set();
let behaviour = "ok";
provider.getSession = () => ({ client: {} });
provider.checkNumber = async (_t, _s, phone) => (notOnWhatsApp.has(phone) ? { checked: true, exists: false } : { checked: true, exists: true, jid: `${phone}@c.us` });
provider.sendTextMessage = async (tenantId, sessionName, to, text) => {
  sent.push({ tenantId, sessionName, to, text });
  if (behaviour === "offline") throw Object.assign(new Error("offline"), { code: "SESSION_OFFLINE" });
  if (behaviour === "uncertain") throw Object.assign(new Error("not confirmed"), { code: "DELIVERY_UNCERTAIN" });
  if (behaviour === "fail") throw new Error("boom");
  return { providerMessageId: `true_${to}_${sent.length}`, to, text, ack: 1 };
};
after(async () => {
  await closeSessions(io);
  io.close();
});

let n = 0;
const phone = () => `97150${String(1000000 + ++n)}`;
const codeIn = (text) => /\*(\d+)\*/.exec(text)[1];
const bearer = (key) => ({ Authorization: `Bearer ${key}` });
const send = (key, body = {}, headers = {}) => request(app).post("/api/otp/send").set(bearer(key)).set(headers).send(body);
const verify = (key, body) => request(app).post("/api/otp/verify").set(bearer(key)).send(body);

async function company(label, { plan = "Free", sessions = true } = {}) {
  const o = await registerTenantAndUser({ name: "Owner", email: `${label}@otp.test`, password: "Password@123", companyName: `${label} Stores` });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan=$2 WHERE id=$1", [tenantId, plan]);
  if (sessions) await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,phone,status) VALUES(gen_random_uuid()::text,$1,'otp-line',$2,'971500000000','CONNECTED')", [tenantId, o.user.id]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  const makeKey = async (body = {}) => (await request(app).post("/api/otp-setup/keys").set(owner).send({ name: "My site", kind: "secret", mode: "live", ...body })).body.key.key;
  return { o, tenantId, owner, makeKey, user: o.user };
}
const rows = async (tenantId) => (await query("SELECT * FROM otp_requests WHERE tenant_id=$1 ORDER BY created_at", [tenantId])).rows;
const reset = () => {
  sent.length = 0;
  behaviour = "ok";
  forgetOtpCache();
};

test("a company on the Free plan sets up, sends a code to a phone and checks it", async () => {
  reset();
  const c = await company("free1");
  const key = await c.makeKey();
  assert.match(key, /^otp_sk_live_[a-f0-9]{40}$/);
  const to = phone();
  const res = await send(key, { phone: `+${to}`, reference: "user-42" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, "success");
  assert.match(res.body.id, /^otp_[a-f0-9]{24}$/);
  assert.equal(res.body.channel, "whatsapp");
  assert.equal(res.body.state, "sent");
  assert.equal(res.body.expiresIn <= 300 && res.body.expiresIn > 290, true);
  assert.equal(res.body.resendAfter, 30);
  assert.ok(!("code" in res.body), "a live send never returns the code");
  assert.match(res.body.to, /^\+971•+\d{4}$/);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, `${to}@c.us`);
  assert.equal(sent[0].sessionName, "otp-line");
  const code = codeIn(sent[0].text);
  assert.equal(code.length, 6);
  assert.ok(sent[0].text.startsWith(`*${code}* is your free1 Stores sign-in code.`), sent[0].text);
  assert.match(sent[0].text, /expires in 5 minutes\. Never share this code with anyone\./);

  const stored = (await rows(c.tenantId))[0];
  assert.equal(stored.status, "sent");
  assert.match(stored.code_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(code), "the code itself is not stored anywhere in the row");
  assert.equal(stored.reference, "user-42");

  const wrong = await verify(key, { id: res.body.id, code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.status, 200);
  assert.deepEqual({ valid: wrong.body.valid, reason: wrong.body.reason, attemptsLeft: wrong.body.attemptsLeft }, { valid: false, reason: "wrong_code", attemptsLeft: 4 });
  const right = await verify(key, { id: res.body.id, code });
  assert.equal(right.body.valid, true, JSON.stringify(right.body));
  assert.equal(right.body.reference, "user-42");
  assert.equal(right.body.phone, `+${to}`);
  assert.ok(!("row" in right.body), "nothing internal is returned");
  const again = await verify(key, { id: res.body.id, code });
  assert.deepEqual({ valid: again.body.valid, reason: again.body.reason }, { valid: false, reason: "already_used" }, "a code works once");
  assert.equal((await rows(c.tenantId))[0].code_hash, null, "once used the hash is dropped too");

  const status = await request(app).get(`/api/otp/requests/${res.body.id}`).set(bearer(key));
  assert.equal(status.body.request.status, "verified");
  assert.ok(!JSON.stringify(status.body).includes(code));
});

test("the check can be made with the phone number instead of the id: the latest code to that number", async () => {
  reset();
  const c = await company("byphone");
  const key = await c.makeKey();
  const to = phone();
  await send(key, { phone: to });
  const code = codeIn(sent[0].text);
  const res = await verify(key, { phone: to, code });
  assert.equal(res.body.valid, true);
});

test("a wrong code is tried a few times, then the request is locked, even for the right code", async () => {
  reset();
  const c = await company("lock");
  await request(app).put("/api/otp-setup/settings").set(c.owner).send({ maxAttempts: 3 });
  const key = await c.makeKey();
  const sendRes = await send(key, { phone: phone() });
  const code = codeIn(sent[0].text);
  const bad = code === "123456" ? "654321" : "123456";
  assert.equal((await verify(key, { id: sendRes.body.id, code: bad })).body.attemptsLeft, 2);
  assert.equal((await verify(key, { id: sendRes.body.id, code: bad })).body.attemptsLeft, 1);
  const last = await verify(key, { id: sendRes.body.id, code: bad });
  assert.deepEqual({ v: last.body.valid, r: last.body.reason }, { v: false, r: "too_many_attempts" });
  const after = await verify(key, { id: sendRes.body.id, code });
  assert.deepEqual({ v: after.body.valid, r: after.body.reason }, { v: false, r: "too_many_attempts" }, "the right code no longer works once locked");
  assert.equal((await rows(c.tenantId))[0].status, "locked");
});

test("a code that was not typed as digits is a mistake in the request, not an attempt", async () => {
  reset();
  const c = await company("shape");
  const key = await c.makeKey();
  const r = await send(key, { phone: phone() });
  for (const bad of ["12ab56", "", "123", "1234567890"]) {
    const res = await verify(key, { id: r.body.id, code: bad });
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.code, "invalid_code");
  }
  assert.equal((await rows(c.tenantId))[0].attempts, 0);
});

test("a code expires", async () => {
  reset();
  const c = await company("expire");
  const key = await c.makeKey();
  const r = await send(key, { phone: phone() });
  const code = codeIn(sent[0].text);
  await query("UPDATE otp_requests SET expires_at=now()-interval '1 second' WHERE tenant_id=$1", [c.tenantId]);
  const res = await verify(key, { id: r.body.id, code });
  assert.deepEqual({ v: res.body.valid, r: res.body.reason }, { v: false, r: "expired" });
  assert.equal((await rows(c.tenantId))[0].status, "expired");
  // the background job also closes codes nobody came back to
  const r2 = await send(key, { phone: phone() });
  await query("UPDATE otp_requests SET expires_at=now()-interval '1 second' WHERE id=$1", [r2.body.id]);
  await pumpOtp();
  assert.equal((await query("SELECT status FROM otp_requests WHERE id=$1", [r2.body.id])).rows[0].status, "expired");
});

test("the same number cannot be sent to again straight away, and a new code replaces the old one", async () => {
  reset();
  const c = await company("resend");
  const key = await c.makeKey();
  const to = phone();
  const first = await send(key, { phone: to });
  const code1 = codeIn(sent[0].text);
  const tooSoon = await send(key, { phone: to });
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.body.code, "resend_too_soon");
  assert.ok(tooSoon.body.retryAfter > 0 && tooSoon.body.retryAfter <= 30);
  assert.ok(tooSoon.body.fix);
  assert.equal(sent.length, 1, "nothing was sent for the refused call");

  await query("UPDATE otp_requests SET created_at=created_at-interval '1 minute' WHERE tenant_id=$1", [c.tenantId]);
  const second = await send(key, { phone: to });
  assert.equal(second.status, 201);
  const code2 = codeIn(sent[1].text);
  const old = await verify(key, { id: first.body.id, code: code1 });
  assert.deepEqual({ v: old.body.valid, r: old.body.reason }, { v: false, r: "superseded" });
  assert.equal((await verify(key, { id: second.body.id, code: code2 })).body.valid, true);
});

test("one number cannot be flooded: three codes in ten minutes, ten a day", async () => {
  reset();
  const c = await company("flood");
  const key = await c.makeKey();
  const to = phone();
  for (let i = 0; i < 3; i++) {
    const r = await send(key, { phone: to });
    assert.equal(r.status, 201, `send ${i + 1}: ${JSON.stringify(r.body)}`);
    await query("UPDATE otp_requests SET created_at=created_at-interval '1 minute' WHERE tenant_id=$1", [c.tenantId]);
  }
  const fourth = await send(key, { phone: to });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.code, "too_many_requests");
  assert.equal(sent.length, 3);
});

test("the free allowance is per company: 100 a day by default, and a company's own limit can be set", async () => {
  reset();
  const c = await company("quota");
  const key = await c.makeKey();
  const overview = await request(app).get("/api/otp-setup").set(c.owner);
  assert.equal(overview.body.usage.today.limit, 100);
  assert.equal(overview.body.usage.month.limit, 1000);
  await query("UPDATE otp_settings SET daily_limit=2 WHERE tenant_id=$1", [c.tenantId]);
  assert.equal((await send(key, { phone: phone() })).status, 201);
  assert.equal((await send(key, { phone: phone() })).status, 201);
  const third = await send(key, { phone: phone() });
  assert.equal(third.status, 429);
  assert.equal(third.body.code, "quota_exceeded");
  assert.match(third.body.message, /2 codes a day/);
  assert.ok(third.body.resets && third.body.retryAfter > 0);
  assert.equal(sent.length, 2);
  const after = await request(app).get("/api/otp-setup").set(c.owner);
  assert.deepEqual({ used: after.body.usage.today.used, limit: after.body.usage.today.limit }, { used: 2, limit: 2 });
  // the month's limit
  await query("UPDATE otp_settings SET daily_limit=NULL,monthly_limit=2 WHERE tenant_id=$1", [c.tenantId]);
  const monthly = await send(key, { phone: phone() });
  assert.equal(monthly.status, 429);
  assert.match(monthly.body.message, /2 codes a month/);
});

test("a number that is not on WhatsApp is told so, and that attempt does not use the allowance", async () => {
  reset();
  const c = await company("nowa");
  const key = await c.makeKey();
  const to = phone();
  notOnWhatsApp.add(to);
  const res = await send(key, { phone: to });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "not_on_whatsapp");
  assert.ok(res.body.fix);
  assert.equal(sent.length, 0);
  const row = (await rows(c.tenantId))[0];
  assert.deepEqual({ status: row.status, error: row.error_code, hash: row.code_hash }, { status: "failed", error: "not_on_whatsapp", hash: null });
  const usage = await request(app).get("/api/otp-setup").set(c.owner);
  assert.equal(usage.body.usage.today.used, 0);
});

test("when no number is linked, or the number is offline, the call says what to do", async () => {
  reset();
  const none = await company("nonum", { sessions: false });
  const k1 = await none.makeKey();
  const r1 = await send(k1, { phone: phone() });
  assert.equal(r1.status, 503);
  assert.equal(r1.body.code, "no_number_connected");
  assert.ok(r1.body.fix);

  const c = await company("offline");
  const key = await c.makeKey();
  behaviour = "offline";
  const r2 = await send(key, { phone: phone() });
  assert.equal(r2.status, 503);
  assert.equal(r2.body.code, "number_offline");
  assert.equal((await rows(c.tenantId))[0].status, "failed");
  // a failed code does not make the person wait before asking again
  behaviour = "ok";
  const to = (await rows(c.tenantId))[0].phone;
  assert.equal((await send(key, { phone: to })).status, 201);

  await query("UPDATE whatsapp_sessions SET status='DISCONNECTED' WHERE tenant_id=$1", [c.tenantId]);
  const r3 = await send(key, { phone: phone() });
  assert.equal(r3.body.code, "number_offline");
});

test("when WhatsApp does not confirm, the answer is 202, the code stays valid and nothing is sent twice", async () => {
  reset();
  const c = await company("uncertain");
  const key = await c.makeKey();
  behaviour = "uncertain";
  const to = phone();
  const res = await send(key, { phone: to });
  assert.equal(res.status, 202);
  assert.equal(res.body.state, "uncertain");
  assert.match(res.body.note, /may still arrive/);
  assert.equal(sent.length, 1, "one attempt, never an automatic second");
  const code = codeIn(sent[0].text);
  assert.equal((await verify(key, { id: res.body.id, code })).body.valid, true, "the person may still have received it");
});

test("the same Idempotency-Key is the same code: one message, the same answer", async () => {
  reset();
  const c = await company("idem");
  const key = await c.makeKey();
  const to = phone();
  const a = await send(key, { phone: to }, { "Idempotency-Key": "order-1001" });
  const b = await send(key, { phone: to }, { "Idempotency-Key": "order-1001" });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.idempotent, true);
  assert.equal(sent.length, 1);
  const bad = await send(key, { phone: phone() }, { "Idempotency-Key": "x".repeat(101) });
  assert.equal(bad.status, 400);
});

test("a test key sends nothing, always uses 123456, and uses none of the allowance", async () => {
  reset();
  const c = await company("testkey", { sessions: false });
  const key = await c.makeKey({ mode: "test" });
  assert.match(key, /^otp_sk_test_/);
  const res = await send(key, { phone: phone(), reference: "ci" });
  assert.equal(res.status, 201);
  assert.equal(res.body.test, true);
  assert.equal(res.body.code, "123456");
  assert.equal(res.body.mode, "test");
  assert.equal(sent.length, 0, "no WhatsApp message, and no number is needed");
  assert.equal((await verify(key, { id: res.body.id, code: "000000" })).body.valid, false);
  assert.equal((await verify(key, { id: res.body.id, code: "123456" })).body.valid, true);
  const usage = await request(app).get("/api/otp-setup").set(c.owner);
  assert.equal(usage.body.usage.today.used, 0);
  // a test key cannot check a live code, nor a live key a test code
  const live = await company("testkey2");
  const liveKey = await live.makeKey();
  const testKey = await live.makeKey({ mode: "test" });
  const liveSend = await send(liveKey, { phone: phone() });
  const crossed = await verify(testKey, { id: liveSend.body.id, code: codeIn(sent.at(-1).text) });
  assert.equal(crossed.status, 404);
  const testSend = await send(testKey, { phone: phone() });
  assert.equal((await verify(liveKey, { id: testSend.body.id, code: "123456" })).status, 404);
});

test("a company can only see and check its own codes, and an OTP key opens nothing else", async () => {
  reset();
  const a = await company("iso-a");
  const b = await company("iso-b");
  const keyA = await a.makeKey();
  const keyB = await b.makeKey();
  const r = await send(keyA, { phone: phone() });
  const code = codeIn(sent[0].text);
  assert.equal((await verify(keyB, { id: r.body.id, code })).status, 404);
  assert.equal((await request(app).get(`/api/otp/requests/${r.body.id}`).set(bearer(keyB))).status, 404);

  // the key can send and check codes and nothing else: every other part of Scriwo answers 401
  for (const [method, path] of [["get", "/api/conversations"], ["get", "/api/contacts"], ["get", "/api/sessions"], ["get", "/api/workspace/keys"], ["get", "/api/home"], ["get", "/api/automations"], ["get", "/api/otp-setup"]]) {
    const res = await request(app)[method](path).set(bearer(keyA));
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  // and the other way round: an ordinary API key does not open the OTP API
  assert.equal((await send(`wpp_${"a".repeat(64)}`, { phone: phone() })).status, 401);
  assert.equal((await request(app).post("/api/otp/send").send({ phone: phone() })).status, 401);
  // a public key is for web pages, not for servers
  const pub = await a.makeKey({ kind: "public", origins: ["https://shop.example.com"] });
  assert.equal((await send(pub, { phone: phone() })).status, 403);
});

test("a revoked key stops working at once", async () => {
  reset();
  const c = await company("revoke");
  const key = await c.makeKey();
  assert.equal((await send(key, { phone: phone() })).status, 201);
  const list = (await request(app).get("/api/otp-setup").set(c.owner)).body.keys;
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes(key) && !JSON.stringify(list).includes("key_hash"), "the key itself is never shown again");
  assert.equal((await request(app).delete(`/api/otp-setup/keys/${list[0].id}`).set(c.owner)).status, 200);
  assert.equal((await send(key, { phone: phone() })).status, 401);
  assert.equal((await request(app).delete(`/api/otp-setup/keys/${list[0].id}`).set(c.owner)).status, 404, "already revoked");
});

test("a company can switch OTP off, and Scriwo can suspend it; the studio's own test still works while it is off", async () => {
  reset();
  const c = await company("pause");
  const key = await c.makeKey();
  await request(app).put("/api/otp-setup/settings").set(c.owner).send({ enabled: false });
  const paused = await send(key, { phone: phone() });
  assert.equal(paused.status, 403);
  assert.equal(paused.body.code, "otp_paused");
  const studio = await request(app).post("/api/otp-setup/test/send").set(c.owner).send({ phone: phone() });
  assert.equal(studio.status, 201, JSON.stringify(studio.body));
  await request(app).put("/api/otp-setup/settings").set(c.owner).send({ enabled: true });
  await query("UPDATE otp_settings SET suspended_reason='abuse report' WHERE tenant_id=$1", [c.tenantId]);
  const suspended = await send(key, { phone: phone() });
  assert.equal(suspended.status, 403);
  assert.equal(suspended.body.code, "otp_suspended");
  assert.ok(!JSON.stringify(suspended.body).includes("abuse report"), "the reason is not shown to the caller");
  process.env.OTP_ENABLED = "false";
  try {
    assert.equal((await send(key, { phone: phone() })).body.code, "otp_unavailable");
  } finally {
    delete process.env.OTP_ENABLED;
  }
});

test("choosing a use case sets what goes with it, and the message follows the use case, the language and the name", async () => {
  reset();
  const c = await company("usecase");
  const key = await c.makeKey();
  const put = (body) => request(app).put("/api/otp-setup/settings").set(c.owner).send(body);
  const changed = await put({ template: "delivery" });
  assert.equal(changed.status, 200);
  assert.deepEqual(
    { t: changed.body.settings.template, d: changed.body.settings.codeLength, s: changed.body.settings.ttlSeconds, a: changed.body.settings.maxAttempts },
    { t: "delivery", d: 4, s: 3600, a: 5 },
  );
  await send(key, { phone: phone() });
  assert.match(sent[0].text, /^\*\d{4}\* is your usecase Stores delivery code\.\nGive it to the delivery person only when your order arrives\. It expires in 1 hour\.$/);

  await put({ template: "payment", brand: "Acme Bank", locale: "hi", codeLength: 8 });
  await send(key, { phone: phone() });
  assert.match(sent[1].text, /^\*\d{8}\* आपका Acme Bank भुगतान पुष्टि कोड है।/);

  // one call can name another use case or language without changing the saved ones
  await send(key, { phone: phone(), template: "reset", locale: "ar" });
  assert.match(sent[2].text, /إعادة تعيين كلمة المرور في Acme Bank/);
  assert.equal((await request(app).get("/api/otp-setup").set(c.owner)).body.settings.template, "payment");
  assert.equal((await send(key, { phone: phone(), template: "nope" })).body.code, "invalid_template");
  assert.equal((await send(key, { phone: phone(), locale: "fr" })).body.code, "invalid_locale");
});

test("the settings refuse what would not work", async () => {
  reset();
  const c = await company("settings");
  const put = (body) => request(app).put("/api/otp-setup/settings").set(c.owner).send(body);
  for (const [body, code] of [
    [{ template: "nope" }, "invalid_settings"],
    [{ brand: "shop.example.com" }, "invalid_brand"],
    [{ brand: "Pay now http://x.co" }, "invalid_brand"],
    [{ locale: "fr" }, "invalid_settings"],
    [{ codeLength: 3 }, "invalid_settings"],
    [{ codeLength: 9 }, "invalid_settings"],
    [{ ttlSeconds: 10 }, "invalid_settings"],
    [{ maxAttempts: 0 }, "invalid_settings"],
    [{ resendSeconds: 5 }, "invalid_settings"],
    [{ sessionName: "not-mine" }, "invalid_settings"],
  ]) {
    const res = await put(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, code, JSON.stringify(body));
    assert.ok(res.body.fix);
  }
  const ok = await put({ brand: "  Acme Stores  ", sessionName: "otp-line", resendSeconds: 45 });
  assert.equal(ok.status, 200);
  assert.deepEqual({ brand: ok.body.settings.brand, s: ok.body.settings.sessionName, r: ok.body.settings.resendSeconds }, { brand: "Acme Stores", s: "otp-line", r: 45 });
  assert.equal((await put({ brand: "" })).body.settings.brandResolved, "settings Stores", "an empty name falls back to the company's own");
});

test("the studio's test sends a real code and checks it, and the setup shows what is ready", async () => {
  reset();
  const c = await company("studio");
  const before = (await request(app).get("/api/otp-setup").set(c.owner)).body;
  assert.deepEqual(before.ready, { number: true, tested: false, key: false });
  assert.equal(before.available, true);
  assert.equal(before.templates.length, 8);
  assert.deepEqual(before.numbers, [{ sessionName: "otp-line", phone: "971500000000", connected: true }]);

  const to = phone();
  const s = await request(app).post("/api/otp-setup/test/send").set(c.owner).send({ phone: to });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(sent.length, 1);
  const code = codeIn(sent[0].text);
  const status = await request(app).get(`/api/otp-setup/test/${s.body.id}`).set(c.owner);
  assert.equal(status.body.request.status, "sent");
  const wrong = await request(app).post("/api/otp-setup/test/verify").set(c.owner).send({ id: s.body.id, code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.body.valid, false);
  const right = await request(app).post("/api/otp-setup/test/verify").set(c.owner).send({ id: s.body.id, code });
  assert.equal(right.body.valid, true);
  assert.ok(right.body.secondsToVerify >= 0);
  await c.makeKey();
  const after = (await request(app).get("/api/otp-setup").set(c.owner)).body;
  assert.deepEqual(after.ready, { number: true, tested: true, key: true });
  assert.equal(after.stats.sent, 1);
  assert.equal(after.stats.verified, 1);
  const log = (await request(app).get("/api/otp-setup/log").set(c.owner)).body.requests;
  assert.equal(log.length, 1);
  assert.deepEqual({ status: log[0].status, source: log[0].source }, { status: "verified", source: "dashboard" });
  assert.ok(!JSON.stringify(log).includes(to), "the log shows the number masked");

  // a number cannot receive a code from itself
  const same = await request(app).post("/api/otp-setup/test/send").set(c.owner).send({ phone: "+971 50 000 0000" });
  assert.equal(same.status, 400);
  assert.equal(same.body.code, "same_number");
  // the preview is the message as it will read
  const preview = await request(app).get("/api/otp-setup/preview").query({ template: "booking", brand: "Noor Clinic", codeLength: 4 }).set(c.owner);
  assert.equal(preview.body.text, "*4829* is your Noor Clinic booking confirmation code.\nIt expires in 5 minutes. Never share this code with anyone.");
  assert.equal((await request(app).get("/api/otp-setup/preview").query({ brand: "bad.link.com" }).set(c.owner)).status, 400);
});

test("only owners and administrators set OTP up", async () => {
  reset();
  const c = await company("roles");
  const staff = await registerTenantAndUser({ name: "Sam", email: "sam@roles.otp.test", password: "Password@123", companyName: "Sam Co" });
  await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [c.tenantId, staff.user.id]);
  const agent = { Authorization: `Bearer ${generateAccessToken(staff.user, c.tenantId, "agent")}`, "X-Tenant-Id": c.tenantId };
  for (const [method, path] of [["get", "/api/otp-setup"], ["put", "/api/otp-setup/settings"], ["post", "/api/otp-setup/keys"], ["post", "/api/otp-setup/test/send"], ["get", "/api/otp-setup/log"]]) {
    const res = await request(app)[method](path).set(agent).send({});
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.equal((await request(app).get("/api/otp-setup")).status, 401);
});

test("bad requests say what is wrong and what to do", async () => {
  reset();
  const c = await company("badreq");
  const key = await c.makeKey();
  for (const body of [{}, { phone: "12345" }, { phone: "hello" }, { phone: "+971 50" }]) {
    const res = await send(key, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "invalid_phone");
    assert.match(res.body.fix, /country code/);
  }
  assert.equal((await request(app).post("/api/otp/send").set("Content-Type", "text/plain").set(bearer(key)).send("not json")).status, 400);
  assert.equal((await verify(key, { id: "otp_nope", code: "123456" })).status, 404);
  assert.equal((await verify(key, { code: "123456" })).status, 400);
  assert.equal((await verify(key, { phone: phone(), code: "123456" })).status, 404);
});
