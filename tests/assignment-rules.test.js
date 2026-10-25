import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io as serverIo } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { pumpAutomations } from "../src/services/automationService.js";
import { pick, withinHours } from "../src/services/assignmentService.js";
import { createLead } from "../src/services/leadService.js";
import { closeSessions } from "../src/services/sessionService.js";

test("who gets a chat: round-robin, least busy, limits and working hours", () => {
  const p = (id, openChats = 0) => ({ id, openChats });
  const team = [p(3), p(5), p(9)];
  // the rotation carries on after whoever got the last chat, and wraps round
  assert.equal(pick({ mode: "round_robin", people: team, lastUserId: null }).userId, 3);
  assert.equal(pick({ mode: "round_robin", people: team, lastUserId: 3 }).userId, 5);
  assert.equal(pick({ mode: "round_robin", people: team, lastUserId: 9 }).userId, 3);
  assert.equal(pick({ mode: "round_robin", people: team, lastUserId: 4 }).userId, 5, "the last person has since left or gone away: carry on from where the rotation was");
  // the busiest person is not skipped by round-robin: it is a rotation, not a load balancer
  assert.equal(pick({ mode: "round_robin", people: [p(3, 9), p(5, 0)], lastUserId: null }).userId, 3);
  // least busy takes whoever has the fewest open chats, and breaks a tie by the rotation
  assert.equal(pick({ mode: "least_busy", people: [p(3, 4), p(5, 1), p(9, 2)], lastUserId: null }).userId, 5);
  assert.equal(pick({ mode: "least_busy", people: [p(3, 1), p(5, 1), p(9, 4)], lastUserId: 3 }).userId, 5);
  assert.equal(pick({ mode: "least_busy", people: [p(3, 1), p(5, 1)], lastUserId: 5 }).userId, 3);
  // a limit on open chats takes people out of the running
  assert.equal(pick({ mode: "round_robin", people: [p(3, 2), p(5, 1)], maxOpen: 2 }).userId, 5);
  const full = pick({ mode: "round_robin", people: [p(3, 2), p(5, 2)], maxOpen: 2 });
  assert.equal(full.userId, null);
  assert.match(full.why, /limit/);
  assert.match(pick({ mode: "round_robin", people: [] }).why, /nobody is available/);
  // a returning customer goes back to their own person, even past the limit
  assert.equal(pick({ mode: "round_robin", people: [p(3, 5)], maxOpen: 1, returning: 77 }).userId, 77);

  const hours = { use_hours: true, timezone: "Asia/Dubai", work_days: [1, 2, 3, 4, 5], work_start: "09:00", work_end: "18:00" };
  const at = (iso) => new Date(iso);
  assert.equal(withinHours(hours, at("2026-10-19T06:00:00Z")), true, "Monday 10:00 in Dubai");
  assert.equal(withinHours(hours, at("2026-10-19T04:59:00Z")), false, "Monday 08:59 in Dubai");
  assert.equal(withinHours(hours, at("2026-10-19T14:00:00Z")), false, "18:00 is closing time");
  assert.equal(withinHours(hours, at("2026-10-24T06:00:00Z")), false, "Saturday");
  assert.equal(withinHours({ ...hours, timezone: "Asia/Kolkata" }, at("2026-10-19T03:45:00Z")), true, "09:15 in India");
  assert.equal(withinHours({ ...hours, use_hours: false }, at("2026-10-24T23:00:00Z")), true, "switched off: always");
});

