import test from 'node:test';
import assert from 'node:assert';
import bcrypt from 'bcryptjs';
import { runMigrations } from '../src/db/migrate.js';
import { query } from '../src/db/index.js';
import { sendEmail, getEmailServiceStatus } from '../src/services/emailService.js';
import { ENV } from '../src/config/env.js';

if (!ENV.RESEND_API_KEY) {
  ENV.RESEND_API_KEY = 'test_mock_resend_key';
}

test('Email Service & Superadmin Configuration Suite', async (t) => {
  await t.test('Email service status reports Resend as active provider', () => {
    const status = getEmailServiceStatus();
    assert.strictEqual(status.provider, 'resend');
    assert.strictEqual(status.configured, true);
    assert.ok(status.fromEmail);
  });

  await t.test('Validation checks reject incomplete email requests', async () => {
    const noTo = await sendEmail({ subject: 'Test', html: '<p>Hi</p>' });
    assert.strictEqual(noTo.success, false);
    assert.ok(noTo.error.includes('to'));

    const noSubject = await sendEmail({ to: 'user@example.com', html: '<p>Hi</p>' });
    assert.strictEqual(noSubject.success, false);
    assert.ok(noSubject.error.includes('subject'));

    const noBody = await sendEmail({ to: 'user@example.com', subject: 'Test' });
    assert.strictEqual(noBody.success, false);
    assert.ok(noBody.error.includes('content'));
  });

  await t.test('Apply migrations including 004_configure_superadmin', async () => {
    // Reset migration 004 record to ensure it executes and cleanses users
    await query(`DELETE FROM schema_migrations WHERE version = '004_configure_superadmin'`);
    const result = await runMigrations();
    assert.strictEqual(result.status, 'success');

    const { rows: migrations } = await query('SELECT version FROM schema_migrations');
    assert.ok(migrations.some(m => m.version === '004_configure_superadmin'), 'Migration 004 must be applied');
  });

  await t.test('Verify karnveer@scriza.in is the sole superadmin user with correct password', async () => {
    const { rows: users } = await query('SELECT id, email, password_hash, is_superadmin, status FROM users');
    
    // Exactly 1 user must exist
    assert.strictEqual(users.length, 1, `Expected exactly 1 user in users table, but found ${users.length}`);
    
    const superadmin = users[0];
    assert.strictEqual(superadmin.email, 'karnveer@scriza.in');
    assert.strictEqual(superadmin.is_superadmin, true);
    assert.strictEqual(superadmin.status, 'active');

    // Verify password matches 'Staycentered@321'
    const isPasswordValid = await bcrypt.compare('Staycentered@321', superadmin.password_hash);
    assert.strictEqual(isPasswordValid, true, 'Password hash must verify against Staycentered@321');

    // Verify all legacy/demo users are purged
    const { rows: legacyUsers } = await query(`
      SELECT * FROM users WHERE email IN ('admin@wppflow.io', 'demo@wppflow.io')
    `);
    assert.strictEqual(legacyUsers.length, 0, 'No legacy admin or demo users should exist');
  });

  await t.test('Verify karnveer@scriza.in has owner membership in tenant_scriza', async () => {
    const { rows: memberships } = await query(`
      SELECT m.role, t.id as tenant_id, t.name as tenant_name, u.email
      FROM memberships m
      JOIN tenants t ON m.tenant_id = t.id
      JOIN users u ON m.user_id = u.id
      WHERE u.email = 'karnveer@scriza.in'
    `);

    assert.strictEqual(memberships.length, 1);
    assert.strictEqual(memberships[0].role, 'owner');
    assert.strictEqual(memberships[0].tenant_id, 'tenant_scriza');
    assert.strictEqual(memberships[0].tenant_name, 'Scriza');
  });
});
