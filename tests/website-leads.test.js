import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ENV } from "../src/config/env.js";
import { setMailTransport } from "../src/services/mailer.js";
import { ensureSuperAdmin } from "../src/services/adminService.js";
import { contactFormLimiter } from "../src/middleware/rateLimiter.js";
import { closeSessions } from "../src/services/sessionService.js";

test("Website contact form: enquiries are saved, the team is told, and admins can follow up", async (t) => {
  const mails = [];
  setMailTransport({ sendMail: async (m) => mails.push(m) });
  t.after(async () => {
    setMailTransport(undefined);
    await closeSessions(io);
    io.close();
  });
  ENV.LEADS_EMAIL = "sales@scriwo.test";
  const visitor = (ip) => (req) => req.set("X-Forwarded-For", ip);
  const send = (body, ip = "203.0.113.10") =>
    request(app).post("/api/public/contact").use(visitor(ip)).send(body);

  await t.test("a complete enquiry is stored and mailed only to the team", async () => {
    const res = await send({
      name: "Aisha Khan",
      email: "Aisha@Example.ae",
      phone: "+971 50 123 4567",
      company: "Marina Homes",
      country: "UAE",
      teamSize: "11-25",
      interest: "growth",
      plan: "Growth",
      message: "We have 14 agents on WhatsApp.\nNeed a demo.",
      sourcePage: "/pricing",
    });
    assert.equal(res.status, 201);
    const { rows } = await query("SELECT * FROM website_leads WHERE id=$1", [res.body.id]);
    assert.equal(rows[0].email, "aisha@example.ae");
    assert.equal(rows[0].interest, "growth");
    assert.equal(rows[0].email_status, "sent");
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, "sales@scriwo.test");
    assert.match(mails[0].subject, /Marina Homes/);
    assert.match(mails[0].text, /14 agents/);
  });

  await t.test("missing or invalid details are explained", async () => {
    assert.match((await send({ email: "a@b.co" }, "203.0.113.11")).body.message, /name is required/i);
    assert.match((await send({ name: "A", email: "nope" }, "203.0.113.11")).body.message, /valid email/);
    assert.match(
      (await send({ name: "A", email: "a@b.co", phone: "call me" }, "203.0.113.11")).body.message,
      /valid phone/,
    );
  });

  await t.test("an unknown interest is filed as general, and markup is escaped in the email", async () => {
    mails.length = 0;
    const res = await send({ name: "<b>x</b>", email: "x@y.in", interest: "hack" }, "203.0.113.12");
    assert.equal(res.status, 201);
    const { rows } = await query("SELECT interest FROM website_leads WHERE id=$1", [res.body.id]);
    assert.equal(rows[0].interest, "general");
    assert.ok(!mails[0].html.includes("<b>x</b>"));
  });

  await t.test("bots that fill the hidden field are answered but nothing is saved", async () => {
    const before = (await query("SELECT count(*)::int AS n FROM website_leads")).rows[0].n;
    const res = await send({ name: "Bot", email: "bot@spam.io", website: "http://spam" }, "203.0.113.13");
    assert.equal(res.status, 201);
    assert.equal((await query("SELECT count(*)::int AS n FROM website_leads")).rows[0].n, before);
  });

  await t.test("the form works from any website address, such as a preview deploy", async () => {
    const res = await request(app)
      .post("/api/public/contact")
      .set("Origin", "https://scriwo-website-git-preview.vercel.app")
      .set("X-Forwarded-For", "203.0.113.16")
      .send({ name: "Preview", email: "p@p.ae" });
    assert.equal(res.status, 201);
  });

  await t.test("one visitor cannot flood the form", async () => {
    contactFormLimiter.resetKey("203.0.113.14");
    for (let i = 0; i < 5; i++)
      assert.equal((await send({ name: "R", email: "r@r.in" }, "203.0.113.14")).status, 201);
    const blocked = await send({ name: "R", email: "r@r.in" }, "203.0.113.14");
    assert.equal(blocked.status, 429);
    assert.equal((await send({ name: "S", email: "s@s.in" }, "203.0.113.15")).status, 201);
  });

  await t.test("only the platform admin can list and update enquiries", async () => {
    assert.equal((await request(app).get("/api/admin/leads")).status, 401);
    ENV.SUPERADMIN_EMAIL = "root@platform.test";
    ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
    await ensureSuperAdmin();
    const sa = await request(app)
      .post("/api/auth/login")
      .send({ email: "root@platform.test", password: "SuperAdmin#12345" });
    const auth = { Authorization: `Bearer ${sa.body.token}` };
    const list = await request(app).get("/api/admin/leads").set(auth);
    assert.equal(list.status, 200);
    const lead = list.body.leads.find((l) => l.company === "Marina Homes");
    assert.equal(lead.status, "new");
    assert.equal(lead.teamSize, "11-25");
    const done = await request(app).patch(`/api/admin/leads/${lead.id}`).set(auth).send({ status: "contacted" });
    assert.equal(done.status, 200);
    assert.equal((await request(app).patch(`/api/admin/leads/${lead.id}`).set(auth).send({ status: "x" })).status, 400);
    assert.equal((await request(app).patch("/api/admin/leads/nope").set(auth).send({ status: "won" })).status, 404);
  });
});
