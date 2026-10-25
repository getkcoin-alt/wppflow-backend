import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { restoreSessions, closeSessions } from "../src/services/sessionService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not reached");
};
const row = async (tenantId, name) =>
  (await query("SELECT * FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [tenantId, name])).rows[0];

test("Unpaired sessions never restart themselves; failures keep their reason", async (t) => {
  const original = { ...provider };
  const starts = [];
  let behaviour = () => {};
  provider.startSession = async (tenant, name, cb) => {
    starts.push(name);
    await behaviour(tenant, name, cb);
  };
  provider.getSession = () => ({ phone: paired ? "15550001@c.us" : null });
  provider.closeSession = async () => {};
  let paired = false;
  t.after(async () => {
    Object.assign(provider, original);
    await closeSessions(io);
    io.close();
  });

  const o = await registerTenantAndUser({ name: "Owner", email: "life@test.invalid", password: "Password@123", companyName: "Life Co" });
  const auth = { Authorization: `Bearer ${generateAccessToken(o.user, o.tenant.id, "owner")}` };
  const start = (name) => request(app).post("/api/sessions/start").set(auth).send({ sessionName: name });
  const status = (name) => request(app).get(`/api/sessions/${name}/status`).set(auth);

  await t.test("a QR that is never scanned leaves nothing to auto-restore", async () => {
    behaviour = async (tenant, name, cb) => cb.onStatus("QRCODE");
    assert.equal((await start("line-a")).status, 202);
    await until(async () => (await row(o.tenant.id, "line-a")).status === "QRCODE");
    assert.equal((await row(o.tenant.id, "line-a")).restore_on_start, false);
    const before = starts.length;
    await restoreSessions(io);
    assert.equal(starts.length, before, "no automatic restart without a paired phone");
  });

  await t.test("an expired QR explains itself and is not retried", async () => {
    behaviour = async (tenant, name, cb) => {
      await cb.onStatus("QRCODE");
      await cb.onStatus("EXPIRED");
    };
    await start("line-b");
    await until(async () => (await row(o.tenant.id, "line-b")).status === "EXPIRED");
    const body = (await status("line-b")).body;
    assert.match(body.error, /not scanned in time/);
    const before = starts.length;
    await restoreSessions(io);
    assert.equal(starts.length, before);
  });

  await t.test("a failed start records the cause and is not retried", async () => {
    behaviour = async () => {
      throw new Error("Chromium executable not found");
    };
    await start("line-c");
    await until(async () => (await row(o.tenant.id, "line-c")).status === "FAILED");
    const body = (await status("line-c")).body;
    assert.match(body.error, /Chromium executable not found/);
    assert.equal((await row(o.tenant.id, "line-c")).restore_on_start, false);
    const before = starts.length;
    await restoreSessions(io);
    assert.equal(starts.length, before);
  });

  await t.test("a paired phone is still restored after a restart", async () => {
    paired = true;
    behaviour = async (tenant, name, cb) => cb.onStatus("CONNECTED");
    await start("line-d");
    await until(async () => (await row(o.tenant.id, "line-d")).status === "CONNECTED");
    assert.equal((await row(o.tenant.id, "line-d")).restore_on_start, true);
    assert.equal((await row(o.tenant.id, "line-d")).last_error, null);
    // Simulate the process dying: lease gone, worker gone, flag kept.
    await query("UPDATE whatsapp_sessions SET worker_id=NULL,lease_until=NULL,status='DISCONNECTED' WHERE tenant_id=$1 AND session_name='line-d'", [o.tenant.id]);
    const before = starts.filter((n) => n === "line-d").length;
    await restoreSessions(io);
    await until(() => starts.filter((n) => n === "line-d").length === before + 1);
  });

  await t.test("linking a new number never starts one that is already linked", async () => {
    await query("UPDATE tenants SET sessions_limit=10 WHERE id=$1", [o.tenant.id]);
    paired = true;
    behaviour = async (tenant, name, cb) => cb.onStatus("CONNECTED");
    await start("Primary-WhatsApp");
    await until(async () => (await row(o.tenant.id, "Primary-WhatsApp")).status === "CONNECTED");
    const before = starts.length;
    // the same name (in any capitals) as a NEW number is refused, and nothing is started
    for (const again of ["Primary-WhatsApp", "primary-whatsapp"]) {
      const res = await request(app).post("/api/sessions/start").set(auth).send({ sessionName: again, newNumber: true });
      assert.equal(res.status, 409, again);
      assert.match(res.body.message, /already have a number called "Primary-WhatsApp".*Reconnect/);
    }
    assert.equal(starts.length, before, "no start was attempted");
    // Reconnect is the same call without the flag, and still works
    const reconnect = await request(app).post("/api/sessions/start").set(auth).send({ sessionName: "Primary-WhatsApp" });
    assert.equal(reconnect.status, 202);
    // a different name is a new number
    behaviour = async (tenant, name, cb) => cb.onStatus("QRCODE");
    const fresh = await request(app).post("/api/sessions/start").set(auth).send({ sessionName: "sales-desk", newNumber: true });
    assert.equal(fresh.status, 202);
    await until(async () => (await row(o.tenant.id, "sales-desk")).status === "QRCODE");
  });
});
