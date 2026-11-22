export const version = "054_agent_new_chats";

// An AI agent may be allowed to start a chat with a number the company has not spoken to yet (message_new_number). That is the one thing
// with real risk of a number being reported, so it is a switch of its own, off unless the owner turns it on, with its own daily cap.
export async function up(client) {
  await client.query(`
    ALTER TABLE agent_keys ADD COLUMN IF NOT EXISTS allow_new_chats BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE agent_keys ADD COLUMN IF NOT EXISTS new_chats_per_day INT NOT NULL DEFAULT 10 CHECK (new_chats_per_day BETWEEN 1 AND 200);
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
