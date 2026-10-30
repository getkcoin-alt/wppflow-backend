import fs from "node:fs";
import path from "node:path";

// Each WhatsApp number runs in its own Chromium profile folder. A browser that outlives its session
// (a pairing that was cancelled while the QR code was showing, a worker that was restarted) keeps that
// folder locked, and the next attempt fails with "The browser is already running for ...". These
// helpers find such browsers by the exact profile folder they were started with and stop them.
// They read /proc, so they act on Linux (the production server) and do nothing elsewhere.
const LINUX = process.platform === "linux";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readProcesses() {
  if (!LINUX) return [];
  const found = [];
  let names = [];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return found;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const args = fs
        .readFileSync(`/proc/${name}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean);
      if (args.length) found.push({ pid: Number(name), args });
    } catch {
      /* the process ended while we looked */
    }
  }
  return found;
}

const profileOf = (args) => {
  const line = args.join(" ");
  const match = line.match(/--user-data-dir=([^\s\0]+)/);
  return match ? path.resolve(match[1]) : null;
};

const parentOf = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // "pid (name) state ppid ..." where the name may itself contain spaces or brackets
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return 0;
  }
};

const isLiveNode = (pid) => {
  if (pid <= 1) return false;
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] || "";
    return /(^|\/)(node(js)?|pm2)(\s|$)/i.test(cmd);
  } catch {
    return false;
  }
};

const rootAncestorOf = (pid) => {
  let curr = pid;
  const visited = new Set([curr]);
  while (curr > 1) {
    const parent = parentOf(curr);
    if (parent <= 1 || isLiveNode(parent)) return { masterPid: curr, parentNode: parent };
    if (visited.has(parent)) break;
    visited.add(parent);
    curr = parent;
  }
  return { masterPid: curr, parentNode: 1 };
};

function kill(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function untilGone(find, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && find().length) await sleep(100);
}

// Browsers started with exactly this profile folder. Matching is on the whole path, so "staff-1"
// never catches "staff-10".
export function browsersUsing(profileDir) {
  const target = path.resolve(profileDir);
  return readProcesses().filter(
    (p) => p.pid !== process.pid && profileOf(p.args) === target,
  );
}

// Stops every browser using this profile folder and waits until they are gone.
export async function stopBrowsers(profileDir, { timeoutMs = 4000 } = {}) {
  const victims = browsersUsing(profileDir);
  if (!victims.length) return 0;
  kill(victims.map((p) => p.pid));
  await untilGone(() => browsersUsing(profileDir), timeoutMs);
  return victims.length;
}

// A killed browser can leave its lock files behind; the next launch would still think it is running.
export function clearProfileLocks(profileDir) {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
    fs.rmSync(path.join(profileDir, name), { force: true });
}

// At start-up this worker owns no browsers, so any browser under the token folder whose parent is
// no longer a running Node process was left behind by a previous run. Browsers that belong to
// another live worker on the same machine are left alone.
export async function sweepOrphanBrowsers(tokenRoot) {
  const root = path.resolve(tokenRoot) + path.sep;
  const orphans = readProcesses().filter((p) => {
    const profile = profileOf(p.args);
    if (p.pid === process.pid || !profile?.startsWith(root)) return false;
    const { parentNode } = rootAncestorOf(p.pid);
    return !isLiveNode(parentNode);
  });
  if (!orphans.length) return 0;
  kill(orphans.map((p) => p.pid));
  await untilGone(
    () => readProcesses().filter((p) => orphans.some((o) => o.pid === p.pid)),
    4000,
  );
  return orphans.length;
}
