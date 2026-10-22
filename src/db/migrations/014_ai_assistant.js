export const version = "014_ai_assistant";
export async function up(client) {
  await client.query(`
    -- Each company can switch the AI assistant off, and can have its own daily allowance
    -- (NULL means the server's default).
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_daily_limit INT;
    -- How much of the allowance a company has used each day, and the tokens it cost.
    CREATE TABLE IF NOT EXISTS ai_usage (
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      requests INT NOT NULL DEFAULT 0,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, day)
    );
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
