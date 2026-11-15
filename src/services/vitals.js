import fs from "node:fs";
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { ENV } from "../config/env.js";
import { getPool } from "../db/index.js";

// What the machine and the process are doing, kept for a few minutes so that a slow spell can be looked at after it has passed.
// Shown on /health (`vitals`), and the slow requests and background jobs are logged ("[slow] ..."), so that "the app is slow" can be
// traced to the machine (load, memory), to Node itself (event-loop delay), to the database (connections waiting), to a browser, or to one
// request or job, without logging in to the server. Numbers only: no address with an id in it, no query string, no person's data.
// See docs/ops/server-vitals.md.

const cpus = Math.max(1, os.availableParallelism?.() || os.cpus().length || 1);
let ring = []; // one sample per VITALS_SAMPLE_MS, the newest last
let timer = null;
let loop = null; // event-loop delay histogram
let browsers = null; // main Chromium processes on the machine, counted every third sample
let inFlight = 0;
const fresh = () => ({ requests: 0, slow: 0, worst: null, maxInFlight: inFlight, jobWorst: null });
let win = fresh(); // since the last sample

// At most a few log lines a minute, however many requests are slow: a struggling server must not also write a flood.
const LOG_PER_MINUTE = 20;
let budget = { at: 0, used: 0 };
const mayLog = () => {
  const now = Date.now();
  if (now - budget.at >= 60000) budget = { at: now, used: 0 };
  return budget.used++ < LOG_PER_MINUTE;
};

// "GET /api/conversations/:conversationId/messages": the route's own pattern, so no id and no query string ever appears.
export function routeLabel(req) {
  const pattern = req.route?.path;
  const base = req.baseUrl || "";
  const path = pattern === undefined ? base || "(no route)" : `${base}${typeof pattern === "string" ? pattern : "(pattern)"}`;
  return `${req.method} ${path.replace(/\/+$/, "") || "/"}`;
}

export function recordRequest({ label, ms, status }) {
  win.requests++;
  if (ms < ENV.SLOW_REQUEST_MS) return;
  win.slow++;
  if (!win.worst || ms > win.worst.ms) win.worst = { route: label, ms: Math.round(ms), status };
  if (mayLog()) console.warn(`[slow] ${label} ${Math.round(ms)} ms (HTTP ${status})`);
}

// Express middleware, mounted first: every request is counted while it runs and timed when it ends (or is dropped).
export function vitalsMiddleware(req, res, next) {
  const start = performance.now();
  inFlight++;
  if (inFlight > win.maxInFlight) win.maxInFlight = inFlight;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inFlight--;
    recordRequest({ label: routeLabel(req), ms: performance.now() - start, status: res.statusCode });
  };
  res.on("finish", finish);
  res.on("close", finish);
  next();
}

// A background job, timed: the slowest of the last minutes is shown, and one over SLOW_JOB_MS is logged.
export async function timeJob(name, fn) {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - start;
    if (!win.jobWorst || ms > win.jobWorst.ms) win.jobWorst = { name, ms: Math.round(ms) };
    if (ms >= ENV.SLOW_JOB_MS && mayLog()) console.warn(`[slow-job] ${name} ${Math.round(ms)} ms`);
  }
}

// Whole Chromium browsers (not their helper processes) running on the machine, which with no number connected means leftovers or a launch
// in progress. null where /proc does not exist.
export function countBrowsers() {
  try {
    let n = 0;
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let cmd;
      try {
        cmd = fs.readFileSync(`/proc/${entry}/cmdline`, "latin1");
      } catch {
        continue; // the process ended meanwhile
      }
      if (/chrom/i.test(cmd.split("\0", 1)[0]) && !cmd.includes("--type=")) n++;
    }
    return n;
  } catch {
    return null;
  }
}

function memory() {
  let available = os.freemem();
  let total = os.totalmem();
  try {
    const text = fs.readFileSync("/proc/meminfo", "utf8");
    const a = /MemAvailable:\s+(\d+) kB/.exec(text);
    const t = /MemTotal:\s+(\d+) kB/.exec(text);
    if (a && t) {
      available = Number(a[1]) * 1024;
      total = Number(t[1]) * 1024;
    }
  } catch {
    // not Linux: the operating system's own figure will do
  }
  return { usedPct: total ? Math.round((1 - available / total) * 1000) / 10 : null, freeMb: Math.round(available / 1048576) };
}

