export const version = "056_agent_new_number_limits";

// Limits for an agent are in two sets that do not use each other up: messages to the customers a company already has (hour, day, one chat),
// and chats with new numbers (an hour and a day). The first message to a new number counts only against the second set,
// so an owner can keep outreach small without stopping replies, and the other way round.
export async function up(client) {
  await client.query(`
    ALTER TABLE agent_keys ADD COLUMN IF NOT EXISTS new_chats_per_hour INT NOT NULL DEFAULT 5 CHECK (new_chats_per_hour BETWEEN 1 AND 100);
    ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS first_message BOOLEAN NOT NULL DEFAULT false;
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
