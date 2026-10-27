export const version = "030_industry_solutions";
export async function up(client) {
  await client.query(`
    -- Which industry solutions a company has been given, by the platform admin (and later by an authorised reseller).
    -- A row that is switched off keeps the company's settings, so switching it on again loses nothing. The universal
    -- product does not read this table: a company with no rows has exactly what it had before.
    CREATE TABLE IF NOT EXISTS tenant_solutions (
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      solution_key VARCHAR(40) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      version INT NOT NULL DEFAULT 1,
      settings JSONB NOT NULL DEFAULT '{}',
      enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      enabled_by INT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, solution_key)
    );
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
