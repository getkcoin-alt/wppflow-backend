export const version = "011_team_categories_and_mail_status";
export async function up(client) {
  await client.query(`
    -- A label that says what a teammate does (sales, support, ...). Permissions still come from the role.
    ALTER TABLE memberships ADD COLUMN IF NOT EXISTS category VARCHAR(40) NOT NULL DEFAULT 'general';
    ALTER TABLE invitations ADD COLUMN IF NOT EXISTS category VARCHAR(40) NOT NULL DEFAULT 'general';
    -- Whether the invitation email actually left: sent, failed or not_configured.
    ALTER TABLE invitations ADD COLUMN IF NOT EXISTS email_status VARCHAR(24);
    ALTER TABLE invitations ADD COLUMN IF NOT EXISTS email_error TEXT;
    ALTER TABLE invitations ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
    ALTER TABLE invitations ADD COLUMN IF NOT EXISTS email_attempts INT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_invitations_pending ON invitations(tenant_id) WHERE accepted_at IS NULL;
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
