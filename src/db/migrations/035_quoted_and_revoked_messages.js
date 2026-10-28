export const version = "035_quoted_and_revoked_messages";

export async function up(client) {
  await client.query(`
    -- 1. Quoted message metadata and reference
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS quoted JSONB DEFAULT NULL;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS quoted_message_id VARCHAR(64) REFERENCES messages(id) ON DELETE SET NULL;

    -- 2. Soft-deletion flag for "delete for me"
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;

    CREATE INDEX IF NOT EXISTS idx_messages_quoted_message_id ON messages(tenant_id, quoted_message_id);
    CREATE INDEX IF NOT EXISTS idx_messages_is_deleted ON messages(tenant_id, conversation_id, is_deleted);

    -- 3. Data healing: Fix existing conversations whose last_message is stuck on 'sending'
    UPDATE conversations c
    SET last_message = jsonb_set(
      jsonb_set(c.last_message, '{status}', to_jsonb(m.status)),
      '{ack}', to_jsonb(m.ack)
    )
    FROM (
      SELECT DISTINCT ON (conversation_id) conversation_id, status, ack
      FROM messages
      WHERE sender = 'agent'
      ORDER BY conversation_id, timestamp_epoch DESC, id DESC
    ) m
    WHERE c.id = m.conversation_id
      AND c.last_message->>'status' = 'sending'
      AND m.status IN ('sent', 'delivered', 'read');
  `);
}

export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
