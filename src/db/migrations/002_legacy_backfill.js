export const version = '002_legacy_backfill';

export async function up(client) {
  // Ensure schema columns and tables are aligned even if 001 ran prior to this upgrade
  await client.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS provider_chat_id VARCHAR(128);
    UPDATE conversations SET provider_chat_id = phone WHERE provider_chat_id IS NULL;
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_tenant_session_chat'
      ) THEN
        ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_tenant_id_phone_key;
        ALTER TABLE conversations ADD CONSTRAINT uq_tenant_session_chat UNIQUE (tenant_id, session_name, provider_chat_id);
      END IF;
    END $$;

    ALTER TABLE messages ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128);
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_tenant_idempotency'
      ) THEN
        ALTER TABLE messages ADD CONSTRAINT uq_tenant_idempotency UNIQUE (tenant_id, idempotency_key);
      END IF;
    END $$;

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
  `);

  // Check if legacy tables or existing users exist
  const legacyCheck = await client.query(`
    SELECT 
      EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'legacy_chats') as has_legacy_chats,
      EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'legacy_contacts') as has_legacy_contacts,
      EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'legacy_messages') as has_legacy_messages,
      EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'legacy_campaigns') as has_legacy_campaigns,
      EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'legacy_automations') as has_legacy_automations,
      EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') as has_users
  `);

  const {
    has_legacy_chats,
    has_legacy_contacts,
    has_legacy_messages,
    has_legacy_campaigns,
    has_legacy_automations,
    has_users
  } = legacyCheck.rows[0];

  if (!has_users) {
    // Fresh database without any legacy users or tables
    return;
  }

  // 1. Group legacy users by company_name to preserve team membership semantics
  const usersRes = await client.query(`
    SELECT id, email, name, 
           COALESCE(company_name, '') as company_name, 
           COALESCE(role, 'user') as role, 
           COALESCE(status, 'active') as status 
    FROM users 
    ORDER BY id ASC
  `);

  if (usersRes.rows.length === 0) return;

  const userToTenant = new Map();
  const companyGroups = new Map();

  for (const u of usersRes.rows) {
    const rawCompany = u.company_name.trim();
    // Normalize company name; group teammates by company
    const groupKey = rawCompany.length > 0 ? rawCompany.toLowerCase() : `solo_user_${u.id}`;
    if (!companyGroups.has(groupKey)) {
      companyGroups.set(groupKey, []);
    }
    companyGroups.get(groupKey).push(u);
  }

  const createdTenantIds = [];

  for (const [groupKey, members] of companyGroups.entries()) {
    const firstMember = members[0];
    const isSolo = groupKey.startsWith('solo_user_');
    const tenantName = isSolo ? `${firstMember.name}'s Workspace` : firstMember.company_name.trim();
    const cleanSlug = tenantName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `workspace-${firstMember.id}`;
    const tenantId = `tenant_${cleanSlug}_${firstMember.id}`;

    await client.query(`
      INSERT INTO tenants (id, name, slug, plan, sessions_limit)
      VALUES ($1, $2, $3, 'Enterprise', 25)
      ON CONFLICT (id) DO NOTHING
    `, [tenantId, tenantName, `${cleanSlug}-${firstMember.id}`]);

    createdTenantIds.push(tenantId);

    // Assign memberships with team roles
    let hasOwner = false;
    for (const member of members) {
      userToTenant.set(member.id, tenantId);

      let assignedRole = 'agent';
      if (!hasOwner && (member.role === 'admin' || members.length === 1)) {
        assignedRole = 'owner';
        hasOwner = true;
      } else if (member.role === 'admin') {
        assignedRole = 'admin';
      }

      await client.query(`
        INSERT INTO memberships (tenant_id, user_id, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, user_id) DO NOTHING
      `, [tenantId, member.id, assignedRole]);

      // Set is_superadmin for admin@wppflow.io
      if (member.email.toLowerCase() === 'admin@wppflow.io') {
        await client.query(`UPDATE users SET is_superadmin = true WHERE id = $1`, [member.id]);
      }
    }

    // If no admin was in group, promote the first member to owner
    if (!hasOwner && members.length > 0) {
      await client.query(`
        UPDATE memberships SET role = 'owner' WHERE tenant_id = $1 AND user_id = $2
      `, [tenantId, firstMember.id]);
    }
  }

  // 2. Backfill legacy contacts
  if (has_legacy_contacts) {
    const contactsRes = await client.query(`
      SELECT id, user_id, name, phone, email, avatar, tags, custom_traits, lifetime_value, assigned_agent, created_at
      FROM legacy_contacts
    `);

    for (const c of contactsRes.rows) {
      const tenantId = userToTenant.get(c.user_id);
      if (!tenantId) continue;

      await client.query(`
        INSERT INTO contacts (
          id, tenant_id, name, phone, email, avatar, tags, custom_traits,
          lifetime_value, assigned_agent, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (tenant_id, phone) DO UPDATE SET
          name = EXCLUDED.name,
          avatar = COALESCE(NULLIF(EXCLUDED.avatar, ''), contacts.avatar)
      `, [
        c.id, tenantId, c.name, c.phone, c.email || '', c.avatar || '',
        c.tags || '[]', c.custom_traits || '{}', c.lifetime_value || 0,
        c.assigned_agent || '', c.created_at
      ]);
    }
  }

  // 3. Backfill legacy chats into conversations
  const chatToTenant = new Map();
  if (has_legacy_chats) {
    const chatsRes = await client.query(`
      SELECT id, user_id, contact_id, contact_name, phone, avatar, channel,
             unread_count, is_group, group_members_count, assigned_to, is_closed,
             last_message, tags, created_at
      FROM legacy_chats
    `);

    for (const chat of chatsRes.rows) {
      const tenantId = userToTenant.get(chat.user_id);
      if (!tenantId) continue;

      chatToTenant.set(chat.id, tenantId);
      const sessionName = chat.channel || 'primary-whatsapp';
      const providerChatId = chat.phone;
      const lastActiveEpoch = Math.floor(new Date(chat.created_at).getTime() / 1000);

      await client.query(`
        INSERT INTO conversations (
          id, tenant_id, session_name, provider_chat_id, contact_id, phone,
          contact_name, avatar, unread_count, is_group, group_members_count,
          assigned_to, is_closed, last_active_epoch, last_message, tags, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (tenant_id, session_name, provider_chat_id) DO UPDATE SET
          last_active_epoch = GREATEST(conversations.last_active_epoch, EXCLUDED.last_active_epoch),
          last_message = EXCLUDED.last_message,
          unread_count = EXCLUDED.unread_count
      `, [
        chat.id, tenantId, sessionName, providerChatId, chat.contact_id, chat.phone,
        chat.contact_name, chat.avatar || '', chat.unread_count || 0, chat.is_group || false,
        chat.group_members_count || 0, chat.assigned_to || '', chat.is_closed || false,
        lastActiveEpoch, chat.last_message || '{}', chat.tags || '[]', chat.created_at
      ]);
    }
  }

  // 4. Backfill legacy messages
  if (has_legacy_messages) {
    const messagesRes = await client.query(`
      SELECT m.id, m.chat_id, m.sender, m.agent_name, m.text, m.type,
             m.media_url, m.file_name, m.file_size, m.audio_duration,
             m.status, m.timestamp, m.created_at, c.user_id
      FROM legacy_messages m
      LEFT JOIN legacy_chats c ON m.chat_id = c.id
    `);

    for (const m of messagesRes.rows) {
      const tenantId = m.user_id ? userToTenant.get(m.user_id) : chatToTenant.get(m.chat_id);
      if (!tenantId) continue;

      const ack = m.status === 'read' ? 3 : (m.status === 'delivered' ? 2 : 1);
      const timestampEpoch = Math.floor(new Date(m.created_at).getTime() / 1000);

      await client.query(`
        INSERT INTO messages (
          id, tenant_id, conversation_id, sender, agent_name, text, type,
          status, ack, media_url, file_name, file_size, audio_duration,
          timestamp, timestamp_epoch, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (id) DO NOTHING
      `, [
        m.id, tenantId, m.chat_id, m.sender, m.agent_name || '', m.text || '', m.type || 'text',
        m.status || 'sent', ack, m.media_url || '', m.file_name || '', m.file_size || '',
        m.audio_duration || '', m.timestamp || '', timestampEpoch, m.created_at
      ]);
    }
  }

  // 5. Backfill legacy campaigns
  if (has_legacy_campaigns) {
    const campRes = await client.query(`
      SELECT id, user_id, name, target_segment, total_recipients, sent_count,
             delivered_count, read_count, replied_count, failed_count,
             cost_saved_meta, status, template_text, anti_ban_delay_seconds,
             scheduled_for, created_at
      FROM legacy_campaigns
    `);

    for (const camp of campRes.rows) {
      const tenantId = userToTenant.get(camp.user_id);
      if (!tenantId) continue;

      await client.query(`
        INSERT INTO campaigns (
          id, tenant_id, name, target_segment, total_recipients, sent_count,
          delivered_count, read_count, replied_count, failed_count,
          cost_saved_meta, status, template_text, anti_ban_delay_seconds,
          scheduled_for, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (id) DO NOTHING
      `, [
        camp.id, tenantId, camp.name, camp.target_segment || '', camp.total_recipients || 0,
        camp.sent_count || 0, camp.delivered_count || 0, camp.read_count || 0, camp.replied_count || 0,
        camp.failed_count || 0, camp.cost_saved_meta || 0, camp.status || 'draft', camp.template_text || '',
        camp.anti_ban_delay_seconds || 4, camp.scheduled_for || '', camp.created_at
      ]);
    }
  }

  // 6. Backfill legacy automations
  if (has_legacy_automations) {
    const autoRes = await client.query(`
      SELECT id, user_id, name, trigger_type, trigger_condition, action_type,
             action_summary, is_enabled, executions_count, created_at
      FROM legacy_automations
    `);

    for (const auto of autoRes.rows) {
      const tenantId = userToTenant.get(auto.user_id);
      if (!tenantId) continue;

      await client.query(`
        INSERT INTO automations (
          id, tenant_id, name, trigger_type, trigger_condition, action_type,
          action_summary, is_enabled, executions_count, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO NOTHING
      `, [
        auto.id, tenantId, auto.name, auto.trigger_type || 'keyword', auto.trigger_condition || '',
        auto.action_type || 'reply_text', auto.action_summary || '', auto.is_enabled ?? true,
        auto.executions_count || 0, auto.created_at
      ]);
    }
  }

  // 7. Explicit session ownership mapping
  // Do NOT guess session ownership or assign sessions to the first administrator if ambiguous.
  if (createdTenantIds.length === 1) {
    // Single tenant: safe to initialize primary session
    const singleTenantId = createdTenantIds[0];
    await client.query(`
      INSERT INTO whatsapp_sessions (id, tenant_id, session_name, status)
      VALUES ($1, $2, 'primary-whatsapp', 'DISCONNECTED')
      ON CONFLICT (tenant_id, session_name) DO NOTHING
    `, [`sess_${singleTenantId}_primary-whatsapp`, singleTenantId]);
  } else if (createdTenantIds.length > 1) {
    // Multiple tenants: flag ambiguous session ownership for explicit administrator resolution
    for (const tId of createdTenantIds) {
      await client.query(`
        INSERT INTO audit_events (tenant_id, event_type, metadata)
        VALUES ($1, 'migration.session_ownership_pending', $2)
      `, [tId, JSON.stringify({
        sessionName: 'primary-whatsapp',
        note: 'Multiple tenants detected during migration. Session ownership preserved on disk awaiting explicit admin attachment.'
      })]);
    }
  }
}

export async function down(client) {
  // Safe rollback: no destructive deletion of backfilled data.
  // Legacy tables and user records remain completely intact.
}
