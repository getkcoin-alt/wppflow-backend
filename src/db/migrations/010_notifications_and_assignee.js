export const version = "010_notifications_and_assignee";
export async function up(client) {
  await client.query(`
    -- Assignment points at a person, not just a display name, so access can follow it.
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_user_id INT REFERENCES users(id) ON DELETE SET NULL;
    -- Backfill only where the name identifies exactly one active teammate in that workspace.
    UPDATE conversations c SET assigned_user_id = m.user_id
      FROM (
        SELECT mm.tenant_id, u.name, min(u.id) AS user_id, count(*) AS n
        FROM memberships mm JOIN users u ON u.id = mm.user_id
        WHERE mm.status = 'active' GROUP BY mm.tenant_id, u.name
      ) m
      WHERE m.tenant_id = c.tenant_id AND m.name = c.assigned_to AND m.n = 1
        AND c.assigned_to <> '' AND c.assigned_user_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_conversations_assignee ON conversations(tenant_id, assigned_user_id) WHERE assigned_user_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(30) NOT NULL,
      conversation_id VARCHAR(64) REFERENCES conversations(id) ON DELETE CASCADE,
      message_id VARCHAR(64),
      dedupe_key TEXT,
      actor_id INT REFERENCES users(id) ON DELETE SET NULL,
      actor_name TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, tenant_id) WHERE read_at IS NULL;
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
