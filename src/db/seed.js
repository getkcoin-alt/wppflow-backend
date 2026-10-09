import bcrypt from 'bcryptjs';
import { getPool } from './index.js';
import { ENV } from '../config/env.js';

export async function seedDemoData() {
  if (ENV.NODE_ENV === 'production') {
    throw new Error('Refusing to seed demo data in production environment.');
  }

  const pool = getPool();
  if (!pool) throw new Error('Database pool unavailable.');

  console.log('🌱 Seeding development demo tenant and data...');

  const passwordHash = await bcrypt.hash('DemoPass@123', 10);

  // 1. Create Demo Tenant A
  const tenantAId = 'tenant_demo_alpha';
  await pool.query(`
    INSERT INTO tenants (id, name, slug, plan, sessions_limit)
    VALUES ($1, 'Acme Global Demo', 'acme-global', 'Enterprise', 20)
    ON CONFLICT (id) DO NOTHING
  `, [tenantAId]);

  // 2. Create Demo Tenant B (for multi-tenant isolation tests)
  const tenantBId = 'tenant_demo_beta';
  await pool.query(`
    INSERT INTO tenants (id, name, slug, plan, sessions_limit)
    VALUES ($1, 'Beta Logistics Demo', 'beta-logistics', 'Growth', 5)
    ON CONFLICT (id) DO NOTHING
  `, [tenantBId]);

  // 3. Create Users
  const userARes = await pool.query(`
    INSERT INTO users (email, password_hash, name, is_superadmin, status)
    VALUES ('alice@acmedemo.com', $1, 'Alice Admin', false, 'active')
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING id
  `, [passwordHash]);
  const userAId = userARes.rows[0].id;

  const userBRes = await pool.query(`
    INSERT INTO users (email, password_hash, name, is_superadmin, status)
    VALUES ('bob@betademo.com', $1, 'Bob Manager', false, 'active')
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING id
  `, [passwordHash]);
  const userBId = userBRes.rows[0].id;

  // 4. Create Memberships
  await pool.query(`
    INSERT INTO memberships (tenant_id, user_id, role)
    VALUES ($1, $2, 'owner')
    ON CONFLICT (tenant_id, user_id) DO NOTHING
  `, [tenantAId, userAId]);

  await pool.query(`
    INSERT INTO memberships (tenant_id, user_id, role)
    VALUES ($1, $2, 'owner')
    ON CONFLICT (tenant_id, user_id) DO NOTHING
  `, [tenantBId, userBId]);

  // 5. Seed sample conversations & contacts for Tenant A
  const contactA1 = 'contact_acme_1';
  await pool.query(`
    INSERT INTO contacts (id, tenant_id, name, phone, email, tags)
    VALUES ($1, $2, 'Acme Client 1', '919876543210', 'client1@example.com', '["VIP"]')
    ON CONFLICT (tenant_id, phone) DO NOTHING
  `, [contactA1, tenantAId]);

  const convA1 = 'conv_acme_1';
  await pool.query(`
    INSERT INTO conversations (id, tenant_id, session_name, contact_id, phone, contact_name, last_active_epoch, last_message)
    VALUES ($1, $2, 'primary-whatsapp', $3, '919876543210', 'Acme Client 1', 1700000000, '{"text": "Welcome to Acme Support", "fromMe": true}')
    ON CONFLICT (tenant_id, phone) DO NOTHING
  `, [convA1, tenantAId, contactA1]);

  console.log('✅ Demo seed completed successfully!');
  return { tenantAId, tenantBId, userAId, userBId };
}

if (process.argv[1]?.endsWith('seed.js')) {
  seedDemoData()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Seed error:', err);
      process.exit(1);
    });
}
