export const version = "024_assignment_rules";
export async function up(client) {
  await client.query(`
    -- Who gets a new chat without anyone picking it: the company's rule. Off until an owner or administrator turns it on.
    CREATE TABLE IF NOT EXISTS assignment_settings (
      tenant_id VARCHAR(64) PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT false,
      mode VARCHAR(20) NOT NULL DEFAULT 'round_robin' CHECK (mode IN ('round_robin','least_busy')),
      team VARCHAR(40),
      session_names JSONB NOT NULL DEFAULT '[]',
      keep_owner BOOLEAN NOT NULL DEFAULT true,
      max_open INT CHECK (max_open IS NULL OR max_open BETWEEN 1 AND 1000),
      use_hours BOOLEAN NOT NULL DEFAULT false,
      timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
      work_days INT[] NOT NULL DEFAULT '{1,2,3,4,5}',
      work_start VARCHAR(5) NOT NULL DEFAULT '09:00',
      work_end VARCHAR(5) NOT NULL DEFAULT '18:00',
      last_assigned_user_id INT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- assignable: the company put this person in the rotation. available: the person's own "I'm taking new chats" switch.
    ALTER TABLE memberships ADD COLUMN IF NOT EXISTS assignable BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE memberships ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT true;
  `);
}
