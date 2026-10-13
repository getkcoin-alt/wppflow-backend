import pg from "pg";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import crypto from "node:crypto";
const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL || "postgresql://localhost:5432/postgres";
const parsed = new URL(adminUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
  throw new Error("Tests require a local disposable PostgreSQL server");
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
let failed = false;
try {
  for (const file of (await readdir("tests"))
    .filter((f) => f.endsWith(".test.js"))
    .sort()) {
    const db = "wppflow_ci_" + crypto.randomBytes(8).toString("hex");
    await admin.query('CREATE DATABASE "' + db + '"');
    const url = new URL(adminUrl);
    url.pathname = "/" + db;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--test", "--import", "./tests/setup.js", "tests/" + file],
          {
            stdio: "inherit",
            env: {
              ...process.env,
              NODE_ENV: "test",
              DATABASE_URL: url.href,
              TEST_DATABASE_ADMIN_URL: adminUrl,
              JWT_SECRET: "local-disposable-test-secret-more-than-32chars",
              ALLOWED_ORIGINS: "http://localhost:5173",
              DOTENV_CONFIG_QUIET: "true",
            },
          },
        );
        child.on("error", reject);
        child.on("exit", resolve);
      });
      if (code !== 0) failed = true;
    } finally {
      await admin.query('DROP DATABASE "' + db + '" WITH (FORCE)');
    }
  }
} finally {
  await admin.end();
}
process.exitCode = failed ? 1 : 0;
