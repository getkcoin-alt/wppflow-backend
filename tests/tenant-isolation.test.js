import test from "node:test";
import assert from "node:assert";
import request from "supertest";
import { app } from "../src/server.js";
import {
  registerTenantAndUser,
  generateAccessToken,
} from "../src/services/authService.js";
import { query } from "../src/db/index.js";

test("Tenant Isolation Suite", async (t) => {
  // Setup 2 isolated tenants
  const tA = await registerTenantAndUser({
    name: "User Alpha",
    email: `alpha_${Date.now()}@example.com`,
    password: "Password@123",
    companyName: "Tenant Alpha Inc",
  });
  const tokenA = generateAccessToken(tA.user, tA.tenant.id, "owner");

  const tB = await registerTenantAndUser({
    name: "User Beta",
    email: `beta_${Date.now()}@example.com`,
    password: "Password@123",
    companyName: "Tenant Beta Corp",
  });
  const tokenB = generateAccessToken(tB.user, tB.tenant.id, "owner");

  // Create a conversation in Tenant A
  const convAId = `conv_iso_${Date.now()}`;
  await query(
    `
    INSERT INTO conversations (id, tenant_id, session_name, phone, provider_chat_id, contact_name, last_active_epoch)
    VALUES ($1, $2, 'session-a', '919000000001', '919000000001@c.us', 'Alpha Confidential Client', 1700000000)
  `,
    [convAId, tA.tenant.id],
  );

  await t.test("Tenant A can see their own conversation", async () => {
    const res = await request(app)
      .get("/api/conversations")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("x-tenant-id", tA.tenant.id);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, "success");
    const found = res.body.conversations.some((c) => c.id === convAId);
    assert.strictEqual(found, true, "Tenant A should see their conversation");
  });

  await t.test("Tenant B CANNOT see Tenant A conversation", async () => {
    const res = await request(app)
      .get("/api/conversations")
      .set("Authorization", `Bearer ${tokenB}`)
      .set("x-tenant-id", tB.tenant.id);

    assert.strictEqual(res.status, 200);
    const found = res.body.conversations.some((c) => c.id === convAId);
    assert.strictEqual(
      found,
      false,
      "Tenant B must NOT see Tenant A conversation",
    );
  });

  await t.test(
    "Tenant B cannot fetch messages for Tenant A conversation",
    async () => {
      const res = await request(app)
        .get(`/api/conversations/${convAId}/messages`)
        .set("Authorization", `Bearer ${tokenB}`)
        .set("x-tenant-id", tB.tenant.id);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(
        res.body.messages,
        undefined,
        "Tenant B must not receive messages for an unowned conversation",
      );
    },
  );

  await t.test(
    "Tenant B cannot send message into Tenant A conversation",
    async () => {
      const res = await request(app)
        .post(`/api/conversations/${convAId}/messages`)
        .set("Authorization", `Bearer ${tokenB}`)
        .set("x-tenant-id", tB.tenant.id)
        .send({
          text: "Malicious cross-tenant injection",
          idempotencyKey: "cross-denied",
        });

      assert.strictEqual(
        res.status,
        404,
        "Should return 404 conversation not found in workspace",
      );
    },
  );

  await t.test(
    "Tenant B cannot spoof x-tenant-id to access Tenant A",
    async () => {
      const res = await request(app)
        .get("/api/conversations")
        .set("Authorization", `Bearer ${tokenB}`)
        .set("x-tenant-id", tA.tenant.id); // Spoofing Tenant A's ID

      assert.strictEqual(
        res.status,
        403,
        "Should reject access to unauthorized tenant",
      );
    },
  );

  await t.test(
    "Two tenants syncing the same recipient phone number succeed without 23505 pkey collision",
    async () => {
      const sharedPhone = "+15559998888";
      const sharedProviderChatId = `${sharedPhone.replace(/\D/g, "")}@c.us`;

      // Tenant A syncs the contact
      const convIdA = `conv_${crypto.randomUUID()}`;
      await query(
        `
      INSERT INTO conversations (id, tenant_id, session_name, provider_chat_id, phone, contact_name, last_active_epoch)
      VALUES ($1, $2, 'primary-whatsapp', $3, $4, 'Common Customer', 1700000000)
      ON CONFLICT (tenant_id, session_name, provider_chat_id) DO UPDATE SET contact_name = EXCLUDED.contact_name
    `,
        [convIdA, tA.tenant.id, sharedProviderChatId, sharedPhone],
      );

      // Tenant B syncs the exact same recipient phone number
      const convIdB = `conv_${crypto.randomUUID()}`;
      await query(
        `
      INSERT INTO conversations (id, tenant_id, session_name, provider_chat_id, phone, contact_name, last_active_epoch)
      VALUES ($1, $2, 'primary-whatsapp', $3, $4, 'Common Customer', 1700000000)
      ON CONFLICT (tenant_id, session_name, provider_chat_id) DO UPDATE SET contact_name = EXCLUDED.contact_name
    `,
        [convIdB, tB.tenant.id, sharedProviderChatId, sharedPhone],
      );

      assert.notStrictEqual(
        convIdA,
        convIdB,
        "Conversation IDs must be distinct",
      );

      const { rows: rowsA } = await query(
        "SELECT id FROM conversations WHERE tenant_id = $1 AND provider_chat_id = $2",
        [tA.tenant.id, sharedProviderChatId],
      );
      const { rows: rowsB } = await query(
        "SELECT id FROM conversations WHERE tenant_id = $1 AND provider_chat_id = $2",
        [tB.tenant.id, sharedProviderChatId],
      );

      assert.strictEqual(rowsA.length, 1);
      assert.strictEqual(rowsB.length, 1);
      assert.strictEqual(rowsA[0].id, convIdA);
      assert.strictEqual(rowsB[0].id, convIdB);
    },
  );

  await t.test(
    "Two sessions in same tenant can hold separate threads with the same contact",
    async () => {
      const contactPhone = "+15557776666";
      const providerChatId = `${contactPhone.replace(/\D/g, "")}@c.us`;

      const convSales = `conv_${crypto.randomUUID()}`;
      const convSupport = `conv_${crypto.randomUUID()}`;

      await query(
        `
      INSERT INTO conversations (id, tenant_id, session_name, provider_chat_id, phone, contact_name, last_active_epoch)
      VALUES ($1, $2, 'sales-wa', $3, $4, 'Shared Lead', 1700000000)
      ON CONFLICT (tenant_id, session_name, provider_chat_id) DO UPDATE SET contact_name = EXCLUDED.contact_name
    `,
        [convSales, tA.tenant.id, providerChatId, contactPhone],
      );

      await query(
        `
      INSERT INTO conversations (id, tenant_id, session_name, provider_chat_id, phone, contact_name, last_active_epoch)
      VALUES ($1, $2, 'support-wa', $3, $4, 'Shared Lead', 1700000000)
      ON CONFLICT (tenant_id, session_name, provider_chat_id) DO UPDATE SET contact_name = EXCLUDED.contact_name
    `,
        [convSupport, tA.tenant.id, providerChatId, contactPhone],
      );

      const { rows } = await query(
        `
      SELECT session_name, id FROM conversations WHERE tenant_id = $1 AND provider_chat_id = $2
    `,
        [tA.tenant.id, providerChatId],
      );

      assert.strictEqual(
        rows.length,
        2,
        "Tenant A should have 2 distinct conversation threads for the two sessions",
      );
    },
  );
});
