import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { app, io } from "../src/server.js";
import { query, getPool } from "../src/db/index.js";
import { ENV } from "../src/config/env.js";
import { registerTenantAndUser } from "../src/services/authService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import {
  startTenantSession,
  closeTenantSession,
  closeSessions,
  recoverSessions,
  restoreSessions,
  restartTenantSession,
  retryDelayMs,
} from "../src/services/sessionService.js";
import { pingSessions } from "../src/services/numberHealth.js";
import { sessionEvents, pruneSessionEvents, recordSessionEvent } from "../src/services/sessionEvents.js";
import { installProcessGuards, isBrowserNoise } from "../src/services/processGuard.js";

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

test("Keeping linked numbers connected: what the server does by itself", async (t) => {
  void app;
  const saved = { ...ENV };
  const realProvider = { startSession: provider.startSession, closeSession: provider.closeSession, useHere: provider.useHere };
  const owner = await registerTenantAndUser({ name: "Sana Stable", email: "sana@stable.test", password: "Password@123", companyName: "Stable Co" });
  const tenantId = owner.tenant.id;
  await query("UPDATE tenants SET sessions_limit=50 WHERE id=$1", [tenantId]);

  // WhatsApp, played by the test: numbers connect after a delay, close after a delay (or never), and report what the test tells them to
  const fake = { starts: [], closes: [], useHere: [], active: 0, maxActive: 0, startMs: {}, closeMs: {}, callbacks: {}, clients: {} };
  provider.startSession = async (tenant, name, cb) => {
    fake.starts.push(name);
    fake.callbacks[name] = cb;
    // "active" is the browser launching, the part that costs memory and processor; it ends when the browser is up (what follows is
    // bookkeeping)
    fake.active++;
    fake.maxActive = Math.max(fake.maxActive, fake.active);
    try {
      await sleep(fake.startMs[name] ?? 0);
    } finally {
      fake.active--;
    }
    const client = { isConnected: async () => true, onStateChange() {}, onStreamChange() {} };
    fake.clients[name] = client;
    provider.sessions.set(provider.sessionKey(tenant, name), { tenantId: tenant, sessionName: name, status: "CONNECTED", phone: "971500000001@c.us", client });
    await cb.onStatus("CONNECTED");
  };
  provider.closeSession = async (tenant, name) => {
    fake.closes.push(name);
    await sleep(fake.closeMs[name] ?? 0);
    provider.sessions.delete(provider.sessionKey(tenant, name));
  };
  provider.useHere = async (tenant, name) => {
    fake.useHere.push(name);
    return true;
  };
  t.after(async () => {
    Object.assign(ENV, saved);
    Object.assign(provider, realProvider);
    await closeSessions(io, { graceMs: 1000 }).catch(() => {});
    io.close();
  });
  const row = async (name) => (await query("SELECT * FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [tenantId, name])).rows[0];
  const addNumber = (name, over = {}) =>
    query(
      "INSERT INTO whatsapp_sessions(id,tenant_id,session_name,status,phone,restore_on_start,reconnect_attempts,last_reconnect_at,owner_user_id) VALUES(gen_random_uuid()::text,$1,$2,'DISCONNECTED','971500000001',$3,$4,$5,$6)",
      [tenantId, name, over.restore ?? true, over.attempts ?? 0, over.lastAt ?? null, owner.user.id],
    );
  const causes = async (name) => (await sessionEvents(tenantId, name, { limit: 100 })).map((e) => `${e.event}:${e.cause ?? ""}`).reverse();
  const stopAll = async (...names) => {
    for (const n of names) await closeTenantSession(tenantId, n, io, false).catch(() => {});
  };

  await t.test("how long a number that keeps failing is left alone: nothing, then 30 s, doubling, never more than 10 minutes", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 30].map((n) => retryDelayMs(n, { base: 30000, max: 600000 })), [0, 30000, 60000, 120000, 240000, 480000, 600000, 600000]);
    assert.equal(retryDelayMs(undefined), 0);
    assert.equal(retryDelayMs(-3), 0);
  });

  await t.test("a failed renewal of the claim does not close a healthy number; only a long outage lets it go", async () => {
    ENV.SESSION_LEASE_TICK_MS = 40;
    ENV.SESSION_LEASE_GRACE_MS = 700;
    await startTenantSession(tenantId, "claim-1", io, owner.user.id);
    await until(async () => (await row("claim-1"))?.status === "CONNECTED", 3000, "claim-1 connected");
    // the database is busy: every renewal fails, as when all 20 connections are in use for more than 5 seconds
    const pool = getPool();
    const original = pool.query.bind(pool);
    let broken = true;
    pool.query = (sql, ...rest) =>
      broken && /SET lease_until=now\(\)\+interval '45 seconds' WHERE/.test(String(sql?.text ?? sql))
        ? Promise.reject(new Error("timeout exceeded when trying to connect"))
        : original(sql, ...rest);
    try {
      await sleep(350); // many failed renewals, still inside the grace period
      assert.deepEqual(fake.closes.filter((n) => n === "claim-1"), [], "the healthy browser was not closed");
      assert.equal((await row("claim-1")).status, "CONNECTED");
      // the database comes back: the claim is renewed again
      broken = false;
      await query("UPDATE whatsapp_sessions SET lease_until=now()-interval '1 minute' WHERE tenant_id=$1 AND session_name='claim-1'", [tenantId]);
      await until(async () => new Date((await row("claim-1")).lease_until) > new Date(), 2000, "claim renewed after the outage");
      assert.deepEqual(fake.closes.filter((n) => n === "claim-1"), []);
      // an outage longer than the grace period does let it go (another worker may be starting it by then)
      broken = true;
      await until(() => fake.closes.includes("claim-1"), 3000, "released after a long outage");
      assert.ok((await causes("claim-1")).includes("claim_error:database"));
      assert.ok((await causes("claim-1")).includes("claim_released:database_unavailable"));
    } finally {
      broken = false;
      pool.query = original;
    }
    await stopAll("claim-1");
    ENV.SESSION_LEASE_TICK_MS = saved.SESSION_LEASE_TICK_MS;
    ENV.SESSION_LEASE_GRACE_MS = saved.SESSION_LEASE_GRACE_MS;
  });

  await t.test("numbers are brought back a few browsers at a time, and the server does not wait for them", async () => {
    ENV.SESSION_START_CONCURRENCY = 2;
    const names = ["rec-1", "rec-2", "rec-3", "rec-4", "rec-5"];
    for (const n of names) {
      await addNumber(n);
      fake.startMs[n] = 120;
    }
    fake.maxActive = 0;
    fake.starts.length = 0;
    const began = Date.now();
    assert.equal(await recoverSessions(io), 5);
    assert.deepEqual([...fake.starts].sort(), names);
    assert.equal(fake.maxActive, 2, "never more than two browsers launching at once");
    assert.ok(Date.now() - began >= 3 * 120 - 40, "the launches really were spread out (5 numbers, 2 at a time)");
    for (const n of names) assert.equal((await row(n)).status, "CONNECTED");
    assert.ok((await causes("rec-1")).includes("restore:server_start_or_drop"));
    await stopAll(...names);
  });

  await t.test("restoring after a start does not hold up the server", async () => {
    ENV.SESSION_START_CONCURRENCY = 1;
    for (const n of ["slow-1", "slow-2"]) {
      await addNumber(n);
      fake.startMs[n] = 250;
    }
    const began = Date.now();
    await restoreSessions(io);
    assert.ok(Date.now() - began < 100, `restoreSessions returned after ${Date.now() - began} ms`);
    await until(async () => (await row("slow-2"))?.status === "CONNECTED", 4000, "both restored in the background");
    await stopAll("slow-1", "slow-2");
    ENV.SESSION_START_CONCURRENCY = saved.SESSION_START_CONCURRENCY;
  });

  await t.test("a number that keeps failing is retried less and less often, one that connected is restored at once", async () => {
    const now = Date.now();
    await addNumber("retry-new", { attempts: 0 });
    await addNumber("retry-early", { attempts: 3, lastAt: new Date(now - 10_000) }); // waits 2 min after the 3rd try
    await addNumber("retry-late", { attempts: 3, lastAt: new Date(now - 5 * 60_000) });
    await addNumber("retry-off", { restore: false });
    fake.starts.length = 0;
    await recoverSessions(io, { now });
    assert.deepEqual([...fake.starts].sort(), ["retry-late", "retry-new"]);
    const early = await row("retry-early");
    assert.equal(early.reconnect_attempts, 3, "not touched, not counted");
    assert.equal((await row("retry-new")).status, "CONNECTED");
    await stopAll("retry-new", "retry-late");
  });

  await t.test("stopping the server closes every number at the same time, within a limit, and lets go of the claims", async () => {
    const names = ["stop-1", "stop-2", "stop-3", "stop-4"];
    for (const n of names) {
      fake.closeMs[n] = 300;
      await startTenantSession(tenantId, n, io, owner.user.id);
    }
    await until(async () => (await query("SELECT count(*)::int AS n FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name = ANY($2) AND status='CONNECTED'", [tenantId, names])).rows[0].n === 4, 4000, "four connected");
    fake.closes.length = 0;
    let began = Date.now();
    await closeSessions(io, { graceMs: 5000 });
    const took = Date.now() - began;
    assert.ok(took < 900, `four numbers that need 300 ms each closed in ${took} ms (one after another would be 1200 or more)`);
    assert.deepEqual([...fake.closes].sort(), names);
    for (const n of names) {
      const r = await row(n);
      assert.equal(r.worker_id, null);
      assert.equal(r.restore_on_start, true, "they come back at the next start");
    }
    assert.ok((await causes("stop-1")).includes("closed:server_stop"));

    // one browser hangs: the others are closed, and the server still stops within the limit
    fake.closeMs["hang-1"] = 60_000;
    fake.closeMs["ok-1"] = 50;
    for (const n of ["hang-1", "ok-1"]) await startTenantSession(tenantId, n, io, owner.user.id);
    await until(async () => (await query("SELECT count(*)::int AS n FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name IN ('hang-1','ok-1') AND status='CONNECTED'", [tenantId])).rows[0].n === 2, 4000, "two connected");
    fake.closes.length = 0;
    began = Date.now();
    await closeSessions(io, { graceMs: 400 });
    const bounded = Date.now() - began;
    assert.ok(bounded >= 380 && bounded < 1500, `stopped after ${bounded} ms although one browser never closed`);
    assert.ok(fake.closes.includes("ok-1"));
    assert.equal((await row("hang-1")).worker_id, null, "even the one that hung lets go of its claim");
    delete fake.closeMs["hang-1"];
  });

  await t.test("a number that stops answering has its browser restarted, once, not over and over", async () => {
    ENV.HEARTBEAT_RESTART_AFTER = 3;
    ENV.HEARTBEAT_RESTART_COOLDOWN_MS = 60_000;
    await startTenantSession(tenantId, "hb-1", io, owner.user.id);
    await until(async () => (await row("hb-1"))?.status === "CONNECTED", 3000, "hb-1 connected");
    fake.clients["hb-1"].isConnected = async () => {
      throw new Error("Page crashed");
    };
    fake.starts.length = 0;
    fake.closes.length = 0;
    const now = Date.now();
    await pingSessions({ io, nowMs: now });
    await pingSessions({ io, nowMs: now + 60_000 });
    await sleep(100);
    assert.deepEqual(fake.closes, [], "two misses are not enough");
    await pingSessions({ io, nowMs: now + 120_000 });
    await until(() => fake.starts.includes("hb-1"), 3000, "restarted after the third miss");
    assert.deepEqual(fake.closes, ["hb-1"]);
    await until(async () => (await row("hb-1"))?.status === "CONNECTED", 3000, "back, without a QR code");
    assert.equal((await row("hb-1")).heartbeat_failures, 0, "the new browser starts with a clean count");
    // it answers badly again: inside the cooldown (a minute after the restart) it is left alone, however many checks it fails
    fake.clients["hb-1"].isConnected = async () => false;
    fake.starts.length = 0;
    for (let i = 0; i < 4; i++) await pingSessions({ io, nowMs: now + 125_000 + i * 5_000 });
    await sleep(150);
    assert.deepEqual(fake.starts, [], "no second restart within the cooldown");
    assert.ok((await causes("hb-1")).includes("restart:heartbeat"));
    // the cooldown is a time window, not a ban: once it has passed, a number that is still failing is restarted again
    await pingSessions({ io, nowMs: now + 120_000 + 60_000 });
    await until(() => fake.starts.includes("hb-1"), 3000, "restarted again after the cooldown");
    await until(async () => (await row("hb-1"))?.status === "CONNECTED", 3000, "back again");
    await stopAll("hb-1");
  });

  await t.test("WhatsApp says another window took over: the number is taken back, not dropped", async () => {
    await startTenantSession(tenantId, "wa-conflict", io, owner.user.id);
    await until(async () => (await row("wa-conflict"))?.status === "CONNECTED", 3000, "connected");
    await fake.callbacks["wa-conflict"].onState("CONFLICT");
    assert.deepEqual(fake.useHere, ["wa-conflict"]);
    const events = await causes("wa-conflict");
    assert.ok(events.includes("whatsapp_state:CONFLICT"));
    assert.ok(events.includes("conflict:took_back"));
    assert.equal((await row("wa-conflict")).status, "CONNECTED", "still connected");
    await stopAll("wa-conflict");
  });

  await t.test("the phone logs the device out: the number is not restored (it would only show a QR code), and its owner is told", async () => {
    await startTenantSession(tenantId, "wa-unpaired", io, owner.user.id);
    await until(async () => (await row("wa-unpaired"))?.status === "CONNECTED", 3000, "connected");
    assert.equal((await row("wa-unpaired")).restore_on_start, true);
    fake.closes.length = 0;
    await fake.callbacks["wa-unpaired"].onState("UNPAIRED");
    const r = await row("wa-unpaired");
    assert.equal(r.status, "EXPIRED");
    assert.equal(r.restore_on_start, false, "not brought back by the recovery loop");
    assert.equal(r.worker_id, null);
    assert.match(r.last_error, /unlinked this number/);
    assert.deepEqual(fake.closes, ["wa-unpaired"], "the browser is closed");
    assert.ok((await causes("wa-unpaired")).includes("unlinked:whatsapp_unpaired"));
    const alert = await until(async () => (await query("SELECT title,body FROM notifications WHERE tenant_id=$1 AND type='session' AND dedupe_key='wa-unpaired'", [tenantId])).rows[0], 3000, "owner notified");
    assert.match(alert.title, /disconnected/);
    fake.starts.length = 0;
    await recoverSessions(io);
    assert.ok(!fake.starts.includes("wa-unpaired"), "recovery leaves it alone");
  });

  await t.test("WhatsApp's connection drops and does not come back: the browser is restarted; if it comes back by itself, nothing is done", async () => {
    ENV.STREAM_DOWN_RESTART_MS = 200;
    await startTenantSession(tenantId, "wa-stream", io, owner.user.id);
    await until(async () => (await row("wa-stream"))?.status === "CONNECTED", 3000, "connected");
    fake.starts.length = 0;
    fake.closes.length = 0;
    // down, then back within the limit
    await fake.callbacks["wa-stream"].onStream("DISCONNECTED");
    await sleep(80);
    await fake.callbacks["wa-stream"].onStream("CONNECTED");
    await sleep(350);
    assert.deepEqual(fake.closes, [], "it came back by itself");
    assert.ok((await causes("wa-stream")).includes("stream_up:came_back_by_itself"));
    // down for good
    await fake.callbacks["wa-stream"].onStream("DISCONNECTED");
    await until(() => fake.starts.includes("wa-stream"), 3000, "restarted");
    assert.deepEqual(fake.closes, ["wa-stream"]);
    await until(async () => (await row("wa-stream"))?.status === "CONNECTED", 3000, "back");
    assert.ok((await causes("wa-stream")).includes("restart:stream_down"));
    await stopAll("wa-stream");
    ENV.STREAM_DOWN_RESTART_MS = saved.STREAM_DOWN_RESTART_MS;
  });

  await t.test("a late report from a browser that has been replaced does not take the new browser's place", async () => {
    ENV.STREAM_DOWN_RESTART_MS = 150;
    await startTenantSession(tenantId, "gen-1", io, owner.user.id);
    await until(async () => (await row("gen-1"))?.status === "CONNECTED", 3000, "connected");
    const old = fake.callbacks["gen-1"];
    assert.equal(await restartTenantSession(tenantId, "gen-1", io, { cause: "heartbeat" }), true);
    await until(async () => (await row("gen-1"))?.status === "CONNECTED" && fake.callbacks["gen-1"] !== old, 3000, "the new browser is connected");
    const before = await row("gen-1");
    fake.starts.length = 0;
    fake.closes.length = 0;
    // the old browser says its goodbyes after the new one is up
    await old.onStatus("DISCONNECTED", "browserClose");
    await old.onState("UNPAIRED");
    await old.onStream("DISCONNECTED");
    await sleep(350);
    const after = await row("gen-1");
    assert.equal(after.status, "CONNECTED", "still connected");
    assert.equal(after.worker_id, before.worker_id, "still holds its claim");
    assert.equal(after.restore_on_start, true);
    assert.deepEqual([fake.starts, fake.closes], [[], []], "nothing was restarted because of it");
    assert.ok(!(await causes("gen-1")).some((e) => e.startsWith("disconnected:") || e.startsWith("unlinked:") || e.startsWith("stream_down:")), "and nothing was recorded as a drop");
    await stopAll("gen-1");
    ENV.STREAM_DOWN_RESTART_MS = saved.STREAM_DOWN_RESTART_MS;
  });

  await t.test("every drop is on record with its cause, and old history is pruned", async () => {
    await startTenantSession(tenantId, "hist-1", io, owner.user.id);
    await until(async () => (await row("hist-1"))?.status === "CONNECTED", 3000, "connected");
    await fake.callbacks["hist-1"].onStatus("DISCONNECTED", "browserClose");
    const events = await causes("hist-1");
    assert.deepEqual(events.slice(0, 3), ["start:user", "connected:user", "disconnected:browserClose"]);
    // a failed start is recorded with what went wrong
    provider.startSession = async () => {
      throw new Error("Failed to launch the browser process: no space left on device");
    };
    await startTenantSession(tenantId, "hist-2", io, owner.user.id);
    await until(async () => (await row("hist-2"))?.status === "FAILED", 3000, "failed");
    const failed = (await sessionEvents(tenantId, "hist-2")).find((e) => e.event === "failed");
    assert.match(failed.detail, /no space left on device/);
    // pruning
    await query("INSERT INTO whatsapp_session_events(tenant_id,session_name,event,created_at) VALUES($1,'hist-1','ancient',now()-interval '100 days')", [tenantId]);
    assert.ok((await pruneSessionEvents(90)) >= 1);
    assert.ok(!(await causes("hist-1")).some((e) => e.startsWith("ancient")));
    assert.ok((await causes("hist-1")).length >= 3, "recent history stays");
    // recording an event can never fail a caller
    await assert.doesNotReject(recordSessionEvent({ tenantId: "no-such-company", sessionName: "x", event: "start" }));
  });
});

