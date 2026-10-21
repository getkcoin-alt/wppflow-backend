export const version = "006_owner_setup_links";
export async function up(client) {
  await client.query(`
    ALTER TABLE invitations ADD COLUMN IF NOT EXISTS set_password BOOLEAN NOT NULL DEFAULT false;
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
