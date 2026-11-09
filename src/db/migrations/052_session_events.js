export const version = "052_session_events";

// What happened to each linked WhatsApp number, and why: connected, dropped (and the reason WhatsApp or the server gave), restarted by
// the server, restored after a deploy, unlinked from the phone. Until now only the current state was kept, so how often numbers dropped,
// and what caused it, could not be told afterwards. One short row per event; nothing from a conversation is stored here.
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_session_events (
      id BIGSERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      session_name VARCHAR(64) NOT NULL,
      event VARCHAR(40) NOT NULL,
      cause VARCHAR(60),
      detail TEXT,
      worker_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_wa_session_events_number ON whatsapp_session_events(tenant_id, session_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wa_session_events_when ON whatsapp_session_events(created_at DESC);
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
