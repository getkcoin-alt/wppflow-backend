export const version = "041_ai_insights";

// What Riwo prepared for a chat while nobody was looking: a one-line summary, how the customer sounds, the next step and a
// reply ready to send. One row per chat, rewritten when the customer writes again. `based_on_message_id` is the customer's
// message it was prepared for, so a stale one is never shown.
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_insights (
      conversation_id VARCHAR(64) PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      based_on_message_id VARCHAR(64),
      status VARCHAR(12) NOT NULL DEFAULT 'working',
      summary TEXT NOT NULL DEFAULT '',
      mood VARCHAR(12),
      mood_note TEXT NOT NULL DEFAULT '',
      next_step TEXT NOT NULL DEFAULT '',
      draft TEXT NOT NULL DEFAULT '',
      provider VARCHAR(40) NOT NULL DEFAULT '',
      model VARCHAR(120) NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      retry_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (status IN ('working','ready','failed'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_insights_tenant ON ai_insights(tenant_id, status);
    -- the company can switch the preparing off while keeping Riwo's buttons
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_prepare BOOLEAN NOT NULL DEFAULT true;
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
