# Keeping WhatsApp numbers connected

A linked WhatsApp number is a headless Chromium (WPPConnect, WA-JS) signed in to WhatsApp Web, with its own profile folder under
`TOKEN_DIR`. WhatsApp's login keys live inside that profile, so **the profile is the session**: lose or corrupt it and the customer
scans a QR code again. This page is what the server does to keep numbers connected, what it records, and what nobody can prevent.

## What can and cannot be promised

**Not in our hands, so detected and reported, not prevented:** the phone offline for 14 days or more (WhatsApp then unlinks the device);
the customer removing the device or logging out on the phone; WhatsApp restricting or banning a number; a WhatsApp Web change that breaks
WA-JS (all numbers fail at once; the fix is a library upgrade).

**In our hands, and what the changes below are for:** restarts and deploys, crashes, memory pressure, database trouble, hung browsers,
and being slow to notice. The goal is **no self-inflicted disconnects**, automatic recovery without a QR code within minutes, and an alert
for anything else.

## What the server does by itself

| Situation | What happens | Where |
|---|---|---|
| The database is busy or restarting (a number's claim cannot be renewed) | The browser **keeps running**; renewal is retried every 10 s; the number is let go only after `SESSION_LEASE_GRACE_MS` (5 min) of failures, or if another worker really holds it. It used to close the browser at the first failed query. | `keepClaim` in `sessionService.js` |
| A stray error (an unhandled rejection from the browser library) | Logged with its stack; the server **keeps running**. An uncaught exception that is not browser noise stops the server *cleanly* (numbers closed properly) so that pm2 restarts it. It used to end the process and bounce every number. | `services/processGuard.js`, installed in `startServer` |
| The server stops (deploy, restart) | Every number is closed **at the same time**, within `SHUTDOWN_GRACE_MS` (30 s); the background jobs and the queue get 5 s each and cannot hold this up; claims are released so the next start can bring the numbers back at once. | `closeSessions`, `stopServer` |
| A browser has to be stopped from outside | It is asked to quit (SIGTERM) and given `BROWSER_TERM_GRACE_MS` (5 s) to finish writing its profile; only then forced (SIGKILL). It used to be SIGKILL straight away. | `browserProcess.js` |
| The server starts, or numbers are down | Numbers are brought back at most `SESSION_START_CONCURRENCY` (2) at a time, in the background (the server answers its health check meanwhile). A number that keeps failing is retried after 30 s, 1, 2, 4, 8, then every 10 min. | `recoverSessions`, `retryDelayMs` |
| A connected number stops answering its check (one a minute) | After `HEARTBEAT_RESTART_AFTER` (3) misses its browser is restarted from the saved login (no QR code), at most once per `HEARTBEAT_RESTART_COOLDOWN_MS` (10 min). It used to be only reported. People are told (`THRESHOLDS.alertAfter`, 5 misses) only when the restart did not help. | `pingSessions` in `numberHealth.js` |
| WhatsApp reports `CONFLICT` (open in another window) | "Use here" takes the number back. | `onWhatsAppState` |
| WhatsApp reports `UNPAIRED` (the phone logged the device out) | The number is **not restored** (it would only show a QR code nobody scans); status `EXPIRED`, owner and managers are told to scan again. | `onWhatsAppState` |
| WhatsApp's stream drops and does not come back within `STREAM_DOWN_RESTART_MS` (90 s) | The browser is restarted. If it comes back by itself nothing is done. | `onWhatsAppStream` |

## What is recorded: `whatsapp_session_events`

One row per event (migration 052), kept 90 days; no message or contact data. `event` and `cause`:

| event | cause | meaning |
|---|---|---|
| `start` | `user`, `restore`, `restart`, `heartbeat`, `stream_down`, `stale` | a browser launch was begun, and who asked |
| `connected` | same as the start | the number reached CONNECTED |
| `disconnected` | `browserClose`, `serverClose`, `unexpected`, `requested` | the number dropped (`browserClose`: the browser went away; `requested`: a person closed it) |
| `expired` | `qr_not_scanned` | the QR code was not scanned in time |
| `failed` | `start_failed` | the launch failed; `detail` has the reason |
| `closed` | `user`, `server_stop`, `restart`, `heartbeat`, `stream_down`, `stale` | the server closed the browser on purpose, and why |
| `restore` | `server_start_or_drop`, `retry` | recovery tried to bring the number back (`detail`: attempt n) |
| `restart` | `heartbeat`, `stream_down` | a stuck browser was restarted |
| `claim_error` / `claim_released` / `claim_lost` | `database`, `database_unavailable`, `another_worker` | trouble with the number's claim in the database |
| `whatsapp_state` | `CONFLICT`, `UNPAIRED`, `PROXYBLOCK`, `TOS_BLOCK` ... | what WhatsApp itself reported |
| `conflict` | `took_back`, `could_not_take_back` | the outcome of "Use here" |
| `unlinked` | `whatsapp_unpaired` | the phone unlinked the device |
| `stream_down` / `stream_up` | `whatsapp`, `came_back_by_itself` | WhatsApp's connection dropped / returned |

On the server, `node scripts/diagnose-numbers.mjs` prints the counts per cause for 7 days and the latest 40 events (read-only; phone
numbers masked). A drop with no `restart`, `closed` or `claim_*` event before it came from outside: the browser died on its own
(`browserClose`, look for OOM kills with `dmesg`), or WhatsApp ended it.

## Settings (all optional; see `.env.example`)

`SESSION_START_CONCURRENCY`, `SESSION_RETRY_BASE_MS`, `SESSION_RETRY_MAX_MS`, `SESSION_LEASE_TICK_MS`, `SESSION_LEASE_GRACE_MS`,
`SESSION_RECOVER_EVERY_MS`, `SESSION_LAUNCH_TIMEOUT_MS`, `SHUTDOWN_GRACE_MS`, `BROWSER_CLOSE_TIMEOUT_MS`, `BROWSER_TERM_GRACE_MS`,
`HEARTBEAT_RESTART_AFTER`, `HEARTBEAT_RESTART_COOLDOWN_MS`, `STREAM_DOWN_RESTART_MS`. The defaults are the tested ones.

## Server settings that go with it (not in the code)

- **pm2 `kill_timeout` must be longer than `SHUTDOWN_GRACE_MS`** (use 120000). pm2's default is 1.6 s: it kills the process while the
  numbers are still closing, which is the main way a restart costs a customer their login. Set it in an ecosystem file kept outside the
  git checkout (`deploy.sh` runs `git reset --hard`), keep the script path pm2 already uses (check `pm2 jlist`; the repository's pm2 entry is `src/pm2.js`), and set `time: true` so that
  log lines carry timestamps.
- Memory: about 0.4 to 0.7 GB per number plus about 1.5 GB for Node, Postgres, Redis and the OS, and 20 % headroom; swap as a safety net.
- Operating-system updates must not restart Postgres or Redis by themselves (`needrestart` in list-only mode) or reboot unannounced.
- A deploy still restarts the process, so every number is stopped and brought back from its saved login, two at a time. With
  `kill_timeout` long enough that costs each number a minute or two of downtime and no QR code; with the default 1.6 s it can cost
  a customer their login. Deploy in quiet hours, and raise `kill_timeout` **before** the first deploy of this code, because that
  deploy is stopped by the *old* process.
- `docs/ops/session-stability-server-agent-prompt.md` is the brief for an operator or AI agent with shell access to audit the server
  and apply the safe changes.

## Tests

`tests/session-stability.test.js` (a failing database does not close a healthy number; recovery launches two at a time and does not
block the server; backoff; shutdown closes in parallel within a limit; a silent number is restarted once per cooldown; `CONFLICT`,
`UNPAIRED` and stream drops; history and pruning; process guards), `tests/browser-process.test.js` (SIGTERM before SIGKILL). Real
Chromium and WhatsApp are not in them: a stand-in plays WhatsApp. **Verify on a spare number before relying on it**: restart the
server three times and check that the number returns without a QR code; kill its browser and check it returns within two minutes.
