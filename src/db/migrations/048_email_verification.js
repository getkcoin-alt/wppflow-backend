export const version = "048_email_verification";

// Email verification, the first sign-in, and the welcome guide. Existing people are treated as verified, as having signed in before
// and as having seen the guide, so nobody is locked out or interrupted by this change; only accounts made from now on start unverified.
export async function up(client) {
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS first_login_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS guide_seen_at TIMESTAMPTZ;
    UPDATE users SET email_verified_at=COALESCE(email_verified_at, now()), first_login_at=COALESCE(first_login_at, created_at, now()), guide_seen_at=COALESCE(guide_seen_at, now())
      WHERE email_verified_at IS NULL AND first_login_at IS NULL AND guide_seen_at IS NULL;

    -- A 24-hour, single-use link emailed to the address. Only the hash of the token is kept, as for invitations and password resets.
    CREATE TABLE IF NOT EXISTS email_verifications (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id, created_at DESC);
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
