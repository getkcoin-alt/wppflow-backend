import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { closeSessions } from "../src/services/sessionService.js";
import { recordWebhook, encryptSecret } from "../src/services/webhookService.js";
import { handleAckEvent } from "../src/services/messageService.js";
import { pumpOtp } from "../src/services/otp/otpService.js";
import { forgetOtpCache } from "../src/services/otp/guard.js";

// Free OTP tells a company's own address what happens to its codes. Any plan may set it up, and it hears only OTP events.
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
const URL_OK = "https://93.184.216.34/otp-events"; // a public address written as numbers, so the check needs no DNS
let n = 0;
const phone = () => `97153${String(1000000 + ++n)}`;
const codeIn = (text) => /\*(\d+)\*/.exec(text)[1];

async function company(label, plan = "Free") {
  const o = await registerTenantAndUser({ name: "Owner", email: `${label}@hooks.test`, password: "Password@123", companyName: `${label} Stores` });
  await query("UPDATE tenants SET plan=$2 WHERE id=$1", [o.tenant.id, plan]);
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,phone,status) VALUES(gen_random_uuid()::text,$1,'otp-line',$2,'971500000000','CONNECTED')", [o.tenant.id, o.user.id]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, o.tenant.id, "owner")}` };
  const key = async (body = {}) => (await request(app).post("/api/otp-setup/keys").set(owner).send({ name: "Site", kind: "secret", mode: "live", ...body })).body.key.key;
  return { tenantId: o.tenant.id, owner, key };
}
const deliveries = async (tenantId) => (await query("SELECT d.event,d.payload,e.scope FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.tenant_id=$1 ORDER BY d.created_at,d.id", [tenantId])).rows;

test("any plan can set one OTP webhook address; the signing secret is shown once", async () => {
  forgetOtpCache();
  const c = await company("hook1");
  const set = await request(app).put("/api/otp-setup/webhook").set(c.owner).send({ url: URL_OK });
  assert.equal(set.status, 201, JSON.stringify(set.body));
  assert.match(set.body.secret, /^[a-f0-9]{64}$/);
  assert.equal(set.body.webhook.url, URL_OK);
  const overview = (await request(app).get("/api/otp-setup").set(c.owner)).body;
  assert.equal(overview.webhook.url, URL_OK);
  assert.ok(!JSON.stringify(overview).includes(set.body.secret), "the secret is never shown again");
  const stored = (await query("SELECT secret,scope FROM webhook_endpoints WHERE tenant_id=$1", [c.tenantId])).rows[0];
  assert.equal(stored.scope, "otp");
  assert.ok(!stored.secret.includes(set.body.secret), "and it is stored encrypted");

  // setting another address replaces the first: only one OTP address listens
  const again = await request(app).put("/api/otp-setup/webhook").set(c.owner).send({ url: "https://93.184.216.35/other" });
  assert.equal(again.status, 201);
  const live = (await query("SELECT url FROM webhook_endpoints WHERE tenant_id=$1 AND enabled", [c.tenantId])).rows;
  assert.deepEqual(live.map((r) => r.url), ["https://93.184.216.35/other"]);
  assert.equal((await request(app).delete("/api/otp-setup/webhook").set(c.owner)).status, 200);
  assert.equal((await request(app).delete("/api/otp-setup/webhook").set(c.owner)).status, 404);
  assert.equal((await request(app).get("/api/otp-setup").set(c.owner)).body.webhook, null);
});

test("an address that is not a public https address is refused", async () => {
  const c = await company("hook2");
  for (const url of ["https://127.0.0.1/x", "https://10.0.0.5/x", "http://93.184.216.34/x", "https://93.184.216.34:8443/x", "https://user:pw@93.184.216.34/x", "not an address", ""]) {
    const res = await request(app).put("/api/otp-setup/webhook").set(c.owner).send({ url });
    assert.equal(res.status, 400, url);
    assert.equal(res.body.code, "invalid_webhook", url);
    assert.ok(res.body.fix);
  }
  assert.equal((await request(app).put("/api/otp-setup/webhook").send({ url: URL_OK })).status, 401);
});

