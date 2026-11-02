export const version = "042_autopilot";

// Autopilot: what a company lets Riwo do by itself (all off until an owner switches it on), and a record of every
// customer message it looked at, so each message is handled once and every action can be reviewed or taken back.
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS autopilot_rules (
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      rule_key VARCHAR(40) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT false,
      updated_by INT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, rule_key)
    );
    CREATE TABLE IF NOT EXISTS autopilot_log (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      trigger_message_id VARCHAR(64) NOT NULL,
      rule_key VARCHAR(40) NOT NULL,
      outcome VARCHAR(12) NOT NULL DEFAULT 'working',
      reason VARCHAR(60) NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      reply_message_id VARCHAR(64),
      prior_awaiting_since BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, trigger_message_id),
      CHECK (outcome IN ('working','sent','cleared','skipped','undone'))
    );
    CREATE INDEX IF NOT EXISTS idx_autopilot_log_tenant ON autopilot_log(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_autopilot_log_chat ON autopilot_log(conversation_id, outcome);
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
