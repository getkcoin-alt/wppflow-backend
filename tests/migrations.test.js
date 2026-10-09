import test from 'node:test';
import assert from 'node:assert';
import { runMigrations, rollbackLatest } from '../src/db/migrate.js';
import { query } from '../src/db/index.js';

test('Database Migrations Suite', async (t) => {
  await t.test('Run migrations up successfully', async () => {
    const result = await runMigrations();
    assert.strictEqual(result.status, 'success');

    const { rows } = await query('SELECT version FROM schema_migrations');
    assert.ok(rows.length >= 2, 'Should have at least 2 migrations applied');
  });

  await t.test('Verify core multitenant tables exist', async () => {
    const expectedTables = [
      'tenants', 'users', 'memberships', 'refresh_tokens',
      'whatsapp_sessions', 'contacts', 'conversations', 'messages',
      'message_receipts', 'attachments', 'consents', 'suppressions',
      'audit_events', 'outbox_events'
    ];

    for (const table of expectedTables) {
      const { rows } = await query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name = $1
        );
      `, [table]);
      assert.strictEqual(rows[0].exists, true, `Table ${table} should exist in database`);
    }
  });
});
