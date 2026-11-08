import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { closeSessions } from "../src/services/sessionService.js";
import { makeProof } from "../src/services/otp/proof.js";
import { forgetOtpCache } from "../src/services/otp/guard.js";

// The drop-in widget: a public key in a visitor's browser, the websites it may run on, the limits, and the proof the company's
// own server checks afterwards.
const sent = [];
provider.getSession = () => ({ client: {} });
provider.checkNumber = async (_t, _s, p) => ({ checked: true, exists: true, jid: `${p}@c.us` });
provider.sendTextMessage = async (tenantId, sessionName, to, text) => {
  sent.push({ to, text });
  return { providerMessageId: `true_${to}_${sent.length}`, to, text, ack: 1 };
};
after(async () => {
  await closeSessions(io);
  io.close();
});
const SITE = "https://shop.example.com";
let n = 0;
const phone = () => `97154${String(1000000 + ++n)}`;
const codeIn = (text) => /\*(\d+)\*/.exec(text)[1];

async function company(label) {
  const o = await registerTenantAndUser({ name: "Owner", email: `${label}@widget.test`, password: "Password@123", companyName: `${label} Stores` });
  await query("UPDATE tenants SET plan='Free' WHERE id=$1", [o.tenant.id]);
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,phone,status) VALUES(gen_random_uuid()::text,$1,'otp-line',$2,'971500000000','CONNECTED')", [o.tenant.id, o.user.id]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, o.tenant.id, "owner")}` };
  const make = async (body) => request(app).post("/api/otp-setup/keys").set(owner).send({ name: "Key", ...body });
  return { tenantId: o.tenant.id, owner, make, key: async (body) => (await make(body)).body.key.key };
}
// what a browser sends: JSON as plain text, from a page on some origin
const widget = (path, body, origin = SITE) => {
  const r = request(app).post(`/api/otp/widget${path}`).set("Content-Type", "text/plain");
  return (origin ? r.set("Origin", origin) : r).send(JSON.stringify(body));
};

