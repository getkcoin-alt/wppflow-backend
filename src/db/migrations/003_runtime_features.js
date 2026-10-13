import { up as ensureCore } from "./001_multitenant_core.js";
export const version = "003_runtime_features";
export async function up(client) {
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS provider_chat_id VARCHAR(128);
    UPDATE conversations SET provider_chat_id=CASE WHEN phone LIKE '%@%' THEN phone ELSE regexp_replace(phone,'[^0-9]','','g')||'@c.us' END WHERE provider_chat_id IS NULL;
    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_tenant_id_phone_key;
    ALTER TABLE conversations ALTER COLUMN provider_chat_id SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_identity ON conversations(tenant_id,session_name,provider_chat_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_message_idempotency ON messages(tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
    ALTER TABLE memberships ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'active';
  `);
  await ensureCore(client);
  await client.query(`
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS restore_on_start BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS worker_id UUID;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS qr_code TEXT;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS next_send_at TIMESTAMPTZ;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS session_name VARCHAR(128);
    ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS message_id VARCHAR(64);
    ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
    ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
    ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_error TEXT;
    ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ DEFAULT now();
    CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_message ON outbox_events(tenant_id,aggregate_id,event_type);
    CREATE TABLE IF NOT EXISTS early_receipts(tenant_id VARCHAR(64) REFERENCES tenants(id),provider_message_id VARCHAR(128),ack INT NOT NULL,PRIMARY KEY(tenant_id,provider_message_id));
    CREATE TABLE IF NOT EXISTS canned_replies(id UUID PRIMARY KEY,tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id),shortcut TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,UNIQUE(tenant_id,shortcut));
    CREATE TABLE IF NOT EXISTS invitations(id UUID PRIMARY KEY,tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id),email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,expires_at TIMESTAMPTZ NOT NULL,accepted_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS api_keys(id UUID PRIMARY KEY,tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id),name TEXT NOT NULL,key_hash TEXT UNIQUE NOT NULL,prefix TEXT NOT NULL,scopes JSONB NOT NULL,revoked_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now(),last_used_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS webhook_endpoints(id UUID PRIMARY KEY,tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id),url TEXT NOT NULL,secret TEXT NOT NULL,enabled BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS webhook_deliveries(id UUID PRIMARY KEY,tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id),endpoint_id UUID REFERENCES webhook_endpoints(id),event TEXT NOT NULL,payload JSONB NOT NULL,status TEXT DEFAULT 'pending',attempts INT DEFAULT 0,response_status INT,error TEXT,retry_at TIMESTAMPTZ DEFAULT now(),created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS automation_executions(id UUID PRIMARY KEY,tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id),automation_id VARCHAR(64) REFERENCES automations(id),message_id VARCHAR(64) REFERENCES messages(id),status TEXT NOT NULL,error TEXT,created_at TIMESTAMPTZ DEFAULT now(),UNIQUE(tenant_id,automation_id,message_id));
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS conversation_id VARCHAR(64) REFERENCES conversations(id);
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS upload_status TEXT DEFAULT 'pending';
    ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) REFERENCES tenants(id);
    CREATE INDEX IF NOT EXISTS ix_outbox_dispatch ON outbox_events(event_type,retry_at,id) WHERE status IN ('pending','queued');
    CREATE INDEX IF NOT EXISTS ix_campaign_recipient_pending ON campaign_recipients(campaign_id,status,id);
    CREATE INDEX IF NOT EXISTS ix_webhook_retry ON webhook_deliveries(retry_at) WHERE status IN ('pending','retry','processing');
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
