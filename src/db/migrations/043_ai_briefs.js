export const version = "043_ai_briefs";

// Each morning's short brief for a company's owners and administrators.
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_briefs (
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      text TEXT NOT NULL,
      source VARCHAR(8) NOT NULL DEFAULT 'rules',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, day),
      CHECK (source IN ('rules','ai'))
    );
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
