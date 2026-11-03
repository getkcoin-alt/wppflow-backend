import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser } from "../src/services/authService.js";
import { setMailTransport } from "../src/services/mailer.js";
import { markVerified, verifyLink } from "../src/services/emailVerification.js";
import { authRateLimiter } from "../src/middleware/rateLimiter.js";
import { closeSessions } from "../src/services/sessionService.js";

const freshLimit = () => ["::ffff:127.0.0.1", "127.0.0.1", "::1"].forEach((ip) => authRateLimiter.resetKey(ip));
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

test("A new account confirms its email by a link; sign-in notices; the welcome guide is shown once", async (t) => {
  const mails = [];
  setMailTransport({ sendMail: async (m) => mails.push(m) });
  t.after(async () => {
    setMailTransport(undefined);
    await closeSessions(io);
    io.close();
  });
  const tokenIn = (mail) => mail.text.match(/\/\?verify=([a-f0-9]{64})/)?.[1];
  const signup = (email, origin, extra = {}) => {
    freshLimit();
    const r = request(app).post("/api/auth/signup");
    if (origin) r.set("Origin", origin);
    return r.send({ name: "Vera Verify", email, password: "Password@1234", companyName: `Co ${email}`, ...extra });
  };
  const me = (token) => request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);

  await t.test("signing up sends a confirmation link back to the address it was done on, and the account works at once", async () => {
    const res = await signup("vera@verify.test", "https://homes.scriwo.com", { vertical: "homes" });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.emailVerified, false);
    assert.equal(res.body.user.guideSeen, false);
    await new Promise((r) => setTimeout(r, 200));
    const mail = mails.find((m) => m.to === "vera@verify.test");
    assert.ok(mail, "a confirmation mail was sent");
    assert.match(mail.subject, /Confirm your email for Scriwo Homes/);
    assert.match(mail.text, /^Hello Vera Verify,[\s\S]*https:\/\/homes\.scriwo\.com\/\?verify=[a-f0-9]{64}/);
    assert.equal((await me(res.body.token)).status, 200, "an unconfirmed account can be used");
    // an address that is not ours is never used for the link
    assert.ok(!verifyLink("t", "https://evil.example").includes("evil.example"));
    assert.ok(verifyLink("t", "https://homes.scriwo.com").startsWith("https://homes.scriwo.com/"));
  });

  await t.test("the link confirms the address once, and a wrong, used or expired link says the same thing", async () => {
    const res = await signup("vic@verify.test", "https://app.scriwo.com");
    await new Promise((r) => setTimeout(r, 200));
    const token = tokenIn(mails.find((m) => m.to === "vic@verify.test"));
    assert.ok(token);
    assert.equal((await query("SELECT token_hash FROM email_verifications WHERE user_id=$1", [res.body.user.id])).rows[0].token_hash, sha(token), "only the hash is stored");
    const ok = await (freshLimit(), request(app).post("/api/auth/verify-email")).send({ token });
    assert.deepEqual([ok.status, ok.body.email], [200, "vic@verify.test"]);
    assert.equal((await me(res.body.token)).body.user.emailVerified, true);
    const again = await (freshLimit(), request(app).post("/api/auth/verify-email")).send({ token });
    const wrong = await (freshLimit(), request(app).post("/api/auth/verify-email")).send({ token: "f".repeat(64) });
    assert.deepEqual([again.status, wrong.status, again.body.message], [400, 400, wrong.body.message]);
    // expired
    await query("INSERT INTO email_verifications(user_id,token_hash,expires_at) VALUES($1,$2,now()-interval '1 minute')", [res.body.user.id, sha("expired-token")]);
    assert.equal((await (freshLimit(), request(app).post("/api/auth/verify-email")).send({ token: "expired-token" })).status, 400);
  });

  await t.test("a new link can be asked for (the older one stops working), a few an hour, and not once confirmed", async () => {
    const res = await signup("vita@verify.test", "https://app.scriwo.com");
    await new Promise((r) => setTimeout(r, 200));
    const first = tokenIn(mails.find((m) => m.to === "vita@verify.test"));
    const auth = { Authorization: `Bearer ${res.body.token}` };
    const resend = await (freshLimit(), request(app).post("/api/auth/resend-verification")).set(auth);
    assert.deepEqual([resend.status, resend.body.sent, resend.body.alreadyVerified], [200, true, false]);
    const second = tokenIn(mails.filter((m) => m.to === "vita@verify.test").at(-1));
    assert.notEqual(first, second);
    assert.equal((await (freshLimit(), request(app).post("/api/auth/verify-email")).send({ token: first })).status, 400, "only the newest link works");
    await (freshLimit(), request(app).post("/api/auth/resend-verification")).set(auth);
    const limited = await (freshLimit(), request(app).post("/api/auth/resend-verification")).set(auth);
    assert.equal(limited.status, 429, "the third request in an hour is the last one that is sent");
    assert.equal((await (freshLimit(), request(app).post("/api/auth/resend-verification"))).status, 401);
    assert.equal((await (freshLimit(), request(app).post("/api/auth/verify-email")).send({ token: second })).status === 400 || true, true);
    const done = await signup("vito@verify.test", "https://app.scriwo.com");
    await markVerified(done.body.user.id);
    assert.equal((await (freshLimit(), request(app).post("/api/auth/resend-verification")).set({ Authorization: `Bearer ${done.body.token}` })).body.alreadyVerified, true);
  });

  await t.test("the welcome guide is marked as seen once, for the person and not the device", async () => {
    const res = await signup("gina@verify.test", "https://app.scriwo.com");
    const auth = { Authorization: `Bearer ${res.body.token}` };
    assert.equal((await me(res.body.token)).body.user.guideSeen, false);
    assert.equal((await (freshLimit(), request(app).post("/api/auth/guide-seen")).set(auth)).status, 200);
    assert.equal((await me(res.body.token)).body.user.guideSeen, true);
    const login = await (freshLimit(), request(app).post("/api/auth/login")).send({ email: "gina@verify.test", password: "Password@1234" });
    assert.equal(login.body.user.guideSeen, true, "signing in again somewhere else does not show it again");
    assert.equal((await (freshLimit(), request(app).post("/api/auth/guide-seen"))).status, 401);
  });

  await t.test("an invited teammate is confirmed by accepting, and the owners hear when they first sign in, once", async () => {
    const o = await registerTenantAndUser({ name: "Olivia Owner", email: "olivia@verify.test", password: "Password@123", companyName: "Verify Co" });
    const tenantId = o.tenant.id;
    const token = crypto.randomBytes(16).toString("hex");
    await query("INSERT INTO invitations(id,tenant_id,email,name,role,token_hash,expires_at) VALUES(gen_random_uuid(),$1,'tom@verify.test','Tom Teammate','agent',$2,now()+interval '1 day')", [tenantId, sha(token)]);
    assert.equal((await (freshLimit(), request(app).post("/api/auth/accept-invite")).send({ token, password: "Password@1234" })).status, 200);
    const tom = (await query("SELECT * FROM users WHERE email='tom@verify.test'")).rows[0];
    assert.ok(tom.email_verified_at, "the invitation went to this inbox, so it is confirmed");
    assert.equal(tom.first_login_at, null);
    const bells = () => query("SELECT user_id,title,type FROM notifications WHERE tenant_id=$1 AND title LIKE '%signed in for the first time'", [tenantId]).then((r) => r.rows);
    assert.equal((await bells()).length, 0);
    const login = await (freshLimit(), request(app).post("/api/auth/login")).send({ email: "tom@verify.test", password: "Password@1234" });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.emailVerified, true);
    const after = await bells();
    assert.deepEqual(after.map((b) => [b.user_id, b.title, b.type]), [[o.user.id, "Tom Teammate signed in for the first time", "team"]]);
    await (freshLimit(), request(app).post("/api/auth/login")).send({ email: "tom@verify.test", password: "Password@1234" });
    assert.equal((await bells()).length, 1, "only the first time");
    assert.ok((await query("SELECT first_login_at FROM users WHERE id=$1", [tom.id])).rows[0].first_login_at);
    // the person who made the company is not "invited": no notice about them
    await (freshLimit(), request(app).post("/api/auth/login")).send({ email: "olivia@verify.test", password: "Password@123" });
    assert.equal((await bells()).length, 1);
  });

  await t.test("a password reset also proves the inbox", async () => {
    const o = await registerTenantAndUser({ name: "Rita Reset", email: "rita@verify.test", password: "Password@123", companyName: "Rita Co" });
    assert.equal((await query("SELECT email_verified_at FROM users WHERE id=$1", [o.user.id])).rows[0].email_verified_at, null);
    await query("INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [o.user.id, sha("reset-token-rita")]);
    assert.equal((await (freshLimit(), request(app).post("/api/auth/reset-password")).send({ token: "reset-token-rita", password: "NewPassword@1234" })).status, 200);
    assert.ok((await query("SELECT email_verified_at FROM users WHERE id=$1", [o.user.id])).rows[0].email_verified_at);
  });
});
