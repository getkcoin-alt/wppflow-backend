import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { app, io as serverIo } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { closeSessions, saveSessionStatus } from "../src/services/sessionService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { judge, numberHealth, pingSessions, alertOnProblems, THRESHOLDS } from "../src/services/numberHealth.js";

test("Number health: heartbeat, failed and waiting sends, alerts and who can see them", async (t) => {
  const running = new Set();
  t.after(async () => {
    for (const key of running) provider.sessions.delete(key);
    await closeSessions(serverIo);
    serverIo.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@health.test", password: "Password@123", companyName: "Health Co" });
  const tenantId = o.tenant.id;
  const mk = async (name, role) => {
    const u = (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [name, `${name.toLowerCase()}@health.test`])).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)", [tenantId, u.id, role]);
    return { ...u, auth: { Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` } };
  };
  const sam = await mk("Sam", "agent"), tina = await mk("Tina", "agent"), ada = await mk("Ada", "admin");
  const owner = { ...o.user, auth: { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` } };
  const addLine = (name, ownerId, phone = "971500000000") =>
    query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status,phone) VALUES(gen_random_uuid()::text,$1,$2,$3,'DISCONNECTED',$4)", [tenantId, name, ownerId, phone]);
  await addLine("sam-line", sam.id);
  await addLine("tina-line", tina.id, "971500000001");
  await addLine("pairing-line", sam.id, null);

  // a number the server is running right now, with a client that answers however the test says
  const answers = { sam: async () => true };
  const run = (name, key) => {
    const k = provider.sessionKey(tenantId, name);
    provider.sessions.set(k, { tenantId, sessionName: name, status: "CONNECTED", phone: "971500000000", client: { isConnected: () => answers[key]() } });
    running.add(k);
  };
  const stop = (name) => {
    const k = provider.sessionKey(tenantId, name);
    provider.sessions.delete(k);
    running.delete(k);
  };
  const row = async (name) => (await query("SELECT * FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [tenantId, name])).rows[0];
  const health = async (name, nowMs) => (await numberHealth(tenantId, { nowMs })).find((n) => n.sessionName === name);

  await t.test("asking a running number whether it is there is remembered, and misses are counted in a row", async () => {
    run("sam-line", "sam");
    assert.equal(await pingSessions(), 1);
    let r = await row("sam-line");
    assert.ok(r.last_heartbeat_at && r.last_heartbeat_ok_at);
    assert.equal(r.heartbeat_failures, 0);

    answers.sam = async () => false;
    await pingSessions();
    answers.sam = async () => {
      throw new Error("Page crashed");
    };
    await pingSessions();
    r = await row("sam-line");
    assert.equal(r.heartbeat_failures, 2);
    assert.match(r.heartbeat_error, /Page crashed/);

    // a browser that hangs is a miss too, and does not hold the others up
    answers.sam = () => new Promise(() => {});
    await pingSessions({ timeoutMs: 1000 });
    r = await row("sam-line");
    assert.equal(r.heartbeat_failures, 3);
    assert.match(r.heartbeat_error, /No answer within 1 second/);

    answers.sam = async () => true;
    await pingSessions();
    r = await row("sam-line");
    assert.equal(r.heartbeat_failures, 0);
    assert.equal(r.heartbeat_error, null);
  });

  await t.test("numbers that are not running here are not asked", async () => {
    // tina's line is in the database only
    const before = await row("tina-line");
    await pingSessions();
    const after = await row("tina-line");
    assert.equal(after.last_heartbeat_at, before.last_heartbeat_at);
    assert.equal(after.last_heartbeat_at, null);
  });

  await t.test("a number's state changes keep since-when and reset the counters on reconnecting", async () => {
    const worker = crypto.randomUUID();
    await query("UPDATE whatsapp_sessions SET worker_id=$3,reconnect_attempts=4,heartbeat_failures=2,heartbeat_error='x' WHERE tenant_id=$1 AND session_name=$2", [tenantId, "tina-line", worker]);
    const set = (status) => saveSessionStatus({ tenantId, sessionName: "tina-line", workerId: worker, status, phone: "971500000001" });
    await set("CONNECTED");
    let r = await row("tina-line");
    assert.ok(r.connected_since);
    assert.equal(r.down_since, null);
    assert.equal(r.reconnect_attempts, 0, "connecting resets the tries");
    assert.equal(r.heartbeat_failures, 0);
    const since = r.connected_since;
    await set("CONNECTED");
    assert.equal((await row("tina-line")).connected_since.getTime(), since.getTime(), "saying it again does not restart the clock");

    await set("DISCONNECTED");
    r = await row("tina-line");
    assert.equal(r.connected_since, null);
    assert.ok(r.down_since, "down since the moment it dropped");
    const down = r.down_since;
    await set("STARTING");
    assert.equal((await row("tina-line")).down_since.getTime(), down.getTime(), "trying again is still down");
    await set("CONNECTED");
    assert.equal((await row("tina-line")).down_since, null);
  });

  await t.test("failed and waiting messages are counted per number, over the right time", async () => {
    await handleIncomingMessage({ tenantId, sessionName: "sam-line", msg: { providerMessageId: "h1", fromMe: false, remoteId: "971511111111@c.us", isGroup: false, rawType: "chat", type: "text", text: "hi", timestampEpoch: Math.floor(Date.now() / 1000) - 7200, senderName: "Cust", ack: 2 } });
    await handleIncomingMessage({ tenantId, sessionName: "tina-line", msg: { providerMessageId: "h2", fromMe: false, remoteId: "971522222222@c.us", isGroup: false, rawType: "chat", type: "text", text: "hi", timestampEpoch: Math.floor(Date.now() / 1000) - 7200, senderName: "Other", ack: 2 } });
    const chatOf = async (line) => (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND session_name=$2", [tenantId, line])).rows[0].id;
    const now = Math.floor(Date.now() / 1000);
    const put = async (line, status, ageSeconds, over = {}) =>
      query("INSERT INTO messages(id,tenant_id,conversation_id,sender,agent_name,type,timestamp_epoch,status) VALUES($1,$2,$3,'agent','Sam',$4,$5,$6)", [crypto.randomUUID(), tenantId, await chatOf(line), over.type || "text", now - ageSeconds, status]);
    for (const s of ["sent", "delivered", "read"]) await put("sam-line", s, 600);
    await put("sam-line", "failed", 300);
    await put("sam-line", "uncertain", 1200);
    await put("sam-line", "failed", 5 * 3600); // earlier today: counts for the day, not the hour
    await put("sam-line", "sent", 30 * 3600); // yesterday: not counted at all
    await put("sam-line", "sending", 900);
    await put("sam-line", "failed", 100, { type: "internal_note" }); // a team note is not a send
    await put("tina-line", "failed", 60); // another number's trouble stays with it

    const sam1 = await health("sam-line");
    assert.deepEqual(sam1.sends, { sentLast24h: 3, failedLast24h: 3, failedLastHour: 2, totalLastHour: 5 });
    assert.equal(sam1.queued.count, 1);
    assert.ok(sam1.queued.oldestSeconds >= 899 && sam1.queued.oldestSeconds < 960);
    assert.equal((await health("tina-line")).sends.failedLast24h, 1);
  });

  await t.test("what counts as a problem, and what is worth waking someone for", async () => {
    const base = { label: "Sam's number", phone: "9715", status: "CONNECTED", heartbeatFailures: 0, heartbeatError: null, reconnectAttempts: 0, downSince: null, sends: { failedLastHour: 0, totalLastHour: 0 }, queued: { count: 0, oldestSeconds: null } };
    const now = Date.now();
    const ago = (minutes) => new Date(now - minutes * 60000).toISOString();
    assert.deepEqual(judge(base, now), { level: "ok", problems: [] });
    assert.equal(judge({ ...base, phone: null, status: "QRCODE" }, now).level, "unpaired", "a number being linked is not unhealthy");

    const down10 = judge({ ...base, status: "DISCONNECTED", downSince: ago(10), reconnectAttempts: 2 }, now);
    assert.equal(down10.level, "down");
    assert.match(down10.problems[0].text, /Not connected for 10 minutes.*tried to bring it back 2 times/);
    assert.equal(down10.problems[0].alert, false, "10 minutes is not yet worth an alert");
    assert.equal(judge({ ...base, status: "DISCONNECTED", downSince: ago(THRESHOLDS.downMinutes + 1) }, now).problems[0].alert, true);
    assert.match(judge({ ...base, status: "STARTING", downSince: ago(3) }, now).problems[0].text, /^Reconnecting for 3 minutes/);

    assert.equal(judge({ ...base, heartbeatFailures: 2 }, now).level, "ok");
    const quiet = judge({ ...base, heartbeatFailures: 3, heartbeatError: "Page crashed" }, now);
    assert.equal(quiet.level, "warn");
    assert.equal(quiet.problems[0].alert, true);
    assert.match(quiet.problems[0].text, /last 3 checks \(Page crashed\)/);

    assert.equal(judge({ ...base, sends: { failedLastHour: 4, totalLastHour: 4 } }, now).level, "ok", "under five is a blip");
    assert.equal(judge({ ...base, sends: { failedLastHour: 5, totalLastHour: 40 } }, now).level, "ok", "a few failures among many sends is normal");
    const failing = judge({ ...base, sends: { failedLastHour: 6, totalLastHour: 8 } }, now);
    assert.equal(failing.problems[0].code, "failing");
    assert.match(failing.problems[0].text, /6 of the last 8/);

    assert.equal(judge({ ...base, queued: { count: 3, oldestSeconds: 240 } }, now).level, "ok");
    const stuck = judge({ ...base, queued: { count: 3, oldestSeconds: 720 } }, now);
    assert.equal(stuck.problems[0].code, "stuck");
    assert.match(stuck.problems[0].text, /3 messages have been waiting to leave for 12 minutes/);
  });

  await t.test("persistent trouble tells the number's owner and the managers once, not on every check", async () => {
    // sam's number stops answering
    answers.sam = async () => false;
    for (let i = 0; i < 3; i++) await pingSessions();
    const noteCount = async () => (await query("SELECT user_id,title,body,dedupe_key FROM notifications WHERE tenant_id=$1 AND type='session' AND dedupe_key LIKE 'health:%' ORDER BY id", [tenantId])).rows;
    assert.equal((await noteCount()).length, 0);
    assert.ok((await alertOnProblems()) > 0);
    let notes = await noteCount();
    const unresponsive = notes.filter((n) => n.dedupe_key === "health:unresponsive:sam-line");
    assert.deepEqual(unresponsive.map((n) => n.user_id).sort(), [ada.id, o.user.id, sam.id].sort(), "the owner of the number, the owner of the company and the administrator");
    assert.ok(!unresponsive.some((n) => n.user_id === tina.id), "someone else's staff are not told");
    assert.match(unresponsive[0].title, /Sam's number stopped answering/);

    const total = notes.length;
    await alertOnProblems();
    await alertOnProblems();
    assert.equal((await noteCount()).length, total, "the same problem does not repeat");

    // after the cooldown, if it is still wrong, they are told again
    await query("UPDATE notifications SET created_at=now()-interval '7 hours' WHERE tenant_id=$1 AND dedupe_key LIKE 'health:%'", [tenantId]);
    await alertOnProblems();
    assert.equal((await noteCount()).length, total * 2);

    // a number that is fine, or still being linked, is left alone
    answers.sam = async () => true;
    await pingSessions();
    await query("DELETE FROM notifications WHERE tenant_id=$1", [tenantId]);
    // the one thing still wrong is the message that has been waiting 15 minutes; the number that answers again is not reported
    await alertOnProblems();
    assert.deepEqual([...new Set((await noteCount()).map((n) => n.dedupe_key))], ["health:stuck:sam-line"]);
  });

  await t.test("a number that stays disconnected is reported once it has been down long enough", async () => {
    stop("sam-line");
    await query("UPDATE whatsapp_sessions SET status='DISCONNECTED',down_since=now()-interval '10 minutes',heartbeat_failures=0 WHERE tenant_id=$1 AND session_name='tina-line'", [tenantId]);
    await query("DELETE FROM notifications WHERE tenant_id=$1", [tenantId]);
    await alertOnProblems();
    assert.equal((await query("SELECT 1 FROM notifications WHERE tenant_id=$1 AND dedupe_key='health:down:tina-line'", [tenantId])).rowCount, 0, "ten minutes is a blip");
    await query("UPDATE whatsapp_sessions SET down_since=now()-interval '2 hours' WHERE tenant_id=$1 AND session_name='tina-line'", [tenantId]);
    await alertOnProblems();
    const told = (await query("SELECT user_id,title FROM notifications WHERE tenant_id=$1 AND dedupe_key='health:down:tina-line'", [tenantId])).rows;
    assert.ok(told.some((n) => n.user_id === tina.id) && told.some((n) => n.user_id === o.user.id));
    assert.match(told[0].title, /Tina's number has been disconnected for 2 hours/);
  });

  await t.test("a suspended company is not watched", async () => {
    await query("DELETE FROM notifications WHERE tenant_id=$1", [tenantId]);
    await query("UPDATE tenants SET status='suspended' WHERE id=$1", [tenantId]);
    assert.equal(await alertOnProblems(), 0);
    await query("UPDATE tenants SET status='active' WHERE id=$1", [tenantId]);
  });

  await t.test("the Numbers screen's data: managers see every number, staff only their own, and no alert wording", async () => {
    run("sam-line", "sam");
    const all = (await request(app).get("/api/sessions/health").set(owner.auth)).body;
    assert.equal(all.scope, "workspace");
    assert.equal(all.checkedEverySeconds, 60);
    assert.deepEqual(all.numbers.map((n) => n.sessionName).sort(), ["pairing-line", "sam-line", "tina-line"]);
    const samView = all.numbers.find((n) => n.sessionName === "sam-line");
    assert.equal(samView.level, "warn", "the message that has waited 15 minutes is the one thing wrong");
    assert.deepEqual(samView.problems.map((p) => p.code), ["stuck"]);
    assert.equal(samView.status, "CONNECTED");
    assert.ok(samView.lastHeartbeatAt && samView.connectedSince !== undefined);
    assert.ok(!("alerts" in samView), "the wording of alerts stays on the server");
    assert.equal(all.numbers.find((n) => n.sessionName === "tina-line").level, "down");
    assert.equal(all.numbers.find((n) => n.sessionName === "pairing-line").level, "unpaired");

    const mine = (await request(app).get("/api/sessions/health").set(sam.auth)).body;
    assert.equal(mine.scope, "own");
    assert.deepEqual(mine.numbers.map((n) => n.sessionName).sort(), ["pairing-line", "sam-line"]);
    assert.equal((await request(app).get("/api/sessions/health")).status, 401);
  });
});
