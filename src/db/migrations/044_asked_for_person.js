export const version = "044_asked_for_person";

// A customer who has asked to talk to a person: set when they say so, cleared when a teammate answers. While it is set,
// nothing automatic (Autopilot, Riwo's chats) answers them, and the chat is first on the team's list.
export async function up(client) {
  await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS needs_human_since BIGINT;`);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
