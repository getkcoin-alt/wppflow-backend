export const version = "029_password_resets";
export async function up(client) {
  await client.query(`
    -- "Forgot password": a one-hour, single-use link emailed to the account. Only the hash of the link's token is kept,
    -- the same way invitations are stored, so a copy of this table cannot be used to take over an account.
    CREATE TABLE IF NOT EXISTS password_resets (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- the per-address request cap and "cancel the older links" both look up by user and time
    CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, created_at DESC);
  `);
}
