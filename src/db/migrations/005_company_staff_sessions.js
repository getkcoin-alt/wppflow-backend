export const version = "005_company_staff_sessions";
export async function up(client) {
  await client.query(`
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'active';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS owner_user_id INT REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS ix_sessions_owner ON whatsapp_sessions(tenant_id,owner_user_id);
    UPDATE whatsapp_sessions s SET owner_user_id=(
      SELECT m.user_id FROM memberships m WHERE m.tenant_id=s.tenant_id AND m.role='owner' ORDER BY m.id LIMIT 1
    ) WHERE s.owner_user_id IS NULL;
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
