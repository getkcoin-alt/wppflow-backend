export const version = "025_support_access";
export async function up(client) {
  await client.query(`
    -- A platform administrator who needs to look at a company's account (its team, the health of its numbers, its
    -- account activity) opens a support session with a reason. It lasts a short while, tells the company's owner,
    -- and every look is written down where the company can read it. Chats, contacts and media are never part of it.
    CREATE TABLE IF NOT EXISTS support_access (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      admin_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      admin_name VARCHAR(255) NOT NULL DEFAULT '',
      admin_email VARCHAR(255) NOT NULL DEFAULT '',
      reason TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_support_access_tenant ON support_access(tenant_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS support_access_log (
      id BIGSERIAL PRIMARY KEY,
      access_id VARCHAR(64) NOT NULL REFERENCES support_access(id) ON DELETE CASCADE,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      action VARCHAR(40) NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}',
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_support_access_log_access ON support_access_log(access_id, at);
  `);
}