test("OTP events go to the OTP address only, and everything else keeps going to the existing webhooks only", async () => {
  forgetOtpCache();
  sent.length = 0;
  const c = await company("hook3", "Business");
  // a Business company's existing webhook (what exists today)
  await query("INSERT INTO webhook_endpoints(id,tenant_id,url,secret) VALUES(gen_random_uuid(),$1,'https://93.184.216.36/all',$2)", [c.tenantId, encryptSecret("s".repeat(64))]);
  await request(app).put("/api/otp-setup/webhook").set(c.owner).send({ url: URL_OK });
  const key = await c.key();
  const to = phone();
  const res = await request(app).post("/api/otp/send").set({ Authorization: `Bearer ${key}` }).send({ phone: to, reference: "order-77" });
  assert.equal(res.status, 201);
  const code = codeIn(sent[0].text);
  await request(app).post("/api/otp/verify").set({ Authorization: `Bearer ${key}` }).send({ id: res.body.id, code });
  await recordWebhook(c.tenantId, "message.received", { text: "hello" });

  const all = await deliveries(c.tenantId);
  assert.deepEqual(all.filter((d) => d.scope === "otp").map((d) => d.event), ["otp.sent", "otp.verified"]);
  assert.deepEqual(all.filter((d) => d.scope === "all").map((d) => d.event), ["message.received"], "the existing webhook hears nothing new");
  const verified = all.find((d) => d.event === "otp.verified").payload;
  assert.deepEqual({ id: verified.id, phone: verified.phone, reference: verified.reference, template: verified.template, mode: verified.mode, source: verified.source }, { id: res.body.id, phone: `+${to}`, reference: "order-77", template: "login", mode: "live", source: "api" });
  assert.ok(verified.secondsToVerify >= 0);
  assert.ok(!JSON.stringify(all).includes(code), "a code is never in any event");
});

test("delivery, a code locking and a code expiring are told too, and a test key's events say so", async () => {
  forgetOtpCache();
  sent.length = 0;
  const c = await company("hook4");
  await request(app).put("/api/otp-setup/webhook").set(c.owner).send({ url: URL_OK });
  await request(app).put("/api/otp-setup/settings").set(c.owner).send({ maxAttempts: 1 });
  const key = await c.key();
  const auth = { Authorization: `Bearer ${key}` };
  const a = await request(app).post("/api/otp/send").set(auth).send({ phone: phone() });
  const row = (await query("SELECT provider_message_id FROM otp_requests WHERE id=$1", [a.body.id])).rows[0];
  await handleAckEvent({ tenantId: c.tenantId, ackData: { providerMessageId: row.provider_message_id, ack: 2 } });
  const code = codeIn(sent[0].text);
  await request(app).post("/api/otp/verify").set(auth).send({ id: a.body.id, code: code === "000000" ? "111111" : "000000" });
  const b = await request(app).post("/api/otp/send").set(auth).send({ phone: phone() });
  await query("UPDATE otp_requests SET expires_at=now()-interval '1 second' WHERE id=$1", [b.body.id]);
  await pumpOtp();
  const testKey = await c.key({ mode: "test" });
  await request(app).post("/api/otp/send").set({ Authorization: `Bearer ${testKey}` }).send({ phone: phone() });
  const events = (await deliveries(c.tenantId)).map((d) => [d.event, d.payload.mode, d.payload.reason]);
  assert.deepEqual(events, [
    ["otp.sent", "live", undefined],
    ["otp.delivered", "live", undefined],
    ["otp.failed", "live", "too_many_attempts"],
    ["otp.sent", "live", undefined],
    ["otp.expired", "live", undefined],
    ["otp.sent", "test", undefined],
  ]);
});

test("a company can send itself a test event, and see what happened to it", async () => {
  const c = await company("hook5");
  const none = await request(app).post("/api/otp-setup/webhook/test").set(c.owner);
  assert.equal(none.status, 400);
  assert.equal(none.body.code, "no_webhook");
  await request(app).put("/api/otp-setup/webhook").set(c.owner).send({ url: URL_OK });
  const test1 = await request(app).post("/api/otp-setup/webhook/test").set(c.owner);
  assert.equal(test1.status, 202);
  const list = await request(app).get("/api/otp-setup/webhook/deliveries").set(c.owner);
  assert.equal(list.body.deliveries.length, 1);
  assert.equal(list.body.deliveries[0].event, "otp.test");
  assert.equal(list.body.deliveries[0].status, "pending");
});

test("webhooks that exist already are still created, listed and scoped as before", async () => {
  const c = await company("hook6", "Business");
  const res = await request(app).post("/api/workspace/webhooks").set(c.owner).send({ url: URL_OK });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal((await query("SELECT scope FROM webhook_endpoints WHERE tenant_id=$1", [c.tenantId])).rows[0].scope, "all");
  // an OTP address and its deliveries are not in their list: that tab shows what it always showed
  await request(app).put("/api/otp-setup/webhook").set(c.owner).send({ url: "https://93.184.216.40/otp" });
  await request(app).post("/api/otp-setup/webhook/test").set(c.owner);
  const listed = await request(app).get("/api/workspace/webhooks").set(c.owner);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.endpoints.map((e) => e.url), [URL_OK]);
  assert.equal(listed.body.deliveries.filter((d) => d.event.startsWith("otp.")).length, 0);
});
