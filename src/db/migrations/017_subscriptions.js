export const version = "017_subscriptions";
export async function up(client) {
  await client.query(`
    -- Where a company stands on its paid plan. Payments are taken outside the product, so the platform
    -- admin records each one; the period it paid for is what the renewal date and the reminders come from.
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(10) CHECK (billing_cycle IN ('monthly','annual'));
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS period_start DATE;
    -- The renewal date: the day the paid period ends and the next payment is due.
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS period_end DATE;
    -- A plan the company moves to when the period ends (a downgrade, or Free for a cancellation).
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS scheduled_plan VARCHAR(50);
    -- The period end each reminder was sent for, so a reminder is sent once per period.
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reminded_soon_for DATE;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reminded_overdue_for DATE;

    CREATE TABLE IF NOT EXISTS subscription_payments (
      id UUID PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      recorded_by INT REFERENCES users(id) ON DELETE SET NULL,
      plan VARCHAR(50) NOT NULL,
      billing_cycle VARCHAR(10) NOT NULL CHECK (billing_cycle IN ('monthly','annual')),
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      amount NUMERIC(12,2) CHECK (amount IS NULL OR amount >= 0),
      currency VARCHAR(3) CHECK (currency IS NULL OR currency IN ('AED','INR')),
      reference TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_payments_tenant ON subscription_payments(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tenants_period_end ON tenants(period_end) WHERE period_end IS NOT NULL;
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
