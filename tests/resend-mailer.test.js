import test from "node:test";
import assert from "node:assert/strict";
import { ENV } from "../src/config/env.js";
import {
  sendOwnerSetup,
  sendStaffInvite,
  mailEnabled,
  setMailTransport,
} from "../src/services/mailer.js";

test("Mail is delivered through the Resend HTTP API", async (t) => {
  setMailTransport(undefined);
  const original = globalThis.fetch;
  const calls = [];
  let status = 200;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(status === 200 ? '{"id":"1"}' : "domain not verified", { status });
  };
  t.after(() => {
    globalThis.fetch = original;
    ENV.RESEND_API_KEY = "";
  });
  ENV.RESEND_API_KEY = "";
  assert.equal(mailEnabled(), false);
  assert.deepEqual(
    await sendOwnerSetup({ to: "o@acme.test", name: "O", company: "Acme", link: "https://app/?invite=abc" }),
    { sent: false, reason: "not_configured" },
  );
  assert.equal(calls.length, 0);

  ENV.RESEND_API_KEY = "re_test_key";
  const ok = await sendOwnerSetup({ to: "o@acme.test", name: "O<b>", company: "Acme", link: "https://app/?invite=tok123" });
  assert.equal(ok.sent, true);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.headers.Authorization, "Bearer re_test_key");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, ["o@acme.test"]);
  assert.match(body.text, /https:\/\/app\/\?invite=tok123/);
  assert.ok(!/password:/i.test(body.text), "no password is ever emailed");
  assert.match(body.html, /href="https:\/\/app\/\?invite=tok123"/);
  assert.ok(body.html.includes("O&lt;b&gt;") && !body.html.includes("O<b>"), "names are HTML-escaped");
  assert.match(body.subject, /Scriwo/);
  assert.match(body.html, /SCRIWO/);
  assert.ok(!/WppFlow/i.test(body.subject + body.text + body.html), "emails carry the Scriwo name only");
  assert.match(ENV.MAIL_FROM, /Scriwo <noreply@scriwo\.com>|@scriwo\.com/);

  status = 403;
  const failed = await sendStaffInvite({ to: "s@acme.test", name: "S", company: "Acme", link: "https://x/?invite=1" });
  assert.equal(failed.sent, false);
  assert.equal(failed.reason, "delivery_failed");
  assert.match(failed.detail, /Resend 403: domain not verified/);
});

test("the production domains are always allowed origins and links point at the app domain", async () => {
  assert.ok(ENV.ALLOWED_ORIGINS.includes("https://scriwo.com"));
  assert.ok(ENV.ALLOWED_ORIGINS.includes("https://www.scriwo.com"));
  assert.ok(!ENV.APP_URL.endsWith("/"), "no double slash in invite links");
});
