export const version = "026_plan_limits";
export async function up(client) {
  await client.query(`
    -- How many broadcasts a company on this plan may start in a calendar month (NULL: no limit). Like the contact
    -- limit, nothing is limited until the platform admin sets a number on a plan.
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_broadcasts_per_month INT CHECK (max_broadcasts_per_month IS NULL OR max_broadcasts_per_month >= 1);
    -- When a broadcast was first started. Starting it again after a pause does not count it twice.
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
    UPDATE campaigns SET started_at=COALESCE(updated_at,created_at) WHERE status<>'draft' AND started_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_campaigns_started ON campaigns(tenant_id, started_at) WHERE started_at IS NOT NULL;
  `);
}
