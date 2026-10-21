import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ensureSuperAdmin } from "../src/services/adminService.js";
import { ENV } from "../src/config/env.js";
import { setMailTransport } from "../src/services/mailer.js";
import { closeSessions } from "../src/services/sessionService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";

test("Super admin -> company owner -> staff -> private WhatsApp sessions", async (t) => {
  const mails = [];
  setMailTransport({ sendMail: async (m) => mails.push(m) });
  const started = [];
  const original = {
    startSession: provider.startSession,
    getSession: provider.getSession,
    closeSession: provider.closeSession,
  };
  provider.startSession = async (tenant, name) => {
    started.push(`${tenant}:${name}`);
  };
  provider.getSession = () => null;
  provider.closeSession = async () => {};
  t.after(async () => {
    Object.assign(provider, original);
    setMailTransport(undefined);
    await closeSessions(io);
    io.close();
  });

  ENV.SUPERADMIN_EMAIL = "root@platform.test";
  ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
  await ensureSuperAdmin();
  const login = (email, password) =>
    request(app).post("/api/auth/login").send({ email, password });
  const sa = await login("root@platform.test", "SuperAdmin#12345");
  assert.equal(sa.status, 200);
  assert.equal(sa.body.user.role, "superadmin");
  const saAuth = { Authorization: `Bearer ${sa.body.token}` };

  let company, ownerPassword;
  await t.test("only a super admin can add a company", async () => {
    const anon = await request(app).post("/api/admin/companies").send({});
    assert.equal(anon.status, 401);
    const res = await request(app)
      .post("/api/admin/companies")
      .set(saAuth)
      .send({
        companyName: "Acme Retail",
        ownerName: "Olivia Owner",
        ownerEmail: "Olivia@Acme.test",
        sessionsLimit: 4,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.emailSent, true);
    assert.ok(!JSON.stringify(res.body).includes("password"));
    company = res.body.company;
    assert.equal(company.sessionsLimit, 4);
    const mail = mails.at(-1);
    assert.equal(mail.to, "olivia@acme.test");
    ownerPassword = /Temporary password: (\S+)/.exec(mail.text)[1];
    assert.ok(ownerPassword.length >= 12);
  });

  let owner, ownerAuth;
  await t.test("owner logs in with emailed password and must change it", async () => {
    const res = await login("olivia@acme.test", ownerPassword);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.mustChangePassword, true);
    assert.equal(res.body.user.membershipRole, "owner");
    const changed = await request(app)
      .post("/api/auth/change-password")
      .set({ Authorization: `Bearer ${res.body.token}` })
      .send({ currentPassword: ownerPassword, newPassword: "Brand-new-pass-1" });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.user.mustChangePassword, false);
    owner = changed.body;
    ownerAuth = { Authorization: `Bearer ${owner.token}` };
    assert.equal((await login("olivia@acme.test", ownerPassword)).status, 401);
  });

  const staff = {};
  await t.test("owner invites staff by email and they activate", async () => {
    for (const [key, name, email] of [
      ["sam", "Sam Staff", "sam@acme.test"],
      ["tina", "Tina Staff", "tina@acme.test"],
    ]) {
      const inv = await request(app)
        .post("/api/auth/users")
        .set(ownerAuth)
        .send({ name, email, role: "agent" });
      assert.equal(inv.status, 201);
      assert.equal(inv.body.emailSent, true);
      const link = /invite=([a-f0-9]+)/.exec(mails.at(-1).text)[1];
      assert.equal(mails.at(-1).to, email);
      const accepted = await request(app)
        .post("/api/auth/accept-invite")
        .send({ token: link, password: "Staff-password-1" });
      assert.equal(accepted.status, 200);
      const s = await login(email, "Staff-password-1");
      assert.equal(s.status, 200);
      assert.equal(s.body.user.membershipRole, "agent");
      staff[key] = { id: s.body.user.id, auth: { Authorization: `Bearer ${s.body.token}` } };
    }
  });

  await t.test("each staff member starts their own session; others cannot touch it", async () => {
    for (const s of Object.values(staff)) {
      const res = await request(app).post("/api/sessions/start").set(s.auth).send({ sessionName: "hijack" });
      assert.equal(res.status, 202);
      assert.equal(res.body.sessionName, `staff-${s.id}`);
    }
    assert.equal(started.length, 2);
    const tinaName = `staff-${staff.tina.id}`;
    for (const path of [`/${tinaName}/status`, `/${tinaName}/qr`]) {
      const res = await request(app).get(`/api/sessions${path}`).set(staff.sam.auth);
      assert.equal(res.status, 404, path);
    }
    const close = await request(app).post(`/api/sessions/${tinaName}/close`).set(staff.sam.auth).send({});
    assert.equal(close.status, 404);
    const del = await request(app).delete(`/api/sessions/${tinaName}`).set(staff.sam.auth);
    assert.equal(del.status, 404);
  });

  await t.test("staff list shows only their own; owner sees all with owners", async () => {
    const mine = await request(app).get("/api/sessions").set(staff.sam.auth);
    assert.equal(mine.body.scope, "own");
    assert.deepEqual(mine.body.sessions.map((s) => s.sessionName), [`staff-${staff.sam.id}`]);
    const all = await request(app).get("/api/sessions").set(ownerAuth);
    assert.equal(all.body.scope, "workspace");
    assert.equal(all.body.sessions.length, 2);
    assert.deepEqual(all.body.sessions.map((s) => s.ownerName).sort(), ["Sam Staff", "Tina Staff"]);
  });

  await t.test("staff only see conversations of their own session", async () => {
    for (const [key, who] of [["sam", "Sam"], ["tina", "Tina"]]) {
      await query(
        `INSERT INTO conversations(id,tenant_id,session_name,phone,provider_chat_id,contact_name,last_active_epoch) VALUES($1,$2,$3,$4,$5,$6,1700000000)`,
        [`conv_${key}`, company.id, `staff-${staff[key].id}`, `9190000000${key.length}`, `9190000000${key.length}@c.us`, `${who} client`],
      );
    }
    const sam = await request(app).get("/api/conversations").set(staff.sam.auth);
    assert.deepEqual(sam.body.conversations.map((c) => c.id), ["conv_sam"]);
    const owned = await request(app).get("/api/conversations").set(ownerAuth);
    assert.equal(owned.body.conversations.length, 2);
    for (const call of [
      request(app).get("/api/conversations/conv_tina/messages").set(staff.sam.auth),
      request(app).post("/api/conversations/conv_tina/read").set(staff.sam.auth).send({}),
      request(app).post("/api/conversations/conv_tina/messages").set(staff.sam.auth).send({ text: "hi" }),
      request(app).patch("/api/conversations/conv_tina").set(staff.sam.auth).send({ isClosed: true }),
    ])
      assert.equal((await call).status, 404);
  });

  await t.test("owner can read any staff session QR; quota is enforced", async () => {
    const qr = await request(app).get(`/api/sessions/staff-${staff.tina.id}/qr`).set(ownerAuth);
    assert.equal(qr.status, 200);
    await query("UPDATE tenants SET sessions_limit=2 WHERE id=$1", [company.id]);
    const blocked = await request(app).post("/api/sessions/start").set(ownerAuth).send({ sessionName: "front-desk" });
    assert.equal(blocked.status, 403);
    await query("UPDATE tenants SET sessions_limit=3 WHERE id=$1", [company.id]);
    const extra = await request(app).post("/api/sessions/start").set(ownerAuth).send({ sessionName: "front-desk" });
    assert.equal(extra.status, 202);
    await new Promise((r) => setTimeout(r, 100));
  });

  await t.test("owner can reassign a session to another staff member", async () => {
    const name = `staff-${staff.sam.id}`;
    assert.equal((await request(app).patch(`/api/sessions/${name}/owner`).set(staff.sam.auth).send({ userId: staff.tina.id })).status, 403);
    const res = await request(app).patch(`/api/sessions/${name}/owner`).set(ownerAuth).send({ userId: staff.tina.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.ownerName, "Tina Staff");
    assert.equal((await request(app).get(`/api/sessions/${name}/status`).set(staff.sam.auth)).status, 404);
    await request(app).patch(`/api/sessions/${name}/owner`).set(ownerAuth).send({ userId: staff.sam.id });
  });

  await t.test("staff cannot reach admin or manager-only APIs", async () => {
    assert.equal((await request(app).get("/api/admin/companies").set(ownerAuth)).status, 403);
    assert.equal((await request(app).post("/api/auth/users").set(staff.sam.auth).send({ name: "x", email: "x@y.test" })).status, 403);
    assert.equal((await request(app).get("/api/campaigns").set(staff.sam.auth)).status, 403);
    for (const path of ["/api/workspace/keys", "/api/workspace/webhooks", "/api/workspace/audit"])
      assert.equal((await request(app).get(path).set(staff.sam.auth)).status, 403, path);
    assert.equal((await request(app).get("/api/workspace/keys").set(ownerAuth)).status, 200);
    assert.equal((await request(app).get("/api/workspace/capabilities").set(staff.sam.auth)).status, 200);
  });

  await t.test("suspending a company blocks its users; resend only before activation", async () => {
    const resend = await request(app).post(`/api/admin/companies/${company.id}/resend-credentials`).set(saAuth).send({});
    assert.equal(resend.status, 409);
    const sus = await request(app).patch(`/api/admin/companies/${company.id}`).set(saAuth).send({ status: "suspended" });
    assert.equal(sus.status, 200);
    assert.equal((await request(app).get("/api/sessions").set(staff.sam.auth)).status, 403);
    assert.equal((await login("sam@acme.test", "Staff-password-1")).status, 403);
    await request(app).patch(`/api/admin/companies/${company.id}`).set(saAuth).send({ status: "active" });
    assert.equal((await request(app).get("/api/sessions").set(staff.sam.auth)).status, 200);
  });

  await t.test("creation is refused (nothing created) when email is not configured", async () => {
    setMailTransport(undefined);
    const savedKey = ENV.RESEND_API_KEY;
    ENV.RESEND_API_KEY = "";
    try {
      const res = await request(app).post("/api/admin/companies").set(saAuth).send({ companyName: "NoMail Ltd", ownerName: "N", ownerEmail: "n@nomail.test" });
      assert.equal(res.status, 503);
      const { rowCount } = await query("SELECT 1 FROM tenants WHERE name='NoMail Ltd'");
      assert.equal(rowCount, 0);
    } finally {
      ENV.RESEND_API_KEY = savedKey;
    }
  });
});
