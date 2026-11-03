import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { pumpAutomations } from "../src/services/automationService.js";
import { closeSessions } from "../src/services/sessionService.js";

const flow = (word = "Thanks for choosing work.") => ({
  start: "q",
  nodes: {
    q: { type: "ask", question: "Is this about work or are you family or a friend?", saveAs: "relation", options: [{ key: "work", label: "Work", hints: ["business"] }, { key: "personal", label: "Family or friend", hints: ["family", "friend"] }], next: { work: "w", personal: "p" } },
    w: { type: "say", text: word, next: "m" },
    m: { type: "meeting" },
    p: { type: "say", text: "Lovely to hear from you!", next: "t" },
    t: { type: "notify", who: "owners", channels: ["app"], text: "{{name}} (friend) wrote: {{last_message}}" },
  },
});

test("A workflow's results can be seen, and every change to a rule can be undone", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Karn", email: "karn@insights.test", password: "Password@123", companyName: "Scriza" });
  const other = await registerTenantAndUser({ name: "Zed", email: "zed@insights.test", password: "Password@123", companyName: "Other Co" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id IN ($1,$2)", [tenantId, other.tenant.id]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  const stranger = { Authorization: `Bearer ${generateAccessToken(other.user, other.tenant.id, "owner")}` };
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,phone,status) VALUES(gen_random_uuid()::text,$1,'line',$2,'919971694047','CONNECTED')", [tenantId, o.user.id]);
  const body = (word, name = "Work or family") => ({ name, triggerType: "first_message", actionType: "workflow", config: { workflow: flow(word) } });

  const created = await request(app).post("/api/automations").set(owner).send(body());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.automation.id;
  await request(app).patch(`/api/automations/${id}/toggle`).set(owner);

  let n = 0;
  const hear = async (phone, text) => {
    n += 1;
    await handleIncomingMessage({ tenantId, sessionName: "line", msg: { providerMessageId: `ins_${n}`, fromMe: false, remoteId: `${phone}@c.us`, rawType: "chat", type: "text", text, timestampEpoch: Math.floor(Date.now() / 1000) + n, senderName: "Asha Rao", ack: 2 } });
    await pumpAutomations();
  };
  const insights = async () => (await request(app).get(`/api/automations/${id}/insights`).set(owner)).body.insights;

  await t.test("nothing yet", async () => {
    const i = await insights();
    assert.equal(i.started, 0);
    assert.equal(i.suggestion, "");
    assert.deepEqual(i.questions[0].options.map((o) => [o.label, o.count]), [["Work", 0], ["Family or friend", 0]]);
  });

  await t.test("counts which way people went, who is waiting, and who was handed to a person", async () => {
    await hear("919800000101", "Hello");
    await hear("919800000101", "1");
    await hear("919800000101", "Tuesday 4pm");
    await hear("919800000102", "Hello");
    await hear("919800000102", "2");
    await hear("919800000103", "Hello");
    await hear("919800000103", "friend");
    await hear("919800000104", "Hello"); // never answers
    const i = await insights();
    assert.equal(i.started, 4);
    assert.equal(i.active, 1);
    assert.equal(i.finished, 3);
    assert.equal(i.meetings, 1);
    assert.equal(i.last7Days, 4);
    assert.deepEqual(i.questions[0].options.map((o) => [o.key, o.count]), [["work", 1], ["personal", 2]]);
    assert.equal(i.suggestion, "", "too few people to say anything yet");
  });

  await t.test("when many answers cannot be understood, Riwo says what to do about it", async () => {
    for (const phone of ["919800000105", "919800000106", "919800000107", "919800000108"]) {
      await hear(phone, "Hello");
      await hear(phone, "hmm");
      await hear(phone, "???");
    }
    const i = await insights();
    assert.equal(i.started, 8);
    assert.equal(i.unclear, 4);
    assert.equal(i.handedOver, 4);
    assert.match(i.suggestion, /^4 of 8 people gave an answer Riwo could not understand\. Add the words people really use/);
  });

  await t.test("insights belong to the company: another company sees nothing", async () => {
    assert.equal((await request(app).get(`/api/automations/${id}/insights`).set(stranger)).status, 404);
    assert.deepEqual((await request(app).get(`/api/automations/${id}/versions`).set(stranger)).body.versions, []);
  });

  await t.test("every change keeps what was there before, and the last change can be undone (and the undoing undone)", async () => {
    assert.deepEqual((await request(app).get(`/api/automations/${id}/versions`).set(owner)).body.versions, []);
    const edit = await request(app).put(`/api/automations/${id}`).set(owner).send(body("Thanks, work it is!", "Work or family v2"));
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.automation.config.workflow.nodes.w.text, "Thanks, work it is!");
    const list = (await request(app).get(`/api/automations/${id}/versions`).set(owner)).body.versions;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "Work or family");
    assert.equal(list[0].note, "Before a change");
    const back = await request(app).post(`/api/automations/${id}/versions/${list[0].version}/restore`).set(owner);
    assert.equal(back.status, 200);
    assert.equal(back.body.automation.name, "Work or family");
    assert.equal(back.body.automation.config.workflow.nodes.w.text, "Thanks for choosing work.");
    assert.equal(back.body.automation.isEnabled, true, "going back does not switch it off");
    // the version it replaced is kept, so going back can be undone too
    const after = (await request(app).get(`/api/automations/${id}/versions`).set(owner)).body.versions;
    assert.equal(after.length, 2);
    assert.equal(after[0].name, "Work or family v2");
    assert.equal(after[0].note, "Before going back");
    assert.equal((await request(app).post(`/api/automations/${id}/versions/999/restore`).set(owner)).status, 404);
    assert.equal((await request(app).post(`/api/automations/${id}/versions/${list[0].version}/restore`).set(stranger)).status, 404);
  });

  await t.test("only the last twenty versions are kept", async () => {
    for (let i = 0; i < 24; i++) await request(app).put(`/api/automations/${id}`).set(owner).send(body(`Version ${i}`, `Work or family ${i}`));
    const list = (await request(app).get(`/api/automations/${id}/versions`).set(owner)).body.versions;
    assert.equal(list.length, 20);
    assert.equal(list[0].name, "Work or family 22", "the newest is the rule as it was before the last change");
    assert.equal((await query("SELECT count(*)::int AS n FROM automation_versions WHERE automation_id=$1", [id])).rows[0].n, 20, "the older ones are really deleted, not just hidden");
  });
});
