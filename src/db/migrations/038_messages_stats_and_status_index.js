export const version = "038_messages_stats_and_status_index";

export async function up(client) {
  await client.query(`
    -- Composite index to accelerate workspace dashboard message counts (sent, delivered, read)
    -- and eliminate full sequential scans on messages table
    CREATE INDEX IF NOT EXISTS idx_messages_tenant_stats 
      ON messages(tenant_id, sender, type, ack);

    -- Index to accelerate queue and outbox lookups for in-flight/sending/dispatching messages
    CREATE INDEX IF NOT EXISTS idx_messages_tenant_status 
      ON messages(tenant_id, status);
  `);
}

export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
