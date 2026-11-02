import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { pumpCampaigns } from "../src/services/campaignService.js";
import { handleIncomingMessage, deleteMessage } from "../src/services/messageService.js";
import { personalise } from "../src/services/templating.js";
import { closeSessions } from "../src/services/sessionService.js";

test("wording variations are only resolved when the broadcast has them switched on", () => {
  assert.equal(personalise("{Hello|Hello} {{first_name}}", { name: "Asha Rao" }), "Hello Asha");
  assert.equal(personalise("{Hello|Hello} {{first_name}}", { name: "Asha Rao", spintax: false }), "{Hello|Hello} Asha");
  assert.equal(personalise("Use {{name}} and {braces}", { name: "Asha" }), "Use Asha and {braces}", "braces without a choice are left alone");
});

test("Review fixes: who may call the API, honest deletes, batches that pause, and groups of a sane size", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@review.test", password: "Password@123", companyName: "Review Co" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status) VALUES(gen_random_uuid()::text,$1,'shop',$2,'CONNECTED')", [tenantId, o.user.id]);

  await t.test("a page on somebody else's *.vercel.app address is not let in", async () => {
    const stranger = await request(app).get("/api/conversations").set(owner).set("Origin", "https://attacker-site.vercel.app");
    assert.notEqual(stranger.headers["access-control-allow-origin"], "https://attacker-site.vercel.app");
    const own = await request(app).get("/api/conversations").set(owner).set("Origin", "http://localhost:5173");
    assert.equal(own.headers["access-control-allow-origin"], "http://localhost:5173", "the company's own app still is");
  });

  await t.test("deleting for everyone is not shown as done when WhatsApp could not do it, and deleting just here still works", async () => {
    await handleIncomingMessage({ tenantId, sessionName: "shop", msg: { providerMessageId: "wamid.DEL1", fromMe: true, remoteId: "971500000001@c.us", rawType: "chat", type: "text", text: "sent by us", timestampEpoch: Math.floor(Date.now() / 1000), senderName: "Asha", ack: 2 } });
    const msg = (await query("SELECT m.id,m.conversation_id FROM messages m WHERE m.tenant_id=$1 AND m.provider_message_id='wamid.DEL1'", [tenantId])).rows[0];
    const res = await request(app).delete(`/api/conversations/${msg.conversation_id}/messages/${msg.id}?forEveryone=true`).set(owner);
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.match(res.body.message, /could not delete this message for everyone/);
    assert.deepEqual((await query("SELECT type,status,text FROM messages WHERE id=$1", [msg.id])).rows[0], { type: "text", status: "delivered", text: "sent by us" }, "the message is untouched");
    const here = await request(app).delete(`/api/conversations/${msg.conversation_id}/messages/${msg.id}`).set(owner);
    assert.equal(here.status, 200, JSON.stringify(here.body));
    assert.equal((await query("SELECT is_deleted FROM messages WHERE id=$1", [msg.id])).rows[0].is_deleted, true);
  });

  await t.test("a new group starts with up to 100 people", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `9715000${String(i).padStart(5, "0")}`);
    const res = await request(app).post("/api/conversations/group").set(owner).send({ title: "Big", participants: many, sessionName: "shop" });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /up to 100 people/);
  });

  await t.test("a broadcast pauses after each batch, then carries on", async () => {
    for (let i = 1; i <= 7; i++) {
      await query("INSERT INTO contacts(id,tenant_id,name,phone) VALUES(gen_random_uuid()::text,$1,$2,$3)", [tenantId, `P${i}`, `97150100000${i}`]);
      await query("INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,$2,true,'workspace_recorded')", [tenantId, `97150100000${i}`]);
    }
    const made = await request(app).post("/api/campaigns").set(owner).send({ name: "Batches", templateText: "Hello", sessionName: "shop", launch: "now", batchSize: 5, cooldownSeconds: 120, antiBanDelaySeconds: 4 });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.campaign.id;
    assert.deepEqual([made.body.campaign.batchSize, made.body.campaign.cooldownSeconds], [5, 120]);
    const claimed = async () => (await query("SELECT count(*)::int AS n FROM campaign_recipients WHERE campaign_id=$1 AND status<>'pending'", [id])).rows[0].n;
    for (let i = 0; i < 8; i++) {
      await query("UPDATE campaigns SET updated_at=now()-interval '1 minute' WHERE id=$1", [id]);
      await pumpCampaigns();
    }
    assert.equal(await claimed(), 5, "five go out, then the broadcast rests");
    const resting = (await query("SELECT cooldown_until FROM campaigns WHERE id=$1", [id])).rows[0].cooldown_until;
    assert.ok(new Date(resting).getTime() > Date.now() + 60_000, "the rest is about two minutes");
    await query("UPDATE campaigns SET cooldown_until=now()-interval '1 second' WHERE id=$1", [id]);
    for (let i = 0; i < 4; i++) {
      await query("UPDATE campaigns SET updated_at=now()-interval '1 minute' WHERE id=$1", [id]);
      await pumpCampaigns();
    }
    assert.equal(await claimed(), 7, "and after the rest the others follow");
  });

  await t.test("a broadcast's own switch decides whether {A|B} wording is varied", async () => {
    await query("INSERT INTO contacts(id,tenant_id,name,phone) VALUES(gen_random_uuid()::text,$1,'Solo','971509999999')", [tenantId]);
    await query("INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,'971509999999',true,'workspace_recorded')", [tenantId]);
    const texts = {};
    for (const on of [true, false]) {
      const made = await request(app).post("/api/campaigns").set(owner).send({ name: `Spin ${on}`, templateText: "{Hello|Hello} there", sessionName: "shop", launch: "now", targetSegment: "All Contacts", spintaxEnabled: on });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      await query("DELETE FROM campaign_recipients WHERE campaign_id=$1 AND phone<>'971509999999'", [made.body.campaign.id]);
      await query("UPDATE campaigns SET updated_at=now()-interval '1 minute' WHERE id=$1", [made.body.campaign.id]);
      await pumpCampaigns();
      texts[on] = (await query("SELECT m.text FROM messages m JOIN campaign_recipients r ON r.message_id=m.id WHERE r.campaign_id=$1", [made.body.campaign.id])).rows.map((r) => r.text);
      await query("UPDATE campaigns SET status='paused' WHERE id=$1", [made.body.campaign.id]);
    }
    assert.deepEqual(texts, { true: ["Hello there"], false: ["{Hello|Hello} there"] });
  });
});
