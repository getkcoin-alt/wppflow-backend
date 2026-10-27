export const version = "031_real_estate";
export async function up(client) {
  await client.query(`
    -- Scriwo Real Estate: tables that belong to this solution only. Nothing here changes a table of the universal product;
    -- a lead gains real-estate detail by having a row in re_lead_profiles, and loses it again if the lead is deleted.

    -- What a prospect asked for. One row per lead, written only when someone qualifies the lead.
    CREATE TABLE IF NOT EXISTS re_lead_profiles (
      lead_id VARCHAR(64) PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_type VARCHAR(12) CHECK (lead_type IN ('buyer','tenant','landlord','seller','investor')),
      intent VARCHAR(4) CHECK (intent IN ('buy','rent')),
      budget_min NUMERIC(14,2) CHECK (budget_min IS NULL OR budget_min >= 0),
      budget_max NUMERIC(14,2) CHECK (budget_max IS NULL OR budget_max >= 0),
      currency VARCHAR(3),
      communities TEXT[] NOT NULL DEFAULT '{}',
      property_types TEXT[] NOT NULL DEFAULT '{}',
      bedrooms_min INT CHECK (bedrooms_min IS NULL OR bedrooms_min BETWEEN 0 AND 20),
      bedrooms_max INT CHECK (bedrooms_max IS NULL OR bedrooms_max BETWEEN 0 AND 20),
      timeline VARCHAR(12) CHECK (timeline IN ('immediate','1_month','3_months','6_months','later','unknown')),
      source_detail VARCHAR(60) NOT NULL DEFAULT '',
      qualification_status VARCHAR(12) NOT NULL DEFAULT 'new' CHECK (qualification_status IN ('new','in_progress','qualified','disqualified')),
      disqualified_reason VARCHAR(255) NOT NULL DEFAULT '',
      next_action VARCHAR(255) NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      qualified_at TIMESTAMPTZ,
      updated_by INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_re_profiles_tenant ON re_lead_profiles(tenant_id, qualification_status);

    -- The company's own listings. A property exists only because someone at the company entered it.
    CREATE TABLE IF NOT EXISTS re_properties (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      reference VARCHAR(40) NOT NULL,
      title VARCHAR(160) NOT NULL DEFAULT '',
      purpose VARCHAR(4) NOT NULL CHECK (purpose IN ('sale','rent')),
      status VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','available','reserved','sold','rented','withdrawn')),
      price NUMERIC(14,2) CHECK (price IS NULL OR price > 0),
      currency VARCHAR(3) NOT NULL,
      rent_period VARCHAR(5) CHECK (rent_period IN ('year','month')),
      community VARCHAR(120) NOT NULL DEFAULT '',
      property_type VARCHAR(20) NOT NULL,
      bedrooms INT CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 20),
      bathrooms INT CHECK (bathrooms IS NULL OR bathrooms BETWEEN 0 AND 20),
      size_sqft NUMERIC(10,2) CHECK (size_sqft IS NULL OR size_sqft > 0),
      furnished VARCHAR(10) CHECK (furnished IN ('furnished','partly','unfurnished')),
      available_from DATE,
      listing_url TEXT NOT NULL DEFAULT '',
      permit_number VARCHAR(60) NOT NULL DEFAULT '',
      media JSONB NOT NULL DEFAULT '[]',
      agent_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      last_verified_at TIMESTAMPTZ,
      verified_by INT REFERENCES users(id) ON DELETE SET NULL,
      created_by INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_re_properties_reference ON re_properties(tenant_id, lower(reference));
    CREATE INDEX IF NOT EXISTS idx_re_properties_match ON re_properties(tenant_id, status, purpose);

    -- A viewing: one agent shows one property to one lead at a time. Times are stored in UTC with the zone they were booked in.
    CREATE TABLE IF NOT EXISTS re_viewings (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id VARCHAR(64) NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      property_id VARCHAR(64) NOT NULL REFERENCES re_properties(id) ON DELETE CASCADE,
      agent_user_id INT NOT NULL REFERENCES users(id),
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      timezone VARCHAR(64) NOT NULL,
      status VARCHAR(10) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','confirmed','completed','cancelled','no_show')),
      notes VARCHAR(500) NOT NULL DEFAULT '',
      cancel_reason VARCHAR(255) NOT NULL DEFAULT '',
      confirmed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      idempotency_key VARCHAR(80),
      reminder_task_id VARCHAR(64) REFERENCES lead_tasks(id) ON DELETE SET NULL,
      followup_task_id VARCHAR(64) REFERENCES lead_tasks(id) ON DELETE SET NULL,
      created_by INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (ends_at > starts_at)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_re_viewings_key ON re_viewings(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_re_viewings_agent ON re_viewings(tenant_id, agent_user_id, starts_at) WHERE status IN ('scheduled','confirmed');
    CREATE INDEX IF NOT EXISTS idx_re_viewings_property ON re_viewings(tenant_id, property_id, starts_at) WHERE status IN ('scheduled','confirmed');
    CREATE INDEX IF NOT EXISTS idx_re_viewings_lead ON re_viewings(lead_id, starts_at);

    -- Revenue leaks: a real condition found in the company's own data. One open alert per condition (dedupe_key); when the
    -- condition stops being true the alert closes itself, and if it happens again later a new alert opens.
    CREATE TABLE IF NOT EXISTS re_alerts (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind VARCHAR(30) NOT NULL CHECK (kind IN ('unassigned_lead','overdue_followup','response_overdue','missing_next_action','stalled_lead','failed_automation')),
      dedupe_key VARCHAR(160) NOT NULL,
      lead_id VARCHAR(64) REFERENCES leads(id) ON DELETE CASCADE,
      conversation_id VARCHAR(64),
      severity VARCHAR(6) NOT NULL DEFAULT 'medium' CHECK (severity IN ('high','medium','low')),
      title VARCHAR(255) NOT NULL,
      reason TEXT NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}',
      value_at_risk NUMERIC(14,2) NOT NULL DEFAULT 0,
      currency VARCHAR(3),
      status VARCHAR(8) NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','resolved')),
      snoozed_until TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      resolved_by INT REFERENCES users(id) ON DELETE SET NULL,
      resolution VARCHAR(10) CHECK (resolution IN ('fixed','dismissed','auto')),
      notified_at TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_re_alerts_open ON re_alerts(tenant_id, dedupe_key) WHERE status IN ('open','snoozed');
    CREATE INDEX IF NOT EXISTS idx_re_alerts_list ON re_alerts(tenant_id, status, severity);

    -- When a company was last scanned, so two servers never scan it at the same moment.
    CREATE TABLE IF NOT EXISTS re_scan_state (
      tenant_id VARCHAR(64) PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
