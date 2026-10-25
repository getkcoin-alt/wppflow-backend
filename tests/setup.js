import { after } from "node:test";
import { runMigrations } from "../src/db/migrate.js";
import { closePool } from "../src/db/index.js";
import { loadPlans } from "../src/services/plans.js";
const url = new URL(process.env.DATABASE_URL || "http://invalid");
if (
  !/^wppflow_ci_[a-f0-9]+$/.test(url.pathname.slice(1)) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
)
  throw new Error("Use npm test: application databases are never test targets");
await runMigrations();
// the plans and prices come from the database, as they do on the server
await loadPlans();
after(() => closePool());