test("A stray error does not take every number down with the process", async (t) => {
  const make = () => {
    const target = new EventEmitter();
    const exits = [];
    target.exit = (code) => exits.push(code);
    const logged = [];
    const log = { error: (...a) => logged.push(a.map(String).join(" ")) };
    return { target, exits, logged, log };
  };
  await t.test("what counts as browser noise", () => {
    for (const m of ["Protocol error (Runtime.callFunctionOn): Target closed", "Execution context was destroyed, most likely because of a navigation", "Navigating frame was detached", "Session closed. Most likely the page has been closed."])
      assert.equal(isBrowserNoise(new Error(m)), true, m);
    for (const m of ["Cannot read properties of undefined", "ECONNREFUSED", ""]) assert.equal(isBrowserNoise(new Error(m)), false, m);
  });
  await t.test("an unhandled rejection is logged with its stack and the server keeps running", () => {
    const h = make();
    const off = installProcessGuards({ onFatal: () => assert.fail("must not stop"), log: h.log, target: h.target });
    h.target.emit("unhandledRejection", new Error("Target closed"));
    h.target.emit("unhandledRejection", new Error("something else"));
    assert.deepEqual(h.exits, []);
    assert.equal(h.logged.length, 2);
    assert.match(h.logged[0], /\(browser\)/);
    off();
  });
  await t.test("a browser error thrown outright is ignored; any other uncaught exception stops the server cleanly, once", async () => {
    const h = make();
    let stops = 0;
    const off = installProcessGuards({ onFatal: async () => { stops++; }, log: h.log, target: h.target });
    h.target.emit("uncaughtException", new Error("Protocol error: Target closed"), "uncaughtException");
    await sleep(20);
    assert.deepEqual([stops, h.exits], [0, []]);
    h.target.emit("uncaughtException", new Error("real bug"), "uncaughtException");
    h.target.emit("uncaughtException", new Error("another"), "uncaughtException");
    await until(() => h.exits.length, 1000, "exit");
    await sleep(20);
    assert.deepEqual([stops, h.exits], [1, [1]]);
    off();
    assert.equal(h.target.listenerCount("uncaughtException"), 0);
  });
  await t.test("even if the clean stop itself fails, the process still ends", async () => {
    const h = make();
    const off = installProcessGuards({ onFatal: async () => { throw new Error("stop failed"); }, log: h.log, target: h.target });
    h.target.emit("uncaughtException", new Error("real bug"), "uncaughtException");
    await until(() => h.exits.length, 1000, "exit");
    assert.deepEqual(h.exits, [1]);
    off();
  });
});
