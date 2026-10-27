import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, comparePassword } from "../src/services/authService.js";
import { setMailTransport } from "../src/services/mailer.js";
import { authRateLimiter } from "../src/middleware/rateLimiter.js";
import { closeSessions } from "../src/services/sessionService.js";
import { RESET_REQUESTS_PER_HOUR } from "../src/services/passwordReset.js";

const freshLimit = () =>
  ["::ffff:127.0.0.1", "127.0.0.1", "::1"].forEach((ip) => authRateLimiter.resetKey(ip));
const tokenOf = (mail) => new URL(/https?:\/\/\S+/.exec(mail.text)[0]).searchParams.get("reset");
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

test("Forgot password: a one-hour single-use link that does not reveal who has an account", async (t) => {
  const mails = [];
  setMailTransport({ sendMail: async (m) => void mails.push(m) });
  t.after(async () => {
    setMailTransport(undefined);
    await closeSessions(io);
    io.close();
  });
  const OLD = "Old-password-12345";
  const NEW = "Brand-new-pass-67890";
  const o = await registerTenantAndUser({ name: "Rhea Rao", email: "rhea@reset.test", password: OLD, companyName: "Reset Co" });
  const userId = o.user.id;
  const ask = async (email) => {
    freshLimit();
    return request(app).post("/api/auth/forgot-password").send({ email });
  };
  // the work happens after the answer, so wait for the mail to arrive
  const asked = async (email) => {
    const before = mails.length;
    const res = await ask(email);
    for (let i = 0; i < 40 && mails.length === before; i++) await settle(25);
    return res;
  };
  const resetMails = () => mails.filter((m) => /Reset your Scriwo password/.test(m.subject));
  const login = (password, email = "rhea@reset.test") => {
    freshLimit();
    return request(app).post("/api/auth/login").send({ email, password });
  };
  const reset = (token, password) => {
    freshLimit();
    return request(app).post("/api/auth/reset-password").send({ token, password });
  };

  await t.test("a known and an unknown address get the same answer, so nobody can find out who is a customer", async () => {
    const known = await ask("rhea@reset.test");
    const unknown = await ask("nobody@reset.test");
    assert.equal(known.status, 200);
    assert.equal(unknown.status, known.status);
    assert.deepEqual(unknown.body, known.body);
    assert.match(known.body.message, /If that address has an account/);
    await settle();
    assert.equal(resetMails().length, 1, "only the real account is mailed");
    assert.equal(resetMails()[0].to, "rhea@reset.test");
    mails.length = 0;
    await query("DELETE FROM password_resets");
  });

  await t.test("the mail carries a link into the app and only a hash of its token is stored", async () => {
    await asked("RHEA@Reset.test");
    assert.equal(resetMails().length, 1, "the address is matched without regard to case");
    const mail = resetMails()[0];
    const token = tokenOf(mail);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.match(mail.text, /\/\?reset=/);
    assert.match(mail.text, /1 hour/);
    const rows = (await query("SELECT * FROM password_resets WHERE user_id=$1", [userId])).rows;
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, token, "the raw token is never kept");
    assert.ok(!JSON.stringify(rows).includes(token));
    const hours = (new Date(rows[0].expires_at) - new Date(rows[0].created_at)) / 3600000;
    assert.ok(hours > 0.99 && hours < 1.01, `the link lasts one hour (${hours})`);
    freshLimit();
    const info = await request(app).get(`/api/auth/reset-info?token=${token}`);
    assert.equal(info.status, 200);
    assert.equal(info.body.email, "rhea@reset.test");
  });

  await t.test("only the newest link works when another is asked for", async () => {
    const first = tokenOf(resetMails()[0]);
    await asked("rhea@reset.test");
    const second = tokenOf(resetMails()[1]);
    assert.notEqual(first, second);
    freshLimit();
    assert.equal((await request(app).get(`/api/auth/reset-info?token=${first}`)).status, 400);
    const stale = await reset(first, NEW);
    assert.equal(stale.status, 400);
    assert.match(stale.body.message, /invalid, expired or already used/);
    assert.equal((await login(OLD)).status, 200, "a refused link changes nothing");
  });

  await t.test("a link that has run out is refused", async () => {
    const live = tokenOf(resetMails()[1]);
    await query("UPDATE password_resets SET expires_at=now()-interval '1 minute' WHERE user_id=$1 AND used_at IS NULL", [userId]);
    assert.equal((await reset(live, NEW)).status, 400);
    freshLimit();
    assert.equal((await request(app).get(`/api/auth/reset-info?token=${live}`)).status, 400);
    assert.equal((await login(NEW)).status, 401);
  });

  await t.test("a short password is refused and the link stays usable", async () => {
    mails.length = 0;
    await query("DELETE FROM password_resets");
    await asked("rhea@reset.test");
    const token = tokenOf(resetMails()[0]);
    const short = await reset(token, "short-pw");
    assert.equal(short.status, 400);
    assert.match(short.body.message, /at least 10/);
    assert.equal((await reset(token, "x".repeat(129))).status, 400);
    freshLimit();
    assert.equal((await request(app).get(`/api/auth/reset-info?token=${token}`)).status, 200, "still good");
  });

  await t.test("a reset sets the new password, ends every session, clears the forced change and works once", async () => {
    const before = await login(OLD);
    assert.equal(before.status, 200);
    const cookie = before.headers["set-cookie"].find((c) => c.startsWith("refreshToken="));
    await query("UPDATE users SET must_change_password=true WHERE id=$1", [userId]);
    const token = tokenOf(resetMails()[0]);
    mails.length = 0;
    const done = await reset(token, NEW);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.match(done.body.message, /Password changed/);
    assert.equal(done.body.token, undefined, "a reset does not sign anyone in");

    assert.equal((await login(OLD)).status, 401, "the old password is gone");
    assert.equal((await login(NEW)).status, 200);
    const user = (await query("SELECT * FROM users WHERE id=$1", [userId])).rows[0];
    assert.equal(user.must_change_password, false);
    assert.ok(await comparePassword(NEW, user.password_hash));

    freshLimit();
    const refreshed = await request(app).post("/api/auth/refresh").set("Cookie", cookie.split(";")[0]);
    assert.equal(refreshed.status, 401, "a device signed in before the reset has to sign in again");

    assert.equal((await reset(token, "Another-pass-13579")).status, 400, "the link works once");
    assert.equal((await login(NEW)).status, 200, "the second attempt changed nothing");
    await settle();
    const notice = mails.find((m) => /password was changed/.test(m.subject));
    assert.ok(notice, "the owner is told the password changed");
    assert.equal(notice.to, "rhea@reset.test");
    assert.ok(!notice.text.includes(NEW), "the notice never repeats the password");
  });

  await t.test("a disabled account is not mailed and cannot use an earlier link", async () => {
    const d = await registerTenantAndUser({ name: "Dev Das", email: "dev@reset.test", password: OLD, companyName: "Off Co" });
    mails.length = 0;
    await asked("dev@reset.test");
    const token = tokenOf(resetMails()[0]);
    await query("UPDATE users SET status='disabled' WHERE id=$1", [d.user.id]);
    mails.length = 0;
    await ask("dev@reset.test");
    await settle();
    assert.equal(mails.length, 0, "no mail for a disabled account");
    const res = await reset(token, NEW);
    assert.equal(res.status, 400);
    freshLimit();
    assert.equal((await request(app).get(`/api/auth/reset-info?token=${token}`)).status, 400);
    assert.ok(await comparePassword(OLD, (await query("SELECT password_hash FROM users WHERE id=$1", [d.user.id])).rows[0].password_hash));
  });

  await t.test("one address can only be mailed a few links an hour", async () => {
    await registerTenantAndUser({ name: "Cap Co", email: "cap@reset.test", password: OLD, companyName: "Cap Co" });
    mails.length = 0;
    for (let i = 0; i < RESET_REQUESTS_PER_HOUR + 2; i++) {
      assert.equal((await ask("cap@reset.test")).status, 200, "the answer never changes");
      await settle(60);
    }
    assert.equal(resetMails().length, RESET_REQUESTS_PER_HOUR);
  });

  await t.test("bad input is refused plainly", async () => {
    assert.equal((await ask("not-an-email")).status, 400);
    assert.equal((await ask("")).status, 400);
    freshLimit();
    assert.equal((await request(app).get("/api/auth/reset-info")).status, 400);
    assert.equal((await reset("0".repeat(64), NEW)).status, 400);
    freshLimit();
    assert.equal((await request(app).post("/api/auth/reset-password").send({ token: "t" })).status, 400);
  });

  await t.test("with mail switched off the answer is still the same and nothing breaks", async () => {
    setMailTransport({ sendMail: async () => { throw new Error("domain is not verified"); } });
    const res = await ask("rhea@reset.test");
    assert.equal(res.status, 200);
    assert.match(res.body.message, /If that address has an account/);
    await settle();
    setMailTransport({ sendMail: async (m) => void mails.push(m) });
  });
});
