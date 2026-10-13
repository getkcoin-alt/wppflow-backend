export const version = '001_multitenant_core';

export async function up(client) {
  // 0. Non-destructive legacy table check & preservation
  // If legacy tables exist without tenant_id, safely rename them to legacy_*
  const legacyCandidates = ['contacts', 'chats', 'messages', 'campaigns', 'automations'];
  for (const t of legacyCandidates) {
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = $1
      );
    `, [t]);

    if (tableExists.rows[0].exists) {
      const colExists = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id'
        );
      `, [t]);

      if (!colExists.rows[0].exists) {
        console.log(`📦 Preserving legacy table '${t}' as 'legacy_${t}'...`);
        await client.query(`ALTER TABLE "${t}" RENAME TO "legacy_${t}"`);
      }
    }
  }

  // 1. Tenants
  await client.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(128) UNIQUE NOT NULL,
      plan VARCHAR(50) DEFAULT 'Growth',
      sessions_limit INT DEFAULT 5,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. Users (Platform users) - Additive upgrade if already exists
  const usersExists = await client.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'users'
    );
  `);

  if (!usersExists.rows[0].exists) {
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        is_superadmin BOOLEAN DEFAULT false,
        status VARCHAR(30) DEFAULT 'active',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } else {
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'active';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
    `);
  }

  // 3. Memberships (Tenant <-> User with role)
  await client.query(`
    CREATE TABLE IF NOT EXISTS memberships (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(50) NOT NULL DEFAULT 'agent',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
    CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id);
  `);

  // 4. Refresh Tokens
  await client.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id VARCHAR(64) PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(255) NOT NULL,
      revoked BOOLEAN DEFAULT false,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
  `);

  // 5. WhatsApp Sessions (Tenant-owned)
  await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      session_name VARCHAR(128) NOT NULL,
      status VARCHAR(50) DEFAULT 'DISCONNECTED',
      phone VARCHAR(64),
      battery INT DEFAULT 100,
      anti_ban_health INT DEFAULT 100,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, session_name)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON whatsapp_sessions(tenant_id);
  `);

  // 6. Contacts (Tenant-owned)
  await client.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(64) NOT NULL,
      email VARCHAR(255) DEFAULT '',
      avatar VARCHAR(512) DEFAULT '',
      tags JSONB DEFAULT '[]',
      custom_traits JSONB DEFAULT '{}',
      lifetime_value NUMERIC DEFAULT 0,
      assigned_agent VARCHAR(255) DEFAULT '',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, phone)
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id);
  `);

  // 7. Conversations (Tenant-owned with multi-session support and compound index)
  await client.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      session_name VARCHAR(128) NOT NULL,
      provider_chat_id VARCHAR(128) NOT NULL,
      contact_id VARCHAR(64) REFERENCES contacts(id) ON DELETE SET NULL,
      phone VARCHAR(64) NOT NULL,
      contact_name VARCHAR(255) NOT NULL,
      avatar VARCHAR(512) DEFAULT '',
      unread_count INT DEFAULT 0,
      is_group BOOLEAN DEFAULT false,
      group_members_count INT DEFAULT 0,
      assigned_to VARCHAR(255) DEFAULT '',
      is_closed BOOLEAN DEFAULT false,
      is_pinned BOOLEAN DEFAULT false,
      is_archived BOOLEAN DEFAULT false,
      last_active_epoch BIGINT DEFAULT 0,
      last_message JSONB DEFAULT '{}',
      tags JSONB DEFAULT '[]',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_tenant_session_chat UNIQUE (tenant_id, session_name, provider_chat_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_tenant_epoch_id ON conversations(tenant_id, last_active_epoch DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_tenant_unread ON conversations(tenant_id, unread_count);
  `);

  // 8. Messages (Tenant-owned with strict idempotency and provider ID uniqueness)
  await client.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      provider_message_id VARCHAR(128),
      idempotency_key VARCHAR(128),
      sender VARCHAR(50) NOT NULL,
      agent_name VARCHAR(255) DEFAULT '',
      text TEXT DEFAULT '',
      type VARCHAR(50) DEFAULT 'text',
      status VARCHAR(50) DEFAULT 'sent',
      ack INT DEFAULT 0,
      media_url TEXT DEFAULT '',
      file_name VARCHAR(255) DEFAULT '',
      file_size VARCHAR(50) DEFAULT '',
      audio_duration VARCHAR(50) DEFAULT '',
      timestamp VARCHAR(50) DEFAULT '',
      timestamp_epoch BIGINT DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_tenant_provider_msg UNIQUE (tenant_id, provider_message_id),
      CONSTRAINT uq_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_tenant_conv_epoch_id ON messages(tenant_id, conversation_id, timestamp_epoch DESC, id DESC);
  `);

  // 9. Message Receipts (ACK auditing)
  await client.query(`
    CREATE TABLE IF NOT EXISTS message_receipts (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      message_id VARCHAR(64) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      provider_message_id VARCHAR(128),
      ack INT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_message ON message_receipts(tenant_id, message_id);
  `);

  // 10. Attachments (Object storage metadata)
  await client.query(`
    CREATE TABLE IF NOT EXISTS attachments (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      message_id VARCHAR(64) REFERENCES messages(id) ON DELETE SET NULL,
      storage_key VARCHAR(512) NOT NULL,
      original_name VARCHAR(255) DEFAULT '',
      mime_type VARCHAR(128) DEFAULT '',
      byte_size BIGINT DEFAULT 0,
      public_url TEXT DEFAULT '',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_tenant ON attachments(tenant_id);
  `);

  // 11. Consents & Suppressions (Compliance)
  await client.query(`
    CREATE TABLE IF NOT EXISTS consents (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      phone VARCHAR(64) NOT NULL,
      opt_in_status BOOLEAN DEFAULT true,
      source VARCHAR(100) DEFAULT 'inbound',
      consented_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, phone)
    );

    CREATE TABLE IF NOT EXISTS suppressions (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      phone VARCHAR(64) NOT NULL,
      reason VARCHAR(255) DEFAULT 'opt_out',
      suppressed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, phone)
    );
  `);

  // 12. Audit Events
  await client.query(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_id INT REFERENCES users(id) ON DELETE SET NULL,
      event_type VARCHAR(100) NOT NULL,
      metadata JSONB DEFAULT '{}',
      ip_address VARCHAR(64) DEFAULT '',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_events(tenant_id, created_at DESC);
  `);

  // 13. Transactional Outbox Events
  await client.query(`
    CREATE TABLE IF NOT EXISTS outbox_events (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      aggregate_type VARCHAR(100) NOT NULL,
      aggregate_id VARCHAR(64) NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      payload JSONB NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMP WITH TIME ZONE
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, created_at) WHERE status = 'pending';
  `);

  // 14. Campaigns & Campaign Recipients (Tenant-owned)
  await client.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      target_segment VARCHAR(255) DEFAULT '',
      total_recipients INT DEFAULT 0,
      sent_count INT DEFAULT 0,
      delivered_count INT DEFAULT 0,
      read_count INT DEFAULT 0,
      replied_count INT DEFAULT 0,
      failed_count INT DEFAULT 0,
      cost_saved_meta NUMERIC DEFAULT 0,
      status VARCHAR(50) DEFAULT 'draft',
      template_text TEXT DEFAULT '',
      anti_ban_delay_seconds INT DEFAULT 4,
      scheduled_for VARCHAR(100) DEFAULT '',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      campaign_id VARCHAR(64) NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      phone VARCHAR(64) NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      error TEXT DEFAULT '',
      sent_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_campaign_recipient UNIQUE (tenant_id, campaign_id, phone)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_tenant ON campaign_recipients(tenant_id, campaign_id);
  `);

  // 15. Automations (Tenant-owned)
  await client.query(`
    CREATE TABLE IF NOT EXISTS automations (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      trigger_type VARCHAR(100) DEFAULT 'keyword',
      trigger_condition TEXT DEFAULT '',
      action_type VARCHAR(100) DEFAULT 'reply_text',
      action_summary TEXT DEFAULT '',
      is_enabled BOOLEAN DEFAULT true,
      executions_count INT DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_automations_tenant ON automations(tenant_id);
  `);
}

export async function down(client) {
  // Safe rollback: drops newly added multitenant auxiliary tables.
  // Intentionally NEVER drops 'users' or any 'legacy_*' tables to guarantee zero data loss.
  await client.query(`
    DROP TABLE IF EXISTS campaign_recipients CASCADE;
    DROP TABLE IF EXISTS campaigns CASCADE;
    DROP TABLE IF EXISTS automations CASCADE;
    DROP TABLE IF EXISTS outbox_events CASCADE;
    DROP TABLE IF EXISTS audit_events CASCADE;
    DROP TABLE IF EXISTS suppressions CASCADE;
    DROP TABLE IF EXISTS consents CASCADE;
    DROP TABLE IF EXISTS attachments CASCADE;
    DROP TABLE IF EXISTS message_receipts CASCADE;
    DROP TABLE IF EXISTS messages CASCADE;
    DROP TABLE IF EXISTS conversations CASCADE;
    DROP TABLE IF EXISTS contacts CASCADE;
    DROP TABLE IF EXISTS whatsapp_sessions CASCADE;
    DROP TABLE IF EXISTS refresh_tokens CASCADE;
    DROP TABLE IF EXISTS memberships CASCADE;
    DROP TABLE IF EXISTS tenants CASCADE;
  `);
}
