export const version = "036_upcoming_followups";

export async function up(client) {
  await client.query(`
    -- Add upcoming_notified_at column to lead_tasks for advance follow-up warnings
    ALTER TABLE lead_tasks ADD COLUMN IF NOT EXISTS upcoming_notified_at TIMESTAMPTZ DEFAULT NULL;
    CREATE INDEX IF NOT EXISTS idx_lead_tasks_upcoming ON lead_tasks(tenant_id, due_at) WHERE done_at IS NULL AND upcoming_notified_at IS NULL;
  `);
}

export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
