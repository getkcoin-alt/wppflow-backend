import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query, withTransaction } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { syncContacts } from "../src/routes/contactRoutes.js";
import { syncConversations } from "../src/services/conversationService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { normalizePhone } from "../src/services/phone.js";
import { up as migrateLabels } from "../src/db/migrations/019_labels_contact_names.js";

test("phone numbers are normalised to the digits WhatsApp uses", () => {
  assert.equal(normalizePhone("+971 50 123 4567"), "971501234567");
  assert.equal(normalizePhone("00971501234567"), "971501234567");
  assert.equal(normalizePhone("(91) 98765-43210"), "919876543210");
  assert.equal(normalizePhone("0501234567"), null, "a local number has no country code");
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone("1234567890123456"), null);
  assert.equal(normalizePhone("123@g.us"), null);
  assert.equal(normalizePhone("call me"), null);
  assert.equal(normalizePhone(""), null);
});

test("contact names, new chats and labels", async (t) => {
  const original = { ...provider };
  t.after(async () => {
    Object.assign(provider, original);
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@labels.test", password: "Password@123", companyName: "Labels Co" });
  const x = await registerTenantAndUser({ name: "Xavier", email: "xavier@labels.test", password: "Password@123", companyName: "Other Co" });
  const tenantId = o.tenant.id;
  const mk = async (name) => (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [name, `${name.toLowerCase()}@labels.test`])).rows[0];
  const sam = await mk("Sam"), tina = await mk("Tina");
  for (const u of [sam, tina]) await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, u.id]);
  await query(
    "INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status) VALUES(gen_random_uuid()::text,$1,'line-olivia',$2,'CONNECTED'),(gen_random_uuid()::text,$1,'line-sam',$3,'CONNECTED'),(gen_random_uuid()::text,$1,'line-off',$2,'DISCONNECTED')",
    [tenantId, o.user.id, sam.id],
  );
  const auth = (u, role, tid = tenantId) => ({ Authorization: `Bearer ${generateAccessToken(u, tid, role)}` });
  const owner = auth(o.user, "owner"), samAuth = auth(sam, "agent"), tinaAuth = auth(tina, "agent"), stranger = auth(x.user, "owner", x.tenant.id);

  let epoch = 1700000000;
  const receive = (session, remote, name, text = "hello") =>
    handleIncomingMessage({
      tenantId,
      sessionName: session,
      msg: { providerMessageId: `true_${remote}_${++epoch}`, fromMe: false, remoteId: remote, rawType: "chat", type: "text", text, timestampEpoch: epoch, senderName: name, ack: 2 },
    });
  const contactOf = async (phone) => (await query("SELECT * FROM contacts WHERE tenant_id=$1 AND phone=$2", [tenantId, phone])).rows[0];
  const chatOf = async (phone) => (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND phone=$2 ORDER BY created_at LIMIT 1", [tenantId, phone])).rows[0];

  await t.test("the name WhatsApp shows is kept apart from the name the team gives", async () => {
    await receive("line-olivia", "919000000001@c.us", "Asha");
    let c = await contactOf("919000000001");
    assert.equal(c.name, "Asha");
    assert.equal(c.whatsapp_name, "Asha");
    assert.equal(c.name_edited, false);

    const renamed = await request(app).patch(`/api/contacts/${c.id}`).set(owner).send({ name: "Asha Kapoor (Delhi store)" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.contact.name, "Asha Kapoor (Delhi store)");
    assert.equal(renamed.body.contact.whatsappName, "Asha");
    assert.equal(renamed.body.contact.nameEdited, true);
    assert.equal((await chatOf("919000000001")).contact_name, "Asha Kapoor (Delhi store)", "the Inbox shows the same name");
    const history = (await query("SELECT metadata FROM audit_events WHERE tenant_id=$1 AND event_type='contact.renamed'", [tenantId])).rows;
    assert.equal(history.length, 1, "each rename is written to the audit log");
    assert.deepEqual({ from: history[0].metadata.from, to: history[0].metadata.to }, { from: "Asha", to: "Asha Kapoor (Delhi store)" });

    // saving a form with the same name changes nothing and writes nothing
    await request(app).patch(`/api/contacts/${c.id}`).set(owner).send({ name: "Asha Kapoor (Delhi store)", email: "asha@shop.test" });
    assert.equal((await query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND event_type='contact.renamed'", [tenantId])).rows[0].n, 1);
  });

  await t.test("WhatsApp updates never overwrite a name the team typed, and the old messages stay", async () => {
    const before = (await query("SELECT count(*)::int n FROM messages WHERE tenant_id=$1", [tenantId])).rows[0].n;
    provider.getContacts = async () => [{ id: { _serialized: "919000000001@c.us" }, name: "Asha K" }];
    await syncContacts(tenantId, "line-olivia");
    await receive("line-olivia", "919000000001@c.us", "Asha K", "second message");
    await syncConversations({ tenantId, sessionName: "line-olivia", remote: [{ id: "919000000001@c.us", phone: "919000000001@c.us", contactName: "Asha K", unreadCount: 1, isGroup: false, lastActiveEpoch: epoch, lastMessage: { text: "second message" } }] });
    const c = await contactOf("919000000001");
    assert.equal(c.name, "Asha Kapoor (Delhi store)");
    assert.equal(c.whatsapp_name, "Asha K", "WhatsApp's own name is still tracked");
    assert.equal((await chatOf("919000000001")).contact_name, "Asha Kapoor (Delhi store)");
    assert.equal((await query("SELECT count(*)::int n FROM messages WHERE tenant_id=$1", [tenantId])).rows[0].n, before + 1);
  });

  await t.test("a name that was only ever the number follows WhatsApp once it is known, and typing WhatsApp's name hands it back", async () => {
    await receive("line-olivia", "919000000002@c.us", "");
    let c = await contactOf("919000000002");
    assert.equal(c.name, "919000000002");
    await receive("line-olivia", "919000000002@c.us", "Bala");
    c = await contactOf("919000000002");
    assert.equal(c.name, "Bala");
    assert.equal((await chatOf("919000000002")).contact_name, "Bala");

    const typed = await request(app).patch(`/api/contacts/${c.id}`).set(owner).send({ name: "Bala R" });
    assert.equal(typed.body.contact.nameEdited, true);
    const back = await request(app).patch(`/api/contacts/${c.id}`).set(owner).send({ resetName: true });
    assert.equal(back.body.contact.name, "Bala");
    assert.equal(back.body.contact.nameEdited, false);
    assert.equal((await chatOf("919000000002")).contact_name, "Bala");
  });

  await t.test("another company cannot rename, read or label this contact", async () => {
    const c = await contactOf("919000000001");
    assert.equal((await request(app).patch(`/api/contacts/${c.id}`).set(stranger).send({ name: "Mine now" })).status, 404);
    assert.equal((await request(app).get(`/api/contacts/${c.id}`).set(stranger)).status, 404);
    assert.equal((await request(app).delete(`/api/contacts/${c.id}`).set(stranger)).status, 200, "deleting scopes to the caller's own company, so nothing happens");
    assert.ok(await contactOf("919000000001"));
  });

  await t.test("a number is one person: typed numbers are tidied, duplicates point at the existing contact", async () => {
    const created = await request(app).post("/api/contacts").set(owner).send({ name: "Chitra", phone: "+91 90000 00003" });
    assert.equal(created.status, 201);
    assert.equal(created.body.contact.phone, "919000000003");
    const again = await request(app).post("/api/contacts").set(owner).send({ name: "Somebody else", phone: "919000000003" });
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already saved as "Chitra"/);
    assert.equal(again.body.contactId, created.body.contact.id);
    assert.equal((await contactOf("919000000003")).name, "Chitra", "the existing name is not overwritten");
    const bad = await request(app).post("/api/contacts").set(owner).send({ name: "Local", phone: "0501234567" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /country code/);

    const look = await request(app).get("/api/contacts/lookup?phone=%2B91%2090000%2000003").set(owner);
    assert.equal(look.body.valid, true);
    assert.equal(look.body.contact.name, "Chitra");
    const unknown = await request(app).get("/api/contacts/lookup?phone=971500000009").set(owner);
    assert.equal(unknown.body.contact, null);
    assert.equal((await request(app).get("/api/contacts/lookup?phone=abc").set(owner)).body.valid, false);
    assert.equal((await request(app).get("/api/contacts/lookup?phone=919000000003").set(stranger)).body.contact, null, "lookup stays inside the company");
  });

  await t.test("a new chat from a typed number: checked, on a number the person may use, and warns when nobody agreed", async () => {
    const asked = [];
    provider.checkNumber = async (tenant, session, phone) => {
      asked.push(phone);
      return phone === "971500000404" ? { checked: true, exists: false } : phone === "5511987654321" ? { checked: true, exists: true, jid: "551187654321@c.us" } : { checked: true, exists: true, jid: `${phone}@c.us` };
    };
    const start = (who, body) => request(app).post("/api/conversations").set(who).send(body);

    assert.equal((await start(owner, { phone: "0501234567", sessionName: "line-olivia" })).status, 400);
    assert.equal((await start(owner, { phone: "971500000404", sessionName: "line-olivia" })).status, 422, "a number that is not on WhatsApp");
    const offline = await start(owner, { phone: "971500000005", sessionName: "line-off" });
    assert.equal(offline.status, 409);
    assert.match(offline.body.message, /not connected/);
    assert.equal((await start(samAuth, { phone: "971500000005", sessionName: "line-olivia" })).status, 404, "staff cannot send from a teammate's number");
    assert.equal((await start(owner, { phone: "971500000005", sessionName: "nope" })).status, 404);

    const ok = await start(owner, { phone: "+971 50 000 0005", name: "Mariam", sessionName: "line-olivia" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.chat.contactName, "Mariam");
    assert.equal(ok.body.chat.channel, "line-olivia");
    assert.equal(ok.body.chat.phone, "971500000005");
    assert.equal(ok.body.contactCreated, true);
    assert.equal(ok.body.optedIn, null, "nobody has recorded permission yet");
    assert.equal((await contactOf("971500000005")).name_edited, true);

    const second = await start(owner, { phone: "971500000005", sessionName: "line-olivia" });
    assert.equal(second.body.chat.id, ok.body.chat.id, "the same chat is opened again");
    assert.equal(second.body.contactCreated, false);

    await query("INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,'971500000005',true,'test')", [tenantId]);
    assert.equal((await start(owner, { phone: "971500000005", sessionName: "line-olivia" })).body.optedIn, true);

    const own = await start(samAuth, { phone: "971500000006", sessionName: "line-sam" });
    assert.equal(own.status, 201);
    assert.equal(own.body.chat.contactName, "+971500000006", "an unnamed contact is shown by its number");

    const real = await start(owner, { phone: "5511987654321", sessionName: "line-olivia" });
    assert.equal(real.body.chat.phone, "551187654321", "WhatsApp's own address for the number is used");

    const byContact = await start(owner, { contactId: (await contactOf("919000000003")).id, sessionName: "line-olivia" });
    assert.equal(byContact.status, 201);
    assert.equal(byContact.body.chat.contactName, "Chitra");
    assert.equal((await request(app).post("/api/conversations").set(stranger).send({ contactId: (await contactOf("919000000003")).id, sessionName: "line-olivia" })).status, 404);
  });

  let vip, cold;
  await t.test("labels: anyone can create one, only managers rename or delete, and names are unique per company", async () => {
    const made = await request(app).post("/api/labels").set(samAuth).send({ name: "VIP", color: "red" });
    assert.equal(made.status, 201);
    vip = made.body.label;
    assert.deepEqual({ name: vip.name, color: vip.color }, { name: "VIP", color: "red" });
    cold = (await request(app).post("/api/labels").set(owner).send({ name: "Cold" })).body.label;
    assert.ok(cold.id);
    const dup = await request(app).post("/api/labels").set(owner).send({ name: "  vip  " });
    assert.equal(dup.status, 409);
    assert.equal((await request(app).post("/api/labels").set(owner).send({ name: "" })).status, 400);
    assert.equal((await request(app).post("/api/labels").set(owner).send({ name: "x".repeat(41) })).status, 400);
    assert.equal((await request(app).post("/api/labels").set(owner).send({ name: "Odd", color: "chartreuse" })).status, 400);
    // the same name in another company is a different label
    assert.equal((await request(app).post("/api/labels").set(stranger).send({ name: "VIP" })).status, 201);

    assert.equal((await request(app).patch(`/api/labels/${vip.id}`).set(samAuth).send({ name: "Gold" })).status, 403);
    assert.equal((await request(app).delete(`/api/labels/${vip.id}`).set(samAuth)).status, 403);
    const list = (await request(app).get("/api/labels").set(tinaAuth)).body;
    assert.deepEqual(list.labels.map((l) => l.name), ["Cold", "VIP"]);
    assert.equal((await request(app).get("/api/labels").set(stranger)).body.labels.length, 1, "labels never leak between companies");
    assert.equal((await request(app).patch(`/api/labels/${vip.id}`).set(stranger).send({ name: "Mine" })).status, 404);
  });

  await t.test("tagging many contacts at once, with the label names mirrored on the contact", async () => {
    const ids = [];
    for (const p of ["919000000001", "919000000002", "919000000003"]) ids.push((await contactOf(p)).id);
    const res = await request(app).post("/api/labels/apply").set(samAuth).send({ contactIds: ids, add: [vip.id] });
    assert.equal(res.status, 200);
    assert.equal(res.body.updated, 3);
    assert.deepEqual((await contactOf("919000000002")).tags, ["VIP"]);
    await request(app).post("/api/labels/apply").set(owner).send({ contactIds: [ids[0]], add: [cold.id] });
    assert.deepEqual((await contactOf("919000000001")).tags, ["Cold", "VIP"]);
    await request(app).post("/api/labels/apply").set(owner).send({ contactIds: [ids[2]], remove: [vip.id] });
    assert.deepEqual((await contactOf("919000000003")).tags, []);
    assert.equal((await query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND event_type='labels.applied'", [tenantId])).rows[0].n, 3);

    assert.equal((await request(app).post("/api/labels/apply").set(owner).send({ contactIds: [], add: [vip.id] })).status, 400);
    assert.equal((await request(app).post("/api/labels/apply").set(owner).send({ contactIds: ids })).status, 400);
    assert.equal((await request(app).post("/api/labels/apply").set(owner).send({ contactIds: ids, add: ["not-a-label"] })).status, 404);
    assert.equal((await request(app).post("/api/labels/apply").set(stranger).send({ contactIds: ids, add: [vip.id] })).status, 404, "another company's contacts and labels are out of reach");
    assert.deepEqual((await contactOf("919000000002")).tags, ["VIP"], "nothing changed");
  });

  await t.test("a contact's labels can be set from the contact, by id or by name, and show with the contact", async () => {
    const c = await contactOf("919000000003");
    const set = await request(app).patch(`/api/contacts/${c.id}`).set(owner).send({ labelIds: [cold.id, vip.id] });
    assert.deepEqual(set.body.contact.labels.map((l) => l.name), ["Cold", "VIP"]);
    assert.equal(set.body.contact.labels[1].color, "red");
    const byName = await request(app).patch(`/api/contacts/${c.id}`).set(owner).send({ tags: ["Cold", "Wholesale"] });
    assert.deepEqual(byName.body.contact.labels.map((l) => l.name), ["Cold", "Wholesale"]);
    assert.ok((await request(app).get("/api/labels").set(owner)).body.labels.some((l) => l.name === "Wholesale"), "a new name becomes a label");
    assert.equal((await request(app).patch(`/api/contacts/${c.id}`).set(owner).send({ labelIds: ["nope"] })).status, 404);
    await request(app).patch(`/api/contacts/${c.id}`).set(owner).send({ labelIds: [] });
    assert.deepEqual((await contactOf("919000000003")).tags, []);
  });

  await t.test("filter contacts by label: any, all, or none", async () => {
    const names = async (qs) => (await request(app).get(`/api/contacts?${qs}`).set(owner)).body.contacts.map((c) => c.phone).sort();
    assert.deepEqual(await names(`label=${vip.id}`), ["919000000001", "919000000002"]);
    assert.deepEqual(await names(`label=${cold.id}`), ["919000000001"]);
    assert.deepEqual(await names(`label=${vip.id},${cold.id}`), ["919000000001", "919000000002"], "any of them");
    assert.deepEqual(await names(`label=${vip.id},${cold.id}&labelMode=all`), ["919000000001"], "all of them");
    assert.ok((await names("label=none")).includes("919000000003"));
    assert.ok(!(await names("label=none")).includes("919000000001"));
    assert.deepEqual(await names(`label=${vip.id}&search=Bala`), ["919000000002"], "with a search");
    const x2 = (await request(app).get(`/api/contacts?label=${vip.id}`).set(stranger)).body.contacts;
    assert.deepEqual(x2, [], "another company's request finds nothing");
  });

  await t.test("the chat list carries each person's labels and filters by them with assignee, number and recent activity", async () => {
    await receive("line-sam", "919000000010@c.us", "Dev");
    const dev = await contactOf("919000000010");
    await request(app).post("/api/labels/apply").set(owner).send({ contactIds: [dev.id], add: [vip.id] });
    const chats = async (who, qs = "") => (await request(app).get(`/api/conversations${qs}`).set(who)).body.conversations;
    const all = await chats(owner);
    const asha = all.find((c) => c.phone === "919000000001");
    assert.deepEqual(asha.labels.map((l) => l.name), ["Cold", "VIP"]);
    assert.deepEqual(all.find((c) => c.phone === "919000000003")?.labels ?? [], []);

    const phones = async (who, qs) => (await chats(who, qs)).map((c) => c.phone).sort();
    assert.deepEqual(await phones(owner, `?labels=${vip.id}`), ["919000000001", "919000000002", "919000000010"]);
    assert.deepEqual(await phones(owner, `?labels=${vip.id},${cold.id}&labelMode=all`), ["919000000001"]);
    assert.deepEqual(await phones(owner, `?labels=${vip.id}&sessionName=line-sam`), ["919000000010"], "a label and a number");
    assert.deepEqual(await phones(samAuth, `?labels=${vip.id}`), ["919000000010"], "staff only ever see their own number's chats");

    const conv = await chatOf("919000000001");
    await request(app).patch(`/api/conversations/${conv.id}`).set(owner).send({ assignedUserId: sam.id });
    assert.deepEqual(await phones(owner, `?assigned=${sam.id}`), ["919000000001"]);
    assert.ok(!(await phones(owner, "?assigned=none")).includes("919000000001"));
    assert.ok((await phones(owner, "?assigned=none")).includes("919000000002"));
    assert.deepEqual(await phones(samAuth, `?assigned=me&labels=${cold.id}`), ["919000000001"], "assigned to me, with a label");

    await query("UPDATE conversations SET last_active_epoch=extract(epoch FROM now())::bigint-40*86400 WHERE tenant_id=$1 AND phone='919000000002'", [tenantId]);
    await query("UPDATE conversations SET last_active_epoch=extract(epoch FROM now())::bigint WHERE tenant_id=$1 AND phone='919000000001'", [tenantId]);
    const recent = await phones(owner, `?labels=${vip.id}&activeDays=7`);
    assert.ok(recent.includes("919000000001"));
    assert.ok(!recent.includes("919000000002"), "quiet for 40 days");
    assert.ok((await phones(owner, `?labels=${vip.id}&activeDays=60`)).includes("919000000002"));

    const one = await request(app).get(`/api/conversations/${conv.id}`).set(owner);
    assert.deepEqual(one.body.conversation.labels.map((l) => l.name), ["Cold", "VIP"]);
  });

  await t.test("renaming or deleting a label updates every contact that has it", async () => {
    const renamed = await request(app).patch(`/api/labels/${vip.id}`).set(owner).send({ name: "Gold", color: "amber" });
    assert.equal(renamed.status, 200);
    assert.deepEqual((await contactOf("919000000002")).tags, ["Gold"]);
    assert.equal((await request(app).patch(`/api/labels/${vip.id}`).set(owner).send({ name: "cold" })).status, 409, "no two labels share a name");
    assert.equal((await query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND event_type='label.renamed'", [tenantId])).rows[0].n, 1);

    assert.equal((await request(app).delete(`/api/labels/${cold.id}`).set(owner)).status, 200);
    assert.deepEqual((await contactOf("919000000001")).tags, ["Gold"]);
    assert.equal((await query("SELECT count(*)::int n FROM contacts WHERE tenant_id=$1", [tenantId])).rows[0].n > 5, true, "no contact is deleted with a label");
    assert.equal((await request(app).delete(`/api/labels/${cold.id}`).set(owner)).status, 404);
  });

  await t.test("a spreadsheet's tags become labels without wiping the ones a contact has", async () => {
    const res = await request(app).post("/api/contacts/import").set(owner).send({
      rows: [
        { name: "Esha", phone: "971500000020", tags: "Gold;Event 2026" },
        { name: "Asha Again", phone: "919000000001" },
        { name: "No number" },
      ],
    });
    assert.equal(res.body.imported, 2);
    assert.equal(res.body.skippedCount, 1);
    assert.deepEqual((await contactOf("971500000020")).tags, ["Event 2026", "Gold"]);
    assert.deepEqual((await contactOf("919000000001")).tags, ["Gold"], "a file without tags leaves the labels alone");
    assert.equal((await chatOf("919000000001")).contact_name, "Asha Again", "a name in a file is a decision, and the chat follows it");
  });

  await t.test("the old free-text tags become labels when the upgrade runs, and nobody loses one", async () => {
    const other = await registerTenantAndUser({ name: "Upg", email: "upg@labels.test", password: "Password@123", companyName: "Upgrade Co" });
    const tid = other.tenant.id;
    await query(
      `INSERT INTO contacts(id,tenant_id,name,phone,tags) VALUES('u1',$1,'One','15550001',$2),('u2',$1,'Two','15550002',$3),('u3',$1,'Three','15550003','[]')`,
      [tid, JSON.stringify(["VIP", "  Lead  "]), JSON.stringify(["vip", "Wholesale", ""])],
    );
    await withTransaction((c) => migrateLabels(c));
    const labels = (await query("SELECT name,color FROM labels WHERE tenant_id=$1 ORDER BY lower(name)", [tid])).rows;
    assert.deepEqual(labels.map((l) => l.name), ["Lead", "VIP", "Wholesale"], "one label per name, whatever the capitals");
    assert.ok(labels.every((l) => ["slate", "red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink"].includes(l.color)));
    const has = async (id) => (await query("SELECT l.name FROM contact_labels cl JOIN labels l ON l.id=cl.label_id WHERE cl.contact_id=$1 ORDER BY l.name", [id])).rows.map((r) => r.name);
    assert.deepEqual(await has("u1"), ["Lead", "VIP"]);
    assert.deepEqual(await has("u2"), ["VIP", "Wholesale"]);
    assert.deepEqual(await has("u3"), []);
    assert.equal((await query("SELECT whatsapp_name FROM contacts WHERE id='u1'")).rows[0].whatsapp_name, "One");
    // running the upgrade again changes nothing
    await withTransaction((c) => migrateLabels(c));
    assert.equal((await query("SELECT count(*)::int n FROM labels WHERE tenant_id=$1", [tid])).rows[0].n, 3);
  });
});
