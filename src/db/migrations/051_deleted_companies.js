export const version = "051_deleted_companies";

// The platform admin can delete a company, and everything of it goes. This keeps one short record of each deletion, so the platform
// can still say what was removed, when and by whom. It holds no message, contact or file: only the company's name, its owner's
// address, its plan, and how much there was.
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS deleted_companies (
      id BIGSERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      plan VARCHAR(50),
      owner_name TEXT,
      owner_email TEXT,
      company_created_at TIMESTAMPTZ,
      counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      deleted_by INT REFERENCES users(id) ON DELETE SET NULL,
      deleted_by_email TEXT,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_deleted_companies_when ON deleted_companies(deleted_at DESC);
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
