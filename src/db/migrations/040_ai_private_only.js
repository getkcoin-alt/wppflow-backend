export const version = "040_ai_private_only";

// A company can limit Riwo to AI providers that say they do not train on what they are sent.
export async function up(client) {
  await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_private_only BOOLEAN NOT NULL DEFAULT false;`);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
