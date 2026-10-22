import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ENV } from "../src/config/env.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";

test("Removing a WhatsApp number unlinks it from the phone and deletes the saved login", async (t) => {
  const baseDir = fs.mkdtempSync(path.join(process.cwd(), ".tokens-test-"));
  const previousDir = ENV.TOKEN_DIR;
  ENV.TOKEN_DIR = baseDir;
  t.after(async () => {
    ENV.TOKEN_DIR = previousDir;
    fs.rmSync(baseDir, { recursive: true, force: true });
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Owner", email: "rm@test.invalid", password: "Password@123", companyName: "Rm Co" });
  const tenantId = o.tenant.id;
  const auth = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };

  const addSession = async (name, client) => {
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status,phone) VALUES(gen_random_uuid()::text,$1,$2,$3,'CONNECTED','15550001@c.us')", [tenantId, name, o.user.id]);
    const dir = provider.tokenDir(tenantId, name);
    fs.mkdirSync(path.join(dir, "profile"), { recursive: true });
    fs.writeFileSync(path.join(dir, "profile", "login.data"), "secret");
    if (client) provider.sessions.set(provider.sessionKey(tenantId, name), { tenantId, sessionName: name, status: "CONNECTED", client });
    return dir;
  };
  const exists = async (name) => (await query("SELECT 1 FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [tenantId, name])).rowCount;

  await t.test("a live session is logged out of WhatsApp, closed, wiped from disk and forgotten", async () => {
    const calls = [];
    const dir = await addSession("line-a", { logout: async () => (calls.push("logout"), true), close: async () => calls.push("close") });
    const res = await request(app).delete("/api/sessions/line-a").set(auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.unlinked, true);
    assert.deepEqual(calls, ["logout", "close"], "unlink first, then close the browser");
    assert.equal(fs.existsSync(dir), false, "saved login and browser profile are gone");
    assert.equal(await exists("line-a"), 0);
  });

  await t.test("if WhatsApp refuses or hangs, the number is still removed and the person is told what to do", async () => {
    const dir = await addSession("line-b", { logout: async () => { throw new Error("page crashed"); }, close: async () => {} });
    const res = await request(app).delete("/api/sessions/line-b").set(auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.unlinked, false);
    assert.match(res.body.message, /Linked devices/);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(await exists("line-b"), 0);
  });

  await t.test("a session that is not running is removed too, with the same guidance", async () => {
    const dir = await addSession("line-c", null);
    const res = await request(app).delete("/api/sessions/line-c").set(auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.unlinked, false);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(await exists("line-c"), 0);
  });

  await t.test("the saved-login cleanup can never reach outside the token folder", () => {
    const outside = path.join(baseDir, "..", "keep-me");
    fs.mkdirSync(outside, { recursive: true });
    // a hostile session name must not be able to escape ENV.TOKEN_DIR
    const original = provider.tokenDir;
    provider.tokenDir = () => outside;
    try {
      assert.equal(provider.deleteTokens("t", "../../x"), false);
      assert.ok(fs.existsSync(outside));
    } finally {
      provider.tokenDir = original;
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  await t.test("someone else's session cannot be removed", async () => {
    const dir = await addSession("line-d", null);
    const other = (await query("INSERT INTO users(name,email,password_hash) VALUES('Other','other@rm.invalid','x') RETURNING *")).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, other.id]);
    const otherAuth = { Authorization: `Bearer ${generateAccessToken(other, tenantId, "agent")}` };
    assert.equal((await request(app).delete("/api/sessions/line-d").set(otherAuth)).status, 404);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(await exists("line-d"), 1);
  });
});
