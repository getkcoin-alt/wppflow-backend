import { getPool, withTransaction } from './index.js';
import * as m001 from './migrations/001_multitenant_core.js';
import * as m002 from './migrations/002_legacy_backfill.js';

const MIGRATIONS = [m001, m002];

export async function runMigrations() {
  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool unavailable for migrations.');
  }

  // Ensure migrations tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(128) PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const { rows: appliedRows } = await pool.query('SELECT version FROM schema_migrations');
  const appliedSet = new Set(appliedRows.map(r => r.version));

  for (const migration of MIGRATIONS) {
    if (!appliedSet.has(migration.version)) {
      console.log(`⏳ Applying migration: ${migration.version}...`);
      await withTransaction(async (client) => {
        await migration.up(client);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
      });
      console.log(`✅ Applied migration: ${migration.version}`);
    }
  }

  return { status: 'success', totalApplied: MIGRATIONS.length };
}

export async function rollbackLatest() {
  const pool = getPool();
  if (!pool) throw new Error('Database pool unavailable.');

  const { rows: appliedRows } = await pool.query('SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1');
  if (appliedRows.length === 0) {
    console.log('No migrations to rollback.');
    return;
  }

  const latestVersion = appliedRows[0].version;
  const migration = MIGRATIONS.find(m => m.version === latestVersion);
  if (!migration) {
    throw new Error(`Migration ${latestVersion} not found in registered migrations.`);
  }

  console.log(`⏳ Rolling back migration: ${latestVersion}...`);
  await withTransaction(async (client) => {
    await migration.down(client);
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [latestVersion]);
  });
  console.log(`✅ Rolled back migration: ${latestVersion}`);
}

// CLI runner
if (process.argv[1]?.endsWith('migrate.js')) {
  const action = process.argv[2] || 'up';
  if (action === 'down') {
    rollbackLatest().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
  } else {
    runMigrations().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
  }
}
