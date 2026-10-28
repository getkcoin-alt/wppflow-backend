import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io as serverIo } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { chatTitle, mobileDigits, mobileText, isWhatsAppId, hideId } from "../src/services/personName.js";
import { snippetOf } from "../src/services/searchService.js";
import { scheduleLidResolution, setLidProvider, forgetLidAttempts } from "../src/services/lidService.js";

test("what a person is called: a name, else a mobile number, never a WhatsApp id", () => {
  assert.equal(chatTitle("Asha Rao", "971500000001"), "Asha Rao");
  assert.equal(chatTitle("83752348860497@lid", "83752348860497@lid"), "Unknown contact", "a hidden id is not a name or a number");
  assert.equal(chatTitle("971500000001", "971500000001"), "+971500000001", "a name that is only the number shows as the number");
  assert.equal(chatTitle("971500000001@c.us", "971500000001"), "+971500000001");
  assert.equal(chatTitle("+971 50 000 0001", "971500000001"), "+971500000001", "one format for a number");
  assert.equal(chatTitle("", "971500000001"), "+971500000001");
  assert.equal(chatTitle("", ""), "Unknown contact");
  assert.equal(chatTitle("83752348860497@lid", "971500000001"), "+971500000001", "a real number beats a hidden id");
  assert.equal(chatTitle("120363000000@g.us", "120363000000@g.us", { isGroup: true }), "WhatsApp Group");
  assert.equal(chatTitle("Team chat", "1203@g.us", { isGroup: true }), "Team chat");
  assert.equal(mobileDigits("83752348860497@lid"), "");
  assert.equal(mobileDigits("971500000001:12@c.us"), "971500000001");
  assert.equal(mobileText("1203@g.us"), "");
  assert.ok(isWhatsAppId("1@lid") && isWhatsAppId("1@c.us") && !isWhatsAppId("Asha"));
  assert.equal(hideId("Villa enquiry", ""), "Villa enquiry", "a title somebody typed is left alone");
  assert.equal(hideId("2024-2025", ""), "2024-2025");
  assert.equal(hideId("83752348860497@lid", ""), "Unknown contact");
});

test("a snippet shows the words around the match, cut at word edges", () => {
  const long = "Hello Asha, thank you for visiting the office yesterday. Please send the quotation for the three bedroom villa in Dubai Marina before Friday so that we can decide with the family this weekend";
  const s = snippetOf(long, "villa");
  assert.ok(s.text.startsWith("…") && s.text.endsWith("…"), s.text);
  assert.equal(s.text.slice(s.start, s.start + s.length).toLowerCase(), "villa");
  assert.ok(!/\s{2}/.test(s.text));
  const short = snippetOf("Hello there", "hello");
  assert.deepEqual(short, { text: "Hello there", start: 0, length: 5 });
  assert.equal(snippetOf("no match here", "zzz").start, -1);
});

