import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ENV } from "../src/config/env.js";
import { registerTenantAndUser } from "../src/services/authService.js";
import { setClientFactory } from "../src/services/whatsapp/WhatsAppProvider.js";
import { startTenantSession, closeTenantSession, closeSessions, recoverSessions, resetGivenUpNumbers } from "../src/services/sessionService.js";
import { sessionEvents } from "../src/services/sessionEvents.js";
import { judge } from "../src/services/numberHealth.js";

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

// Every try to bring a number back launches a whole browser. A number that cannot start (a damaged profile, a starved machine) used to be
// tried again every ten minutes for ever; now it is tried a limited number of times, then left alone and the people who look after it are told.
test("A number that keeps failing to start is tried a limited number of times, then left alone until the server restarts or a person presses Reconnect", async (t) => {
  void app;
  const saved = { tokenDir: ENV.TOKEN_DIR, max: ENV.SESSION_MAX_AUTO_ATTEMPTS };
  ENV.TOKEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "retrycap-"));
  ENV.SESSION_MAX_AUTO_ATTEMPTS = 3;
  let launches = 0;
  let works = true;
  // WPPConnect's login, played by the test: it either returns a client (the number connects) or fails the way a browser that cannot launch does
  setClientFactory(async () => {
    launches++;
    if (!works) throw new Error("Failed to launch the browser process");
    return {
      getWid: async () => "971500000009@c.us",
      onStateChange() {},
      onStreamChange() {},
      onAnyMessage() {},
      onAck() {},
      onRevokedMessage() {},
      isConnected: async () => true,
      close: async () => {},
      logout: async () => true,
    };
  });
  const owner = await registerTenantAndUser({ name: "Rita Retry", email: "rita@retrycap.test", password: "Password@123", companyName: "RetryCap Co" });
  const tenantId = owner.tenant.id;
  await query("UPDATE tenants SET sessions_limit=20 WHERE id=$1", [tenantId]);
  t.after(async () => {
    setClientFactory(undefined);
    ENV.TOKEN_DIR = saved.tokenDir;
    ENV.SESSION_MAX_AUTO_ATTEMPTS = saved.max;
    await closeSessions(io, { graceMs: 1000 }).catch(() => {});
    io.close();
    fs.rmSync(ENV.TOKEN_DIR === saved.tokenDir ? path.join(os.tmpdir(), "retrycap-none") : ENV.TOKEN_DIR, { recursive: true, force: true });
  });
  const row = async (name) => (await query("SELECT * FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [tenantId, name])).rows[0];
  const events = async (name) => (await sessionEvents(tenantId, name, { limit: 200 })).map((e) => `${e.event}:${e.cause ?? ""}`);
  const gaveUpEvents = async (name) => (await events(name)).filter((e) => e === "gave_up:too_many_failures").length;
  const alerts = async (name) => (await query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND type='session' AND dedupe_key=$2", [tenantId, `${name}:gave_up`])).rows[0].n;
  // one pass of the recovery loop, a day later than the last (so that the waiting time between tries never gets in the way)
  let pass = 0;
  const recover = () => recoverSessions(io, { now: Date.now() + ++pass * 24 * 3600_000 });
  // a number that was linked before and is meant to run: connected once, then closed in a way that keeps it restorable
  const linked = async (name) => {
    works = true;
    await startTenantSession(tenantId, name, io, owner.user.id, { wait: true });
    await until(async () => (await row(name))?.status === "CONNECTED", 3000, `${name} connected`);
    await closeTenantSession(tenantId, name, io, true);
    works = false;
  };

  await t.test("it is tried the set number of times, then given up on once: on the number, in its history, and to its owner", async () => {
    await linked("cap-1");
    const before = launches;
    for (let i = 1; i <= 3; i++) {
      assert.equal(await recover(), 1, `try ${i} launches the browser`);
      const r = await row("cap-1");
      assert.equal(r.reconnect_attempts, i);
      assert.equal(r.restore_on_start, true, "still meant to run");
      assert.equal(r.status, "FAILED");
    }
    assert.equal(launches - before, 3);

    assert.equal(await recover(), 0, "the fourth pass launches nothing");
    assert.equal(launches - before, 3, "no browser was started");
    const r = await row("cap-1");
    assert.match(r.last_error, /tried to bring this number back 3 times in a row and could not, so it stopped trying/);
    assert.match(r.last_error, /press Reconnect/);
    assert.equal(await gaveUpEvents("cap-1"), 1);
    assert.equal(await alerts("cap-1"), 1, "the owner was told");
    const note = (await query("SELECT title,body FROM notifications WHERE tenant_id=$1 AND dedupe_key='cap-1:gave_up'", [tenantId])).rows[0];
    assert.match(note.title, /could not be brought back/);
    assert.match(note.body, /press Reconnect/i);

    // said once, however many passes follow
    await recover();
    await recover();
    assert.equal(await gaveUpEvents("cap-1"), 1);
    assert.equal(await alerts("cap-1"), 1);
    assert.equal(launches - before, 3);
  });

  await t.test("a person pressing Reconnect is never held back by the limit, and a later outage is said again", async () => {
    works = true;
    await startTenantSession(tenantId, "cap-1", io, owner.user.id, { wait: true });
    await until(async () => (await row("cap-1"))?.status === "CONNECTED", 3000, "reconnected by hand");
    const r = await row("cap-1");
    assert.equal(r.reconnect_attempts, 0, "a connection starts the count again");
    assert.equal(r.last_error, null);

    // it fails again later: three more tries, then it is given up on a second time (the first alert is old news by then)
    await query("UPDATE notifications SET created_at=now()-interval '2 hours' WHERE tenant_id=$1 AND dedupe_key='cap-1:gave_up'", [tenantId]);
    await closeTenantSession(tenantId, "cap-1", io, true);
    works = false;
    for (let i = 1; i <= 3; i++) assert.equal(await recover(), 1);
    assert.equal(await recover(), 0);
    assert.equal(await gaveUpEvents("cap-1"), 2, "a new outage is said again");
    assert.equal(await alerts("cap-1"), 2);
  });

  await t.test("a server that has just started tries a number it had given up on once more, and only once", async () => {
    // (the first number is out of this: only the one that is linked now is meant to run)
    await query("UPDATE whatsapp_sessions SET restore_on_start=false WHERE tenant_id=$1 AND session_name='cap-1'", [tenantId]);
    await linked("cap-2");
    for (let i = 1; i <= 3; i++) assert.equal(await recover(), 1);
    assert.equal(await recover(), 0, "given up on");
    assert.equal(await gaveUpEvents("cap-2"), 1);

    // what the server does as it starts (restoreSessions)
    assert.equal(await resetGivenUpNumbers(), 1);
    assert.equal((await row("cap-2")).reconnect_attempts, 2, "one try left");
    const before = launches;
    assert.equal(await recover(), 1, "one more try after the restart");
    assert.equal(launches - before, 1);
    assert.equal(await recover(), 0, "and then given up on again");
    assert.equal(launches - before, 1);
    assert.equal(await gaveUpEvents("cap-2"), 2);
  });

  await t.test("the Numbers screen says that the server has stopped trying, and what to do", () => {
    const now = Date.now();
    const base = { label: "Sam's number", phone: "9715", status: "DISCONNECTED", heartbeatFailures: 0, heartbeatError: null, downSince: new Date(now - 3 * 3600_000).toISOString(), sends: { failedLastHour: 0, totalLastHour: 0 }, queued: { count: 0, oldestSeconds: null } };
    const trying = judge({ ...base, reconnectAttempts: 2 }, now).problems[0].text;
    assert.match(trying, /tried to bring it back 2 times\.$/);
    assert.doesNotMatch(trying, /stopped trying/);
    const stopped = judge({ ...base, reconnectAttempts: 3 }, now).problems[0].text;
    assert.match(stopped, /tried to bring it back 3 times and has stopped trying\. Press Reconnect\.$/);
  });
});