test("a live public key needs the websites it will run on, written as plain addresses", async () => {
  const c = await company("keys");
  const none = await c.make({ kind: "public", mode: "live" });
  assert.equal(none.status, 400);
  assert.equal(none.body.code, "origins_required");
  for (const origins of [["ftp://shop.example.com"], ["http://shop.example.com"], ["not a website"], ["https://user:pw@shop.example.com"], Array(11).fill(SITE)]) {
    const res = await c.make({ kind: "public", mode: "live", origins });
    assert.equal(res.status, 400, JSON.stringify(origins));
    assert.equal(res.body.code, "invalid_origins");
  }
  const ok = await c.make({ kind: "public", mode: "live", origins: ["https://Shop.Example.com/checkout?x=1", "https://shop.example.com", "http://localhost:3000"] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.match(ok.body.key.key, /^otp_pk_live_[a-f0-9]{40}$/);
  assert.deepEqual(ok.body.key.allowedOrigins, ["https://shop.example.com", "http://localhost:3000"], "tidied to the website itself, no repeats");
  const test = await c.make({ kind: "public", mode: "test" });
  assert.equal(test.status, 201, "a test key needs no website: it sends nothing");
  assert.equal((await c.make({ kind: "secret", mode: "live", origins: [SITE] })).body.key.allowedOrigins.length, 0, "a secret key has no websites");
});

test("from an allowed website a visitor can ask for a code and check it, and gets a proof", async () => {
  forgetOtpCache();
  sent.length = 0;
  const c = await company("flow");
  const pk = await c.key({ kind: "public", mode: "live", origins: [SITE] });
  const sk = await c.key({ kind: "secret", mode: "live" });
  const to = phone();

  const config = await request(app).get("/api/otp/widget/config").query({ key: pk }).set("Origin", SITE);
  assert.equal(config.status, 200);
  assert.deepEqual({ brand: config.body.brand, digits: config.body.codeLength, wait: config.body.resendSeconds, locale: config.body.locale, test: config.body.test, available: config.body.available }, { brand: "flow Stores", digits: 6, wait: 30, locale: "en", test: false, available: true });

  const res = await widget("/send", { key: pk, phone: `+${to}`, reference: "form-9" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.headers["access-control-allow-origin"], SITE);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body.state, "sent");
  assert.ok(!("code" in res.body));
  const code = codeIn(sent[0].text);

  const wrong = await widget("/verify", { key: pk, id: res.body.id, code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.body.valid, false);
  assert.ok(!("proof" in wrong.body));
  const right = await widget("/verify", { key: pk, id: res.body.id, code });
  assert.equal(right.body.valid, true, JSON.stringify(right.body));
  assert.match(right.body.proof, /^otp_proof_[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
  assert.ok(!("phone" in right.body) && !("reference" in right.body), "the browser is told nothing the page does not already know");

  // the company's server asks Scriwo whether the proof is real: once
  const check = (proof, key = sk) => request(app).post("/api/otp/proof/verify").set({ Authorization: `Bearer ${key}` }).send({ proof });
  const first = await check(right.body.proof);
  assert.equal(first.status, 200);
  assert.deepEqual({ valid: first.body.valid, phone: first.body.phone, reference: first.body.reference, mode: first.body.mode }, { valid: true, phone: `+${to}`, reference: "form-9", mode: "live" });
  const second = await check(right.body.proof);
  assert.deepEqual({ valid: second.body.valid, reason: second.body.reason }, { valid: false, reason: "already_used" });
});

test("a proof is useless to anyone else: another company, a tampered one, an old one", async () => {
  forgetOtpCache();
  sent.length = 0;
  const a = await company("proofA");
  const b = await company("proofB");
  const pk = await a.key({ kind: "public", mode: "live", origins: [SITE] });
  const skA = await a.key({ kind: "secret", mode: "live" });
  const skB = await b.key({ kind: "secret", mode: "live" });
  const r = await widget("/send", { key: pk, phone: phone() });
  const v = await widget("/verify", { key: pk, id: r.body.id, code: codeIn(sent[0].text) });
  const proof = v.body.proof;
  const asB = await request(app).post("/api/otp/proof/verify").set({ Authorization: `Bearer ${skB}` }).send({ proof });
  assert.equal(asB.status, 400);
  assert.equal(asB.body.code, "invalid_proof");
  const [head, sig] = proof.split(".");
  for (const bad of [`${head}.${"0".repeat(64)}`, `${head.slice(0, -2)}xx.${sig}`, "otp_proof_", "garbage", ""]) {
    const res = await request(app).post("/api/otp/proof/verify").set({ Authorization: `Bearer ${skA}` }).send({ proof: bad });
    assert.equal(res.status, 400, bad);
  }
  // it is still good for its owner, once
  assert.equal((await request(app).post("/api/otp/proof/verify").set({ Authorization: `Bearer ${skA}` }).send({ proof })).body.valid, true);
  // and it is good for ten minutes only
  const old = makeProof({ id: r.body.id, tenant_id: a.tenantId }, Date.now() - 11 * 60 * 1000);
  const expired = await request(app).post("/api/otp/proof/verify").set({ Authorization: `Bearer ${skA}` }).send({ proof: old });
  assert.deepEqual({ valid: expired.body.valid, reason: expired.body.reason }, { valid: false, reason: "expired" });
  // a proof for a code that was never checked successfully proves nothing
  const unchecked = await widget("/send", { key: pk, phone: phone() });
  const forged = makeProof({ id: unchecked.body.id, tenant_id: a.tenantId });
  assert.equal((await request(app).post("/api/otp/proof/verify").set({ Authorization: `Bearer ${skA}` }).send({ proof: forged })).body.valid, false);
});

test("only the listed websites may use a live key; the error is still readable by the page", async () => {
  forgetOtpCache();
  const c = await company("origin");
  const pk = await c.key({ kind: "public", mode: "live", origins: [SITE] });
  const other = await widget("/send", { key: pk, phone: phone() }, "https://evil.example.org");
  assert.equal(other.status, 403);
  assert.equal(other.body.code, "origin_not_allowed");
  assert.equal(other.headers["access-control-allow-origin"], "https://evil.example.org", "the page can read why it was refused");
  assert.ok(other.body.fix);
  assert.equal((await widget("/send", { key: pk, phone: phone() }, null)).body.code, "origin_not_allowed", "no origin at all: not a browser on a listed page");
  assert.equal((await request(app).get("/api/otp/widget/config").query({ key: pk }).set("Origin", "https://evil.example.org")).status, 403);
  assert.equal((await widget("/verify", { key: pk, id: "otp_x", code: "123456" }, "https://evil.example.org")).status, 403);
  // a browser's pre-flight question is answered without a key
  const pre = await request(app).options("/api/otp/widget/send").set("Origin", SITE).set("Access-Control-Request-Method", "POST");
  assert.equal(pre.status, 204);
  assert.equal(pre.headers["access-control-allow-origin"], SITE);
  assert.match(pre.headers["access-control-allow-methods"], /POST/);
});

test("a public key can do nothing a public key should not, and a secret key never belongs in a page", async () => {
  const c = await company("kinds");
  const pk = await c.key({ kind: "public", mode: "live", origins: [SITE] });
  const sk = await c.key({ kind: "secret", mode: "live" });
  const bad = await widget("/send", { key: sk, phone: phone() });
  assert.equal(bad.status, 403);
  assert.equal(bad.body.code, "wrong_key_kind");
  assert.equal((await widget("/send", { key: `otp_pk_live_${"a".repeat(40)}`, phone: phone() })).status, 401);
  assert.equal((await widget("/send", { phone: phone() })).status, 401);
  assert.equal((await request(app).post("/api/otp/widget/send").set("Origin", SITE).set("Content-Type", "text/plain").send("{not json")).status, 400);
  assert.equal((await request(app).post("/api/otp/widget/elsewhere").set("Origin", SITE).send("{}")).status, 404);
  // the public key opens nothing else
  for (const [method, path] of [["post", "/api/otp/send"], ["post", "/api/otp/verify"], ["post", "/api/otp/proof/verify"], ["get", "/api/conversations"], ["get", "/api/otp-setup"]]) {
    const res = await request(app)[method](path).set({ Authorization: `Bearer ${pk}` }).send({});
    assert.ok([401, 403].includes(res.status), `${method} ${path} -> ${res.status}`);
  }
});

test("a test public key works from anywhere, sends nothing and still gives a proof", async () => {
  forgetOtpCache();
  sent.length = 0;
  const c = await company("testpk");
  const pk = await c.key({ kind: "public", mode: "test" });
  const sk = await c.key({ kind: "secret", mode: "test" });
  const res = await widget("/send", { key: pk, phone: phone() }, "http://localhost:5500");
  assert.equal(res.status, 201);
  assert.deepEqual({ test: res.body.test, code: res.body.code }, { test: true, code: "123456" });
  assert.equal(sent.length, 0);
  const v = await widget("/verify", { key: pk, id: res.body.id, code: "123456" }, null);
  assert.equal(v.body.valid, true);
  const proof = await request(app).post("/api/otp/proof/verify").set({ Authorization: `Bearer ${sk}` }).send({ proof: v.body.proof });
  assert.deepEqual({ valid: proof.body.valid, mode: proof.body.mode }, { valid: true, mode: "test" });
});

test("one visitor, and one page, can only ask for so many codes an hour", async () => {
  forgetOtpCache();
  sent.length = 0;
  const c = await company("limits");
  const pk = await c.key({ kind: "public", mode: "live", origins: [SITE] });
  const forwarded = (ip) => ({ "X-Forwarded-For": ip });
  const ask = (ip, to = phone()) => request(app).post("/api/otp/widget/send").set("Content-Type", "text/plain").set("Origin", SITE).set(forwarded(ip)).send(JSON.stringify({ key: pk, phone: to }));
  for (let i = 0; i < 12; i++) assert.equal((await ask("203.0.113.9")).status, 201, `code ${i + 1}`);
  const blocked = await ask("203.0.113.9");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, "too_many_requests");
  assert.equal((await ask("203.0.113.10")).status, 201, "another visitor is not held back by the first");
  // the browser is told which website asked, but the database keeps only a hash of who
  const stored = (await query("SELECT visitor_hash FROM otp_requests WHERE tenant_id=$1 AND source='widget' LIMIT 1", [c.tenantId])).rows[0];
  assert.match(stored.visitor_hash, /^[a-f0-9]{32}$/);
});

test("a company that has paused OTP, or has no number, is told so in the widget too", async () => {
  forgetOtpCache();
  const c = await company("paused");
  const pk = await c.key({ kind: "public", mode: "live", origins: [SITE] });
  await request(app).put("/api/otp-setup/settings").set(c.owner).send({ enabled: false });
  assert.equal((await request(app).get("/api/otp/widget/config").query({ key: pk }).set("Origin", SITE)).body.available, false);
  const res = await widget("/send", { key: pk, phone: phone() });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "otp_paused");
});
