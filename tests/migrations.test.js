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
      'audit_events', 'outbox_events', 'campaigns', 'campaign_recipients',
      'automations'
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

  await t.test('Upgrade legacy schema non-destructively and preserve team semantics', async () => {
    // 1. Setup simulated legacy schema and records
    await query(`
      DROP TABLE IF EXISTS legacy_messages CASCADE;
      DROP TABLE IF EXISTS legacy_chats CASCADE;
      DROP TABLE IF EXISTS legacy_contacts CASCADE;
      DROP TABLE IF EXISTS legacy_campaigns CASCADE;
      DROP TABLE IF EXISTS legacy_automations CASCADE;

      -- Seed legacy users: 2 teammates in "Nexus Retail" and 1 solo user
      INSERT INTO users (id, email, password_hash, name, is_superadmin, status)
      VALUES 
        (9001, 'nexus_lead@nexus.com', 'hash1', 'Nexus Lead', false, 'active'),
        (9002, 'nexus_agent@nexus.com', 'hash2', 'Nexus Agent', false, 'active'),
        (9003, 'solo_founder@solo.com', 'hash3', 'Solo Founder', false, 'active')
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;

      -- Add legacy company_name and role columns if not already present
      ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50);
      UPDATE users SET company_name = 'Nexus Retail', role = 'admin' WHERE id = 9001;
      UPDATE users SET company_name = 'Nexus Retail', role = 'user' WHERE id = 9002;
      UPDATE users SET company_name = 'Solo Ventures', role = 'user' WHERE id = 9003;

      -- Create legacy un-migrated tables
      CREATE TABLE IF NOT EXISTS legacy_contacts (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(64) NOT NULL,
        email VARCHAR(255) DEFAULT '',
        avatar VARCHAR(512) DEFAULT '',
        tags JSONB DEFAULT '[]',
        custom_traits JSONB DEFAULT '{}',
        lifetime_value NUMERIC DEFAULT 0,
        assigned_agent VARCHAR(255) DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS legacy_chats (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT,
        contact_id VARCHAR(64),
        contact_name VARCHAR(255) NOT NULL,
        phone VARCHAR(64) NOT NULL,
        avatar VARCHAR(512) DEFAULT '',
        channel VARCHAR(50) DEFAULT 'primary-whatsapp',
        unread_count INT DEFAULT 0,
        is_group BOOLEAN DEFAULT false,
        group_members_count INT DEFAULT 0,
        assigned_to VARCHAR(255) DEFAULT '',
        is_closed BOOLEAN DEFAULT false,
        last_message JSONB DEFAULT '{}',
        tags JSONB DEFAULT '[]',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS legacy_messages (
        id VARCHAR(64) PRIMARY KEY,
        chat_id VARCHAR(64),
        sender VARCHAR(50) NOT NULL,
        agent_name VARCHAR(255) DEFAULT '',
        text TEXT DEFAULT '',
        type VARCHAR(50) DEFAULT 'text',
        media_url VARCHAR(512) DEFAULT '',
        file_name VARCHAR(255) DEFAULT '',
        file_size VARCHAR(50) DEFAULT '',
        audio_duration VARCHAR(20) DEFAULT '',
        status VARCHAR(50) DEFAULT 'delivered',
        timestamp VARCHAR(50) DEFAULT '10:00 AM',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Populate legacy data
      INSERT INTO legacy_contacts (id, user_id, name, phone, email)
      VALUES ('cnt_legacy_1', 9001, 'High Value Buyer', '+15551234567', 'buyer@test.com')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO legacy_chats (id, user_id, contact_id, contact_name, phone, channel)
      VALUES ('chat_legacy_1', 9001, 'cnt_legacy_1', 'High Value Buyer', '+15551234567', 'primary-whatsapp')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO legacy_messages (id, chat_id, sender, text, status)
      VALUES ('msg_legacy_1', 'chat_legacy_1', 'customer', 'Is this item available?', 'delivered')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Reset migration 002 record to re-run backfill against the legacy data
    await query(`DELETE FROM schema_migrations WHERE version = '002_legacy_backfill'`);

    // Run migrations
    const res = await runMigrations();
    assert.strictEqual(res.status, 'success');

    // Verify 9001 and 9002 share the SAME tenant
    const { rows: mem9001 } = await query('SELECT tenant_id, role FROM memberships WHERE user_id = 9001');
    const { rows: mem9002 } = await query('SELECT tenant_id, role FROM memberships WHERE user_id = 9002');
    assert.strictEqual(mem9001.length, 1);
    assert.strictEqual(mem9002.length, 1);
    assert.strictEqual(mem9001[0].tenant_id, mem9002[0].tenant_id, 'Teammates must belong to the same tenant');
    assert.strictEqual(mem9001[0].role, 'owner', 'First admin in team must be owner');
    assert.strictEqual(mem9002[0].role, 'agent', 'Teammate must be agent');

    // Verify solo user has separate tenant
    const { rows: mem9003 } = await query('SELECT tenant_id FROM memberships WHERE user_id = 9003');
    assert.notStrictEqual(mem9003[0].tenant_id, mem9001[0].tenant_id, 'Solo user must have separate tenant');

    // Verify contact migrated into shared tenant
    const sharedTenantId = mem9001[0].tenant_id;
    const { rows: contacts } = await query('SELECT * FROM contacts WHERE tenant_id = $1', [sharedTenantId]);
    assert.ok(contacts.some(c => c.phone === '+15551234567'), 'Contact should be backfilled');

    // Verify conversation migrated with provider_chat_id
    const { rows: convs } = await query('SELECT * FROM conversations WHERE tenant_id = $1', [sharedTenantId]);
    assert.ok(convs.some(c => c.provider_chat_id === '+15551234567'), 'Conversation should be backfilled with provider_chat_id');

    // Verify message migrated
    const { rows: msgs } = await query('SELECT * FROM messages WHERE tenant_id = $1', [sharedTenantId]);
    assert.ok(msgs.some(m => m.id === 'msg_legacy_1'), 'Message should be backfilled');

    // Verify Welcome Greeting automations are disabled by default
    const { rows: welcomeRules } = await query(`
      SELECT * FROM automations 
      WHERE id LIKE 'auto_welcome%' 
         OR name = 'Welcome Greeting' 
         OR action_summary LIKE '%Thank you for messaging us%'
    `);
    for (const rule of welcomeRules) {
      assert.strictEqual(rule.is_enabled, false, 'Welcome greeting auto-reply must be disabled');
    }
  });
});
