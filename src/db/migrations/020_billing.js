export const version = "020_billing";
export async function up(client) {
  await client.query(`
    -- Who a company is for invoicing: the legal name, address, state (it decides CGST + SGST or IGST) and GSTIN.
    CREATE TABLE IF NOT EXISTS billing_profiles (
      tenant_id VARCHAR(64) PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      legal_name VARCHAR(150) NOT NULL,
      address_line1 VARCHAR(200) NOT NULL,
      address_line2 VARCHAR(200) NOT NULL DEFAULT '',
      city VARCHAR(100) NOT NULL,
      state_code VARCHAR(2) NOT NULL,
      postal_code VARCHAR(10) NOT NULL,
      country VARCHAR(2) NOT NULL DEFAULT 'IN',
      gstin VARCHAR(15),
      billing_email VARCHAR(255) NOT NULL DEFAULT '',
      updated_by INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- One row per attempt to pay for a period online. The price, the credit and the tax are fixed here, on the
    -- server, when the order is made; the browser never says what something costs.
    CREATE TABLE IF NOT EXISTS payment_orders (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      plan_code VARCHAR(30) NOT NULL,
      billing_interval VARCHAR(10) NOT NULL CHECK (billing_interval IN ('monthly','annual')),
      source VARCHAR(12) NOT NULL DEFAULT 'checkout' CHECK (source IN ('checkout','autopay')),
      currency VARCHAR(3) NOT NULL,
      base_minor BIGINT NOT NULL,
      credit_minor BIGINT NOT NULL DEFAULT 0,
      tax_minor BIGINT NOT NULL,
      total_minor BIGINT NOT NULL,
      quote JSONB NOT NULL DEFAULT '{}',
      gateway VARCHAR(20) NOT NULL DEFAULT 'razorpay',
      gateway_order_id VARCHAR(64) UNIQUE,
      receipt VARCHAR(64),
      status VARCHAR(12) NOT NULL DEFAULT 'created' CHECK (status IN ('created','attempted','paid','failed','expired','mismatch')),
      failure_reason TEXT,
      gateway_payment_id VARCHAR(64),
      expires_at TIMESTAMPTZ NOT NULL,
      last_checked_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_by INT,
      subscription_payment_id VARCHAR(64),
      invoice_id VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_payment_orders_tenant ON payment_orders(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payment_orders_open ON payment_orders(status, created_at);

    -- What the gateway says happened to a payment. The gateway's id is unique, so a payment is counted once.
    CREATE TABLE IF NOT EXISTS payments (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      order_id VARCHAR(64) REFERENCES payment_orders(id) ON DELETE SET NULL,
      gateway_payment_id VARCHAR(64) NOT NULL UNIQUE,
      status VARCHAR(16) NOT NULL,
      method VARCHAR(30),
      amount_minor BIGINT NOT NULL,
      currency VARCHAR(3) NOT NULL,
      error_code VARCHAR(100),
      error_description TEXT,
      captured_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Every webhook the gateway sends, once. The event id is unique, so a repeat does nothing.
    CREATE TABLE IF NOT EXISTS gateway_webhook_receipts (
      event_id VARCHAR(120) PRIMARY KEY,
      event VARCHAR(60) NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      attempts INT NOT NULL DEFAULT 1,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ,
      result TEXT
    );

    -- Refunds are recorded and shown to the platform admin. They do not remove access by themselves.
    CREATE TABLE IF NOT EXISTS payment_refunds (
      refund_id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) REFERENCES tenants(id) ON DELETE CASCADE,
      order_id VARCHAR(64),
      gateway_payment_id VARCHAR(64),
      amount_minor BIGINT NOT NULL,
      currency VARCHAR(3) NOT NULL,
      status VARCHAR(20) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Tax invoices. Numbers run in a series per financial year with no gaps: the counter moves in the same
    -- transaction that writes the invoice, so a failed payment never uses one up.
    CREATE TABLE IF NOT EXISTS invoice_counters (
      series VARCHAR(20) PRIMARY KEY,
      last_seq INT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      number VARCHAR(40) NOT NULL UNIQUE,
      series VARCHAR(20) NOT NULL,
      seq INT NOT NULL,
      issue_date DATE NOT NULL,
      order_id VARCHAR(64),
      subscription_payment_id VARCHAR(64),
      plan_name VARCHAR(60) NOT NULL,
      billing_interval VARCHAR(10) NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      currency VARCHAR(3) NOT NULL,
      lines JSONB NOT NULL DEFAULT '[]',
      taxable_minor BIGINT NOT NULL,
      cgst_minor BIGINT NOT NULL DEFAULT 0,
      sgst_minor BIGINT NOT NULL DEFAULT 0,
      igst_minor BIGINT NOT NULL DEFAULT 0,
      total_minor BIGINT NOT NULL,
      seller JSONB NOT NULL,
      buyer JSONB NOT NULL,
      sac_code VARCHAR(12) NOT NULL,
      payment_ref VARCHAR(120) NOT NULL DEFAULT '',
      payment_method VARCHAR(30) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (series, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_payment ON invoices(subscription_payment_id) WHERE subscription_payment_id IS NOT NULL;

    -- Autopay: opt-in recurring charges through Razorpay Subscriptions. Razorpay plans are fixed-amount, so a
    -- price change makes a new one.
    CREATE TABLE IF NOT EXISTS razorpay_plans (
      plan_code VARCHAR(30) NOT NULL,
      billing_interval VARCHAR(10) NOT NULL,
      amount_minor BIGINT NOT NULL,
      gateway_plan_id VARCHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (plan_code, billing_interval, amount_minor)
    );
    CREATE TABLE IF NOT EXISTS autopay_subscriptions (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      plan_code VARCHAR(30) NOT NULL,
      billing_interval VARCHAR(10) NOT NULL,
      amount_minor BIGINT NOT NULL,
      gateway_plan_id VARCHAR(64) NOT NULL,
      gateway_subscription_id VARCHAR(64) UNIQUE,
      status VARCHAR(14) NOT NULL DEFAULT 'created' CHECK (status IN ('created','authenticated','active','pending','halted','cancelled','completed')),
      created_by INT,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- a company has at most one autopay that is still alive
    CREATE UNIQUE INDEX IF NOT EXISTS idx_autopay_live ON autopay_subscriptions(tenant_id) WHERE status IN ('created','authenticated','active','pending','halted');

    -- A readable history of a company's subscription: payments, changes, cancellations.
    CREATE TABLE IF NOT EXISTS subscription_events (
      id BIGSERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      event_type VARCHAR(40) NOT NULL,
      plan VARCHAR(60),
      details JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_events_tenant ON subscription_events(tenant_id, created_at DESC);

    -- Where a recorded payment came from, and the order behind it.
    ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS source VARCHAR(12) NOT NULL DEFAULT 'manual';
    ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS order_id VARCHAR(64);
  `);
}
