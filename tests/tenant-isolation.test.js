import test from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../src/server.js';
import { registerTenantAndUser, generateAccessToken } from '../src/services/authService.js';
import { query } from '../src/db/index.js';

test('Tenant Isolation Suite', async (t) => {
  // Setup 2 isolated tenants
  const tA = await registerTenantAndUser({
    name: 'User Alpha',
    email: `alpha_${Date.now()}@example.com`,
    password: 'Password@123',
    companyName: 'Tenant Alpha Inc'
  });
  const tokenA = generateAccessToken(tA.user, tA.tenant.id, 'owner');

  const tB = await registerTenantAndUser({
    name: 'User Beta',
    email: `beta_${Date.now()}@example.com`,
    password: 'Password@123',
    companyName: 'Tenant Beta Corp'
  });
  const tokenB = generateAccessToken(tB.user, tB.tenant.id, 'owner');

  // Create a conversation in Tenant A
  const convAId = `conv_iso_${Date.now()}`;
  await query(`
    INSERT INTO conversations (id, tenant_id, session_name, phone, contact_name, last_active_epoch)
    VALUES ($1, $2, 'session-a', '919000000001', 'Alpha Confidential Client', 1700000000)
  `, [convAId, tA.tenant.id]);

  await t.test('Tenant A can see their own conversation', async () => {
    const res = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('x-tenant-id', tA.tenant.id);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'success');
    const found = res.body.conversations.some(c => c.id === convAId);
    assert.strictEqual(found, true, 'Tenant A should see their conversation');
  });

  await t.test('Tenant B CANNOT see Tenant A conversation', async () => {
    const res = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('x-tenant-id', tB.tenant.id);

    assert.strictEqual(res.status, 200);
    const found = res.body.conversations.some(c => c.id === convAId);
    assert.strictEqual(found, false, 'Tenant B must NOT see Tenant A conversation');
  });

  await t.test('Tenant B cannot fetch messages for Tenant A conversation', async () => {
    const res = await request(app)
      .get(`/api/conversations/${convAId}/messages`)
      .set('Authorization', `Bearer ${tokenB}`)
      .set('x-tenant-id', tB.tenant.id);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.messages.length, 0, 'Tenant B should receive 0 messages for unowned conversation');
  });

  await t.test('Tenant B cannot send message into Tenant A conversation', async () => {
    const res = await request(app)
      .post(`/api/conversations/${convAId}/messages`)
      .set('Authorization', `Bearer ${tokenB}`)
      .set('x-tenant-id', tB.tenant.id)
      .send({ text: 'Malicious cross-tenant injection' });

    assert.strictEqual(res.status, 404, 'Should return 404 conversation not found in workspace');
  });

  await t.test('Tenant B cannot spoof x-tenant-id to access Tenant A', async () => {
    const res = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('x-tenant-id', tA.tenant.id); // Spoofing Tenant A's ID

    assert.strictEqual(res.status, 403, 'Should reject access to unauthorized tenant');
  });
});
