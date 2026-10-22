import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { setMailTransport } from "../src/services/mailer.js";
import { authRateLimiter } from "../src/middleware/rateLimiter.js";
import { closeSessions } from "../src/services/sessionService.js";

const freshLimit = () =>
  ["::ffff:127.0.0.1", "127.0.0.1", "::1"].forEach((ip) => authRateLimiter.resetKey(ip));
const tokenOf = (link) => new URL(link).searchParams.get("invite");

test("Team: rename, categories, invitation mail status", async (t) => {
  const mails = [];
  let failMail = false;
  setMailTransport({
    sendMail: async (m) => {
      if (failMail) throw new Error("domain is not verified");
      mails.push(m);
    },
  });
  t.after(async () => {
    setMailTransport(undefined);
    await closeSessions(io);
    io.close();
  });

  const o = await registerTenantAndUser({ name: "Karnveer", email: "owner@team.test", password: "Password@123", companyName: "Team Co" });
  const tenantId = o.tenant.id;
  const authFor = (u, role) => ({ Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` });
  const owner = authFor(o.user, "owner");
  const list = async (auth = owner) => (await request(app).get("/api/auth/users").set(auth)).body;
  const invite = (body, auth = owner) => request(app).post("/api/auth/users").set(auth).send(body);

  let first;
  await t.test("an invitation records its category and that the email really went out", async () => {
    first = await invite({ name: "Laxman", email: "Laxman@team.test", role: "agent", category: "sales" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.emailStatus, "sent");
    assert.equal(mails.length, 1, "exactly one email per invitation");
    assert.match(mails[0].subject, /invited you to Scriwo/);
    const { invitations } = await list();
    assert.equal(invitations.length, 1);
    assert.equal(invitations[0].email, "laxman@team.test");
    assert.equal(invitations[0].category, "sales");
    assert.equal(invitations[0].mail.status, "sent");
    assert.ok(invitations[0].mail.sentAt);
    assert.equal(invitations[0].expired, false);
  });

  await t.test("unknown categories are refused and inviting again replaces the earlier invitation", async () => {
    const bad = await invite({ name: "X", email: "x@team.test", category: "wizard" });
    assert.equal(bad.status, 400);
    const again = await invite({ name: "Laxman", email: "laxman@team.test", role: "agent", category: "support" });
    assert.equal(again.status, 201);
    const { invitations } = await list();
    assert.equal(invitations.length, 1, "one live invitation per person");
    assert.equal(invitations[0].category, "support");
    const stale = await request(app).post("/api/auth/accept-invite").send({ token: tokenOf(first.body.activationLink), password: "Another-Pass-123" });
    assert.equal(stale.status, 400, "the replaced link no longer works");
    first = again;
  });

  await t.test("a failed email is shown as failed with the reason, and resending recovers it", async () => {
    failMail = true;
    const res = await invite({ name: "Meera", email: "meera@team.test" });
    assert.equal(res.status, 201);
    assert.equal(res.body.emailSent, false);
    assert.equal(res.body.emailStatus, "failed");
    const failed = (await list()).invitations.find((i) => i.email === "meera@team.test");
    assert.equal(failed.mail.status, "failed");
    assert.match(failed.mail.error, /domain is not verified/);

    failMail = false;
    const before = mails.length;
    const resend = await request(app).post(`/api/auth/users/invitations/${failed.id}/resend`).set(owner);
    assert.equal(resend.status, 200, JSON.stringify(resend.body));
    assert.equal(resend.body.emailStatus, "sent");
    assert.equal(mails.length, before + 1);
    const ok = (await list()).invitations.find((i) => i.email === "meera@team.test");
    assert.equal(ok.mail.status, "sent");
    assert.equal(ok.mail.attempts, 2);
    const old = await request(app).post("/api/auth/accept-invite").send({ token: tokenOf(res.body.activationLink), password: "Another-Pass-123" });
    assert.equal(old.status, 400, "the earlier link is retired by the resend");

    assert.equal((await request(app).post("/api/auth/users/invitations/not-an-id/resend").set(owner)).status, 404);
  });

  await t.test("a cancelled invitation disappears and its link stops working", async () => {
    const inv = (await list()).invitations.find((i) => i.email === "meera@team.test");
    assert.equal((await request(app).delete(`/api/auth/users/invitations/${inv.id}`).set(owner)).status, 200);
    assert.ok(!(await list()).invitations.some((i) => i.email === "meera@team.test"));
  });

  let laxman;
  await t.test("accepting an invitation creates the teammate with the chosen category", async () => {
    freshLimit();
    const res = await request(app).post("/api/auth/accept-invite").send({ token: tokenOf(first.body.activationLink), password: "Laxman-Pass-1234" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = await list();
    assert.equal(body.invitations.length, 0, "accepted invitations are no longer pending");
    laxman = body.users.find((u) => u.email === "laxman@team.test");
    assert.equal(laxman.category, "support");
    assert.equal(laxman.membershipRole, "agent");
    const again = await invite({ name: "Laxman", email: "laxman@team.test" });
    assert.equal(again.status, 409, "someone already on the team cannot be invited twice");
  });

  await t.test("the owner can rename a teammate; assignments and the team list follow the new name", async () => {
    await query(
      "INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,phone,contact_name,assigned_to,assigned_user_id,last_active_epoch) VALUES('c-rn',$1,'s','c-rn@c.us','1','Cust','Laxman',$2,1700000000)",
      [tenantId, laxman.id],
    );
    await query(
      "INSERT INTO automations(id,tenant_id,name,trigger_condition,action_type,action_summary) VALUES('a-rn',$1,'Route','price','assign_agent','Laxman')",
      [tenantId],
    );
    const res = await request(app).patch(`/api/auth/users/${laxman.id}`).set(owner).send({ name: "  Laxman Singh  " });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const renamed = (await list()).users.find((u) => u.email === "laxman@team.test");
    assert.equal(renamed.name, "Laxman Singh");
    assert.equal((await query("SELECT assigned_to FROM conversations WHERE id='c-rn'")).rows[0].assigned_to, "Laxman Singh");
    assert.equal((await query("SELECT action_summary FROM automations WHERE id='a-rn'")).rows[0].action_summary, "Laxman Singh");
    const audit = await query("SELECT metadata FROM audit_events WHERE event_type='member.renamed' AND tenant_id=$1", [tenantId]);
    assert.equal(audit.rowCount, 1);
    assert.equal((await request(app).patch(`/api/auth/users/${laxman.id}`).set(owner).send({ name: "   " })).status, 400);
  });

  await t.test("the owner's own name can be fixed, but an administrator cannot rename the owner", async () => {
    const admin = (await query("INSERT INTO users(name,email,password_hash) VALUES('Ada Admin','ada@team.test','x') RETURNING *")).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenantId, admin.id]);
    const adminAuth = authFor(admin, "admin");
    assert.equal((await request(app).patch(`/api/auth/users/${o.user.id}`).set(adminAuth).send({ name: "Hijacked" })).status, 403);
    const own = await request(app).patch(`/api/auth/users/${o.user.id}`).set(owner).send({ name: "Karnveer Singh" });
    assert.equal(own.status, 200);
    const me = (await list()).users.find((u) => u.membershipRole === "owner");
    assert.equal(me.name, "Karnveer Singh");
    assert.equal(me.canRename, true);
    // an administrator may rename an ordinary teammate
    assert.equal((await request(app).patch(`/api/auth/users/${laxman.id}`).set(adminAuth).send({ name: "Laxman S" })).status, 200);
  });

  await t.test("a person in several workspaces keeps control of their own name", async () => {
    const other = await registerTenantAndUser({ name: "Other Boss", email: "boss@other.test", password: "Password@123", companyName: "Other Co" });
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [other.tenant.id, laxman.id]);
    const body = await list();
    assert.equal(body.users.find((u) => u.email === "laxman@team.test").canRename, false);
    const res = await request(app).patch(`/api/auth/users/${laxman.id}`).set(owner).send({ name: "Not Allowed" });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /other workspaces/);
  });

  await t.test("categories can be changed without signing the person out, and never on the owner", async () => {
    const sock = [];
    const original = app.get("io");
    app.set("io", { in: (room) => ({ disconnectSockets: () => sock.push(room) }), to: () => ({ emit() {} }) });
    const res = await request(app).patch(`/api/auth/users/${laxman.id}`).set(owner).send({ category: "billing" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(sock.length, 0, "a label change does not disconnect anyone");
    await request(app).patch(`/api/auth/users/${laxman.id}`).set(owner).send({ status: "suspended" });
    assert.equal(sock.length, 1, "suspending still ends live connections");
    app.set("io", original);
    assert.equal((await list()).users.find((u) => u.email === "laxman@team.test").category, "billing");
    assert.equal((await request(app).patch(`/api/auth/users/${laxman.id}`).set(owner).send({ category: "wizard" })).status, 400);
    assert.equal((await request(app).patch(`/api/auth/users/${o.user.id}`).set(owner).send({ category: "sales" })).status, 403);
    assert.equal((await request(app).patch(`/api/auth/users/${laxman.id}`).set(owner).send({})).status, 400);
  });
});
