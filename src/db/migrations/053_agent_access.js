export const version = "053_agent_access";

// AI agent access: a company lets an AI agent (Claude, ChatGPT, Cursor, a script of its own ...) work its WhatsApp inbox through
// Scriwo's MCP server or REST API, with the permissions the owner chose. Nothing existing is rewritten.
//
// The agent's key is its own credential on purpose and never an api_keys row: an API key counts as a manager (isManager in
// services/access.js) on every route that does not check scope, and an agent must be able to do only what its level allows. The key
// is stored only as a hash, shown once, and revoking it stops the agent at once.
//
// agent_events is the record of what each agent did (one short row per call, no message text, kept 30 days), so the owner can see it and
// the limits (messages an hour, a day, per chat) can be counted. A send is first written with ok = NULL (reserved), then settled.
// messages.sent_via marks a message an AI agent sent, so that the inbox can label it and the hand-off rules treat it like a machine.
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_keys (
      id VARCHAR(40) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(80) NOT NULL,
      level VARCHAR(8) NOT NULL CHECK (level IN ('read','reply','full')),
      key_hash TEXT NOT NULL UNIQUE,
      prefix VARCHAR(24) NOT NULL,
      sessions JSONB NOT NULL DEFAULT '[]'::jsonb,
      allow_groups BOOLEAN NOT NULL DEFAULT false,
      share_phones BOOLEAN NOT NULL DEFAULT false,
      disclose BOOLEAN NOT NULL DEFAULT true,
      per_hour INT NOT NULL DEFAULT 30 CHECK (per_hour BETWEEN 1 AND 1000),
      per_day INT NOT NULL DEFAULT 200 CHECK (per_day BETWEEN 1 AND 10000),
      per_chat_hour INT NOT NULL DEFAULT 6 CHECK (per_chat_hour BETWEEN 1 AND 100),
      expires_at TIMESTAMPTZ,
      created_by INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      last_client VARCHAR(80),
      revoked_at TIMESTAMPTZ,
      revoked_by INT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_keys_tenant ON agent_keys(tenant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_events (
      id BIGSERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      agent_id VARCHAR(40) NOT NULL REFERENCES agent_keys(id) ON DELETE CASCADE,
      tool VARCHAR(40) NOT NULL,
      ok BOOLEAN,
      conversation_id VARCHAR(64),
      summary VARCHAR(240) NOT NULL DEFAULT '',
      error_code VARCHAR(40),
      ms INT,
      via VARCHAR(8) NOT NULL DEFAULT 'mcp',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_events_tenant ON agent_events(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_events_when ON agent_events(created_at);

    -- a column with no default is only a catalogue change: the messages table is not rewritten
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_via VARCHAR(16);
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
