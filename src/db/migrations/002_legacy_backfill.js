export const version = '002_legacy_backfill';

export async function up(client) {
  // Check if legacy chats table exists
  const legacyChatsCheck = await client.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'chats'
    );
  `);

  if (!legacyChatsCheck.rows[0].exists) {
    // Fresh database, no legacy backfill needed
    return;
  }

  // 1. Backfill legacy users into tenants and memberships
  const usersRes = await client.query(`SELECT id, email, name, company_name, role, status FROM users`);
  for (const u of usersRes.rows) {
    const tenantId = `tenant_user_${u.id}`;
    const slug = `workspace-${u.id}`;
    const tenantName = u.company_name || `${u.name}'s Workspace`;

    await client.query(`
      INSERT INTO tenants (id, name, slug, plan, sessions_limit)
      VALUES ($1, $2, $3, 'Enterprise', 25)
      ON CONFLICT (id) DO NOTHING
    `, [tenantId, tenantName, slug]);

    await client.query(`
      INSERT INTO memberships (tenant_id, user_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, user_id) DO NOTHING
    `, [tenantId, u.id, u.role === 'admin' ? 'owner' : 'agent']);

    // 2. Backfill legacy contacts for this user
    await client.query(`
      INSERT INTO contacts (id, tenant_id, name, phone, email, avatar, tags, custom_traits, created_at)
      SELECT id, $1, name, phone, email, avatar, tags, custom_traits, created_at
      FROM contacts
      WHERE user_id = $2
      ON CONFLICT (tenant_id, phone) DO UPDATE SET
        name = EXCLUDED.name,
        avatar = COALESCE(NULLIF(EXCLUDED.avatar, ''), contacts.avatar)
    `, [tenantId, u.id]);

    // 3. Backfill legacy chats into conversations
    await client.query(`
      INSERT INTO conversations (
        id, tenant_id, session_name, contact_id, phone, contact_name, avatar,
        unread_count, is_group, group_members_count, assigned_to, is_closed,
        last_active_epoch, last_message, tags, created_at
      )
      SELECT 
        id, $1, COALESCE(channel, 'primary-whatsapp'), contact_id, phone, contact_name, avatar,
        unread_count, is_group, group_members_count, assigned_to, is_closed,
        COALESCE(last_active_epoch, EXTRACT(EPOCH FROM created_at)::bigint),
        last_message, tags, created_at
      FROM chats
      WHERE user_id = $2
      ON CONFLICT (tenant_id, phone) DO UPDATE SET
        last_active_epoch = GREATEST(conversations.last_active_epoch, EXCLUDED.last_active_epoch),
        last_message = EXCLUDED.last_message,
        unread_count = EXCLUDED.unread_count
    `, [tenantId, u.id]);

    // 4. Backfill legacy messages into messages
    await client.query(`
      INSERT INTO messages (
        id, tenant_id, conversation_id, sender, agent_name, text, type,
        status, ack, media_url, file_name, file_size, audio_duration,
        timestamp, timestamp_epoch, created_at
      )
      SELECT 
        m.id, $1, m.chat_id, m.sender, m.agent_name, m.text, m.type,
        m.status, (CASE WHEN m.status = 'read' THEN 3 WHEN m.status = 'delivered' THEN 2 ELSE 1 END),
        m.media_url, m.file_name, m.file_size, m.audio_duration,
        m.timestamp, EXTRACT(EPOCH FROM m.created_at)::bigint, m.created_at
      FROM messages m
      JOIN chats c ON m.chat_id = c.id
      WHERE c.user_id = $2
      ON CONFLICT (id) DO NOTHING
    `, [tenantId, u.id]);
  }
}

export async function down(client) {
  // Safe rollback: no destructive deletion of backfilled data
}
