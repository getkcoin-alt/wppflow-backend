import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import crypto from "node:crypto";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { closeSessions } from "../src/services/sessionService.js";

test("Today: what needs a person now, most urgent first, and only what they may see", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia Owner", email: "olivia@home.test", password: "Password@123", companyName: "Home Co" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const mk = async (name, role) => {
    const u = (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [name, `${name.toLowerCase()}@home.test`])).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)", [tenantId, u.id, role]);
    return { ...u, auth: { Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` } };
  };
  const sam = await mk("Sam", "agent"), tina = await mk("Tina", "agent");
  const owner = { auth: { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` } };
  // two numbers that are up: leased, heard from a moment ago
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status,phone,lease_until,last_heartbeat_at,last_heartbeat_ok_at,connected_since) VALUES(gen_random_uuid()::text,$1,'sam-line',$2,'CONNECTED','971500000100',now()+interval '1 hour',now(),now(),now()-interval '1 day'),(gen_random_uuid()::text,$1,'tina-line',$3,'CONNECTED','971500000200',now()+interval '1 hour',now(),now(),now()-interval '1 day')", [tenantId, sam.id, tina.id]);
  const home = async (who, qs = "") => (await request(app).get(`/api/home${qs}`).set(who.auth)).body;

  await t.test("a new workspace has nothing waiting, and owners are shown how to get set up", async () => {
    const h = await home(owner);
    assert.equal(h.status, "success");
    assert.deepEqual(h.counts, { waiting: 0, overdue: 0, tasksDue: 0, tasksOverdue: 0, numbersNeedingCare: 0 });
    assert.deepEqual(h.needsYou, []);
    assert.equal(h.firstName, "Olivia");
    assert.deepEqual(h.setup.steps.map((s) => [s.key, s.done]), [["connect", true], ["replies", false], ["automation", false], ["team", true]]);
    assert.equal(h.setup.done, 2);
    assert.equal((await home(sam)).setup, null, "staff are not shown the owner's set-up list");
  });

  let epoch = Math.floor(Date.now() / 1000) - 7200;
  const hear = (line, remote, text, name) =>
    handleIncomingMessage({ tenantId, sessionName: line, msg: { providerMessageId: `m_${remote}_${++epoch}`, fromMe: false, remoteId: remote, rawType: "chat", type: "text", text, timestampEpoch: epoch, senderName: name, ack: 2 } });

  await t.test("customers who wrote last are listed, the longest wait first, and one past the reply target is marked", async () => {
    await hear("sam-line", "971500000001@c.us", "Is the villa still available?", "Asha Rao");
    await hear("sam-line", "83752348860497@lid", "hello?", "");
    await hear("tina-line", "971500000003@c.us", "Price please", "Ben Hall");
    await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint-5400 WHERE tenant_id=$1 AND phone='971500000001'", [tenantId]); // 90 minutes
    await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint-300 WHERE tenant_id=$1 AND phone='83752348860497@lid'", [tenantId]); // 5 minutes
    await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint-3000 WHERE tenant_id=$1 AND phone='971500000003'", [tenantId]); // 50 minutes
    const h = await home(owner);
    assert.deepEqual(h.counts.waiting, 3);
    assert.equal(h.counts.overdue, 2, "the default target is 30 minutes");
    assert.deepEqual(h.needsYou.map((i) => [i.title, i.overdue]), [["Asha Rao", true], ["Ben Hall", true], ["Unknown contact", false]]);
    const asha = h.needsYou[0];
    assert.equal(asha.kind, "chat");
    assert.equal(asha.preview, "Is the villa still available?");
    assert.ok(asha.waitingSeconds >= 5390 && asha.waitingSeconds < 5700, `about 90 minutes: ${asha.waitingSeconds}`);
    assert.ok(asha.conversationId && !JSON.stringify(h).includes("@lid"), "no hidden id anywhere");
  });

  await t.test("staff only see their own numbers' customers", async () => {
    assert.deepEqual((await home(sam)).needsYou.map((i) => i.title), ["Asha Rao", "Unknown contact"]);
    assert.deepEqual((await home(tina)).needsYou.map((i) => i.title), ["Ben Hall"]);
    const ben = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND phone='971500000003'", [tenantId])).rows[0].id;
    await query("UPDATE conversations SET assigned_user_id=$2 WHERE id=$1", [ben, sam.id]);
    assert.deepEqual((await home(sam)).needsYou.map((i) => i.title).sort(), ["Asha Rao", "Ben Hall", "Unknown contact"], "a chat handed to someone is theirs too");
    await query("UPDATE conversations SET assigned_user_id=NULL WHERE id=$1", [ben]);
  });

  await t.test("an answered or resolved chat leaves the list, and groups never appear", async () => {
    const asha = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND phone='971500000001'", [tenantId])).rows[0].id;
    await query("UPDATE conversations SET is_closed=true WHERE id=$1", [asha]);
    assert.ok(!(await home(owner)).needsYou.some((i) => i.title === "Asha Rao"));
    await query("UPDATE conversations SET is_closed=false WHERE id=$1", [asha]);
    await query("UPDATE conversations SET awaiting_since=NULL WHERE id=$1", [asha]);
    assert.ok(!(await home(owner)).needsYou.some((i) => i.title === "Asha Rao"), "once somebody answers");
    await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint-5400 WHERE id=$1", [asha]);
    await hear("sam-line", "120363000000000001@g.us", "group chatter", "Someone").catch(() => {});
    await query("UPDATE conversations SET awaiting_since=extract(epoch FROM now())::bigint-9000 WHERE tenant_id=$1 AND provider_chat_id LIKE '%@g.us'", [tenantId]);
    assert.ok(!(await home(owner)).needsYou.some((i) => i.title === "WhatsApp Group"));
  });

  await t.test("follow-ups due today and overdue are listed, mixed in by urgency, for the person they are assigned to", async () => {
    const asha = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND phone='971500000001'", [tenantId])).rows[0].id;
    const add = (title, minutes, user) =>
      query("INSERT INTO lead_tasks(id,tenant_id,lead_id,conversation_id,title,due_at,assigned_user_id,created_by) VALUES($1,$2,NULL,$3,$4,now()+($5||' minutes')::interval,$6,$6)", [crypto.randomUUID(), tenantId, asha, title, String(minutes), user]);
    await add("Call back about the deposit", -120, sam.id);
    await add("Send the brochure", 90, sam.id);
    await add("Tina's follow-up", -10, tina.id);
    const until = new Date(Date.now() + 6 * 3600_000).toISOString();
    const h = await home(sam, `?until=${encodeURIComponent(until)}`);
    const tasks = h.needsYou.filter((i) => i.kind === "task");
    assert.deepEqual(tasks.map((i) => [i.title, i.overdue]), [["Call back about the deposit", true], ["Send the brochure", false]]);
    assert.deepEqual([h.counts.tasksDue, h.counts.tasksOverdue], [2, 1]);
    assert.equal(tasks[0].conversationId, asha);
    const order = h.needsYou.map((i) => i.kind + (i.overdue ? "!" : ""));
    assert.ok(order.indexOf("task!") > order.indexOf("chat!") || !order.includes("chat!"), "customers past the target come before late follow-ups");
    const none = await home(sam, `?until=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
    assert.deepEqual(none.needsYou.filter((i) => i.kind === "task").map((i) => i.title), ["Call back about the deposit"], "'today' ends when the person's day does");
  });

  await t.test("a number that is down is shown to its owner and to managers, not to others", async () => {
    await query("UPDATE whatsapp_sessions SET status='DISCONNECTED', lease_until=NULL, down_since=now()-interval '20 minutes' WHERE tenant_id=$1 AND session_name='tina-line'", [tenantId]);
    const mine = (await home(tina)).needsYou.filter((i) => i.kind === "number");
    assert.equal(mine.length, 1);
    assert.ok(mine[0].problem.length > 5);
    assert.equal((await home(owner)).needsYou.filter((i) => i.kind === "number").length, 1);
    assert.equal((await home(sam)).needsYou.filter((i) => i.kind === "number").length, 0);
  });

  await t.test("at most ten are listed and the rest are counted", async () => {
    for (let i = 0; i < 12; i++) await hear("sam-line", `97150010${String(i).padStart(4, "0")}@c.us`, "hi", `Person ${i}`);
    const h = await home(owner);
    assert.equal(h.needsYou.length, 10);
    assert.ok(h.more >= 1);
  });

  await t.test("it needs a sign-in", async () => {
    assert.equal((await request(app).get("/api/home")).status, 401);
  });
});
