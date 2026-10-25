export const version = "018_plan_catalogue";
export async function up(client) {
  await client.query(`
    -- The plans and what each includes, read by the server instead of being written into the code, so the
    -- platform admin can change a price or a limit without a release.
    CREATE TABLE IF NOT EXISTS plans (
      code VARCHAR(30) PRIMARY KEY,
      name VARCHAR(60) NOT NULL,
      sort_order INT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      -- WhatsApp numbers included (NULL: agreed per company) and people it is for (NULL: no limit)
      numbers INT,
      seats INT,
      features JSONB NOT NULL DEFAULT '[]',
      -- NULL means no limit; nothing enforces a contact limit until a plan sets one
      max_contacts INT,
      trial_days INT NOT NULL DEFAULT 0,
      -- 'exclusive': tax is added to the price (GST in India)
      tax_mode VARCHAR(12) NOT NULL DEFAULT 'exclusive' CHECK (tax_mode IN ('exclusive','inclusive')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- What a plan costs, in the smallest unit of the currency (paise, fils), per billing interval.
    CREATE TABLE IF NOT EXISTS plan_prices (
      plan_code VARCHAR(30) NOT NULL REFERENCES plans(code) ON DELETE CASCADE,
      billing_interval VARCHAR(10) NOT NULL CHECK (billing_interval IN ('monthly','annual')),
      currency VARCHAR(3) NOT NULL CHECK (currency IN ('INR','AED')),
      amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
      PRIMARY KEY (plan_code, billing_interval, currency)
    );
    -- Who changed a plan, and what it was before.
    CREATE TABLE IF NOT EXISTS plan_changes (
      id SERIAL PRIMARY KEY,
      plan_code VARCHAR(30) NOT NULL,
      actor_id INT REFERENCES users(id) ON DELETE SET NULL,
      before JSONB,
      after JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reminded_expired_for DATE;

    INSERT INTO plans(code,name,sort_order,numbers,seats,features) VALUES
      ('free','Free',0,1,1,'[]'),
      ('starter','Starter',1,3,NULL,'[]'),
      ('growth','Growth',2,10,NULL,'["broadcasts","automations","leads","audit","ai"]'),
      ('business','Business',3,25,NULL,'["broadcasts","automations","leads","audit","ai","api"]'),
      ('enterprise','Enterprise',4,NULL,NULL,'["broadcasts","automations","leads","audit","ai","api"]')
    ON CONFLICT (code) DO NOTHING;
    -- Monthly prices are the ones on the pricing page. A year costs ten months: two months free.
    INSERT INTO plan_prices(plan_code,billing_interval,currency,amount_minor) VALUES
      ('starter','monthly','INR',249900),  ('starter','annual','INR',2499000),
      ('growth','monthly','INR',699900),   ('growth','annual','INR',6999000),
      ('business','monthly','INR',1499900),('business','annual','INR',14999000),
      ('starter','monthly','AED',29900),   ('starter','annual','AED',299000),
      ('growth','monthly','AED',79900),    ('growth','annual','AED',799000),
      ('business','monthly','AED',169900), ('business','annual','AED',1699000)
    ON CONFLICT DO NOTHING;
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
