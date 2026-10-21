import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// What is actually running, so a deploy can be verified from outside the server.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
      .toString()
      .trim();
  } catch {
    return (process.env.GIT_COMMIT || "").slice(0, 7) || "unknown";
  }
}
export const BUILD = { commit: gitCommit(), startedAt: new Date().toISOString() };
