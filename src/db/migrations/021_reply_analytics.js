export const version = "021_reply_analytics";
export async function up(client) {
  await client.query(`
    -- Who on the team sent a reply (the name alone is not enough to tell two people apart).
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_by_user_id INT;
    -- Replies sent before this existed are matched by name, but only where one person in the company has that name.
    WITH only_one AS (
      SELECT mem.tenant_id, u.name, min(u.id) AS user_id
      FROM memberships mem JOIN users u ON u.id=mem.user_id
      GROUP BY mem.tenant_id, u.name HAVING count(*)=1
    )
    UPDATE messages m SET sent_by_user_id=o.user_id
    FROM only_one o
    WHERE m.tenant_id=o.tenant_id AND m.sender='agent' AND m.sent_by_user_id IS NULL AND m.agent_name=o.name AND m.agent_name<>'';
    -- Reply-time reports read recent messages of one company in order, by chat.
    CREATE INDEX IF NOT EXISTS idx_messages_tenant_epoch ON messages(tenant_id, timestamp_epoch);

    -- How fast a reply should come: a default for the company and, optionally, one per team (the label a teammate has).
    CREATE TABLE IF NOT EXISTS report_settings (
      tenant_id VARCHAR(64) PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      sla_minutes INT NOT NULL DEFAULT 30 CHECK (sla_minutes BETWEEN 1 AND 10080),
      daily_in_app BOOLEAN NOT NULL DEFAULT true,
      daily_email BOOLEAN NOT NULL DEFAULT false,
      last_daily_for DATE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS team_sla (
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      team VARCHAR(40) NOT NULL,
      sla_minutes INT NOT NULL CHECK (sla_minutes BETWEEN 1 AND 10080),
      PRIMARY KEY (tenant_id, team)
    );
  `);
}
