export const version = "046_automation_audit";

// A record of everything the machine said to a customer: what started it, which rule allowed it, which model was involved,
// the exact words, and whether a person can take it back. Rows are only ever added: a database trigger refuses to change or
// remove one, taking a message back is a new row, and each row carries the hash of the one before it, so a gap or an edit can
// be found. (The only deletion allowed is when the whole company has been deleted.)
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS automation_audit (
      id BIGSERIAL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id VARCHAR(64) NOT NULL,
      event VARCHAR(16) NOT NULL CHECK (event IN ('sent','cleared','undone')),
      source VARCHAR(24) NOT NULL,
      rule_ref TEXT NOT NULL DEFAULT '',
      trigger_message_id VARCHAR(64),
      message_id VARCHAR(64),
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      reversible BOOLEAN NOT NULL DEFAULT false,
      undoes BIGINT,
      prev_hash CHAR(64) NOT NULL,
      hash CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_automation_audit_tenant ON automation_audit(tenant_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_automation_audit_chat ON automation_audit(tenant_id, conversation_id, id DESC);

    CREATE OR REPLACE FUNCTION automation_audit_guard() RETURNS trigger AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'automation_audit is append-only';
    END;
    $fn$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS automation_audit_append_only ON automation_audit;
    CREATE TRIGGER automation_audit_append_only BEFORE UPDATE OR DELETE ON automation_audit
      FOR EACH ROW EXECUTE FUNCTION automation_audit_guard();
  `);
}

export async function down() {
  throw new Error("Use a verified backup or forward repair; destructive rollback is disabled.");
}
