# Server vitals: seeing why the app is slow without logging in to the server

`GET /health` (public, the same address the app's "all good" dot uses) carries a `vitals` object, and the server logs every slow request
and every slow background job. Everything is a number or the name of a route or job: no address with an id in it, no query string, nothing
about a person. The code is `src/services/vitals.js`; the numbers are kept for the last ten minutes, so a slow spell can still be looked at
after it has passed.

## Look at it

    curl -s https://app.scriwo.com/health | jq .vitals

To watch a slow spell as it happens (one line every 10 seconds):

    while true; do curl -s https://app.scriwo.com/health | jq -c '{t:.timestamp, load:.vitals.now.loadPerCpu, mem:.vitals.now.memUsedPct,
      lag:.vitals.recent.loopLagMaxMs, dbWait:.vitals.recent.poolWaitingMax, slow:.vitals.recent.slowRequests,
      worst:.vitals.recent.slowestRequest.route, job:.vitals.recent.slowestJob.name, browsers:.vitals.now.browsers, numbers:.activeSessions}'; sleep 10; done

On the server, the slow requests and jobs are in the pm2 log:

    pm2 logs wppflow-backend-v3 --nostream --lines 500 | grep -E "\[slow(-job)?\]"

    [slow] GET /api/home 6120 ms (HTTP 200)
    [slow-job] ai prep 1850 ms

At most 20 such lines a minute are written, however many are slow (all are counted in `slowRequests`).

## What the fields mean

| Field | Meaning |
|---|---|
| `cpus` | processors the server has |
| `now.loadPerCpu` | the machine's one-minute load divided by `cpus`. About 1 = every processor busy; above 2 for minutes = the machine is short of processor |
| `now.memUsedPct`, `now.memFreeMb` | memory in use (caches not counted) and what is left. Above 90 % = swapping soon |
| `now.rssMb` | memory the Node process itself uses |
| `now.loopLagP99Ms`, `recent.loopLagMaxMs` | how late Node's own timers ran. Above 100 ms = something is holding the process (a heavy job, or the machine not giving it processor time); in the hundreds or thousands every request waits |
| `now.pool`, `recent.poolWaitingMax` | database connections: `total`, `idle`, and requests `waiting` for one (the pool has 20; a request waits up to 5 s, then fails with a 500) |
| `now.inFlight`, `recent.inFlightMax` | requests being answered right now / at most, lately |
| `now.browsers` | whole Chromium browsers running on the machine (one per connected or launching WhatsApp number). Compare with `activeSessions`: more browsers than connected numbers = launches in progress, or leftovers |
| `recent.requests`, `recent.slowRequests` | requests ended lately, and how many took longer than `SLOW_REQUEST_MS` (2 s) |
| `recent.slowestRequest` | the route pattern, time, status and moment of the slowest one |
| `recent.slowestJob` | the same for the background jobs that run every 4 seconds (automations, ai prep, autopilot, number health, ...) |
| `recent.seconds` | how long a stretch the "recent" figures cover (up to 10 minutes) |

## Reading a slow spell

| What it shows | It means | Next |
|---|---|---|
| `loadPerCpu` above 2, `loopLag` high, `dbWait` 0 | the machine (or a heavy job in Node) is short of processor | look at `slowestJob` and `browsers`; run the checklist in `slow-server-checklist.md` (vmstat, ps) |
| `dbWait` above 0, `slowestRequest` is a list or summary route | requests are waiting for database connections: slow queries, or too many requests at once | `pg_stat_activity` for long queries (checklist step 4); the app's own polling (docs in the app repo, `src/services/polling.ts`) |
| `memUsedPct` above 90, `loopLag` high | memory pressure, swapping | fewer browsers; a bigger machine |
| `browsers` above `numbers` for minutes | browsers left behind, or a number being retried | `diagnose-numbers` (see `session-stability.md`); numbers that cannot start are retried only `SESSION_MAX_AUTO_ATTEMPTS` times |
| `slowestJob` is a job and `loopLag` is high at the same moment | that job holds the process | its name says which; the next step is its queries |
| all of it low, yet the app is slow | the network or the servers in front (Vercel, nginx) | `curl` the server directly (`https://<server>/health`) and through the app and compare |

## Settings

`VITALS_SAMPLE_MS` (10000: how often the readings are taken), `VITALS_KEEP` (60: how many are kept; 60 x 10 s = ten minutes),
`SLOW_REQUEST_MS` (2000), `SLOW_JOB_MS` (1000). The defaults are meant to be left alone.

## Tests

`tests/vitals.test.js`: the fields on `/health`, a slow request named by its route pattern and never its address, a dropped request, job
timing (and a job's own errors passing through), event-loop delay (the process held for 160 ms is seen as a delay of at least 100 ms), the
history limit and the log limit.
