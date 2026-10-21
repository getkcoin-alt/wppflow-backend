// Deletes every user except the platform admin and (re)sets that admin's password.
// Usage: SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... DATABASE_URL=... node scripts/reset-users.mjs --confirm
import pg from "pg";
import bcrypt from "bcryptjs";
const email = (process.env.SUPERADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.SUPERADMIN_PASSWORD || "";
if (!email || password.length < 10 || !process.env.DATABASE_URL)
  throw new Error("SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD (10+ chars) and DATABASE_URL are required");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  const keep = (
    await client.query(
      `INSERT INTO users(email,password_hash,name,is_superadmin,status,must_change_password)
       VALUES($1,$2,'Platform Administrator',true,'active',false)
       ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,is_superadmin=true,status='active',must_change_password=false,updated_at=now()
       RETURNING id`,
      [email, await bcrypt.hash(password, 10)],
    )
  ).rows[0].id;
  const doomed = (await client.query("SELECT email FROM users WHERE id<>$1 ORDER BY id", [keep])).rows;
  console.log(`Users to delete (${doomed.length}):`, doomed.map((u) => u.email).join(", ") || "none");
  if (!process.argv.includes("--confirm")) {
    await client.query("ROLLBACK");
    console.log("Dry run only. Re-run with --confirm to apply.");
  } else {
    await client.query("DELETE FROM users WHERE id<>$1", [keep]);
    await client.query("DELETE FROM invitations");
    const orphans = await client.query(
      "SELECT count(*)::int AS n FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id=t.id)",
    );
    await client.query("COMMIT");
    console.log(`Done. Kept ${email}; deleted ${doomed.length} users and all pending invitations.`);
    console.log(`${orphans.rows[0].n} company workspace(s) now have no members and were left untouched.`);
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
