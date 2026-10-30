export const version = "037_anti_ban_broadcast_safety";

export async function up(client) {
  await client.query(`
    -- Add Anti-Ban protection columns to campaigns
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS batch_size INT DEFAULT 25;
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cooldown_seconds INT DEFAULT 300;
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS consecutive_failures INT DEFAULT 0;
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS circuit_breaker_tripped BOOLEAN DEFAULT FALSE;
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS spintax_enabled BOOLEAN DEFAULT TRUE;
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS typing_simulation BOOLEAN DEFAULT TRUE;

    CREATE INDEX IF NOT EXISTS idx_campaigns_cooldown ON campaigns(tenant_id, status, cooldown_until);
  `);
}

export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
