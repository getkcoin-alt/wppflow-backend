export const version = "045_sales_assistant";

// The sales assistant: Riwo asks a company's own discovery questions one by one and keeps what the customer answers, then
// hands the chat to an executive when the customer asks for pricing or a proposal (or the questions are done).
//   automation_chats.step          how many of the questions have been asked
//   automation_chats.requirements  [{ n, question, answer }] what has been answered so far
//   automation_chats.outcome       how the conversation ended: pricing, qualified or limit
//   conversations.needs_human_reason  why a person is needed: person, pricing or qualified (read only while needs_human_since is set)
export async function up(client) {
  await client.query(`
    ALTER TABLE automation_chats ADD COLUMN IF NOT EXISTS step INT NOT NULL DEFAULT 0;
    ALTER TABLE automation_chats ADD COLUMN IF NOT EXISTS requirements JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE automation_chats ADD COLUMN IF NOT EXISTS outcome VARCHAR(16);
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS needs_human_reason VARCHAR(16);
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
