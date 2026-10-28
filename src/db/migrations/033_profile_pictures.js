export const version = "033_profile_pictures";
export async function up(client) {
  await client.query(`
    -- The picture WhatsApp shows for a chat, kept here so it can be shown again without asking WhatsApp each time. WhatsApp's own
    -- addresses for pictures are signed and run out within days, so the image itself is kept (a small thumbnail), with the
    -- time it was fetched. "none" remembers that a person has no picture, so they are not asked about again at once.
    CREATE TABLE IF NOT EXISTS profile_pictures (
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      chat_id VARCHAR(128) NOT NULL,
      status VARCHAR(8) NOT NULL CHECK (status IN ('ok','none')),
      content_type VARCHAR(24),
      image BYTEA,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, chat_id)
    );
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
