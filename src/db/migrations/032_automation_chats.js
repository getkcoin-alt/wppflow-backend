export const version = "032_automation_chats";
export async function up(client) {
  await client.query(`
    -- A chat that an automation is holding a short conversation in (Riwo answering until a person takes over). One row per
    -- chat and rule. The row is how the engine knows a later message belongs to that conversation, and how a person's
    -- reply, or the end of the allowance, hands the chat back for good. Nothing here is read by the rest of the product.
    CREATE TABLE IF NOT EXISTS automation_chats (
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      automation_id VARCHAR(64) NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      started_by_message_id VARCHAR(64),
      handed_off_reason TEXT,
      heard_from TEXT,
      needs_person BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, conversation_id, automation_id),
      CHECK (status IN ('active','handed_off'))
    );
    CREATE INDEX IF NOT EXISTS idx_automation_chats_automation ON automation_chats(automation_id);
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
