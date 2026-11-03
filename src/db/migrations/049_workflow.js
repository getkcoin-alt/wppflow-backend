export const version = "049_workflow";

// Workflows: an automation that asks, understands the answer and branches. The chat a workflow is holding remembers which step it
// is on and what the customer said so far, and every saved change to an automation is kept so the last one can be undone.
// Nothing existing is rewritten: the new columns have defaults, and a rule that is not a workflow never reads them.
export async function up(client) {
  await client.query(`
    ALTER TABLE automation_chats
      ADD COLUMN IF NOT EXISTS node VARCHAR(64),
      ADD COLUMN IF NOT EXISTS vars JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS automation_versions (
      id BIGSERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      automation_id VARCHAR(64) NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      version INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      trigger_type VARCHAR(100) NOT NULL,
      trigger_condition TEXT NOT NULL DEFAULT '',
      action_type VARCHAR(100) NOT NULL,
      action_summary TEXT NOT NULL DEFAULT '',
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      note TEXT NOT NULL DEFAULT '',
      created_by INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (automation_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_automation_versions_rule ON automation_versions(tenant_id, automation_id, version DESC);
  `);
}
export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
