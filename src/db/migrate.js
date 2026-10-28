import { getPool } from "./index.js";
import * as m001 from "./migrations/001_multitenant_core.js";
import * as m002 from "./migrations/002_legacy_backfill.js";
import * as m003 from "./migrations/003_runtime_features.js";
import * as m004 from "./migrations/004_configure_superadmin.js";
import * as m005 from "./migrations/005_company_staff_sessions.js";
import * as m006 from "./migrations/006_owner_setup_links.js";
import * as m007 from "./migrations/007_session_last_error.js";
import * as m008 from "./migrations/008_conversation_updated_index.js";
import * as m009 from "./migrations/009_clean_group_and_status_data.js";
import * as m010 from "./migrations/010_notifications_and_assignee.js";
import * as m011 from "./migrations/011_team_categories_and_mail_status.js";
import * as m012 from "./migrations/012_website_leads.js";
import * as m013 from "./migrations/013_attachment_previews.js";
import * as m014 from "./migrations/014_ai_assistant.js";
import * as m015 from "./migrations/015_automation_rules.js";
import * as m016 from "./migrations/016_leads.js";
import * as m017 from "./migrations/017_subscriptions.js";
import * as m018 from "./migrations/018_plan_catalogue.js";
import * as m019 from "./migrations/019_labels_contact_names.js";
import * as m020 from "./migrations/020_billing.js";
import * as m021 from "./migrations/021_reply_analytics.js";
import * as m022 from "./migrations/022_inbox_followups.js";
import * as m023 from "./migrations/023_number_health.js";
import * as m024 from "./migrations/024_assignment_rules.js";
import * as m025 from "./migrations/025_support_access.js";
import * as m026 from "./migrations/026_plan_limits.js";
import * as m027 from "./migrations/027_billing_settings.js";
import * as m028 from "./migrations/028_website_checkout.js";
import * as m029 from "./migrations/029_password_resets.js";
import * as m030 from "./migrations/030_industry_solutions.js";
import * as m031 from "./migrations/031_real_estate.js";
import * as m032 from "./migrations/032_automation_chats.js";
import * as m033 from "./migrations/033_profile_pictures.js";
import * as m034 from "./migrations/034_user_identities.js";
import * as m035 from "./migrations/035_quoted_and_revoked_messages.js";
import * as m036 from "./migrations/036_upcoming_followups.js";

const MIGRATION_ADVISORY_LOCK_ID = 88992211;
const MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016, m017, m018, m019, m020, m021, m022, m023, m024, m025, m026, m027, m028, m029, m030, m031, m032, m033, m034, m035, m036];

// A migration that cannot get its table lock (someone holds a long transaction) must fail
// fast. Waiting forever would hang the deploy and queue every other query on that table
// behind it, freezing the app. A failed migration rolls back and the deploy restores the
// previous release.
export async function runMigrations({
  migrations = MIGRATIONS,
  lockTimeoutMs = 20000,
} = {}) {
  const pool = getPool();
  if (!pool) {
    throw new Error("Database pool unavailable for migrations.");
  }

  const client = await pool.connect();
  try {
    // Prevent concurrent migration runs, but never wait for another run indefinitely.
    await client.query(`SET lock_timeout = '${Math.max(1000, lockTimeoutMs * 3)}ms'`);
    await client.query("SELECT pg_advisory_lock($1)", [
      MIGRATION_ADVISORY_LOCK_ID,
    ]);
    await client.query("RESET lock_timeout");
  } catch (error) {
    client.release();
    throw new Error(
      `Another migration run is holding the lock (${error.message}). Check for a stuck deploy.`,
    );
  }
  try {
    // Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(128) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const { rows: appliedRows } = await client.query(
      "SELECT version FROM schema_migrations",
    );
    const appliedSet = new Set(appliedRows.map((r) => r.version));

    for (const migration of migrations) {
      if (!appliedSet.has(migration.version)) {
        console.log(`⏳ Applying migration: ${migration.version}...`);
        await client.query("BEGIN");
        try {
          await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
          await client.query("SET LOCAL statement_timeout = '300s'");
          await migration.up(client);
          await client.query(
            "INSERT INTO schema_migrations (version) VALUES ($1)",
            [migration.version],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        console.log(`✅ Applied migration: ${migration.version}`);
      }
    }

    return { status: "success", totalApplied: migrations.length };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [
      MIGRATION_ADVISORY_LOCK_ID,
    ]);
    client.release();
  }
}

export async function rollbackLatest() {
  throw new Error(
    "Automatic rollback is disabled to preserve application data. Use a verified backup or forward repair migration.",
  );
}

// CLI runner
if (process.argv[1]?.endsWith("migrate.js")) {
  const action = process.argv[2] || "up";
  if (action === "down") {
    rollbackLatest()
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else {
    runMigrations()
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  }
}