test("Automatic assignment of new chats", async (t) => {
  t.after(async () => {
    await closeSessions(serverIo);
    serverIo.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@assign.test", password: "Password@123", companyName: "Assign Co" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const mk = async (name, role, category = "general") => {
    const u = (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [name, `${name.toLowerCase()}@assign.test`])).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role,category) VALUES($1,$2,$3,$4)", [tenantId, u.id, role, category]);
    return { ...u, auth: { Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` } };
  };
  const sam = await mk("Sam", "agent", "sales"), tina = await mk("Tina", "agent", "support"), uma = await mk("Uma", "agent", "sales"), ada = await mk("Ada", "admin");
  const owner = { ...o.user, auth: { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` } };
  await query(
    "INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status) VALUES(gen_random_uuid()::text,$1,'shared-line',NULL,'CONNECTED'),(gen_random_uuid()::text,$1,'sam-line',$2,'CONNECTED')",
    [tenantId, sam.id],
  );
  const put = (body, who = owner) => request(app).put("/api/assignment").set(who.auth).send(body);
  const rule = async (body = {}) => {
    const res = await put({ enabled: true, mode: "round_robin", sessionNames: ["shared-line"], rotation: [sam.id, tina.id, uma.id], team: "", maxOpen: null, useHours: false, keepOwner: true, ...body });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.settings;
  };

  let n = 0;
  let epoch = Math.floor(Date.now() / 1000) - 3600;
  const hear = async (line, phone, { group = false, fromMe = false, name = "Customer" } = {}) => {
    await handleIncomingMessage({
      tenantId,
      sessionName: line,
      msg: { providerMessageId: `m_${phone}_${++n}`, fromMe, remoteId: group ? `${phone}@g.us` : `${phone}@c.us`, isGroup: group, groupName: group ? "A group" : undefined, rawType: "chat", type: "text", text: "hello", timestampEpoch: ++epoch, senderName: name, ack: 2 },
    });
    await pumpAutomations();
    return (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND provider_chat_id=$2 AND session_name=$3", [tenantId, group ? `${phone}@g.us` : `${phone}@c.us`, line])).rows[0];
  };
  const owned = async (user) => (await query("SELECT phone FROM conversations WHERE tenant_id=$1 AND assigned_user_id=$2 ORDER BY phone", [tenantId, user.id])).rows.map((r) => r.phone);
  const reset = async () => {
    await query("DELETE FROM conversations WHERE tenant_id=$1", [tenantId]);
    await query("DELETE FROM notifications WHERE tenant_id=$1", [tenantId]);
    await query("UPDATE assignment_settings SET last_assigned_user_id=NULL WHERE tenant_id=$1", [tenantId]);
    await query("UPDATE memberships SET available=true WHERE tenant_id=$1", [tenantId]);
  };

  await t.test("only owners and administrators set the rule, and it says what is wrong with a bad one", async () => {
    assert.equal((await put({ enabled: false }, sam)).status, 403);
    assert.equal((await request(app).get("/api/assignment").set(sam.auth)).status, 403);
    assert.equal((await request(app).get("/api/assignment")).status, 401);
    const bad = async (body, pattern) => {
      const res = await put(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.message, pattern);
    };
    await bad({ mode: "random" }, /round-robin or the least busy/);
    await bad({ timezone: "Mars/Olympus" }, /time zone is not recognised/);
    await bad({ workDays: [1, 9] }, /0 \(Sunday\) to 6/);
    await bad({ workStart: "9am" }, /times such as 09:00/);
    await bad({ workStart: "18:00", workEnd: "09:00" }, /start before they end/);
    await bad({ useHours: true, workDays: [] }, /at least one working day/);
    await bad({ maxOpen: 0 }, /whole number from 1 to 1000/);
    await bad({ sessionNames: ["not-mine"] }, /does not belong to this company/);
    await bad({ rotation: [99999] }, /active teammate/);
    await bad({ team: "ghosts" }, /Nobody is in a team called "ghosts"/);
    await bad({ enabled: true }, /at least one teammate in the rotation/);
    await bad({ enabled: true, rotation: [sam.id] }, /at least one number/);
    // nothing half-saved
    assert.equal((await request(app).get("/api/assignment").set(owner.auth)).body.settings.enabled, false);
  });

  await t.test("the screen's data: people with their team and open chats, numbers, teams and the saved rule", async () => {
    const saved = await rule({ team: "sales", maxOpen: 8, useHours: true, timezone: "Asia/Dubai", workDays: [0, 1, 2], workStart: "08:30", workEnd: "17:00", mode: "least_busy" });
    assert.deepEqual({ enabled: saved.enabled, mode: saved.mode, team: saved.team, sessionNames: saved.sessionNames, maxOpen: saved.maxOpen, timezone: saved.timezone, workDays: saved.workDays, workStart: saved.workStart }, { enabled: true, mode: "least_busy", team: "sales", sessionNames: ["shared-line"], maxOpen: 8, timezone: "Asia/Dubai", workDays: [0, 1, 2], workStart: "08:30" });
    const sams = saved.members.find((m) => m.id === sam.id);
    assert.deepEqual({ team: sams.team, inRotation: sams.inRotation, available: sams.available, openChats: sams.openChats }, { team: "sales", inRotation: true, available: true, openChats: 0 });
    assert.equal(saved.members.find((m) => m.id === ada.id).inRotation, false);
    assert.deepEqual(saved.teams, ["general", "sales", "support"]);
    assert.deepEqual(saved.numbers.map((x) => x.sessionName).sort(), ["sam-line", "shared-line"]);
    assert.equal((await query("SELECT 1 FROM audit_events WHERE tenant_id=$1 AND event_type='assignment.settings_changed'", [tenantId])).rowCount > 0, true, "changes to the rule are on record");
    await rule(); // back to the plain rule for the tests below
  });

  await t.test("new chats go round the rotation in turn, and the person can open theirs and is told", async () => {
    await reset();
    const phones = ["971500000001", "971500000002", "971500000003", "971500000004"];
    for (const ph of phones) await hear("shared-line", ph);
    assert.deepEqual(await owned(sam), ["971500000001", "971500000004"], "round the rotation and back to the first");
    assert.deepEqual(await owned(tina), ["971500000002"]);
    assert.deepEqual(await owned(uma), ["971500000003"]);
    const first = (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND phone='971500000001'", [tenantId])).rows[0];
    assert.equal(first.assigned_to, "Sam", "the name is kept with the id");
    assert.equal((await query("SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND type='assignment' AND conversation_id=$3", [tenantId, sam.id, first.id])).rowCount, 1);
    assert.equal((await request(app).get(`/api/conversations/${first.id}/messages`).set(sam.auth)).status, 200, "the person it went to can open it");
    assert.equal((await request(app).get(`/api/conversations/${first.id}/messages`).set(tina.auth)).status, 404, "someone else's staff still cannot");
    assert.equal((await query("SELECT 1 FROM audit_events WHERE tenant_id=$1 AND event_type='chat.auto_assigned'", [tenantId])).rowCount, 4);
  });

  await t.test("the same chat is not assigned twice, and a manager's choice is respected", async () => {
    await reset();
    const chat = await hear("shared-line", "971500000010");
    assert.equal(chat.assigned_user_id, sam.id);
    // the manager moves it, then the customer writes again: it stays where the manager put it
    assert.equal((await request(app).patch(`/api/conversations/${chat.id}`).set(owner.auth).send({ assignedUserId: tina.id })).status, 200);
    await hear("shared-line", "971500000010");
    assert.equal((await query("SELECT assigned_user_id FROM conversations WHERE id=$1", [chat.id])).rows[0].assigned_user_id, tina.id);
    // and after the manager unassigns it on purpose, the customer's next message does not take it back
    await request(app).patch(`/api/conversations/${chat.id}`).set(owner.auth).send({ assignedTo: "" });
    await hear("shared-line", "971500000010");
    assert.equal((await query("SELECT assigned_user_id FROM conversations WHERE id=$1", [chat.id])).rows[0].assigned_user_id, null);
  });

  await t.test("only the numbers the company chose, never a group, never a chat a person started", async () => {
    await reset();
    assert.equal((await hear("sam-line", "971500000020")).assigned_user_id, null, "a number that is not in the rule");
    assert.equal((await hear("shared-line", "120363000000000001", { group: true })).assigned_user_id, null, "a group is not a person");
    // a person writes first (from the phone or the New chat button), then the customer answers
    await hear("shared-line", "971500000021", { fromMe: true });
    assert.equal((await hear("shared-line", "971500000021")).assigned_user_id, null);
  });

  await t.test("people who are away, or not in the rotation, are skipped; nobody available leaves it unassigned", async () => {
    await reset();
    assert.equal((await request(app).put("/api/assignment/me").set(sam.auth).send({ available: "no" })).status, 400);
    assert.equal((await request(app).put("/api/assignment/me").set(sam.auth).send({ available: false })).status, 200);
    assert.equal((await request(app).get("/api/assignment/me").set(sam.auth)).body.available, false);
    assert.equal((await hear("shared-line", "971500000030")).assigned_user_id, tina.id, "Sam is away, so it goes to the next person");
    await request(app).put("/api/assignment/me").set(tina.auth).send({ available: false });
    await request(app).put("/api/assignment/me").set(uma.auth).send({ available: false });
    assert.equal((await hear("shared-line", "971500000031")).assigned_user_id, null, "nobody is taking chats: it waits for a person, like any unassigned chat");
    await request(app).put("/api/assignment/me").set(sam.auth).send({ available: true });
    assert.equal((await hear("shared-line", "971500000032")).assigned_user_id, sam.id);
    assert.equal((await request(app).get("/api/assignment/me").set(ada.auth)).body.inRotation, false, "an administrator who is not in the rotation is never given chats");
  });

  await t.test("the rule can be limited to one team, and to the least busy person under a limit", async () => {
    await reset();
    await rule({ team: "sales" });
    assert.deepEqual([(await hear("shared-line", "971500000040")).assigned_user_id, (await hear("shared-line", "971500000041")).assigned_user_id, (await hear("shared-line", "971500000042")).assigned_user_id], [sam.id, uma.id, sam.id], "Tina is in support, so she is not in the sales rotation");

    await reset();
    await rule({ mode: "least_busy", team: "", maxOpen: 2 });
    const give = (user, count, base) => Promise.all(Array.from({ length: count }, (_, i) => query("INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,phone,contact_name,assigned_user_id,assigned_to) VALUES(gen_random_uuid()::text,$1,'sam-line',$2,$2,'x',$3,'x')", [tenantId, `${base}${i}`, user.id])));
    await give(sam, 2, "9715000100");
    await give(tina, 1, "9715000200");
    assert.equal((await hear("shared-line", "971500000050")).assigned_user_id, uma.id, "Uma has none open");
    assert.equal((await hear("shared-line", "971500000051")).assigned_user_id, tina.id, "then Tina (one open) before Uma (one open now): tie broken by the rotation");
    // Sam is at the limit of two; Tina and Uma take the rest until they reach it too
    await hear("shared-line", "971500000052");
    await hear("shared-line", "971500000053");
    assert.equal((await hear("shared-line", "971500000054")).assigned_user_id, null, "everyone is at the limit");
    assert.ok(!(await owned(sam)).some((p) => p.startsWith("97150000005")), "Sam never went over the limit");
    // resolving a chat frees a place
    await query("UPDATE conversations SET is_closed=true WHERE tenant_id=$1 AND assigned_user_id=$2", [tenantId, tina.id]);
    assert.equal((await hear("shared-line", "971500000055")).assigned_user_id, tina.id);
  });

  await t.test("a returning customer goes back to the person who has their lead", async () => {
    await reset();
    await rule();
    await query("DELETE FROM contacts WHERE tenant_id=$1", [tenantId]);
    const contact = (await query("INSERT INTO contacts(id,tenant_id,name,phone) VALUES(gen_random_uuid()::text,$1,'Repeat Buyer','971500000060') RETURNING *", [tenantId])).rows[0];
    await createLead({ tenantId, actor: owner, contact, ownerUserId: uma.id });
    const chat = await hear("shared-line", "971500000060");
    assert.equal(chat.assigned_user_id, uma.id, "Uma has their lead");
    // the rotation did not move for it: the next new customer still goes to the first person
    assert.equal((await hear("shared-line", "971500000061")).assigned_user_id, sam.id);
    // if Uma is away, the rotation decides
    await request(app).put("/api/assignment/me").set(uma.auth).send({ available: false });
    await query("DELETE FROM conversations WHERE tenant_id=$1 AND phone='971500000060'", [tenantId]);
    assert.notEqual((await hear("shared-line", "971500000060")).assigned_user_id, uma.id);
    // and a company can switch continuity off
    await request(app).put("/api/assignment/me").set(uma.auth).send({ available: true });
    await rule({ keepOwner: false });
    await query("UPDATE assignment_settings SET last_assigned_user_id=$2 WHERE tenant_id=$1", [tenantId, uma.id]); // the rotation would give the next chat to Sam
    await query("DELETE FROM conversations WHERE tenant_id=$1 AND phone='971500000060'", [tenantId]);
    assert.notEqual((await hear("shared-line", "971500000060")).assigned_user_id, uma.id);
    await rule();
  });

  await t.test("outside working hours nothing is assigned", async () => {
    await reset();
    const today = new Date().getUTCDay();
    await rule({ useHours: true, timezone: "UTC", workDays: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== today), workStart: "00:00", workEnd: "23:59" });
    assert.equal((await hear("shared-line", "971500000070")).assigned_user_id, null, "today is not a working day");
    await rule({ useHours: true, timezone: "UTC", workDays: [0, 1, 2, 3, 4, 5, 6], workStart: "00:00", workEnd: "23:59" });
    assert.ok((await hear("shared-line", "971500000071")).assigned_user_id, "every day, all day");
  });

  await t.test("off means off, and a plan without automations does not run it", async () => {
    await reset();
    await rule({ enabled: false });
    assert.equal((await hear("shared-line", "971500000080")).assigned_user_id, null);
    await rule();
    await query("UPDATE tenants SET plan='free' WHERE id=$1", [tenantId]);
    assert.equal((await hear("shared-line", "971500000081")).assigned_user_id, null, "the Free plan has no automations");
    assert.equal((await request(app).get("/api/assignment").set(owner.auth)).status, 403, "and its screen is not open");
    await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
    assert.ok((await hear("shared-line", "971500000082")).assigned_user_id);
  });

  await t.test("the rule \"assign to a teammate\" now gives them the chat, not just their name on it", async () => {
    await reset();
    await rule({ enabled: false });
    await query("INSERT INTO automations(id,tenant_id,name,trigger_condition,action_type,action_summary,is_enabled) VALUES('a-route',$1,'Route','price','assign_agent','Tina',true)", [tenantId]);
    await handleIncomingMessage({ tenantId, sessionName: "shared-line", msg: { providerMessageId: "route_1", fromMe: false, remoteId: "971500000090@c.us", rawType: "chat", type: "text", text: "what is the price", timestampEpoch: ++epoch, senderName: "Asker", ack: 2 } });
    await pumpAutomations();
    const chat = (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND phone='971500000090'", [tenantId])).rows[0];
    assert.equal(chat.assigned_to, "Tina");
    assert.equal(chat.assigned_user_id, tina.id);
    assert.equal((await request(app).get(`/api/conversations/${chat.id}/messages`).set(tina.auth)).status, 200, "Tina can open it");
    assert.equal((await query("SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND type='assignment' AND conversation_id=$3", [tenantId, tina.id, chat.id])).rowCount, 1, "and was told");
    await query("DELETE FROM automation_executions WHERE tenant_id=$1", [tenantId]);
    await query("DELETE FROM automations WHERE id='a-route'");
  });
});
