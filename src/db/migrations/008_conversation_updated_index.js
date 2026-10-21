export const version = "008_conversation_updated_index";
export async function up(client) {
  // Serves "what changed since" catch-up requests without scanning a workspace's chats.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_conversations_tenant_updated ON conversations(tenant_id, updated_at);
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
