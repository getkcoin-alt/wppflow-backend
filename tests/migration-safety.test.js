import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { getPool, query } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";

test("A stuck table lock can never hang a deploy, and /health says what is running", async (t) => {
  t.after(() => io.close());

  await t.test("/health reports the running build and the database schema version", async () => {
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.match(res.body.build.commit, /^[0-9a-f]{7}$|^unknown$/);
    assert.ok(res.body.build.startedAt);
    assert.equal(res.body.schemaVersion, "011_team_categories_and_mail_status");
  });

  const probe = {
    version: "zz_probe",
    up: (c) => c.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS zz_probe INT"),
  };

  await t.test("a migration that cannot get its table lock fails fast and changes nothing", async () => {
    const holder = await getPool().connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE contacts IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      await assert.rejects(
        runMigrations({ migrations: [probe], lockTimeoutMs: 400 }),
        /lock timeout/i,
      );
      assert.ok(Date.now() - started < 5000, "gave up quickly instead of waiting forever");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    assert.equal((await query("SELECT 1 FROM schema_migrations WHERE version='zz_probe'")).rowCount, 0);
    // once the lock is gone the same migration applies normally
    await runMigrations({ migrations: [probe], lockTimeoutMs: 400 });
    assert.equal((await query("SELECT 1 FROM schema_migrations WHERE version='zz_probe'")).rowCount, 1);
    await query("ALTER TABLE contacts DROP COLUMN zz_probe");
    await query("DELETE FROM schema_migrations WHERE version='zz_probe'");
  });

  await t.test("a stale migration run holding the advisory lock is reported, not waited on forever", async () => {
    const other = await getPool().connect();
    try {
      await other.query("SELECT pg_advisory_lock(88992211)");
      const started = Date.now();
      await assert.rejects(
        runMigrations({ lockTimeoutMs: 300 }),
        /Another migration run is holding the lock/,
      );
      assert.ok(Date.now() - started < 5000);
    } finally {
      await other.query("SELECT pg_advisory_unlock(88992211)");
      other.release();
    }
    // and a normal run is unaffected afterwards
    assert.equal((await runMigrations()).status, "success");
  });
});
