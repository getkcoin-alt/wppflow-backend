export const version = "016_leads";
export async function up(client) {
  await client.query(`
    -- Money is shown in the company's own currency.
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'AED';

    -- One sales pipeline per company for now; the table leaves room for more.
    CREATE TABLE IF NOT EXISTS pipelines (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL DEFAULT 'Sales',
      preset VARCHAR(40) NOT NULL DEFAULT 'general',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id)
    );
    -- The steps a lead moves through. "won" and "lost" end a lead; the rest are open.
    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      pipeline_id VARCHAR(64) NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      name VARCHAR(60) NOT NULL,
      kind VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')),
      position INT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stages_pipeline ON pipeline_stages(pipeline_id, position);

    -- One sales opportunity for one contact. The contact's name and number are copied onto it so the
    -- sales history survives if the contact is deleted.
    CREATE TABLE IF NOT EXISTS leads (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      pipeline_id VARCHAR(64) NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      stage_id VARCHAR(64) NOT NULL REFERENCES pipeline_stages(id),
      contact_id VARCHAR(64) REFERENCES contacts(id) ON DELETE SET NULL,
      contact_name VARCHAR(255) NOT NULL DEFAULT '',
      phone VARCHAR(64) NOT NULL DEFAULT '',
      session_name VARCHAR(128),
      title VARCHAR(255) NOT NULL DEFAULT '',
      value NUMERIC(14,2) NOT NULL DEFAULT 0,
      source VARCHAR(30) NOT NULL DEFAULT 'manual',
      owner_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
      lost_reason VARCHAR(255) NOT NULL DEFAULT '',
      expected_close DATE,
      rank DOUBLE PRECISION NOT NULL DEFAULT 0,
      stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at TIMESTAMPTZ,
      created_by INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- A contact has at most one open lead at a time.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_one_open_per_contact ON leads(tenant_id, contact_id) WHERE status = 'open' AND contact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_leads_board ON leads(tenant_id, stage_id, rank);
    CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(tenant_id, owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_leads_session ON leads(tenant_id, session_name);
    -- Finding a contact's chat quickly, for the lead's last message.
    CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(tenant_id, contact_id);

    -- Follow-ups: something to do for a lead, and when.
    CREATE TABLE IF NOT EXISTS lead_tasks (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id VARCHAR(64) NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      due_at TIMESTAMPTZ NOT NULL,
      assigned_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      done_at TIMESTAMPTZ,
      notified_at TIMESTAMPTZ,
      created_by INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_lead_tasks_open ON lead_tasks(tenant_id, due_at) WHERE done_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_lead_tasks_lead ON lead_tasks(lead_id);

    -- What happened to a lead, in order.
    CREATE TABLE IF NOT EXISTS lead_activities (
      id BIGSERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id VARCHAR(64) NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      actor_id INT REFERENCES users(id) ON DELETE SET NULL,
      actor_name VARCHAR(255) NOT NULL DEFAULT '',
      type VARCHAR(30) NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id, id DESC);
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