function poolStats() {
  try {
    const p = getPool();
    return p ? { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount } : null;
  } catch {
    return null;
  }
}

const round1 = (n) => Math.round(n * 10) / 10;

// One reading, added to the history. Also what runs on the timer.
export function sampleNow(at = Date.now()) {
  const lag = loop && loop.count > 0 ? { p50: round1(loop.percentile(50) / 1e6), p99: round1(loop.percentile(99) / 1e6), max: round1(loop.max / 1e6) } : null;
  loop?.reset();
  const mem = memory();
  const sample = {
    at,
    loadPerCpu: round1(os.loadavg()[0] / cpus),
    memUsedPct: mem.usedPct,
    memFreeMb: mem.freeMb,
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    lag,
    pool: poolStats(),
    inFlight,
    maxInFlight: win.maxInFlight,
    requests: win.requests,
    slow: win.slow,
    worst: win.worst && { ...win.worst, at },
    jobWorst: win.jobWorst && { ...win.jobWorst, at },
    browsers,
  };
  ring.push(sample);
  if (ring.length > ENV.VITALS_KEEP) ring.splice(0, ring.length - ENV.VITALS_KEEP);
  win = fresh();
  return sample;
}

const iso = (at) => new Date(at).toISOString();
const biggest = (list) => list.filter(Boolean).sort((a, b) => b.ms - a.ms)[0] || null;

// For /health: how things are now, and the worst of the recent past (a slow spell is over by the time anyone looks). The reading in
// progress is included, so that a request that was slow a moment ago is already there.
export function vitalsSnapshot() {
  if (!ring.length) sampleNow(); // before the first scheduled reading
  const at = Date.now();
  const mem = memory();
  const pool = poolStats();
  const load = round1(os.loadavg()[0] / cpus);
  const open = {
    at,
    loadPerCpu: load,
    memUsedPct: mem.usedPct,
    maxInFlight: win.maxInFlight,
    requests: win.requests,
    slow: win.slow,
    worst: win.worst && { ...win.worst, at },
    jobWorst: win.jobWorst && { ...win.jobWorst, at },
    pool,
    lag: null,
  };
  const all = [...ring, open];
  const max = (pick) => all.reduce((m, s) => Math.max(m, pick(s) ?? 0), 0);
  const worst = biggest(all.map((s) => s.worst));
  const job = biggest(all.map((s) => s.jobWorst));
  const last = ring[ring.length - 1];
  return {
    cpus,
    now: {
      loadPerCpu: load,
      memUsedPct: mem.usedPct,
      memFreeMb: mem.freeMb,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      loopLagP99Ms: last.lag?.p99 ?? null,
      pool,
      inFlight,
      browsers,
    },
    recent: {
      seconds: Math.round((at - ring[0].at) / 1000),
      loadPerCpuMax: max((s) => s.loadPerCpu),
      memUsedPctMax: max((s) => s.memUsedPct),
      loopLagMaxMs: max((s) => s.lag?.max),
      loopLagP99MaxMs: max((s) => s.lag?.p99),
      poolWaitingMax: max((s) => s.pool?.waiting),
      inFlightMax: max((s) => s.maxInFlight),
      requests: all.reduce((n, s) => n + s.requests, 0),
      slowRequests: all.reduce((n, s) => n + s.slow, 0),
      slowestRequest: worst && { route: worst.route, ms: worst.ms, status: worst.status, at: iso(worst.at) },
      slowestJob: job && { name: job.name, ms: job.ms, at: iso(job.at) },
    },
  };
}

export function startVitals() {
  if (timer) return;
  loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  browsers = countBrowsers();
  let tick = 0;
  timer = setInterval(() => {
    if (++tick % 3 === 0) browsers = countBrowsers();
    sampleNow();
  }, ENV.VITALS_SAMPLE_MS);
  timer.unref();
}

export function stopVitals() {
  clearInterval(timer);
  timer = null;
  loop?.disable();
  loop = null;
}

// for tests
export function resetVitals() {
  ring = [];
  win = fresh();
  budget = { at: 0, used: 0 };
}
