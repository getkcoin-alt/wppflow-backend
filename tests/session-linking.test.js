import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ENV } from "../src/config/env.js";
import { registerTenantAndUser } from "../src/services/authService.js";
import { defaultWhatsAppProvider as provider, setClientFactory } from "../src/services/whatsapp/WhatsAppProvider.js";
import { startTenantSession, closeTenantSession, closeSessions, removeTenantSession, recoverSessions } from "../src/services/sessionService.js";
import { sessionEvents } from "../src/services/sessionEvents.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000, what = "condition") => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error(`not reached: ${what}`);
};

test("Linking a number: what the server does when WhatsApp's login takes long, never finishes, or is undone", async (t) => {
  void app;
  const saved = { tokenDir: ENV.TOKEN_DIR, confirm: ENV.SESSION_UNLINK_CONFIRM_MS };
  ENV.TOKEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "linking-"));
  // WPPConnect's login, played by the test: the script is given the options the provider passed (its statusFind and catchQR) and either
  // returns a client, as create() does once the number is in, or throws, as it does when it gives up
  let script = async () => {
    throw new Error("no script");
  };
  setClientFactory((options) => script(options));
  const owner = await registerTenantAndUser({ name: "Lina Linker", email: "lina@linking.test", password: "Password@123", companyName: "Linking Co" });
  const tenantId = owner.tenant.id;
  await query("UPDATE tenants SET sessions_limit=20 WHERE id=$1", [tenantId]);
  t.after(async () => {
    setClientFactory(undefined);
    ENV.TOKEN_DIR = saved.tokenDir;
    ENV.SESSION_UNLINK_CONFIRM_MS = saved.confirm;
    await closeSessions(io, { graceMs: 1000 }).catch(() => {});
    io.close();
    fs.rmSync(path.dirname(path.join(ENV.TOKEN_DIR, "x")), { recursive: true, force: true });
  });
  const fakeClient = (over = {}) => ({
    getWid: async () => "971500000009@c.us",
    onStateChange() {},
    onStreamChange() {},
    onAnyMessage() {},
    onAck() {},
    onRevokedMessage() {},
    isConnected: async () => true,
    close: async () => {},
    logout: async () => true,
    ...over,
  });
  const row = async (name) => (await query("SELECT * FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [tenantId, name])).rows[0];
  const history = async (name) => (await sessionEvents(tenantId, name, { limit: 100 })).map((e) => `${e.event}:${e.cause ?? ""}`).reverse();
  const waitDown = (name) => until(async () => { const r = await row(name); return r && r.worker_id === null && ["DISCONNECTED", "EXPIRED"].includes(r.status) ? r : null; }, 4000, `${name} down`);

  await t.test("the library is given far longer than its own three minutes for a number's chats to load", async () => {
    let seen;
    script = async (options) => {
      seen = options;
      return fakeClient();
    };
    await startTenantSession(tenantId, "link-opts", io, owner.user.id, { wait: true });
    await until(async () => (await row("link-opts"))?.status === "CONNECTED", 3000, "connected");
    assert.equal(seen.deviceSyncTimeout, ENV.SESSION_DEVICE_SYNC_TIMEOUT_MS);
    assert.ok(seen.deviceSyncTimeout >= 600_000, `${seen.deviceSyncTimeout} ms`);
    assert.equal(seen.autoClose, ENV.QR_TIMEOUT_MS, "the QR wait is a separate limit");
    await closeTenantSession(tenantId, "link-opts", io, false); // disconnected by a person: not brought back by the recovery loop
  });

  await t.test("a scanned number whose chats do not finish loading is tried again from its saved login, not turned into 'scan the QR code again'", async () => {
    let attempts = 0;
    script = async (options) => {
      attempts++;
      // (the real reports are seconds or minutes apart: each is given time to be saved before the next)
      options.statusFind("notLogged", "x");
      await sleep(40);
      options.catchQR("qr", "", 1, "");
      await sleep(40);
      options.statusFind("qrReadSuccess", "x");
      await sleep(40);
      options.statusFind("phoneNotConnected", "x"); // WPPConnect: the chats did not load in time ...
      await sleep(40);
      options.statusFind("autocloseCalled", "x"); // ... and it closes the page
      await sleep(40);
      throw new Error("Phone not connected");
    };
    await startTenantSession(tenantId, "link-big", io, owner.user.id);
    let r = await waitDown("link-big");
    assert.equal(r.status, "DISCONNECTED", "not EXPIRED: the QR code was scanned");
    assert.equal(r.restore_on_start, true, "the server will try again by itself");
    assert.match(r.last_error, /had not finished loading this number's chats/);
    assert.doesNotMatch(r.last_error, /QR code was not scanned/);
    assert.ok((await history("link-big")).includes("disconnected:device_sync_timeout"));
    await until(() => !provider.hasSession(tenantId, "link-big"), 2000, "the browser the library left behind is released");

    // tried again, from the saved login, a few times; then a person is asked to step in
    const later = Date.now() + 10 * 3600_000;
    for (let i = 1; i <= 3; i++) {
      assert.equal(await recoverSessions(io, { now: later }), 1, `retry ${i}`);
      r = await until(async () => { const x = await row("link-big"); return x.worker_id === null && x.status === "DISCONNECTED" && x.reconnect_attempts === i ? x : null; }, 4000, `retry ${i} over`);
      assert.equal(r.restore_on_start, i < 3, i < 3 ? `still trying after retry ${i}` : "given up after the third retry");
    }
    assert.equal(attempts, 4, "the first start and three retries");
    assert.equal(await recoverSessions(io, { now: later }), 0, "and then left alone");
    assert.match((await row("link-big")).last_error, /press Reconnect/);
  });

  await t.test("a QR code that is never scanned still ends as expired, and is not retried", async () => {
    script = async (options) => {
      options.statusFind("notLogged", "x");
      await sleep(40);
      options.catchQR("qr", "", 1, "");
      await sleep(40);
      options.statusFind("autocloseCalled", "x");
      await sleep(40);
      throw new Error("Auto Close Called");
    };
    await startTenantSession(tenantId, "link-unscanned", io, owner.user.id);
    const r = await waitDown("link-unscanned");
    assert.equal(r.status, "EXPIRED");
    assert.equal(r.restore_on_start, false);
    assert.match(r.last_error, /QR code was not scanned in time/);
    assert.ok((await history("link-unscanned")).includes("expired:qr_not_scanned"));
  });

  await t.test("the phone unlinks the device: the number stops pretending to be connected, is not restored, and its owner is told", async () => {
    let seen;
    let loggedIn = true;
    ENV.SESSION_UNLINK_CONFIRM_MS = 40;
    script = async (options) => {
      seen = options;
      // WPPConnect reports this once at the start of a number that was never linked: it must not count
      options.statusFind("disconnectedMobile", "x");
      return fakeClient({ isAuthenticated: async () => loggedIn });
    };
    await startTenantSession(tenantId, "link-undone", io, owner.user.id);
    await until(async () => (await row("link-undone"))?.status === "CONNECTED", 3000, "connected");
    await sleep(150);
    assert.equal((await row("link-undone")).status, "CONNECTED", "the report at the start changed nothing");
    assert.equal((await row("link-undone")).restore_on_start, true);

    // a report while the page is in fact still logged in is a blip: the number is left alone
    seen.statusFind("disconnectedMobile", "x");
    await sleep(250);
    assert.equal((await row("link-undone")).status, "CONNECTED", "a blip does not give the number up");
    assert.equal((await row("link-undone")).restore_on_start, true);

    // now the device really is unregistered (WhatsApp or the person removed it from Linked devices)
    loggedIn = false;
    seen.statusFind("disconnectedMobile", "x");
    const r = await until(async () => { const x = await row("link-undone"); return x.status === "EXPIRED" ? x : null; }, 3000, "unlinked");
    assert.equal(r.restore_on_start, false, "the recovery loop does not start a number that would only show a QR code");
    assert.equal(r.worker_id, null);
    assert.match(r.last_error, /unlinked this number/);
    assert.ok((await history("link-undone")).includes("unlinked:whatsapp_unpaired"));
    assert.ok(!provider.hasSession(tenantId, "link-undone"), "its browser is closed");
    const alert = await until(async () => (await query("SELECT title,body FROM notifications WHERE tenant_id=$1 AND type='session' AND dedupe_key='link-undone'", [tenantId])).rows[0], 3000, "owner told");
    assert.match(alert.title, /disconnected/);
    assert.match(alert.body, /scan the QR code again/i);
  });

  await t.test("removing a number is on record: who asked, and whether the phone could be unlinked", async () => {
    script = async () => fakeClient();
    await startTenantSession(tenantId, "link-removed", io, owner.user.id);
    await until(async () => (await row("link-removed"))?.status === "CONNECTED", 3000, "connected");
    assert.deepEqual(await removeTenantSession(tenantId, "link-removed", io, { actorId: owner.user.id }), { unlinked: true });
    assert.equal(await row("link-removed"), undefined);
    const [latest] = await sessionEvents(tenantId, "link-removed", { limit: 1 });
    assert.deepEqual([latest.event, latest.cause], ["removed", "removed_by_user"]);
    assert.match(latest.detail, /unlinked from the phone; asked by user \d+/);

    // the phone could not be reached
    script = async () => fakeClient({ logout: async () => { throw new Error("page crashed"); } });
    await startTenantSession(tenantId, "link-removed-2", io, owner.user.id);
    await until(async () => (await row("link-removed-2"))?.status === "CONNECTED", 3000, "connected");
    assert.deepEqual(await removeTenantSession(tenantId, "link-removed-2", io), { unlinked: false });
    const [second] = await sessionEvents(tenantId, "link-removed-2", { limit: 1 });
    assert.match(second.detail, /could not be unlinked from the phone/);
    assert.doesNotMatch(second.detail, /asked by/);
  });
});
