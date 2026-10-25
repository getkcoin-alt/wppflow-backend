export const version = "023_number_health";
export async function up(client) {
  await client.query(`
    -- What the server knows about how a WhatsApp number is doing: the last time it was asked "are you there?",
    -- how many checks in a row went unanswered, since when it has been connected or down, and how often it has
    -- been brought back by itself. The number-health screen and the alerts read these.
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS last_heartbeat_ok_at TIMESTAMPTZ;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS heartbeat_failures INT NOT NULL DEFAULT 0;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS heartbeat_error TEXT;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS connected_since TIMESTAMPTZ;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS down_since TIMESTAMPTZ;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS reconnect_attempts INT NOT NULL DEFAULT 0;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS last_reconnect_at TIMESTAMPTZ;
    -- A number that is connected right now has been connected since it last changed to that state.
    UPDATE whatsapp_sessions SET connected_since=COALESCE(connected_since,updated_at) WHERE status='CONNECTED';
    -- Failed and still-waiting messages of one number, newest first, without reading every message of a chat.
    CREATE INDEX IF NOT EXISTS idx_messages_trouble ON messages(tenant_id, timestamp_epoch) WHERE status IN ('failed','uncertain','sending','dispatching');
  `);
}
