export const version = "039_message_hidden";

// "Delete for me" in a shared inbox hides a message from that one person only. The message, the customer's phone and
// every teammate's view are left as they were.
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS message_hidden (
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      message_id VARCHAR(64) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_hidden_user ON message_hidden(tenant_id, user_id);
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
