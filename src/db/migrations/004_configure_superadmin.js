import bcrypt from 'bcryptjs';

export const version = '004_configure_superadmin';

export async function up(client) {
  const superadminEmail = 'karnveer@scriza.in';
  const superadminPassword = 'Staycentered@321';
  const superadminName = 'Karnveer Singh';
  const passwordHash = await bcrypt.hash(superadminPassword, 10);

  // 1. Ensure primary tenant exists for Scriza
  const tenantId = 'tenant_scriza';
  await client.query(`
    INSERT INTO tenants (id, name, slug, plan, sessions_limit)
    VALUES ($1, 'Scriza', 'scriza', 'Enterprise', 100)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      plan = EXCLUDED.plan,
      sessions_limit = EXCLUDED.sessions_limit
  `, [tenantId]);

  // 2. Upsert superadmin user karnveer@scriza.in
  const userRes = await client.query(`
    INSERT INTO users (email, password_hash, name, is_superadmin, status)
    VALUES ($1, $2, $3, true, 'active')
    ON CONFLICT (email) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      name = EXCLUDED.name,
      is_superadmin = true,
      status = 'active'
    RETURNING id
  `, [superadminEmail, passwordHash, superadminName]);

  const userId = userRes.rows[0].id;

  // 3. Ensure superadmin membership as owner of tenant_scriza
  await client.query(`
    INSERT INTO memberships (tenant_id, user_id, role)
    VALUES ($1, $2, 'owner')
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'owner'
  `, [tenantId, userId]);

  // Clean up any other memberships for superadmin
  await client.query(`
    DELETE FROM memberships
    WHERE user_id = $1 AND tenant_id != $2
  `, [userId, tenantId]);

  // 4. Remove all other users as requested
  await client.query(`
    DELETE FROM users
    WHERE LOWER(email) != LOWER($1)
  `, [superadminEmail]);

  // 5. Reassign any orphaned sessions to primary tenant
  await client.query(`
    UPDATE whatsapp_sessions
    SET tenant_id = $1
    WHERE tenant_id NOT IN (SELECT id FROM tenants)
  `, [tenantId]);
}

export async function down(client) {
  // Non-destructive down: preserve superadmin record
}
