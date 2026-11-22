export const version = "055_agent_no_ai_line";

// Messages an AI agent sends no longer carry "AI assistant reply" by default: they go out as the owner's agent wrote them. The line stays
// available as a choice per agent. Agents made while it was on by default are switched off, because their owner never chose it.
export async function up(client) {
  await client.query(`
    ALTER TABLE agent_keys ALTER COLUMN disclose SET DEFAULT false;
    UPDATE agent_keys SET disclose=false WHERE disclose=true;
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
