export const version = "034_user_identities";
export async function up(client) {
  await client.query(`
    -- A way of signing in other than a password, linked to a person. For now only Google. The person is found by the
    -- provider's own stable id ("subject"), not by e-mail, which a person can change; the e-mail is kept only to show.
    CREATE TABLE IF NOT EXISTS user_identities (
      provider VARCHAR(16) NOT NULL,
      subject VARCHAR(64) NOT NULL,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email VARCHAR(254),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, subject)
    );
    CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
