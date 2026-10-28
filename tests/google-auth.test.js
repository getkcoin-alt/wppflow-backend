import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ENV } from "../src/config/env.js";
import { registerTenantAndUser } from "../src/services/authService.js";
import { setGoogleFetch, cleanIntent } from "../src/services/googleAuth.js";
import { authRateLimiter } from "../src/middleware/rateLimiter.js";
import { closeSessions } from "../src/services/sessionService.js";

const CLIENT_ID = "1234567890-abc.apps.googleusercontent.com";
const freshLimit = () => ["::ffff:127.0.0.1", "127.0.0.1", "::1"].forEach((ip) => authRateLimiter.resetKey(ip));
const jwt = (claims) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

test("Continue with Google", async (t) => {
  const keep = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, uri: process.env.GOOGLE_REDIRECT_URI, signup: ENV.ALLOW_PUBLIC_SIGNUP };
  t.after(async () => {
    setGoogleFetch(undefined);
    for (const [k, v] of [["GOOGLE_CLIENT_ID", keep.id], ["GOOGLE_CLIENT_SECRET", keep.secret], ["GOOGLE_REDIRECT_URI", keep.uri]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
    ENV.ALLOW_PUBLIC_SIGNUP = keep.signup;
    await closeSessions(io);
    io.close();
  });
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REDIRECT_URI;

  // Google's token endpoint, scripted and recorded
  const sent = [];
  let reply = () => ({});
  setGoogleFetch(async (url, init) => {
    sent.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(init.body)) });
    const r = reply(sent.at(-1));
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
  const claims = (over = {}, nonce) => ({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "g-1001", email: "gita@gmail.test", email_verified: true, name: "Gita Rao", exp: Math.floor(Date.now() / 1000) + 3600, nonce, ...over });

  // one whole visit: start, then the browser comes back from Google
  const visit = async ({ query: q = "", code = "good-code", over = {}, state, cookie, skipCallback = false, callbackQuery } = {}) => {
    freshLimit();
    const start = await request(app).get(`/api/auth/google/start${q}`);
    const target = new URL(start.headers.location);
    if (skipCallback) return { start, target };
    const jar = (start.headers["set-cookie"] || []).find((c) => c.startsWith("googleSignIn="))?.split(";")[0];
    reply = () => ({ body: { id_token: jwt(claims(over, target.searchParams.get("nonce"))), access_token: "x" } });
    freshLimit();
    const back = await request(app)
      .get(`/api/auth/google/callback?${callbackQuery ?? new URLSearchParams({ code, state: state ?? target.searchParams.get("state") }).toString()}`)
      .set("Cookie", cookie === null ? [] : [cookie ?? jar]);
    const to = new URL(back.headers.location);
    return { start, target, jar, back, to, params: Object.fromEntries(to.searchParams), refresh: (back.headers["set-cookie"] || []).find((c) => c.startsWith("refreshToken=")) };
  };
  const users = async (email) => (await query("SELECT u.*,(SELECT count(*)::int FROM memberships m WHERE m.user_id=u.id) AS ws FROM users u WHERE lower(email)=$1", [email])).rows;

  await t.test("when Google is not set up, the page is told so and nothing starts", async () => {
    freshLimit();
    assert.deepEqual((await request(app).get("/api/auth/providers")).body, { status: "success", google: false });
    freshLimit();
    const res = await request(app).get("/api/auth/google/start");
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/\?google_error=unavailable$/);
    assert.ok(!res.headers.location.includes("accounts.google.com"));
  });

  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = "a-secret-that-never-leaves-the-server";

  await t.test("starting sends the person to Google with a one-time state, a nonce, a PKCE challenge and the registered return address", async () => {
    freshLimit();
    assert.deepEqual((await request(app).get("/api/auth/providers")).body, { status: "success", google: true });
    const { start, target } = await visit({ skipCallback: true });
    assert.equal(start.status, 302);
    assert.equal(target.origin + target.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    const p = Object.fromEntries(target.searchParams);
    assert.equal(p.client_id, CLIENT_ID);
    assert.equal(p.redirect_uri, `${ENV.APP_URL}/api/auth/google/callback`, "exactly the address registered with Google");
    assert.equal(p.response_type, "code");
    assert.equal(p.scope, "openid email profile");
    assert.equal(p.code_challenge_method, "S256");
    assert.ok(p.state.length >= 30 && p.nonce.length >= 30 && p.code_challenge.length >= 40);
    assert.ok(!target.href.includes("a-secret-that-never-leaves"), "the secret is never sent through the browser");
    const cookie = start.headers["set-cookie"].find((c) => c.startsWith("googleSignIn="));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\/api\/auth/);
    const saved = JSON.parse(Buffer.from(cookie.split(";")[0].split("=")[1], "base64url").toString());
    assert.equal(saved.state, p.state);
    assert.equal(crypto.createHash("sha256").update(saved.verifier).digest("base64url"), p.code_challenge, "the challenge is the hash of the secret the cookie keeps");
    const second = await visit({ skipCallback: true });
    assert.notEqual(second.target.searchParams.get("state"), p.state, "every sign-in has its own state");
  });

  await t.test("a new person gets a Free workspace and is signed in, and the plan they chose is carried back to the app", async () => {
    const r = await visit({ query: "?plan=growth&interval=yearly" });
    assert.equal(r.back.status, 302);
    assert.equal(r.to.origin, ENV.APP_URL);
    assert.deepEqual(r.params, { google: "new", plan: "growth", interval: "annual" });
    assert.match(r.refresh, /HttpOnly/i, "signed in the same way as with a password");
    assert.ok(!r.back.headers.location.includes("token"), "nothing secret is put in the address");
    const [u] = await users("gita@gmail.test");
    assert.equal(u.name, "Gita Rao");
    assert.equal(u.ws, 1);
    const ws = (await query("SELECT t.plan,t.sessions_limit,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1", [u.id])).rows[0];
    assert.deepEqual({ ...ws }, { plan: "Free", sessions_limit: 1, role: "owner" }, "paid plans are paid for, never given");
    // the cookie works: the app can turn it into a session
    freshLimit();
    const me = await request(app).post("/api/auth/refresh").set("Cookie", [r.refresh.split(";")[0]]);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "gita@gmail.test");
    assert.equal(me.body.tenant.plan, "Free");
    // that cookie was single-use state: the sign-in cookie is cleared
    assert.match(r.back.headers["set-cookie"].find((c) => c.startsWith("googleSignIn=")), /googleSignIn=;/);
  });

  await t.test("the same Google person coming back is the same person, not a second workspace", async () => {
    const r = await visit({ query: "?plan=free" });
    assert.deepEqual(r.params, { google: "ok", plan: "free" });
    assert.equal((await users("gita@gmail.test")).length, 1);
    assert.equal((await query("SELECT count(*)::int AS n FROM tenants WHERE name=$1", ["Gita Rao's Workspace"])).rows[0].n, 1);
    // even if they change their address at Google, their Google id still finds them
    const moved = await visit({ over: { email: "gita.new@gmail.test" } });
    assert.equal(moved.params.google, "ok");
    assert.equal((await users("gita.new@gmail.test")).length, 0, "no second person was made");
  });

  await t.test("someone who already has a password account is joined to it by their verified e-mail, and can still use the password", async () => {
    await registerTenantAndUser({ name: "Hari Das", email: "hari@gmail.test", password: "Old-password-12345", companyName: "Hari Co", plan: "Growth" });
    const r = await visit({ over: { sub: "g-2002", email: "Hari@Gmail.test", name: "Hari D" } });
    assert.equal(r.params.google, "ok");
    const found = await users("hari@gmail.test");
    assert.equal(found.length, 1);
    assert.equal((await query("SELECT count(*)::int AS n FROM tenants WHERE name='Hari Co'")).rows[0].n, 1, "no extra workspace");
    assert.equal((await query("SELECT count(*)::int AS n FROM user_identities WHERE user_id=$1", [found[0].id])).rows[0].n, 1);
    freshLimit();
    assert.equal((await request(app).post("/api/auth/login").send({ email: "hari@gmail.test", password: "Old-password-12345" })).status, 200);
    freshLimit();
    const me = await request(app).post("/api/auth/refresh").set("Cookie", [r.refresh.split(";")[0]]);
    assert.equal(me.body.tenant.plan, "Growth", "their own workspace and plan");
  });

  await t.test("a Google person has no password to guess: they can only get in with Google, or by choosing one with 'Forgot password'", async () => {
    freshLimit();
    assert.equal((await request(app).post("/api/auth/login").send({ email: "gita@gmail.test", password: "" })).status >= 400, true);
    freshLimit();
    assert.equal((await request(app).post("/api/auth/login").send({ email: "gita@gmail.test", password: "anything-at-all-123" })).status, 401);
  });

  await t.test("the code is exchanged with the server's own secret and the PKCE secret, never any other way", async () => {
    sent.length = 0;
    await visit({ over: { sub: "g-3003", email: "ivan@gmail.test", name: "Ivan" } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://oauth2.googleapis.com/token");
    assert.equal(sent[0].body.client_secret, "a-secret-that-never-leaves-the-server");
    assert.equal(sent[0].body.grant_type, "authorization_code");
    assert.equal(sent[0].body.redirect_uri, `${ENV.APP_URL}/api/auth/google/callback`);
    assert.ok(sent[0].body.code_verifier.length >= 40);
  });

  await t.test("anything that does not hold up is refused, nobody is created, and the person is told in one plain word", async () => {
    const before = (await query("SELECT count(*)::int AS n FROM users")).rows[0].n;
    const refused = async (label, opts, code) => {
      const r = await visit(opts);
      assert.equal(r.to.origin, ENV.APP_URL, label);
      assert.equal(r.params.google_error, code, `${label}: ${JSON.stringify(r.params)}`);
      assert.equal(r.refresh, undefined, `${label}: nobody was signed in`);
    };
    await refused("an unverified e-mail address", { over: { sub: "g-9001", email: "bad1@gmail.test", email_verified: false } }, "unverified");
    await refused("no e-mail address at all", { over: { sub: "g-9002", email: undefined } }, "unverified");
    await refused("an identity meant for another app", { over: { sub: "g-9003", email: "bad3@gmail.test", aud: "someone-else.apps.googleusercontent.com" } }, "failed");
    await refused("an identity from somewhere that is not Google", { over: { sub: "g-9004", email: "bad4@gmail.test", iss: "https://evil.example" } }, "failed");
    await refused("an expired identity", { over: { sub: "g-9005", email: "bad5@gmail.test", exp: Math.floor(Date.now() / 1000) - 3600 } }, "failed");
    await refused("a replayed identity (wrong nonce)", { over: { sub: "g-9006", email: "bad6@gmail.test", nonce: "not-ours" } }, "failed");
    await refused("a state that is not ours", { state: "forged", over: { sub: "g-9007", email: "bad7@gmail.test" } }, "expired");
    await refused("no sign-in cookie (another browser, or too slow)", { cookie: null, over: { sub: "g-9008", email: "bad8@gmail.test" } }, "expired");
    await refused("no code", { callbackQuery: "state=x", over: { sub: "g-9009", email: "bad9@gmail.test" } }, "expired");
    assert.equal((await query("SELECT count(*)::int AS n FROM users")).rows[0].n, before);
    // Google says no, or the person closes the window
    freshLimit();
    const start = await request(app).get("/api/auth/google/start");
    const jar = start.headers["set-cookie"].find((c) => c.startsWith("googleSignIn=")).split(";")[0];
    freshLimit();
    const denied = await request(app).get("/api/auth/google/callback?error=access_denied").set("Cookie", [jar]);
    assert.match(denied.headers.location, /google_error=cancelled/);
    // Google's own server refuses the code
    reply = () => ({ status: 400, body: { error: "invalid_grant" } });
    const state = new URL(start.headers.location).searchParams.get("state");
    freshLimit();
    const bad = await request(app).get(`/api/auth/google/callback?code=used&state=${state}`).set("Cookie", [jar]);
    assert.match(bad.headers.location, /google_error=failed/);
  });

  await t.test("a disabled account stays out, and so does a person when sign-up is switched off (while existing people still get in)", async () => {
    const [u] = await users("hari@gmail.test");
    await query("UPDATE users SET status='disabled' WHERE id=$1", [u.id]);
    const off = await visit({ over: { sub: "g-2002", email: "hari@gmail.test" } });
    assert.equal(off.params.google_error, "disabled");
    assert.equal(off.refresh, undefined);
    await query("UPDATE users SET status='active' WHERE id=$1", [u.id]);

    ENV.ALLOW_PUBLIC_SIGNUP = false;
    const closed = await visit({ over: { sub: "g-7001", email: "newcomer@gmail.test" } });
    assert.equal(closed.params.google_error, "closed");
    assert.equal((await users("newcomer@gmail.test")).length, 0);
    assert.equal((await visit({ over: { sub: "g-2002", email: "hari@gmail.test" } })).params.google, "ok", "someone who already has an account can still sign in");
    ENV.ALLOW_PUBLIC_SIGNUP = true;
  });

  await t.test("only known words are carried through Google and back", () => {
    assert.deepEqual(cleanIntent({ plan: "Growth", interval: "yearly" }), { plan: "growth", interval: "annual" });
    assert.deepEqual(cleanIntent({ plan: "starter", interval: "monthly" }), { plan: "starter", interval: "monthly" });
    assert.deepEqual(cleanIntent({ plan: "https://evil.example/x?y=z", interval: "<script>" }), { plan: "", interval: "" });
    assert.deepEqual(cleanIntent({ plan: "a".repeat(31) }), { plan: "", interval: "" });
    assert.deepEqual(cleanIntent(), { plan: "", interval: "" });
  });

  await t.test("a different return address can be set for another host, and the secret is not in any answer", async () => {
    process.env.GOOGLE_REDIRECT_URI = "https://staging.example/api/auth/google/callback";
    const { target } = await visit({ skipCallback: true });
    assert.equal(target.searchParams.get("redirect_uri"), "https://staging.example/api/auth/google/callback");
    delete process.env.GOOGLE_REDIRECT_URI;
    freshLimit();
    assert.ok(!JSON.stringify((await request(app).get("/api/auth/providers")).body).includes("secret"));
  });
});
