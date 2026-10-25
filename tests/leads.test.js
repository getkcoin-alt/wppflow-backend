import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io as serverIo } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { pumpAutomations } from "../src/services/automationService.js";
import { pumpLeadReminders, PRESETS } from "../src/services/leadService.js";
import { closeSessions } from "../src/services/sessionService.js";

test("The sales pipeline: leads, steps, follow-ups, and who can see what", async (t) => {
  const emitted = [];
  const recorder = {
    to(room) {
      const rooms = [room];
      const chain = { to: (r) => (rooms.push(r), chain), emit: (event, payload) => emitted.push({ rooms, event, payload }) };
      return chain;
    },
  };
  app.set("io", recorder);
  t.after(async () => {
    app.set("io", serverIo);
    await closeSessions(serverIo);
    serverIo.close();
  });

  // A company on Growth with an owner, an admin, and two agents who each have their own number.
  const o = await registerTenantAndUser({ name: "Olivia Owner", email: "olivia@leads.test", password: "Password@123", companyName: "Leads Co" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const person = async (name, email, role) => {
    const u = (await registerTenantAndUser({ name, email, password: "Password@123", companyName: `${name}'s own` })).user;
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)", [tenantId, u.id, role]);
    return { ...u, auth: { Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` } };
  };
  const owner = { ...o.user, auth: { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` } };
  const admin = await person("Ada Admin", "ada@leads.test", "admin");
  const sam = await person("Sam Agent", "sam@leads.test", "agent");
  const tina = await person("Tina Agent", "tina@leads.test", "agent");
  for (const [name, who] of [["sam-line", sam], ["tina-line", tina], ["front-desk", owner]])
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status) VALUES(gen_random_uuid()::text,$1,$2,$3,'CONNECTED')", [tenantId, name, who.id]);

  let n = 0;
  // A customer writes on one of the numbers: this makes the contact and the chat, as in real life.
  const customer = async (phone, name, line = "sam-line", text = "hello") => {
    n += 1;
    await handleIncomingMessage({
      tenantId,
      sessionName: line,
      msg: { providerMessageId: `true_${phone}@c.us_${n}`, fromMe: false, remoteId: `${phone}@c.us`, rawType: "chat", type: "text", text, timestampEpoch: Math.floor(Date.now() / 1000) + n, senderName: name, ack: 2 },
    });
    const contact = (await query("SELECT id FROM contacts WHERE tenant_id=$1 AND phone=$2", [tenantId, phone])).rows[0].id;
    const chat = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND contact_id=$2 AND session_name=$3", [tenantId, contact, line])).rows[0].id;
    return { contact, chat };
  };
  const get = (path, who = owner) => request(app).get(`/api/leads${path}`).set(who.auth);
  const post = (path, body, who = owner) => request(app).post(`/api/leads${path}`).set(who.auth).send(body);
  const patch = (path, body, who = owner) => request(app).patch(`/api/leads${path}`).set(who.auth).send(body);
  const stages = async () => (await get("/settings")).body.stages;
  const stageId = async (name) => (await stages()).find((s) => s.name === name).id;
  const ids = (list) => list.map((l) => l.id);

  await t.test("it belongs to the plans that include it", async () => {
    assert.equal((await request(app).get("/api/leads/board")).status, 401);
    await query("UPDATE tenants SET plan='Starter' WHERE id=$1", [tenantId]);
    const locked = await get("/board");
    assert.equal(locked.status, 403);
    assert.match(locked.body.message, /The sales pipeline isn't included in your Starter plan/);
    await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
    assert.equal((await get("/board")).status, 200);
    const caps = (await request(app).get("/api/workspace/capabilities").set(owner.auth)).body;
    assert.equal(caps.plan.features.leads, true);
  });

  await t.test("the pipeline starts with seven steps, ready to use", async () => {
    const res = await get("/settings");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stages.map((s) => [s.name, s.kind]), [["New", "open"], ["Contacted", "open"], ["Qualified", "open"], ["Proposal", "open"], ["Negotiation", "open"], ["Won", "won"], ["Lost", "lost"]]);
    assert.equal(res.body.currency, "AED");
    assert.deepEqual(res.body.presets.map((p) => p.id), Object.keys(PRESETS));
    assert.deepEqual(res.body.autoCreate, { exists: false, enabled: false });
    const board = (await get("/board")).body;
    assert.equal(board.stages.length, 7);
    assert.deepEqual(board.totals, { open: 0, openValue: 0, won: 0 });
  });

  let aisha, bilal, aishaLead;
  await t.test("a lead is made from a chat, takes its number, and a contact has only one open lead", async () => {
    aisha = await customer("971500000001", "Aisha Khan", "sam-line");
    const res = await post("", { conversationId: aisha.chat, value: 12000 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    aishaLead = res.body.lead;
    assert.deepEqual([aishaLead.stageName, aishaLead.status, aishaLead.value, aishaLead.sessionName, aishaLead.source, aishaLead.contactName], ["New", "open", 12000, "sam-line", "chat", "Aisha Khan"]);
    assert.equal(aishaLead.title, "Aisha Khan", "with no title it is named after the person");
    assert.equal(aishaLead.conversationId, aisha.chat);
    assert.equal(aishaLead.lastMessage.text, "hello");
    const again = await post("", { conversationId: aisha.chat, value: 5 });
    assert.deepEqual([again.status, again.body.existing, again.body.lead.id], [200, true, aishaLead.id], "the same lead, not a second one");
    assert.equal((await query("SELECT count(*)::int AS n FROM leads WHERE tenant_id=$1", [tenantId])).rows[0].n, 1);
    const events = emitted.filter((e) => e.event === "lead:changed");
    assert.ok(events.length >= 1, "open boards are told");
    assert.ok(events[0].rooms.includes(`tenant:${tenantId}:managers`));
  });

  await t.test("a group chat is never a lead, and a missing contact is refused", async () => {
    n += 1;
    await handleIncomingMessage({ tenantId, sessionName: "sam-line", msg: { providerMessageId: `true_group_${n}`, fromMe: false, remoteId: "120363000000000009@g.us", isGroup: true, groupName: "Friends", rawType: "chat", type: "text", text: "hi", timestampEpoch: Math.floor(Date.now() / 1000), senderName: "Zed", ack: 2 } });
    const group = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND is_group", [tenantId])).rows[0].id;
    const res = await post("", { conversationId: group });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /group chat can't be a lead/);
    assert.equal((await post("", { contactId: "nope" })).status, 404);
  });

  await t.test("a lead can also be made from a contact, with a title and an expected close date", async () => {
    bilal = await customer("971500000002", "Bilal", "tina-line");
    const res = await post("", { contactId: bilal.contact, title: "2BR Marina", value: 950000, expectedClose: "2026-12-31", ownerUserId: tina.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const lead = res.body.lead;
    assert.deepEqual([lead.title, lead.value, lead.expectedClose, lead.ownerName, lead.sessionName, lead.source], ["2BR Marina", 950000, "2026-12-31", "Tina Agent", "tina-line", "manual"]);
    assert.equal((await post("", { contactId: bilal.contact, value: -5 })).body.existing, true, "the open lead is returned before anything is checked");
    const bad = await post("", { contactId: (await customer("971500000003", "Chitra", "front-desk")).contact, value: -5 });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /value between 0 and/);
  });

  await t.test("staff see their own leads and those on their own number, never a colleague's", async () => {
    const all = ids((await get("/")).body.leads);
    assert.equal(all.length, 2);
    const samSees = (await get("/", sam)).body.leads;
    assert.deepEqual(samSees.map((l) => l.contactName), ["Aisha Khan"], "Sam's number");
    const tinaSees = (await get("/", tina)).body.leads;
    assert.deepEqual(tinaSees.map((l) => l.contactName), ["Bilal"], "Tina's number, and she owns it too");
    assert.equal((await get(`/${aishaLead.id}`, tina)).status, 404, "Tina can't open Sam's lead");
    assert.equal((await get(`/${aishaLead.id}`, sam)).status, 200);
    assert.equal((await get(`/${aishaLead.id}`, admin)).status, 200, "managers see all");
    assert.equal((await patch(`/${aishaLead.id}`, { value: 1 }, tina)).status, 404);
    assert.equal((await post(`/${aishaLead.id}/move`, { stageId: await stageId("Contacted") }, tina)).status, 404);
    const board = (await get("/board", tina)).body;
    assert.equal(board.totals.open, 1, "the board counts only what she can see");
    assert.equal(board.stages[0].leads.length, 1);
  });

  await t.test("someone who can't see a contact's number can still make a lead, and it is theirs", async () => {
    const carol = await customer("971500000004", "Carol", "front-desk");
    const res = await post("", { contactId: carol.contact, title: "Carol's deal" }, sam);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual([res.body.lead.ownerName, res.body.lead.sessionName], ["Sam Agent", null]);
    assert.ok(ids((await get("/", sam)).body.leads).includes(res.body.lead.id), "Sam can see what he made");
    assert.equal((await get(`/${res.body.lead.id}`, tina)).status, 404);
    const other = await post("", { contactId: carol.contact }, sam);
    assert.deepEqual([other.status, other.body.existing], [200, true], "she already has an open lead");
    assert.equal((await query("SELECT assigned_user_id FROM conversations WHERE id=$1", [carol.chat])).rows[0].assigned_user_id, sam.id, "her chat is his now");
    const tinaNumber = await customer("971500000005", "Dev", "front-desk");
    const denied = await post("", { contactId: tinaNumber.contact, sessionName: "tina-line" }, sam);
    assert.equal(denied.status, 404, "he can't use a number that isn't his");
    await query("DELETE FROM leads WHERE id=$1", [res.body.lead.id]);
  });

  await t.test("moving a lead between steps keeps a record, puts it on top, and can slot it between two others", async () => {
    const contacted = await stageId("Contacted");
    const mk = async (phone, name) => (await post("", { contactId: (await customer(phone, name, "front-desk")).contact, title: name })).body.lead;
    const a = await mk("971500000010", "A"), b = await mk("971500000011", "B"), c = await mk("971500000012", "C");
    for (const l of [a, b, c]) assert.equal((await post(`/${l.id}/move`, { stageId: contacted })).status, 200);
    const order = async () => (await get(`/board`)).body.stages.find((s) => s.id === contacted).leads.map((l) => l.title);
    assert.deepEqual(await order(), ["C", "B", "A"], "the one moved last is on top");
    assert.equal((await post(`/${a.id}/move`, { stageId: contacted, beforeLeadId: c.id })).status, 200);
    assert.deepEqual(await order(), ["A", "C", "B"], "dropped above C");
    assert.equal((await post(`/${b.id}/move`, { stageId: contacted, beforeLeadId: c.id })).status, 200);
    assert.deepEqual(await order(), ["A", "B", "C"], "dropped between A and C");
    const history = (await get(`/${a.id}`)).body.timeline.map((e) => [e.type, e.detail.to]);
    assert.deepEqual(history, [["stage", "Contacted"], ["created", undefined]]);
    assert.equal((await post(`/${a.id}/move`, { stageId: "not-a-step" })).status, 400);
    const other = await registerTenantAndUser({ name: "Zed", email: "zed@leads.test", password: "Password@123", companyName: "Elsewhere" });
    await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [other.tenant.id]);
    const foreign = await request(app).get("/api/leads/settings").set({ Authorization: `Bearer ${generateAccessToken(other.user, other.tenant.id, "owner")}` });
    assert.equal((await post(`/${a.id}/move`, { stageId: foreign.body.stages[0].id })).status, 400, "another company's step is not ours");
    for (const l of [a, b, c]) await query("DELETE FROM leads WHERE id=$1", [l.id]);
  });

  await t.test("winning and losing end a lead; moving back reopens it unless the contact has another open lead", async () => {
    const won = await stageId("Won"), lost = await stageId("Lost"), proposal = await stageId("Proposal");
    const res = await post(`/${aishaLead.id}/move`, { stageId: proposal });
    assert.equal(res.body.lead.stageName, "Proposal");
    const winning = await post(`/${aishaLead.id}/move`, { stageId: won });
    assert.deepEqual([winning.body.lead.status, winning.body.lead.stageKind], ["won", "won"]);
    assert.ok(winning.body.lead.closedAt);
    let board = (await get("/board")).body;
    assert.deepEqual([board.totals.won, board.totals.open], [12000, 1], "won money is counted, and the lead has left the open ones");
    const next = await post("", { contactId: aisha.contact, title: "A second deal" });
    assert.equal(next.status, 201, "after a win the same person can have a new lead");
    const reopen = await post(`/${aishaLead.id}/move`, { stageId: proposal });
    assert.equal(reopen.status, 409);
    assert.match(reopen.body.message, /already has another open lead/);
    const losing = await post(`/${next.body.lead.id}/move`, { stageId: lost, lostReason: "Went with a competitor" });
    assert.deepEqual([losing.body.lead.status, losing.body.lead.lostReason], ["lost", "Went with a competitor"]);
    const back = await post(`/${next.body.lead.id}/move`, { stageId: await stageId("New") });
    assert.deepEqual([back.body.lead.status, back.body.lead.lostReason, back.body.lead.closedAt], ["open", "", null], "reopening clears the loss");
    const types = (await get(`/${next.body.lead.id}`)).body.timeline.map((e) => e.type);
    assert.deepEqual(types, ["reopened", "lost", "created"]);
    aishaLead = (await get(`/${aishaLead.id}`)).body.lead;
    await query("DELETE FROM leads WHERE id=$1", [next.body.lead.id]);
    await post(`/${aishaLead.id}/move`, { stageId: await stageId("Qualified") });
  });

  await t.test("the lead's owner and the chat's assignee are the same thing, whichever is changed", async () => {
    const res = await patch(`/${aishaLead.id}`, { ownerUserId: admin.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.lead.ownerName, "Ada Admin");
    const chat = (await query("SELECT assigned_to,assigned_user_id FROM conversations WHERE id=$1", [aisha.chat])).rows[0];
    assert.deepEqual([chat.assigned_to, chat.assigned_user_id], ["Ada Admin", admin.id], "the chat follows the lead");
    const note = (await query("SELECT title FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND type='assignment'", [tenantId, admin.id])).rows;
    assert.ok(note.length >= 1, "and the new owner is told");
    const viaChat = await request(app).patch(`/api/conversations/${aisha.chat}`).set(owner.auth).send({ assignedUserId: sam.id });
    assert.equal(viaChat.status, 200, JSON.stringify(viaChat.body));
    await until(async () => (await get(`/${aishaLead.id}`)).body.lead.ownerName === "Sam Agent");
    const types = (await get(`/${aishaLead.id}`)).body.timeline.filter((e) => e.type === "owner").map((e) => e.detail.to);
    assert.deepEqual(types, ["Sam Agent", "Ada Admin"], "the lead follows the chat, and both are on record");
    assert.equal((await patch(`/${aishaLead.id}`, { ownerUserId: 999999 })).status, 400);
    assert.equal((await patch(`/${aishaLead.id}`, {})).status, 400);
    const val = await patch(`/${aishaLead.id}`, { value: 15000 });
    assert.equal(val.body.lead.value, 15000);
    assert.equal((await get(`/${aishaLead.id}`)).body.timeline[0].type, "value");
  });

  await t.test("follow-ups: set, listed for today, ticked off, and reminded once when due", async () => {
    const hour = 3600_000;
    const add = (body, who = owner) => post(`/${aishaLead.id}/tasks`, body, who);
    assert.equal((await add({ title: "", dueAt: new Date().toISOString() })).status, 400);
    assert.equal((await add({ title: "Call", dueAt: "soon" })).status, 400);
    assert.equal((await add({ title: "Call", dueAt: new Date().toISOString() }, tina)).status, 404, "not for someone who can't see the lead");
    const due = await add({ title: "Send the brochure", dueAt: new Date(Date.now() - hour).toISOString() });
    assert.equal(due.status, 201, JSON.stringify(due.body));
    const later = await add({ title: "Check in", dueAt: new Date(Date.now() + 5 * 24 * hour).toISOString() });
    const task = due.body.tasks.find((x) => x.title === "Send the brochure");
    assert.equal(task.assignedName, "Sam Agent", "it goes to whoever owns the lead");
    assert.equal(later.body.tasks.length, 2);
    const until1 = new Date(Date.now() + hour).toISOString();
    const today = await get(`/tasks?when=today&until=${encodeURIComponent(until1)}`, sam);
    assert.deepEqual(today.body.tasks.map((x) => [x.title, x.contactName]), [["Send the brochure", "Aisha Khan"]]);
    assert.equal(today.body.tasks[0].conversationId, aisha.chat, "it opens the chat");
    assert.equal((await get(`/tasks?when=today&until=${encodeURIComponent(until1)}`, tina)).body.tasks.length, 0, "Tina has none of Sam's");
    assert.equal((await get("/tasks?when=all", owner)).body.tasks.length, 0, "and the owner's own list is empty");
    assert.equal((await get("/tasks?when=all&everyone=1", owner)).body.tasks.length, 2, "managers can ask for everyone's");
    assert.equal((await get("/tasks?when=all&everyone=1", sam)).body.tasks.length, 2, "but staff only ever get theirs");
    assert.equal((await get("/tasks?when=overdue", sam)).body.tasks.length, 1);
    const card = (await get("/board")).body.stages.flatMap((s) => s.leads).find((l) => l.id === aishaLead.id);
    assert.deepEqual([card.openTasks, card.nextTask.title], [2, "Send the brochure"]);

    await pumpLeadReminders(serverIo);
    await pumpLeadReminders(serverIo);
    const reminders = (await query("SELECT user_id,title,body FROM notifications WHERE tenant_id=$1 AND type='lead_task'", [tenantId])).rows;
    assert.deepEqual(reminders.map((r) => [r.user_id, r.title, r.body]), [[sam.id, "Follow-up due: Send the brochure", "Aisha Khan"]], "once, to the right person");
    const moved = await request(app).patch(`/api/leads/tasks/${task.id}`).set(owner.auth).send({ dueAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(moved.status, 200);
    await pumpLeadReminders(serverIo);
    assert.equal((await query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND type='lead_task'", [tenantId])).rows[0].n, 2, "a new time reminds again");

    assert.equal((await request(app).patch(`/api/leads/tasks/${task.id}`).set(tina.auth).send({ done: true })).status, 404);
    const done = await request(app).patch(`/api/leads/tasks/${task.id}`).set(sam.auth).send({ done: true });
    assert.deepEqual([done.status, done.body.task.done], [200, true]);
    assert.equal((await get("/tasks?when=all", sam)).body.tasks.length, 1);
    assert.equal((await request(app).delete(`/api/leads/tasks/${later.body.tasks.find((x) => x.title === "Check in").id}`).set(sam.auth)).status, 200);
    assert.equal((await get(`/${aishaLead.id}`)).body.tasks.length, 1);
  });

  await t.test("finished or lost leads are not reminded about", async () => {
    const lead = (await post("", { contactId: (await customer("971500000020", "Late", "front-desk")).contact })).body.lead;
    await post(`/${lead.id}/tasks`, { title: "Chase", dueAt: new Date(Date.now() - 1000).toISOString() });
    await post(`/${lead.id}/move`, { stageId: await stageId("Lost") });
    const before = (await query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND type='lead_task'", [tenantId])).rows[0].n;
    await pumpLeadReminders(serverIo);
    assert.equal((await query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND type='lead_task'", [tenantId])).rows[0].n, before);
    assert.equal((await get("/tasks?when=all&everyone=1")).body.tasks.filter((x) => x.title === "Chase").length, 0);
  });

  await t.test("the board and the list can be narrowed down", async () => {
    const q = async (path, who = owner) => (await get(path, who)).body.leads.map((l) => l.contactName).sort();
    assert.deepEqual(await q("/?q=aish"), ["Aisha Khan"]);
    assert.deepEqual(await q("/?q=971500000002"), ["Bilal"], "by phone number");
    assert.deepEqual(await q("/?number=tina-line"), ["Bilal"]);
    assert.deepEqual(await q("/?status=open&mine=1", sam), ["Aisha Khan"]);
    const nobody = (await post("", { contactId: (await customer("971500000021", "Nobody's", "front-desk")).contact })).body.lead;
    await post(`/${nobody.id}/tasks`, { title: "Chase", dueAt: new Date(Date.now() - 3600_000).toISOString() });
    assert.deepEqual(await q("/?owner=none&status=open"), ["Nobody's"], "leads nobody owns yet");
    assert.deepEqual(await q("/?overdue=1&status=open"), ["Nobody's"], "leads with a late follow-up");
    assert.deepEqual(await q("/?source=chat"), ["Aisha Khan"]);
    await query("DELETE FROM leads WHERE id=$1", [nobody.id]);
    const page = await get("/?limit=1&offset=1");
    assert.deepEqual([page.body.leads.length, page.body.limit, page.body.offset], [1, 1, 1]);
    assert.ok(page.body.total >= 2, "the total counts every match, not just this page");
  });

  await t.test("managers shape the pipeline: rename, reorder, add, and remove only an empty step", async () => {
    const before = await stages();
    const open = before.filter((s) => s.kind === "open").map((s) => ({ id: s.id, name: s.name }));
    assert.equal((await request(app).put("/api/leads/settings/stages").set(sam.auth).send({ open, wonName: "Won", lostName: "Lost" })).status, 403, "staff can't");
    const put = (body) => request(app).put("/api/leads/settings/stages").set(owner.auth).send(body);
    const busy = before.find((s) => s.leads > 0 && s.kind === "open");
    const without = open.filter((s) => s.id !== busy.id);
    const refused = await put({ open: without, wonName: "Won", lostName: "Lost" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, new RegExp(`Move the leads out of “${busy.name}”`));
    assert.equal((await put({ open: [], wonName: "Won", lostName: "Lost" })).status, 400);
    assert.equal((await put({ open: [{ name: "x".repeat(61) }], wonName: "Won", lostName: "Lost" })).status, 400);
    assert.equal((await put({ open, wonName: "", lostName: "Lost" })).status, 400);
    const empty = before.find((s) => s.kind === "open" && s.leads === 0 && s.name === "Negotiation");
    const reshaped = [open[1], { id: open[0].id, name: "Fresh" }, ...open.slice(2).filter((s) => s.id !== empty.id), { name: "Site visit" }];
    const ok = await put({ open: reshaped, wonName: "Closed", lostName: "Dropped" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.stages.map((s) => s.name), ["Contacted", "Fresh", "Qualified", "Proposal", "Site visit", "Closed", "Dropped"]);
    assert.deepEqual(ok.body.stages.map((s) => s.position), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal((await get(`/${aishaLead.id}`)).body.lead.stageName, "Qualified", "leads stay where they were");
    assert.equal((await put({ open: Array.from({ length: 9 }, (_, i) => ({ name: `S${i}` })), wonName: "Won", lostName: "Lost" })).status, 400);
    assert.equal((await put({ open: [{ id: "someone-elses", name: "x" }], wonName: "Won", lostName: "Lost" })).status, 400);
  });

  await t.test("a template renames the steps in place, so no lead moves", async () => {
    const res = await post("/settings/preset", { preset: "real_estate" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.stages.map((s) => s.name), ["New enquiry", "Contacted", "Viewing booked", "Offer made", "Negotiation", "Deal closed", "Lost"]);
    assert.equal(res.body.pipeline.preset, "real_estate");
    assert.equal((await get(`/${aishaLead.id}`)).body.lead.stageName, "Viewing booked");
    assert.equal((await post("/settings/preset", { preset: "pirate" })).status, 400);
    assert.equal((await post("/settings/preset", { preset: "clinic" }, sam)).status, 403);
  });

  await t.test("a company has a currency, AED or INR", async () => {
    const put = (body, who = owner) => request(app).put("/api/leads/settings/currency").set(who.auth).send(body);
    assert.equal((await put({ currency: "USD" })).status, 400);
    assert.equal((await put({ currency: "INR" }, sam)).status, 403);
    assert.equal((await put({ currency: "INR" })).body.currency, "INR");
    assert.equal((await get("/board")).body.currency, "INR");
  });

  await t.test("a rule can make a lead for every new customer, once, and tells the person whose number it was", async () => {
    const on = await request(app).put("/api/leads/settings/auto-create").set(owner.auth).send({ enabled: true });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.autoCreate, { exists: true, enabled: true });
    const rule = (await query("SELECT * FROM automations WHERE tenant_id=$1 AND template_id='new-lead'", [tenantId])).rows;
    assert.equal(rule.length, 1);
    assert.deepEqual([rule[0].trigger_type, rule[0].action_type, rule[0].is_enabled], ["first_message", "create_lead", true]);
    const fresh = await customer("971500000030", "Newcomer", "sam-line", "hi, do you have flats?");
    await pumpAutomations(serverIo);
    const made = (await get(`/?q=Newcomer`)).body.leads;
    assert.equal(made.length, 1);
    assert.deepEqual([made[0].source, made[0].stageName, made[0].sessionName], ["automation", "New enquiry", "sam-line"]);
    const bell = (await query("SELECT user_id FROM notifications WHERE tenant_id=$1 AND type='lead' AND conversation_id=$2", [tenantId, fresh.chat])).rows;
    assert.deepEqual(bell.map((r) => r.user_id), [sam.id]);
    await customer("971500000030", "Newcomer", "sam-line", "are you there?");
    await pumpAutomations(serverIo);
    assert.equal((await get(`/?q=Newcomer`)).body.leads.length, 1, "no second lead");
    const off = await request(app).put("/api/leads/settings/auto-create").set(owner.auth).send({ enabled: false });
    assert.deepEqual(off.body.autoCreate, { exists: true, enabled: false });
    const stillOne = (await query("SELECT count(*)::int AS n FROM automations WHERE tenant_id=$1 AND template_id='new-lead'", [tenantId])).rows[0].n;
    assert.equal(stillOne, 1, "switching it on again reuses the rule");
    assert.equal((await request(app).put("/api/leads/settings/auto-create").set(owner.auth).send({ enabled: "yes" })).status, 400);
    assert.equal((await request(app).put("/api/leads/settings/auto-create").set(sam.auth).send({ enabled: true })).status, 403);
  });

  await t.test("managers can add many contacts at once, and anyone with an open lead is skipped", async () => {
    const c1 = await customer("971500000040", "Bulk One", "front-desk"), c2 = await customer("971500000041", "Bulk Two", "front-desk");
    await post("", { contactId: c1.contact });
    const res = await post("/bulk", { contactIds: [c1.contact, c2.contact, "missing"] });
    assert.deepEqual([res.status, res.body.created, res.body.skipped], [201, 1, 2]);
    assert.equal((await post("/bulk", { contactIds: [c2.contact] }, sam)).status, 403);
    assert.equal((await post("/bulk", { contactIds: [] })).status, 400);
  });

  await t.test("only managers delete a lead", async () => {
    const lead = (await post("", { contactId: (await customer("971500000050", "Gone", "front-desk")).contact })).body.lead;
    assert.equal((await request(app).delete(`/api/leads/${lead.id}`).set(sam.auth)).status, 403);
    assert.equal((await request(app).delete(`/api/leads/${lead.id}`).set(owner.auth)).status, 200);
    assert.equal((await get(`/${lead.id}`)).status, 404);
  });

  await t.test("a chat can ask whether its customer has an open lead", async () => {
    const c = await customer("971500000070", "Asked About", "sam-line");
    const none = await get(`/chat/${c.chat}`, sam);
    assert.deepEqual([none.status, none.body.lead], [200, null]);
    const made = (await post("", { conversationId: c.chat }, sam)).body.lead;
    assert.equal((await get(`/chat/${c.chat}`, sam)).body.lead.id, made.id);
    assert.equal((await get(`/chat/${c.chat}`, tina)).status, 404, "only for a chat the person can open");
    await post(`/${made.id}/move`, { stageId: await stageId("Deal closed") }, sam);
    assert.equal((await get(`/chat/${c.chat}`, sam)).body.lead, null, "a won lead is no longer open");
  });

  await t.test("deleting a contact keeps the lead and what it was worth", async () => {
    const c = await customer("971500000060", "Soon Deleted", "front-desk");
    const lead = (await post("", { contactId: c.contact, value: 777 })).body.lead;
    await query("DELETE FROM conversations WHERE contact_id=$1", [c.contact]);
    await query("DELETE FROM contacts WHERE id=$1", [c.contact]);
    const kept = (await get(`/${lead.id}`)).body.lead;
    assert.deepEqual([kept.contactName, kept.value, kept.phone, kept.contactId], ["Soon Deleted", 777, "971500000060", null]);
  });
});

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not reached");
}
