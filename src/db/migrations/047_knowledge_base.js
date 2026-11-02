export const version = "047_knowledge_base";

// A company's knowledge base: the websites it points Riwo at (read page by page, and read again when it asks or once a day),
// the pages themselves, and a short profile of what the company does and sells (written from the pages by Riwo) with the
// owner's own notes. Riwo answers customers from this, so a company with many products can be talked about naturally.
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_sources (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      status VARCHAR(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','reading','ready','failed')),
      error TEXT NOT NULL DEFAULT '',
      pages INT NOT NULL DEFAULT 0,
      auto_refresh BOOLEAN NOT NULL DEFAULT true,
      last_read_at TIMESTAMPTZ,
      last_changed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_sources_due ON knowledge_sources(status, last_read_at);

    CREATE TABLE IF NOT EXISTS knowledge_pages (
      id BIGSERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      source_id UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      hash CHAR(64) NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (source_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_pages_tenant ON knowledge_pages(tenant_id);

    CREATE TABLE IF NOT EXISTS knowledge_profile (
      tenant_id VARCHAR(64) PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      overview TEXT NOT NULL DEFAULT '',
      products JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes TEXT NOT NULL DEFAULT '',
      written_by_ai BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
