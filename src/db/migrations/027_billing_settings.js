export const version = "027_billing_settings";
export async function up(client) {
  await client.query(`
    -- Who sells and how the tax is worked out, editable by the platform admin instead of written in the code. One row.
    -- Invoices copy the seller's details and the tax rate when they are made, so a change here never alters one that
    -- was already issued.
    CREATE TABLE IF NOT EXISTS billing_settings (
      id INT PRIMARY KEY CHECK (id = 1),
      value JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by INT REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS billing_settings_changes (
      id SERIAL PRIMARY KEY,
      actor_id INT REFERENCES users(id) ON DELETE SET NULL,
      before JSONB NOT NULL,
      after JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- The rate the tax on an invoice was worked out at; the invoices made before this column were all at 18%.
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gst_rate NUMERIC(5,2) NOT NULL DEFAULT 18;
  `);
}
