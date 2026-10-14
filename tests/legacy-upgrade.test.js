import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import * as core from "../src/db/migrations/001_multitenant_core.js";
import * as legacy from "../src/db/migrations/002_legacy_backfill.js";
import * as runtime from "../src/db/migrations/003_runtime_features.js";
test("Fresh legacy upgrade preserves sources, JSON tags and duplicate conversation history", async () => {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  const name = "wppflow_ci_" + crypto.randomBytes(8).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('CREATE DATABASE "' + name + '"');
  const url = new URL(adminUrl);
  url.pathname = "/" + name;
  const c = new pg.Client({ connectionString: url.href });
  await c.connect();
  const previous = process.env.LEGACY_TENANT_MAP;
  try {
    await c.query(`CREATE TABLE users(id SERIAL PRIMARY KEY,email TEXT UNIQUE,name TEXT,password_hash TEXT,company_name TEXT,role TEXT);
   INSERT INTO users(email,name,password_hash,company_name,role) VALUES('agent@legacy.invalid','Agent','hash','Shared Label','user'),('admin@legacy.invalid','Admin','hash','Shared Label','admin');
   CREATE TABLE contacts(id TEXT PRIMARY KEY,user_id INT,name TEXT,phone TEXT,tags JSONB,created_at TIMESTAMPTZ DEFAULT now());
   INSERT INTO contacts VALUES
     ('contact-a',1,'Customer','15551234567','["VIP"]',now()),
     ('contact-b',2,'Customer','15551234567','["Client"]',now()),
     ('contact-c',1,'Customer Alternate','15551234567','["VIP"]',now());
   CREATE TABLE chats(id TEXT PRIMARY KEY,user_id INT,contact_id TEXT,phone TEXT,contact_name TEXT,created_at TIMESTAMPTZ DEFAULT now());
   INSERT INTO chats VALUES('chat-a',1,'contact-a','15551234567','Customer',now()),('chat-b',2,'contact-b','15551234567','Customer',now());
   CREATE TABLE messages(id TEXT PRIMARY KEY,chat_id TEXT,sender TEXT,text TEXT,created_at TIMESTAMPTZ DEFAULT now());
   INSERT INTO messages VALUES('message-a','chat-a','customer','A',now()),('message-b','chat-b','agent','B',now());`);
    await c.query("BEGIN");
    await core.up(c);
    await c.query("COMMIT");
    delete process.env.LEGACY_TENANT_MAP;
    await c.query("BEGIN");
    await assert.rejects(legacy.up(c), /ambiguous/);
    await c.query("ROLLBACK");
    process.env.LEGACY_TENANT_MAP = JSON.stringify({
      1: "verified_legacy",
      2: "verified_legacy",
    });
    await c.query("BEGIN");
    await legacy.up(c);
    await runtime.up(c);
    await c.query("COMMIT");
    assert.equal(
      (await c.query("SELECT count(*)::int AS n FROM legacy_messages")).rows[0]
        .n,
      2,
    );
    assert.equal(
      (await c.query("SELECT count(*)::int AS n FROM messages")).rows[0].n,
      2,
    );
    assert.equal(
      (await c.query("SELECT count(*)::int AS n FROM conversations")).rows[0].n,
      1,
    );
    const duplicateContact = (
      await c.query(
        "SELECT id,name,custom_traits FROM contacts WHERE tenant_id='verified_legacy' AND phone='15551234567'",
      )
    ).rows;
    assert.equal(duplicateContact.length, 1);
    assert.equal(duplicateContact[0].id, "contact-a");
    assert.equal(duplicateContact[0].name, "Customer");
    assert.deepEqual(
      duplicateContact[0].custom_traits._legacy_migration.contact_ids,
      ["contact-a", "contact-c", "contact-b"],
    );
    assert.deepEqual(
      duplicateContact[0].custom_traits._legacy_migration.alternate_names,
      ["Customer Alternate"],
    );
    assert.equal(
      (await c.query("SELECT role FROM memberships WHERE user_id=2")).rows[0]
        .role,
      "owner",
    );
    assert.equal(
      (await c.query("SELECT role FROM memberships WHERE user_id=1")).rows[0]
        .role,
      "agent",
    );
    assert.equal(
      (await c.query("SELECT jsonb_typeof(tags) AS type FROM contacts LIMIT 1"))
        .rows[0].type,
      "array",
    );
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int AS n FROM users WHERE is_superadmin=true",
        )
      ).rows[0].n,
      0,
    );
    await c.query("BEGIN");
    await runtime.up(c);
    await c.query("COMMIT"); // repeated runtime upgrade is additive
  } finally {
    if (previous === undefined) delete process.env.LEGACY_TENANT_MAP;
    else process.env.LEGACY_TENANT_MAP = previous;
    await c.end();
    await admin.query('DROP DATABASE "' + name + '" WITH (FORCE)');
    await admin.end();
  }
});
