export const version = "050_otp";

// Free OTP: a company's website or app asks Scriwo to send a one-time code on WhatsApp from the company's own linked number.
// Nothing existing is rewritten. The OTP keys are their own table on purpose: an API key (api_keys) counts as a manager on the
// routes that do not check scope, so a key that can only send and check codes must never live there. A code is stored only
// as an HMAC, never as the code, and the rows are pruned after 30 days.
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS otp_settings (
      tenant_id VARCHAR(64) PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT true,
      template_key VARCHAR(32) NOT NULL DEFAULT 'login',
      brand VARCHAR(60) NOT NULL DEFAULT '',
      locale VARCHAR(8) NOT NULL DEFAULT 'en',
      code_length INT NOT NULL DEFAULT 6 CHECK (code_length BETWEEN 4 AND 8),
      ttl_seconds INT NOT NULL DEFAULT 300 CHECK (ttl_seconds BETWEEN 60 AND 3600),
      max_attempts INT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
      resend_seconds INT NOT NULL DEFAULT 30 CHECK (resend_seconds BETWEEN 15 AND 300),
      session_name VARCHAR(128),
      daily_limit INT CHECK (daily_limit IS NULL OR daily_limit >= 0),
      monthly_limit INT CHECK (monthly_limit IS NULL OR monthly_limit >= 0),
      suspended_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS otp_keys (
      id UUID PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      kind VARCHAR(8) NOT NULL CHECK (kind IN ('secret','public')),
      mode VARCHAR(4) NOT NULL CHECK (mode IN ('live','test')),
      key_hash TEXT NOT NULL UNIQUE,
      prefix VARCHAR(24) NOT NULL,
      allowed_origins JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_otp_keys_tenant ON otp_keys(tenant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS otp_requests (
      id VARCHAR(40) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      key_id UUID REFERENCES otp_keys(id) ON DELETE SET NULL,
      source VARCHAR(10) NOT NULL DEFAULT 'api' CHECK (source IN ('api','widget','dashboard')),
      mode VARCHAR(4) NOT NULL DEFAULT 'live' CHECK (mode IN ('live','test')),
      phone VARCHAR(20) NOT NULL,
      template_key VARCHAR(32) NOT NULL,
      locale VARCHAR(8) NOT NULL DEFAULT 'en',
      session_name VARCHAR(128),
      status VARCHAR(12) NOT NULL DEFAULT 'pending',
      code_hash TEXT,
      text_hash TEXT,
      attempts INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 5,
      provider_message_id TEXT,
      ack INT NOT NULL DEFAULT 0,
      reference VARCHAR(80),
      idempotency_key VARCHAR(100),
      error_code VARCHAR(40),
      visitor_hash VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      verified_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      proof_used_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_otp_requests_tenant_time ON otp_requests(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_otp_requests_phone ON otp_requests(tenant_id, phone, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_otp_requests_provider ON otp_requests(tenant_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_otp_requests_idem ON otp_requests(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_otp_requests_open ON otp_requests(expires_at) WHERE status IN ('pending','sent','delivered','read','uncertain');
    CREATE INDEX IF NOT EXISTS idx_otp_requests_text ON otp_requests(tenant_id, text_hash) WHERE text_hash IS NOT NULL;

    -- A webhook address can be for everything a company's integrations hear about ('all', what exists today) or for OTP events
    -- only ('otp'), which any plan may set up.
    ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS scope VARCHAR(8) NOT NULL DEFAULT 'all';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_otp_endpoint ON webhook_endpoints(tenant_id) WHERE scope = 'otp' AND enabled;
  `);
}
