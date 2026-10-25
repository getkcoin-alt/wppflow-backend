export const version = "022_inbox_followups";
export async function up(client) {
  await client.query(`
    -- When the customer's first still-unanswered message was sent (epoch seconds): set when a customer writes to a
    -- chat nobody is waiting on, cleared when a person on the team answers. Automatic replies and team notes do
    -- not clear it. The inbox filters "waiting" and "overdue" read it, and so does the badge on a chat.
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS awaiting_since BIGINT;
    UPDATE conversations c SET awaiting_since = x.first_unanswered
    FROM (
      SELECT c2.id,
        (SELECT min(m.timestamp_epoch) FROM messages m
          WHERE m.conversation_id=c2.id AND m.sender='customer'
            AND m.timestamp_epoch > COALESCE((SELECT max(h.timestamp_epoch) FROM messages h
                WHERE h.conversation_id=c2.id AND h.sender='agent' AND h.type<>'internal_note' AND h.agent_name NOT IN ('Automation','Campaign')),0)) AS first_unanswered
      FROM conversations c2 WHERE NOT c2.is_group
    ) x
    WHERE c.id=x.id AND x.first_unanswered IS NOT NULL AND c.awaiting_since IS NULL;
    CREATE INDEX IF NOT EXISTS idx_conversations_awaiting ON conversations(tenant_id, awaiting_since) WHERE awaiting_since IS NOT NULL;

    -- A follow-up can belong to a chat with no lead behind it.
    ALTER TABLE lead_tasks ALTER COLUMN lead_id DROP NOT NULL;
    ALTER TABLE lead_tasks ADD COLUMN IF NOT EXISTS conversation_id VARCHAR(64) REFERENCES conversations(id) ON DELETE CASCADE;
    ALTER TABLE lead_tasks ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lead_tasks_has_a_home') THEN
        ALTER TABLE lead_tasks ADD CONSTRAINT lead_tasks_has_a_home CHECK (lead_id IS NOT NULL OR conversation_id IS NOT NULL);
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_lead_tasks_conversation ON lead_tasks(conversation_id) WHERE conversation_id IS NOT NULL;

    -- How long a follow-up may stay overdue before the owner and administrators are told (0: never).
    ALTER TABLE report_settings ADD COLUMN IF NOT EXISTS task_escalation_hours INT NOT NULL DEFAULT 24 CHECK (task_escalation_hours BETWEEN 0 AND 720);
  `);
}