test("Inbox search: people by name or number in any format, messages by their words, only what the person may see", async (t) => {
  t.after(async () => {
    await closeSessions(serverIo);
    serverIo.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@search.test", password: "Password@123", companyName: "Search Co" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const mk = async (name, role) => {
    const u = (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [name, `${name.toLowerCase()}@search.test`])).rows[0];
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)", [tenantId, u.id, role]);
    return { ...u, auth: { Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` } };
  };
  const sam = await mk("Sam", "agent"), tina = await mk("Tina", "agent");
  const owner = { auth: { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` } };
  await query(
    "INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status) VALUES(gen_random_uuid()::text,$1,'sam-line',$2,'CONNECTED'),(gen_random_uuid()::text,$1,'tina-line',$3,'CONNECTED')",
    [tenantId, sam.id, tina.id],
  );
  let epoch = Math.floor(Date.now() / 1000) - 3600;
  const say = (line, remote, text, name = "Customer", extra = {}) =>
    handleIncomingMessage({ tenantId, sessionName: line, msg: { providerMessageId: `m_${remote}_${++epoch}`, fromMe: false, remoteId: remote, rawType: "chat", type: "text", text, timestampEpoch: epoch, senderName: name, ack: 2, ...extra } });
  const find = async (who, q, extra = "") => (await request(app).get(`/api/conversations/search?q=${encodeURIComponent(q)}${extra}`).set(who.auth)).body;

  await say("sam-line", "919810011122@c.us", "Please send the quotation for the villa", "Asha Rao");
  await say("sam-line", "919810011122@c.us", "Thanks, the price list is great", "Asha Rao");
  await say("sam-line", "971500000001@c.us", "Is the 100% refund real? Also 50_off", "Ben Hall");
  await say("sam-line", "83752348860497@lid", "hello from a hidden number", "");
  await say("tina-line", "919000000002@c.us", "Tina's private villa viewing", "Chitra Das");
  await say("sam-line", "120363000000000001@g.us", "group villa chat", "Someone", { isGroup: true, groupName: "Villa buyers" });

  await t.test("a name is found from any part of it, ignoring case", async () => {
    const r = await find(owner, "rao");
    assert.deepEqual(r.chats.map((c) => c.contactName), ["Asha Rao"]);
  });

  await t.test("a number is found however it is written", async () => {
    for (const q of ["9810011122", "+91 98100 11122", "98100-11122", "91 9810011122", "(981) 001"]) {
      const r = await find(owner, q);
      assert.ok(r.chats.some((c) => c.contactName === "Asha Rao"), `"${q}" finds Asha: ${JSON.stringify(r.chats.map((c) => c.contactName))}`);
    }
    assert.equal((await find(owner, "9810099999")).chats.length, 0);
  });

  await t.test("the hidden id of a person is never shown, and never matched as if it were their number", async () => {
    const all = await request(app).get("/api/conversations").set(owner.auth);
    const hidden = all.body.conversations.find((c) => c.providerChatId === "83752348860497@lid");
    assert.equal(hidden.contactName, "Unknown contact");
    assert.equal(hidden.displayPhone, "");
    assert.ok(!JSON.stringify(all.body.conversations.map((c) => [c.contactName, c.contact_name, c.displayPhone])).includes("@lid"));
    assert.equal((await find(owner, "83752348")).chats.length, 0, "digits of a hidden id do not find the chat");
    assert.equal((await find(owner, "lid")).chats.filter((c) => c.providerChatId.endsWith("@lid")).length, 0);
  });

  await t.test("messages are found by their words, newest first, each with the words around the match and its chat", async () => {
    const r = await find(owner, "villa");
    assert.deepEqual(r.messages.map((m) => m.snippet.text.toLowerCase().includes("villa")), r.messages.map(() => true));
    assert.equal(r.messages.length, 3, "Asha's, Chitra's and the group's");
    const times = r.messages.map((m) => m.timestampEpoch);
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    const asha = r.messages.find((m) => m.chat.contactName === "Asha Rao");
    assert.equal(asha.snippet.text.slice(asha.snippet.start, asha.snippet.start + asha.snippet.length), "villa");
    assert.ok(asha.conversationId && asha.messageId && asha.fromMe === false);
    assert.equal(r.partial, false);
  });

  await t.test("a staff member only finds what is in their own chats", async () => {
    const mine = await find(sam, "villa");
    assert.ok(mine.messages.every((m) => m.chat.sessionName === "sam-line"), "nothing from Tina's number");
    assert.ok(!JSON.stringify(mine).includes("Tina's private"));
    assert.equal((await find(sam, "Chitra")).chats.length, 0);
    assert.equal((await find(tina, "Chitra")).chats.length, 1);
    const line = await find(owner, "villa", "&sessionName=tina-line");
    assert.deepEqual(line.messages.map((m) => m.chat.contactName), ["Chitra Das"], "one number at a time");
  });

  await t.test("another company's messages are never found", async () => {
    const other = await registerTenantAndUser({ name: "Zed", email: "zed@search.test", password: "Password@123", companyName: "Other Co" });
    const zed = { auth: { Authorization: `Bearer ${generateAccessToken(other.user, other.tenant.id, "owner")}` } };
    const r = await find(zed, "villa");
    assert.deepEqual([r.chats.length, r.messages.length], [0, 0]);
  });

  await t.test("% and _ in what is typed are ordinary characters, and a one-letter search asks for more", async () => {
    assert.equal((await find(owner, "100%")).messages.length, 1);
    assert.equal((await find(owner, "50_off")).messages.length, 1);
    assert.equal((await find(owner, "50_of")).messages.length, 1);
    assert.equal((await find(owner, "5%off")).messages.length, 0, "% is not a wildcard");
    const one = await find(owner, "a");
    assert.deepEqual([one.chats.length, one.messages.length], [0, 0]);
  });

  await t.test("team notes are not message search results", async () => {
    const chat = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND phone='919810011122'", [tenantId])).rows[0];
    const note = await request(app).post(`/api/conversations/${chat.id}/notes`).set(sam.auth).send({ text: "secretword in a team note", idempotencyKey: "n1" });
    assert.equal(note.status, 201);
    assert.equal((await find(owner, "secretword")).messages.length, 0);
  });

  await t.test("the chat list search uses the same rules", async () => {
    const l = await request(app).get(`/api/conversations?search=${encodeURIComponent("+91 98100 11122")}`).set(owner.auth);
    assert.deepEqual(l.body.conversations.map((c) => c.contactName), ["Asha Rao"]);
  });

  await t.test("a person's real number is learned from the phone for a hidden id, once, and a failure changes nothing", async () => {
    forgetLidAttempts();
    const hidden = (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND provider_chat_id='83752348860497@lid'", [tenantId])).rows[0];
    let asked = 0;
    setLidProvider({ resolveLidPhone: async () => { asked += 1; throw new Error("offline"); } });
    assert.deepEqual(await scheduleLidResolution([hidden]), []);
    assert.equal((await query("SELECT phone FROM conversations WHERE id=$1", [hidden.id])).rows[0].phone, "83752348860497@lid");
    assert.deepEqual(await scheduleLidResolution([hidden]), [], "not asked again straight away");
    assert.equal(asked, 1);
    forgetLidAttempts();
    setLidProvider({ resolveLidPhone: async () => "971 55 555 0100@c.us".replace(/\D/g, "") });
    assert.deepEqual(await scheduleLidResolution([hidden]), [hidden.id]);
    const after = (await query("SELECT phone,provider_chat_id FROM conversations WHERE id=$1", [hidden.id])).rows[0];
    assert.deepEqual(after, { phone: "971555550100", provider_chat_id: "83752348860497@lid" });
    const shown = await request(app).get("/api/conversations").set(owner.auth);
    assert.equal(shown.body.conversations.find((c) => c.id === hidden.id).contactName, "+971555550100");
    assert.equal((await find(owner, "55 555 0100")).chats.length, 1, "and the new number can be searched");
    setLidProvider(null);
  });
});
