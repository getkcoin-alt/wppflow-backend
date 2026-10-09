export const version = '001_multitenant_core';

export async function up(client) {
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

  // 2. Users (Platform users)
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
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

  // 7. Conversations (Tenant-owned, replaced legacy chats)
  await client.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      session_name VARCHAR(128) NOT NULL,
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
      UNIQUE (tenant_id, phone)
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_tenant_epoch ON conversations(tenant_id, last_active_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_tenant_unread ON conversations(tenant_id, unread_count);
  `);

  // 8. Messages (Tenant-owned)
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
      CONSTRAINT uq_tenant_provider_msg UNIQUE (tenant_id, provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_tenant_conv_epoch ON messages(tenant_id, conversation_id, timestamp_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_tenant_idempotency ON messages(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
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
}

export async function down(client) {
  await client.query(`
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
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS tenants CASCADE;
  `);
}
