import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import {
  registerTenantAndUser,
  generateAccessToken,
  hashPassword,
  generateRefreshToken,
  rotateRefreshToken,
} from "../src/services/authService.js";
import {
  sendTextMessage,
  handleIncomingMessage,
  handleAckEvent,
  getConversationMessages,
} from "../src/services/messageService.js";
import {
  dispatchMessage,
  recoverInterruptedDispatches,
} from "../src/services/queue/messageQueue.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import {
  startCampaign,
  pumpCampaigns,
} from "../src/services/campaignService.js";
import { pumpAutomations } from "../src/services/automationService.js";
import {
  publicAddress,
  resolveWebhook,
} from "../src/services/webhookService.js";
import {
  validateMedia,
  validateContent,
} from "../src/services/mediaService.js";

test("Real API, database and dispatcher regression suite", async (t) => {
  const a = await registerTenantAndUser({
    name: "Owner A",
    email: "owner-a@test.invalid",
    password: "Password@123",
    companyName: "Alpha",
  });
  const b = await registerTenantAndUser({
    name: "Owner B",
    email: "owner-b@test.invalid",
    password: "Password@123",
    companyName: "Beta",
  });
  const tenantId = a.tenant.id,
    otherTenant = b.tenant.id;
  const owner = generateAccessToken(a.user, tenantId, "owner"),
    other = generateAccessToken(b.user, otherTenant, "owner");
  const agentRow = await query(
    "INSERT INTO users(name,email,password_hash) VALUES('Agent','agent@test.invalid',$1) RETURNING *",
    [await hashPassword("Password@123")],
  );
  const agentId = agentRow.rows[0].id;
  await query(
    "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')",
    [tenantId, agentId],
  );
  const agent = generateAccessToken(agentRow.rows[0], tenantId, "owner"); // Deliberately forged role claim: DB role must win.
  const id = crypto.randomUUID();
  await query(
    "INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,phone,contact_name) VALUES($1,$2,'primary','15550000001@c.us','15550000001','Customer')",
    [id, tenantId],
  );
  await query(
    "INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id) VALUES($1,$2,'primary',$3)",
    [crypto.randomUUID(), tenantId, agentId],
  );
  const api = (method, path, token = owner) =>
    request(app)
      [method](path)
      .set("Authorization", "Bearer " + token);
  const send = (key, text = "Hello") =>
    sendTextMessage({
      tenantId,
      conversationId: id,
      text,
      idempotencyKey: key,
    });
  const outbox = async (messageId) =>
    (
      await query(
        "SELECT payload FROM outbox_events WHERE aggregate_id=$1 AND event_type='message.outgoing'",
        [messageId],
      )
    ).rows[0].payload;
  await t.test(
    "Contact CRUD/import are tenant-owned, opt-in persists and viewer writes are denied",
    async () => {
      const created = await api("post", "/api/contacts").send({
        name: "API Contact",
        phone: "15559990000",
        email: "contact@test.invalid",
        tags: ["VIP"],
      });
      assert.equal(created.status, 201);
      const contactId = created.body.contact.id;
      assert.equal(
        (await api("get", "/api/contacts/" + contactId, other)).status,
        404,
      );
      const updated = await api("patch", "/api/contacts/" + contactId).send({
        optIn: true,
        customTraits: { source: "API" },
      });
      assert.equal(updated.body.contact.optIn, true);
      assert.equal(
        (await api("get", "/api/contacts?search=contact@test.invalid")).body
          .contacts[0].customTraits.source,
        "API",
      );
      // A row that cannot be used is reported and skipped; the rest of the file still goes in.
      const partial = await api("post", "/api/contacts/import").send({
        rows: [
          { name: "Imported", phone: "15559991111" },
          { name: "Missing phone" },
          { name: "Local number", phone: "0501234567" },
        ],
      });
      assert.equal(partial.status, 200);
      assert.equal(partial.body.imported, 1);
      assert.equal(partial.body.skippedCount, 2);
      assert.match(partial.body.skipped[0].reason, /country code/);
      assert.equal(
        (
          await query(
            "SELECT 1 FROM contacts WHERE tenant_id=$1 AND phone='15559991111'",
            [tenantId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (await query("SELECT 1 FROM contacts WHERE tenant_id=$1 AND phone='0501234567'", [tenantId])).rowCount,
        0,
      );
      await query(
        "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",
        [tenantId, agentId],
      );
      try {
        assert.equal(
          (
            await api("post", "/api/contacts", agent).send({
              name: "Denied",
              phone: "15555555555",
            })
          ).status,
          403,
        );
        assert.equal((await api("get", "/api/contacts", agent)).status, 200);
      } finally {
        await query(
          "UPDATE memberships SET role='agent' WHERE tenant_id=$1 AND user_id=$2",
          [tenantId, agentId],
        );
      }
      await api("delete", "/api/contacts/" + contactId);
    },
  );
  await t.test(
    "ACK zero stays pending and a provider error becomes failed without retry",
    async () => {
      const pending = await send("ack-zero");
      const original = provider.sendTextMessage;
      provider.sendTextMessage = async () => ({
        providerMessageId: "pending-provider",
        ack: 0,
      });
      try {
        await dispatchMessage(await outbox(pending.message.id));
      } finally {
        provider.sendTextMessage = original;
      }
      assert.equal(
        (
          await query("SELECT status FROM messages WHERE id=$1", [
            pending.message.id,
          ])
        ).rows[0].status,
        "sending",
      );
      await handleAckEvent({
        tenantId,
        ackData: { providerMessageId: "pending-provider", ack: -1 },
      });
      assert.equal(
        (
          await query("SELECT status FROM messages WHERE id=$1", [
            pending.message.id,
          ])
        ).rows[0].status,
        "failed",
      );
    },
  );
  await t.test(
    "Agent cannot invite, suspend, self-promote or mutate another tenant",
    async () => {
      assert.equal(
        (
          await api("post", "/api/auth/users", agent).send({
            name: "Attacker",
            email: "x@test.invalid",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await api("patch", "/api/auth/users/" + agentId, agent).send({
            role: "admin",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await api("patch", "/api/auth/users/" + b.user.id).send({
            status: "suspended",
          })
        ).status,
        404,
      );
      assert.equal(
        (await query("SELECT status FROM users WHERE id=$1", [b.user.id]))
          .rows[0].status,
        "active",
      );
      assert.equal(
        (
          await api("get", "/api/conversations", other).set(
            "X-Tenant-Id",
            tenantId,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await api("patch", "/api/conversations/" + id, other).send({
            isClosed: true,
          })
        ).status,
        404,
      );
    },
  );
  await t.test(
    "Private notes persist without a provider job; text endpoint rejects notes",
    async () => {
      const note = await api(
        "post",
        "/api/conversations/" + id + "/notes",
        agent,
      ).send({ text: "Private context", idempotencyKey: "private-note" });
      assert.equal(note.status, 201);
      assert.equal(note.body.message.isNote, true);
      assert.equal(
        (
          await query("SELECT 1 FROM outbox_events WHERE aggregate_id=$1", [
            note.body.message.id,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await api("post", "/api/conversations/" + id + "/messages").send({
            text: "Must not leak",
            isNote: true,
            idempotencyKey: "leak",
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    "Concurrent retries create exactly one message and durable outbox row",
    async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => send("parallel")),
      );
      assert.equal(new Set(results.map((x) => x.message.id)).size, 1);
      assert.equal(results.filter((x) => !x.duplicate).length, 1);
      assert.equal(
        (
          await query(
            "SELECT 1 FROM outbox_events WHERE aggregate_id=$1 AND event_type='message.outgoing'",
            [results[0].message.id],
          )
        ).rowCount,
        1,
      );
      await assert.rejects(
        send("parallel", "Different payload"),
        (e) => e.status === 409,
      );
    },
  );
  await t.test(
    "Duplicate incoming events increment unread once; own echoes do not trigger automation",
    async () => {
      const msg = {
        providerMessageId: "incoming-once",
        remoteId: "15550000001@c.us",
        text: "Help please",
        timestampEpoch: 1800000000,
      };
      await Promise.all(
        Array.from({ length: 5 }, () =>
          handleIncomingMessage({ tenantId, sessionName: "primary", msg }),
        ),
      );
      assert.equal(
        (
          await query("SELECT unread_count FROM conversations WHERE id=$1", [
            id,
          ])
        ).rows[0].unread_count,
        1,
      );
      const echo = await handleIncomingMessage({
        tenantId,
        sessionName: "primary",
        msg: { ...msg, providerMessageId: "own-echo", fromMe: true },
      });
      assert.equal(echo.sender, "agent");
      assert.equal(
        (
          await query(
            "SELECT 1 FROM outbox_events WHERE aggregate_id=$1 AND event_type='automation.incoming'",
            [echo.id],
          )
        ).rowCount,
        0,
      );
    },
  );
  await t.test(
    "Early ACK and outgoing echo merge into one confirmed bubble; stale ACK cannot regress",
    async () => {
      const result = await send("dispatch-echo");
      const original = provider.sendTextMessage;
      provider.sendTextMessage = async () => {
        await handleAckEvent({
          tenantId,
          ackData: { providerMessageId: "echo-confirmed", ack: 3 },
        });
        await handleIncomingMessage({
          tenantId,
          sessionName: "primary",
          msg: {
            providerMessageId: "echo-confirmed",
            remoteId: "15550000001@c.us",
            text: "Hello",
            fromMe: true,
          },
        });
        return { providerMessageId: "echo-confirmed", ack: 1 };
      };
      try {
        await dispatchMessage(await outbox(result.message.id));
      } finally {
        provider.sendTextMessage = original;
      }
      const saved = (
        await query("SELECT * FROM messages WHERE id=$1", [result.message.id])
      ).rows[0];
      assert.equal(saved.status, "read");
      assert.equal(saved.ack, 3);
      assert.equal(
        (
          await query(
            "SELECT 1 FROM messages WHERE tenant_id=$1 AND provider_message_id='echo-confirmed'",
            [tenantId],
          )
        ).rowCount,
        1,
      );
      await handleAckEvent({
        tenantId,
        ackData: { providerMessageId: "echo-confirmed", ack: 1 },
      });
      assert.equal(
        (await query("SELECT ack FROM messages WHERE id=$1", [saved.id]))
          .rows[0].ack,
        3,
      );
    },
  );
  await t.test(
    "Unknown delivery is never automatically resent; offline sends stay durable",
    async () => {
      const original = provider.sendTextMessage;
      let calls = 0;
      const uncertain = await send("uncertain");
      provider.sendTextMessage = async () => {
        calls++;
        throw new Error("Connection lost after dispatch");
      };
      try {
        await dispatchMessage(await outbox(uncertain.message.id));
        await dispatchMessage(await outbox(uncertain.message.id));
      } finally {
        provider.sendTextMessage = original;
      }
      assert.equal(calls, 1);
      assert.equal(
        (
          await query("SELECT status FROM messages WHERE id=$1", [
            uncertain.message.id,
          ])
        ).rows[0].status,
        "uncertain",
      );
      const offline = await send("offline");
      provider.sendTextMessage = async () => {
        const e = new Error("Offline");
        e.code = "SESSION_OFFLINE";
        throw e;
      };
      try {
        await dispatchMessage(await outbox(offline.message.id));
      } finally {
        provider.sendTextMessage = original;
      }
      assert.equal(
        (
          await query("SELECT status FROM messages WHERE id=$1", [
            offline.message.id,
          ])
        ).rows[0].status,
        "sending",
      );
      await query(
        "UPDATE messages SET status='dispatching',updated_at=now()-interval '3 minutes' WHERE id=$1",
        [offline.message.id],
      );
      await recoverInterruptedDispatches();
      assert.equal(
        (
          await query("SELECT status FROM messages WHERE id=$1", [
            offline.message.id,
          ])
        ).rows[0].status,
        "uncertain",
      );
    },
  );
  await t.test(
    "Compound message cursors include every record when timestamps tie",
    async () => {
      const total = Number(
        (
          await query(
            "SELECT count(*) FROM messages WHERE conversation_id=$1",
            [id],
          )
        ).rows[0].count,
      );
      await query(
        "UPDATE messages SET timestamp_epoch=12345 WHERE conversation_id=$1",
        [id],
      );
      const seen = [];
      let cursor = null;
      do {
        const page = await getConversationMessages({
          tenantId,
          conversationId: id,
          limit: 2,
          cursor,
        });
        seen.push(...page.messages.map((m) => m.id));
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(seen.length, total);
      assert.equal(new Set(seen).size, total);
    },
  );
  await t.test(
    "Invitations use expiring single-use tokens and refresh reuse really revokes sessions",
    async () => {
      const invite = await api("post", "/api/auth/users").send({
        name: "New teammate",
        email: "new@test.invalid",
        role: "agent",
      });
      assert.equal(invite.status, 201);
      assert.ok(invite.body.activationLink);
      assert.equal(invite.body.password, undefined);
      const token = new URL(invite.body.activationLink).searchParams.get(
        "invite",
      );
      assert.equal(
        (
          await request(app)
            .post("/api/auth/accept-invite")
            .send({ token, password: "SecurePassword123" })
        ).status,
        200,
      );
      assert.equal(
        (
          await request(app)
            .post("/api/auth/accept-invite")
            .send({ token, password: "SecurePassword123" })
        ).status,
        400,
      );
      const refresh = await generateRefreshToken(a.user.id, tenantId);
      const rotated = await rotateRefreshToken(refresh.refreshToken);
      await assert.rejects(rotateRefreshToken(refresh.refreshToken), /reuse/);
      assert.equal(
        (
          await query("SELECT revoked FROM refresh_tokens WHERE id=$1", [
            rotated.tokenId,
          ])
        ).rows[0].revoked,
        true,
      );
      const login = await request(app)
        .post("/api/auth/login")
        .send({ email: a.user.email, password: "Password@123" });
      assert.equal(login.status, 200);
      assert.equal(login.body.refreshToken, undefined);
      assert.match(login.headers["set-cookie"][0], /HttpOnly/);
    },
  );
  await t.test(
    "Membership suspension revokes workspace access but not the global user",
    async () => {
      assert.equal(
        (
          await api("patch", "/api/auth/users/" + agentId).send({
            status: "suspended",
          })
        ).status,
        200,
      );
      assert.equal((await api("get", "/api/contacts", agent)).status, 403);
      assert.equal(
        (await query("SELECT status FROM users WHERE id=$1", [agentId])).rows[0]
          .status,
        "active",
      );
      assert.equal(
        (
          await api("patch", "/api/auth/users/" + agentId).send({
            status: "active",
          })
        ).status,
        200,
      );
    },
  );
  await t.test(
    "API keys have enforced scopes, tenant binding, one-time disclosure and revocation",
    async () => {
      const created = await api("post", "/api/workspace/keys").send({
        name: "Read contacts",
        scopes: ["contacts"],
      });
      assert.equal(created.status, 201);
      assert.equal(
        (await api("get", "/api/contacts", created.body.key)).status,
        200,
      );
      assert.equal(
        (await api("get", "/api/conversations", created.body.key)).status,
        403,
      );
      assert.equal(
        (await api("get", "/api/workspace/keys", created.body.key)).status,
        403,
      );
      const list = await api("get", "/api/workspace/keys");
      assert.equal(list.body.keys[0].key_hash, undefined);
      await api("delete", "/api/workspace/keys/" + created.body.id);
      assert.equal(
        (await api("get", "/api/contacts", created.body.key)).status,
        401,
      );
    },
  );
  await t.test(
    "QR access is restricted, quotas are enforced and foreign worker leases cannot be removed",
    async () => {
      await query("UPDATE tenants SET sessions_limit=0 WHERE id=$1", [
        tenantId,
      ]);
      assert.equal(
        (
          await api("post", "/api/sessions/start").send({
            sessionName: "new-line",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await api("post", "/api/sessions/start").send({
            sessionName: "../../escape",
          })
        ).status,
        400,
      );
      await query(
        "INSERT INTO whatsapp_sessions(id,tenant_id,session_name,status,qr_code,worker_id,lease_until) VALUES($1,$2,'locked','QRCODE','test-qr',$3,now()+interval '1 minute')",
        [crypto.randomUUID(), tenantId, crypto.randomUUID()],
      );
      assert.equal(
        (await api("get", "/api/sessions/locked/qr", agent)).status,
        404,
      );
      assert.equal(
        (await api("get", "/api/sessions/locked/qr")).body.qrcode,
        "test-qr",
      );
      assert.equal(
        (await api("get", "/api/sessions", agent)).body.sessions.some(
          (x) => x.sessionName === "locked",
        ),
        false,
      );
      assert.equal((await api("delete", "/api/sessions/locked")).status, 409);
      assert.equal(
        (
          await query(
            "SELECT 1 FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name='locked'",
            [tenantId],
          )
        ).rowCount,
        1,
      );
      await query(
        "DELETE FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name='locked'",
        [tenantId],
      );
      await query("UPDATE tenants SET sessions_limit=5 WHERE id=$1", [
        tenantId,
      ]);
    },
  );
  await t.test(
    "Campaigns require opt-in and stop dispatching queued work; consent checked again before send",
    async () => {
      await query(
        "INSERT INTO whatsapp_sessions(id,tenant_id,session_name) VALUES($1,$2,'primary') ON CONFLICT DO NOTHING",
        [crypto.randomUUID(), tenantId],
      );
      for (const [phone, optIn] of [
        ["15550000010", true],
        ["15550000011", false],
      ]) {
        await query(
          "INSERT INTO contacts(id,tenant_id,name,phone) VALUES($1,$2,$3,$4)",
          [crypto.randomUUID(), tenantId, "Recipient", phone],
        );
        await query(
          "INSERT INTO consents(tenant_id,phone,opt_in_status) VALUES($1,$2,$3)",
          [tenantId, phone, optIn],
        );
      }
      const campaign = crypto.randomUUID();
      await query(
        "INSERT INTO campaigns(id,tenant_id,name,target_segment,template_text,session_name) VALUES($1,$2,'Consent test','All Contacts','Hi {{name}}','primary')",
        [campaign, tenantId],
      );
      const started = await startCampaign(tenantId, campaign);
      assert.equal(started.totalRecipients, 1);
      await query(
        "UPDATE campaigns SET updated_at=now()-interval '10 seconds' WHERE id=$1",
        [campaign],
      );
      await pumpCampaigns();
      const recipient = (
        await query("SELECT * FROM campaign_recipients WHERE campaign_id=$1", [
          campaign,
        ])
      ).rows[0];
      assert.ok(recipient.message_id);
      await query("UPDATE campaigns SET status='stopped' WHERE id=$1", [
        campaign,
      ]);
      const original = provider.sendTextMessage;
      let calls = 0;
      provider.sendTextMessage = async () => {
        calls++;
        return { providerMessageId: "campaign-test" };
      };
      try {
        await dispatchMessage(await outbox(recipient.message_id));
        assert.equal(calls, 0);
        await query("UPDATE campaigns SET status='running' WHERE id=$1", [
          campaign,
        ]);
        await query(
          "UPDATE consents SET opt_in_status=false WHERE tenant_id=$1",
          [tenantId],
        );
        await dispatchMessage(await outbox(recipient.message_id));
        assert.equal(calls, 0);
      } finally {
        provider.sendTextMessage = original;
      }
      assert.equal(
        (
          await query("SELECT status FROM messages WHERE id=$1", [
            recipient.message_id,
          ])
        ).rows[0].status,
        "failed",
      );
    },
  );
  await t.test(
    "Keyword automation executes once and excludes outgoing messages",
    async () => {
      const rule = crypto.randomUUID();
      await query(
        "INSERT INTO automations(id,tenant_id,name,trigger_condition,action_summary,is_enabled) VALUES($1,$2,'Help reply','help','We can help',true)",
        [rule, tenantId],
      );
      await pumpAutomations();
      await pumpAutomations();
      assert.equal(
        (
          await query("SELECT executions_count FROM automations WHERE id=$1", [
            rule,
          ])
        ).rows[0].executions_count,
        1,
      );
    },
  );
  await t.test(
    "Unowned media is denied and reserved webhook destinations are blocked",
    async () => {
      assert.equal(
        (
          await api(
            "post",
            "/api/attachments/" + crypto.randomUUID() + "/send",
            other,
          ).send({ idempotencyKey: "media-denied" })
        ).status,
        404,
      );
      for (const ip of [
        "127.0.0.1",
        "10.1.1.1",
        "169.254.169.254",
        "192.168.0.1",
        "100.64.1.1",
        "::1",
        "::ffff:127.0.0.1",
        "64:ff9b::a00:1",
        "fc00::1",
        "2001:db8::1",
      ])
        assert.equal(publicAddress(ip), false, ip);
      assert.equal(publicAddress("8.8.8.8"), true);
      assert.equal(publicAddress("2606:4700:4700::1111"), true);
      await assert.rejects(
        resolveWebhook("https://127.0.0.1/"),
        (e) => e.status === 400,
      );
      await assert.rejects(
        resolveWebhook("http://example.com/"),
        (e) => e.status === 400,
      );
      assert.throws(() => validateMedia("text/html", 10));
      assert.throws(() => validateMedia("image/png", 17 * 1024 * 1024));
      assert.throws(() =>
        validateContent(Buffer.from("<script>alert(1)</script>"), "image/png"),
      );
      assert.doesNotThrow(() =>
        validateContent(Buffer.from("Plain text document"), "text/plain"),
      );
    },
  );
  io.close();
});
