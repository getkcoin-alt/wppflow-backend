export const version = "007_session_last_error";
export async function up(client) {
  await client.query(`
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS last_error TEXT;
    -- A session that never paired a phone has nothing to restore.
    UPDATE whatsapp_sessions SET restore_on_start=false WHERE phone IS NULL AND restore_on_start;
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
