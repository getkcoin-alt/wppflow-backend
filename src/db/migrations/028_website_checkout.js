export const version = "028_website_checkout";
export async function up(client) {
  await client.query(`
    -- Buying from the website: the buyer has no company yet, so an order can exist before one does. The company
    -- and its owner are created in the same transaction that records the confirmed payment, never before.
    ALTER TABLE payment_orders ALTER COLUMN tenant_id DROP NOT NULL;
    ALTER TABLE payments ALTER COLUMN tenant_id DROP NOT NULL;
    ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_source_check;
    ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_source_check CHECK (source IN ('checkout','autopay','website'));
    -- Who is buying and for what: the company and owner to create, the contact number, and that the terms were accepted.
    ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS guest JSONB;
    ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS guest_email VARCHAR(255);
    CREATE INDEX IF NOT EXISTS idx_payment_orders_guest ON payment_orders(guest_email, status) WHERE guest_email IS NOT NULL;
  `);
}
