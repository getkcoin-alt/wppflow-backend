export const version = "012_website_leads";
export async function up(client) {
  await client.query(`
    -- Enquiries from the public website's contact form. Until online payments are approved,
    -- this is how new companies ask for a plan, a demo or a quote.
    CREATE TABLE IF NOT EXISTS website_leads (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      country VARCHAR(40) NOT NULL DEFAULT '',
      team_size VARCHAR(20) NOT NULL DEFAULT '',
      interest VARCHAR(20) NOT NULL DEFAULT 'general',
      plan VARCHAR(40) NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      source_page TEXT NOT NULL DEFAULT '',
      status VARCHAR(20) NOT NULL DEFAULT 'new',
      -- Whether the team was told: sent, failed or not_configured.
      email_status VARCHAR(24),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_website_leads_created ON website_leads(created_at DESC);
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
