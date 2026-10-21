import test from "node:test";
import assert from "node:assert/strict";
import { ENV } from "../src/config/env.js";
import {
  sendOwnerCredentials,
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
    await sendOwnerCredentials({ to: "o@acme.test", name: "O", company: "Acme", password: "pw" }),
    { sent: false, reason: "not_configured" },
  );
  assert.equal(calls.length, 0);

  ENV.RESEND_API_KEY = "re_test_key";
  const ok = await sendOwnerCredentials({ to: "o@acme.test", name: "O<b>", company: "Acme", password: "Temp-Pass-1" });
  assert.equal(ok.sent, true);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.headers.Authorization, "Bearer re_test_key");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, ["o@acme.test"]);
  assert.match(body.text, /Temporary password: Temp-Pass-1/);
  assert.ok(body.html.includes("O&lt;b&gt;") && !body.html.includes("O<b>"), "names are HTML-escaped");

  status = 403;
  const failed = await sendStaffInvite({ to: "s@acme.test", name: "S", company: "Acme", link: "https://x/?invite=1" });
  assert.deepEqual(failed, { sent: false, reason: "delivery_failed" });
});
