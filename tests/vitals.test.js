import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { app, io as serverIo } from "../src/server.js";
import { ENV } from "../src/config/env.js";
import { routeLabel, recordRequest, vitalsMiddleware, timeJob, sampleNow, vitalsSnapshot, resetVitals, countBrowsers, startVitals, stopVitals } from "../src/services/vitals.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "The app is slow" has to be traceable without logging in to the server: to the machine, to Node, to the database, or to one request or
// job. These are the instruments (src/services/vitals.js) and what /health shows of them.
test("Server vitals: what /health shows, and how a slow request or job is found", async (t) => {
  const saved = { slowRequest: ENV.SLOW_REQUEST_MS, slowJob: ENV.SLOW_JOB_MS, keep: ENV.VITALS_KEEP };
  const logs = [];
  const warn = console.warn;
  console.warn = (...args) => logs.push(args.join(" "));
  t.after(() => {
    console.warn = warn;
    Object.assign(ENV, { SLOW_REQUEST_MS: saved.slowRequest, SLOW_JOB_MS: saved.slowJob, VITALS_KEEP: saved.keep });
    stopVitals();
    serverIo.close();
  });
  const fresh = () => {
    resetVitals();
    logs.length = 0;
  };

  await t.test("/health carries the vitals: numbers about the machine and the process, nothing about a person", async () => {
    fresh();
    await request(app).get("/health"); // a request is counted when it ends, so the second one sees the first
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    const v = res.body.vitals;
    assert.ok(v.cpus >= 1);
    for (const k of ["loadPerCpu", "memUsedPct", "memFreeMb", "rssMb", "inFlight"]) assert.equal(typeof v.now[k], "number", `now.${k}`);
    assert.ok(v.now.memUsedPct > 0 && v.now.memUsedPct <= 100, `memory used ${v.now.memUsedPct}%`);
    assert.ok(v.now.inFlight >= 1, "the health request itself is in flight");
    assert.equal(typeof v.now.pool.total, "number", "the database connections are counted");
    assert.equal(typeof v.now.pool.waiting, "number");
    for (const k of ["loadPerCpuMax", "loopLagMaxMs", "poolWaitingMax", "inFlightMax", "requests", "slowRequests"]) assert.equal(typeof v.recent[k], "number", `recent.${k}`);
    assert.ok(v.recent.requests >= 1, "requests are counted (the middleware is first in line)");
    assert.doesNotMatch(JSON.stringify(v), /@|Bearer|password|token/i);
  });

  await t.test("a slow request is counted and logged by its route pattern, never its address, and the worst one is shown", async () => {
    fresh();
    ENV.SLOW_REQUEST_MS = 40;
    const mini = express();
    mini.use(vitalsMiddleware);
    const router = express.Router();
    router.get("/:conversationId/messages", async (req, res) => {
      await sleep(Number(req.query.ms));
      res.json({ ok: true });
    });
    mini.use("/api/conversations", router);
    await request(mini).get("/api/conversations/conv_secret123/messages?ms=90&token=abc");
    await request(mini).get("/api/conversations/conv_other456/messages?ms=1");
    await request(mini).get("/nothing/at/this/address?secret=1");

    const recent = vitalsSnapshot().recent;
    assert.equal(recent.requests, 3);
    assert.equal(recent.slowRequests, 1, "only the slow one");
    assert.equal(recent.slowestRequest.route, "GET /api/conversations/:conversationId/messages");
    assert.ok(recent.slowestRequest.ms >= 85, `${recent.slowestRequest.ms} ms`);
    assert.equal(recent.slowestRequest.status, 200);
    const line = logs.find((l) => l.startsWith("[slow]"));
    assert.match(line, /^\[slow\] GET \/api\/conversations\/:conversationId\/messages \d+ ms \(HTTP 200\)$/);
    const everything = logs.join("\n") + JSON.stringify(vitalsSnapshot());
    assert.doesNotMatch(everything, /conv_secret123|conv_other456|token=abc|secret=1|nothing\/at/, "no id, no query string, no raw address");
    assert.equal(vitalsSnapshot().now.inFlight, 0, "finished requests are no longer counted as running");
  });

  await t.test("a request that is dropped by the client is counted once and no longer in flight", async () => {
    fresh();
    ENV.SLOW_REQUEST_MS = 10_000;
    const mini = express();
    mini.use(vitalsMiddleware);
    mini.get("/never", () => {}); // never answers
    const server = mini.listen(0);
    try {
      const { port } = server.address();
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/never`, { signal: controller.signal }).catch(() => {});
      await sleep(60);
      assert.equal(vitalsSnapshot().now.inFlight, 1);
      controller.abort();
      await pending;
      await sleep(60);
      assert.equal(vitalsSnapshot().now.inFlight, 0);
      assert.equal(vitalsSnapshot().recent.requests, 1);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  await t.test("a background job is timed, the slowest is shown, a slow one is logged, and the job's own result and errors pass through", async () => {
    fresh();
    ENV.SLOW_JOB_MS = 30;
    assert.equal(await timeJob("quick job", async () => 7), 7);
    assert.equal(logs.length, 0, "a quick job is not logged");
    await timeJob("demo job", () => sleep(60));
    await assert.rejects(
      timeJob("failing job", async () => {
        await sleep(40);
        throw new Error("the job's own error");
      }),
      /the job's own error/,
    );
    const job = vitalsSnapshot().recent.slowestJob;
    assert.equal(job.name, "demo job");
    assert.ok(job.ms >= 55, `${job.ms} ms`);
    assert.ok(logs.some((l) => /^\[slow-job\] demo job \d+ ms$/.test(l)));
    assert.ok(logs.some((l) => /^\[slow-job\] failing job \d+ ms$/.test(l)), "a failing job is timed too");
  });

  await t.test("a stall of the whole process (something holding the processor) shows as event-loop delay", async () => {
    fresh();
    startVitals();
    try {
      await sleep(80); // the delay meter ticks every 20 ms
      const end = Date.now() + 160;
      while (Date.now() < end); // nothing else can run for this long, as when the machine or a heavy job holds the process
      await sleep(80);
      const sample = sampleNow();
      assert.ok(sample.lag && sample.lag.max >= 100, `longest delay ${sample.lag?.max} ms`);
      assert.ok(vitalsSnapshot().recent.loopLagMaxMs >= 100);
      const calm = (await sleep(120), sampleNow());
      assert.ok(calm.lag.max < 100, `a calm moment later: ${calm.lag.max} ms`);
    } finally {
      stopVitals();
    }
  });

  await t.test("only the last VITALS_KEEP readings are kept, and the log is limited to a few lines a minute", async () => {
    fresh();
    ENV.VITALS_KEEP = 3;
    for (let i = 0; i < 7; i++) {
      recordRequest({ label: "GET /x", ms: 1, status: 200 });
      sampleNow();
    }
    assert.equal(vitalsSnapshot().recent.requests, 3, "the 4 older readings are gone");

    fresh();
    ENV.SLOW_REQUEST_MS = 1;
    for (let i = 0; i < 60; i++) recordRequest({ label: "GET /busy", ms: 5, status: 200 });
    assert.ok(logs.length <= 20, `${logs.length} lines`);
    assert.equal(vitalsSnapshot().recent.slowRequests, 60, "all are counted, only the log is limited");
  });

  await t.test("a route is named by its pattern; an address no route matched is not named at all", () => {
    assert.equal(routeLabel({ method: "GET", baseUrl: "/api/home", route: { path: "/" } }), "GET /api/home");
    assert.equal(routeLabel({ method: "POST", baseUrl: "/api/leads", route: { path: "/chat/:conversationId/tasks" } }), "POST /api/leads/chat/:conversationId/tasks");
    assert.equal(routeLabel({ method: "GET", baseUrl: "", url: "/private/123?token=1" }), "GET (no route)");
    assert.equal(routeLabel({ method: "GET", baseUrl: "/x", route: { path: /^\/a\d+$/ } }), "GET /x(pattern)");
  });

  await t.test("counting the machine's browsers never throws (a number where /proc exists, null elsewhere)", () => {
    const n = countBrowsers();
    assert.ok(n === null || (Number.isInteger(n) && n >= 0), String(n));
  });
});
