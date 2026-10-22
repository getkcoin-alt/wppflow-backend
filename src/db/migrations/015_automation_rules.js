export const version = "015_automation_rules";
export async function up(client) {
  await client.query(`
    -- Rules can start on more than a keyword (a first message, after hours) and do more than reply or
    -- assign. The extra settings of a rule live here: how keywords match, business hours, a confirmation
    -- reply, and how long to leave a customer alone after the rule ran.
    ALTER TABLE automations ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}';
    -- Which ready-made rule it was made from, if any.
    ALTER TABLE automations ADD COLUMN IF NOT EXISTS template_id VARCHAR(64);
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
