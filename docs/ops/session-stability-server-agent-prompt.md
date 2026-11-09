# Mission: make the WhatsApp numbers on this server stay connected

You are an engineer with shell access to the production VPS that runs the Scriwo backend (a shared WhatsApp inbox and CRM used by many companies). The owner's number-one priority: every customer's linked WhatsApp number must stay connected for weeks and months, with no random drops and no QR re-scans. When something does go wrong it must recover by itself, and the owner must hear about it fast.

Work in the phases below. At every **STOP**, send the owner what you have and wait for "go". If a command needs privileges you do not have, say so; do not work around it.

## 1. What runs here (verified in the repository at commit 6c20e02)

- **App:** Node 22 backend in `/opt/wppflow-backend`, run by pm2 as `wppflow-backend-v3` (Node binary under `/opt/wppflow-runtime/node-v22.23.3-linux-x64/bin`). Under pm2 the entry file is most likely `src/pm2.js` (it calls `startServer()`); `src/server.js` only starts itself when run directly, so **never change the script path pm2 uses**: read it from `pm2 jlist` (`script` below). Settings in `/opt/wppflow-backend/.env` (never print it). PostgreSQL and Redis (BullMQ) on the same host. Logs: `~/.pm2/logs/wppflow*-{out,error}.log` and the deploy log `/var/log/wppflow-backend-deploy.log`. `GET /health` shows `build.commit` and `uptimeSeconds`.
- **Deploy:** a push to `main` -> GitHub webhook -> deployer service on :9095 -> `scripts/deploy.sh`: `git reset --hard origin/main`, `npm ci`, `pg_dump`, migrations, then `pm2 restart wppflow-backend-v3 --update-env`. That is a full process restart: every number's browser is stopped and relaunched on every deploy.
- **WhatsApp:** `@wppconnect-team/wppconnect` 2.3.4 (WA-JS 4.6.1, puppeteer 24, system Chromium). **One headless Chromium per linked number.** Each has a profile folder `TOKEN_DIR/tenant_<tenantId>_<name>/tenant_<tenantId>_<name>` (`TOKEN_DIR` comes from `.env`; default `./tokens` relative to the app directory). WhatsApp's login keys live inside that profile, so **the profile is the session**: lose or corrupt it and the customer must scan a QR code again.
- **Table `whatsapp_sessions`** (one row per number): `status` (STARTING, QRCODE, AUTHENTICATING, CONNECTED, DISCONNECTED, EXPIRED, FAILED), `restore_on_start`, `worker_id`, `lease_until`, `reconnect_attempts`, `last_reconnect_at`, `connected_since`, `down_since`, `heartbeat_failures`, `heartbeat_error`, `last_heartbeat_ok_at`, `last_error`.
- **How the app keeps numbers alive today:** at boot it restores every number with `restore_on_start=true`; every 30 s it relaunches numbers that are down; a lease row is renewed every 10 s per number; a heartbeat asks each connected number every 60 s and only raises an in-app alert after 3 failures. Graceful shutdown (SIGINT or SIGTERM) closes the numbers one after another; any browser left behind is killed with SIGKILL at the next start.

## 2. Code-level risks the owner's developer assistant found

Confirm or refute each one from evidence (log lines, timestamps). **Do not patch code on the server**: every deploy runs `git reset --hard`, so edits there vanish, and code changes go through the repository. Report them with evidence and they will be fixed there.

- **C1** The per-number lease timer closes the *healthy* browser if one lease query fails (database pool: max 20 connections, 5 s wait). Database saturation, or a Postgres or Redis restart, can bounce numbers.
- **C2** There are no `unhandledRejection` or `uncaughtException` handlers. Node 22 exits on a stray rejection (puppeteer "Target closed" errors are common) and pm2 restarts the whole process, so every number restarts.
- **C3** Shutdown closes numbers one by one with no overall deadline. pm2's default `kill_timeout` is 1.6 s, so a restart can kill the process midway and orphan Chromium; the next boot SIGKILLs it. A Chromium killed uncleanly can corrupt its profile, which means a forced QR re-scan.
- **C4** At boot every number launches Chromium at once (no concurrency limit): memory and CPU spike, timeouts, OOM.
- **C5** A hung page (heartbeat fails) is alerted but never restarted.
- **C6** The app does not listen to WhatsApp's own connection-state events (CONFLICT, UNPAIRED, stream DISCONNECTED), so it learns late and does not know why.
- **C7** The recovery loop has no backoff: a number that keeps failing is relaunched every 30 s forever.
- **C8** No history of status changes is stored (only de-duplicated alert notifications), so drops cannot be counted or explained afterwards.

## 3. Goal, and what nobody can promise

**Goal:** zero *self-inflicted* disconnects (restarts, deploys, crashes, memory, bugs); automatic recovery without a QR code within minutes; an alert to the owner within 5 minutes for anything else.

**Outside our control, so detect and alert only:** the phone offline for 14+ days (WhatsApp then unlinks the device); the customer removing the device or logging out on the phone; WhatsApp restricting or banning the number; a WhatsApp Web change that breaks WA-JS. Never say "it will never disconnect".

## 4. Rules (hard)

1. Customers' numbers are their sales channel. Never log a number out or unlink it. Never delete, move or overwrite anything under `TOKEN_DIR`. Never kill or restart one customer's browser to "test". Never edit or run `git` in `/opt/wppflow-backend`. Never change the deployer service or the GitHub webhook. Never run `pm2 flush`, `pm2 kill`, `pkill -f chrom` or `killall chrom*`, and never `pm2 delete` except as described in section 7.
2. No secrets in your output: never print `.env`, `pm2 env`, raw `pm2 jlist`, tokens, API keys, or full phone numbers (last 4 digits only; the commands below already mask).
3. Database: `SELECT` only.
4. Anything that restarts the app, Postgres or Redis, reboots the machine, or changes kernel or system settings needs the owner's "go" for that exact change, in the maintenance window they name. Back up a file before editing it (`cp f f.bak-$(date +%F)`). Log every change (what, why, how to undo) in `/root/session-stability-changes.md`.
5. Destructive tests (killing browsers, repeated restarts) run only on the spare test number the owner gives you. If there is none, skip them and say so.
6. When unsure, stop and ask. Do not call anything "fixed" until Phase 4 passes.

**Ask the owner first** (do not block Phase 1 on the answers): (a) a spare WhatsApp number for tests? (b) a maintenance window, with time zone? (c) alert channel: email, Telegram or a Slack webhook? (d) may the VPS plan be upgraded and a swap file added?

## 5. Phase 1: read-only evidence (about 45 minutes)

Run these and keep the output for the report (trimmed and masked).

### 5.1 Machine

```bash
hostname; date -u; uptime; nproc; free -m; swapon --show; df -h / /opt /var 2>/dev/null
timedatectl 2>/dev/null | grep -E "System clock synchronized|NTP service|Time zone"
(chromium-browser --version || chromium --version) 2>/dev/null; uname -r; . /etc/os-release; echo "$PRETTY_NAME"
last -x -n 20 reboot shutdown 2>/dev/null | head -20; journalctl --list-boots 2>/dev/null | tail -6
ls /var/run/reboot-required 2>/dev/null; grep -Rhs "Automatic-Reboot" /etc/apt/apt.conf.d/; systemctl is-enabled unattended-upgrades 2>/dev/null
grep -hs '^\$nrconf{restart}' /etc/needrestart/needrestart.conf /etc/needrestart/conf.d/* 2>/dev/null
dmesg -T 2>/dev/null | grep -iE "out of memory|oom-kill|killed process" | tail -20
journalctl -k --since "-30 days" --no-pager 2>/dev/null | grep -iE "out of memory|oom-kill|killed process" | tail -20
```

### 5.2 The app under pm2 (prints only safe fields)

```bash
export PATH=/opt/wppflow-runtime/node-v22.23.3-linux-x64/bin:$PATH
pm2 ls
pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s)){const e=p.pm2_env;console.log(JSON.stringify({name:p.name,script:e.pm_exec_path,status:e.status,restarts:e.restart_time,unstable:e.unstable_restarts,uptime_h:Math.round((Date.now()-e.pm_uptime)/36e5*10)/10,kill_timeout_ms:e.kill_timeout,max_memory_restart:e.max_memory_restart??null,exec_mode:e.exec_mode,node:e.node_version,cwd:e.pm_cwd,autorestart:e.autorestart,min_uptime:e.min_uptime,max_restarts:e.max_restarts,log_time:e.time??null,node_rss_mb:Math.round((p.monit?.memory||0)/1048576)}))}})'
systemctl list-unit-files 2>/dev/null | grep -iE "pm2|postgres|redis"; ls -la ~/.pm2/dump.pm2 2>/dev/null
ps -eo pid,etimes,args | grep -E "src/server.js|wppflow" | grep -v grep | cut -c1-160    # more than one copy of the app?
```

### 5.3 Numbers, memory per browser, saved logins

`diagnose-numbers.mjs` is an existing read-only script that masks phones and secrets.

```bash
cd /opt/wppflow-backend && node scripts/diagnose-numbers.mjs
ps -eo rss,args | grep -E "chrom" | grep -v grep | awk '{s+=$1;n++} END {printf "%d Chromium processes, %d MB total\n", n, s/1024}'
TOKENS=$(grep -E '^TOKEN_DIR=' /opt/wppflow-backend/.env | tail -1 | cut -d= -f2- | tr -d "\"'"); TOKENS=${TOKENS:-./tokens}
case "$TOKENS" in /*) ;; *) TOKENS="/opt/wppflow-backend/${TOKENS#./}";; esac
echo "TOKEN_DIR=$TOKENS"; ls -ld "$TOKENS"; du -sh "$TOKENS"/* 2>/dev/null | sort -h | tail -15; du -sh ~/.pm2/logs
```

### 5.4 Database (SELECT only)

```bash
export DATABASE_URL="$(grep -E '^DATABASE_URL=' /opt/wppflow-backend/.env | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
psql "$DATABASE_URL" -X -P pager=off <<'SQL'
-- Q1 state of every number
SELECT t.name AS company, s.session_name, s.status,
       '…'||right(regexp_replace(coalesce(s.phone,''),'\D','','g'),4) AS phone,
       s.restore_on_start AS restore, s.reconnect_attempts AS reconnects, s.last_reconnect_at,
       s.connected_since, s.down_since, s.heartbeat_failures AS hb_fail, left(s.heartbeat_error,60) AS hb_error,
       s.last_heartbeat_ok_at, left(s.last_error,100) AS last_error, s.updated_at
FROM whatsapp_sessions s JOIN tenants t ON t.id=s.tenant_id
ORDER BY (s.status='CONNECTED'), t.name, s.session_name;
-- Q2 numbers dropped per hour, last 30 days (the app's own "disconnected" notifications)
SELECT date_trunc('hour', created_at) AS hour, count(DISTINCT tenant_id||'/'||dedupe_key) AS numbers_dropped
FROM notifications
WHERE type='session' AND title='A WhatsApp number was disconnected' AND created_at > now() - interval '30 days'
GROUP BY 1 ORDER BY 1 DESC;
-- Q3 drops per number, last 30 days
SELECT tenant_id, dedupe_key AS session_name, count(DISTINCT date_trunc('minute', created_at)) AS drops, max(created_at) AS last_drop
FROM notifications
WHERE type='session' AND title='A WhatsApp number was disconnected' AND created_at > now() - interval '30 days'
GROUP BY 1,2 ORDER BY drops DESC LIMIT 30;
-- Q4 "connected" numbers that stopped answering
SELECT session_name, status, heartbeat_failures, heartbeat_error, last_heartbeat_ok_at, now()-last_heartbeat_ok_at AS silent_for
FROM whatsapp_sessions WHERE status='CONNECTED' AND (heartbeat_failures>0 OR last_heartbeat_ok_at < now()-interval '5 minutes');
-- Q5 database restarts and connection pressure
SELECT pg_postmaster_start_time() AS postgres_started, (SELECT count(*) FROM pg_stat_activity) AS connections, current_setting('max_connections') AS max_connections;
SQL
```

### 5.5 Logs: build one timeline

First check whether the pm2 logs carry timestamps (`head -3 ~/.pm2/logs/wppflow*-out.log`). If they do not, say so: correlation then relies on the deploy log, `journalctl` and `pm2 jlist` (`uptime_h`, `restarts`).

```bash
cd ~/.pm2/logs && ls -la wppflow*
grep -E "Backend deployment started|Deployed|Rolling back|Finished with exit code" /var/log/wppflow-backend-deploy.log | tail -60
grep -hc "Scriwo backend running on port" wppflow*-out.log*                    # process starts in the retained logs
grep -hE "orphaned browser|leftover browser" wppflow*-out.log* wppflow*-error.log* | sort | uniq -c | tail
grep -hE "WhatsApp [^:]+: (notLogged|qrReadSuccess|qrReadFail|autocloseCalled|browserClose|serverClose|desconnectedMobile|deleteToken)|QR code ready|Session start failed|Session recovery failed" wppflow*-out.log* wppflow*-error.log* | sed -E 's/[A-Za-z0-9_+\/=-]{40,}/<hidden>/g' | tail -200
grep -hE "UnhandledPromiseRejection|unhandled|uncaught|Target closed|Protocol error|Execution context was destroyed|Page crashed|timeout exceeded when trying to connect|too many clients|ECONNRESET|ENOMEM|EMFILE|CONFLICT" wppflow*-error.log* wppflow*-out.log* | sed -E 's/[A-Za-z0-9_+\/=-]{40,}/<hidden>/g' | sort | uniq -c | sort -rn | head -30
```

Build the timeline for the last 14 to 30 days: every moment a number went down; next to it, what else happened then (deploy, reboot, OOM kill, node restart, unattended upgrade, Postgres restart, network error); and for each drop whether a QR code was needed (a `QR code ready` line after the drop) or it came back by itself.

### 5.6 Outside world

```bash
for h in web.whatsapp.com g.whatsapp.net mmg.whatsapp.net; do printf "%s " $h; curl -sS -o /dev/null -m 10 -w "http=%{http_code} dns=%{time_namelookup}s tls=%{time_appconnect}s total=%{time_total}s\n" https://$h/ || true; done
ping -c 10 -q 1.1.1.1 | tail -2; (resolvectl status 2>/dev/null || cat /etc/resolv.conf) | grep -iE "DNS Server|nameserver" | head -4
grep -hE "Storage=" /etc/systemd/journald.conf /etc/systemd/journald.conf.d/* 2>/dev/null
redis-cli config get maxmemory-policy 2>/dev/null; redis-cli config get appendonly 2>/dev/null
```

### 5.7 The hypothesis table

Give each row a verdict, CONFIRMED / REFUTED / UNKNOWN, with 1 to 3 evidence lines.

| ID | Suspect | Look for | Fix lives in |
|---|---|---|---|
| H1 | Hard stop on deploy or restart | pm2 `kill_timeout` 1600; "orphaned browser" lines at boot; `QR code ready` right after a deploy for a number that was connected | infra + code (C3) |
| H2 | Memory pressure, OOM | OOM lines; free and swap; sum of Chromium RSS against RAM; drops clustered at boot | infra + code (C4) |
| H3 | Node crashes | pm2 `restarts` and `unstable`; "unhandled" and "Target closed" lines; several numbers dropping in the same minute | code (C2) |
| H4 | Database saturation or restart | "timeout exceeded when trying to connect", "too many clients", `postgres_started` (Q5) | code (C1) + infra |
| H5 | Hung page | Q4 rows: CONNECTED but silent | code (C5) |
| H6 | OS patching or reboots | reboot history; unattended-upgrades logs; needrestart restarting services; `/var/run/reboot-required` | infra |
| H7 | Reboot without auto-start | no pm2 systemd unit or `dump.pm2`; services not enabled | infra |
| H8 | Disk full or bloat | `df`, profile and log sizes | infra |
| H9 | Network, DNS or clock | curl timings to WhatsApp hosts, ping loss, time sync | infra |
| H10 | The same session open elsewhere | `CONFLICT` lines, a second copy of the app, a staging server on the same database, copied token folders | owner |
| H11 | A WhatsApp Web change | many numbers failing at the same moment with `notLogged` or WA-JS errors and no local cause | code or library upgrade |
| H12 | WhatsApp-side logout | a single number; `notLogged` or `qrReadFail`; phone offline; the customer's report | alert and guidance |

**STOP.** Send the report (section 9) and wait for "go".

## 6. Phase 2: safe, reversible changes (after "go"; the app is not restarted)

- **pm2-logrotate**: `pm2 install pm2-logrotate`, then `pm2 set pm2-logrotate:max_size 50M`, `:retain 30`, `:compress true`. Logs must reach back weeks.
- **Persistent journal** (`Storage=persistent`, `SystemMaxUse=500M`) so kernel and OOM messages survive a reboot.
- **Time sync** active (chrony or systemd-timesyncd).
- **OS patching must not surprise us:** no automatic reboot; needrestart in list-only mode (`$nrconf{restart} = 'l';`) so apt cannot restart Postgres, Redis or pm2 behind our back; patch inside the window.
- **Swap:** if RAM is 8 GB or less and there is no swap, add a 2 to 4 GB `/swapfile` (`chmod 600`, fstab entry, `vm.swappiness=10`).
- **Boot survival:** `pm2 startup systemd` (run the command it prints) and `pm2 save`; confirm `postgresql` and `redis-server` are enabled and start before pm2's unit.
- **Capacity:** rule of thumb 0.4 to 0.7 GB per number plus about 1.5 GB for Node, Postgres, Redis and the OS, with 20 % headroom. If the real figures do not fit, say what to upgrade.
- **OOM priority**, only if OOM kills were CONFIRMED: make the kernel prefer killing a Chromium renderer over Node or Postgres (`OOMScoreAdjust=-500` drop-ins for postgresql and the pm2 unit).

## 7. Phase 3: changes that restart the app (owner's window; spare test number first)

1. **Cold backup** (consistent, because nothing is running): `pm2 stop wppflow-backend-v3`, then wait until no Chromium holds a profile under `TOKEN_DIR` (`pgrep -fa 'user-data-dir=.*tokens'` prints nothing; if some linger, report it and do not `kill -9` without the owner's OK), then `tar -czf /var/backups/wppflow/tokens-cold-$(date -u +%Y%m%dT%H%M%SZ).tgz -C "$TOKENS" .` with `chmod 600`, then `pm2 start`. The archive holds every customer's WhatsApp login keys: never copy it off the box unencrypted.
2. **Put the pm2 process definition in an ecosystem file outside the git checkout** (so deploys cannot overwrite it), starting from this and adapting it to the evidence:

```js
// /opt/wppflow-runtime/ecosystem.config.cjs
module.exports = { apps: [{
  name: "wppflow-backend-v3",
  cwd: "/opt/wppflow-backend",
  script: "src/pm2.js",       // EXACTLY the `script` printed in 5.2 (do not guess; src/server.js does not start the server under pm2)
  interpreter: "/opt/wppflow-runtime/node-v22.23.3-linux-x64/bin/node",
  time: true,                 // timestamp every log line, to correlate drops with restarts and deploys
  kill_timeout: 120000,       // let the app close every number gracefully (the default 1.6 s kills it midway)
  autorestart: true, min_uptime: 60000, max_restarts: 20, exp_backoff_restart_delay: 2000,
  env: { NODE_ENV: "production" },   // everything else stays in /opt/wppflow-backend/.env
}]};
```

   Before applying, record the running process's `script`, `cwd`, `interpreter` and the env variable **names** (from `pm2 jlist`, names only), and compare after, so nothing the app relies on is lost. If `/health` does not return `"status":"ok"` within 2 minutes of the restart, put the old definition back at once (`pm2 delete` is allowed here only as part of re-creating the same process from the saved definition, after `pm2 save` and the cold backup). Apply with `pm2 startOrRestart /opt/wppflow-runtime/ecosystem.config.cjs --update-env`, then `pm2 save`, and confirm the effective `kill_timeout` with the 5.2 one-liner. `deploy.sh` keeps working unchanged (`pm2 restart wppflow-backend-v3 --update-env` reuses the stored definition); check that the deployer service has no short timeout of its own.
3. **`treekill`**: I am not certain how pm2 signals Chromium children on stop (its `treekill` option defaults to true). Test on the spare number: `treekill: true` against `false`, and count `QR code ready` lines after each restart. Keep the setting that never forces a QR.
4. After each restart: `curl -s localhost:8080/health`; re-run Q1 until every number that was CONNECTED is CONNECTED again; check there is no `QR code ready` for those numbers; note the time it took. Keep restarts to the minimum: each one bounces every customer.

## 8. Phase 4: verify, then monitor

- **V1** After the Phase 3 restart, every number that was CONNECTED returns to CONNECTED without a QR. Record the time to full recovery.
- **V2** Spare number only: `pm2 restart` three times in a row; then `kill -9` the main Chromium process of the spare number: it must be back within 2 minutes without a QR. Do **not** restart Postgres to test C1 until the code fix has shipped.
- **V3** A watchdog independent of the app: a cron job every 2 minutes, using a **read-only** Postgres role limited to `SELECT` on `whatsapp_sessions`, plus `/health`. It alerts the owner's channel (de-duplicated, with a "recovered" message) when: `/health` fails twice in a row; a number with `restore_on_start=true` is not CONNECTED for more than 10 minutes; `heartbeat_failures >= 3`; Node restarted more than twice in an hour; free memory is under 10 % or disk over 85 %; an OOM kill appears in the journal. Keep it in `/opt/wppflow-runtime/watchdog/`, outside the git checkout, with no secrets in the script (the role's URL in a mode-600 file).
- **V4** A one-line daily summary for 7 days: drops per number, cause, recovery time, QR needed yes or no.

## 9. Report back (≤ 150 lines, masked; save as `/root/session-stability-report-$(date +%F).md` and print it)

- **A. Server:** RAM, CPU, disk, swap, OS, Chromium version, number of numbers and browsers, RSS per browser, headroom.
- **B. Timeline:** table (time | number | what happened | likely cause | QR needed?) for the last 14 to 30 days, plus counts of Node starts, deploys, reboots, OOM kills and unhandled rejections.
- **C. Hypotheses H1 to H12 and C1 to C8:** CONFIRMED / REFUTED / UNKNOWN with 1 to 3 evidence lines each.
- **D. Changes made**, from `/root/session-stability-changes.md`, each with its undo command.
- **E. Verification results** V1 to V4, with times.
- **F. What needs a code change** (with log evidence) and **what needs the owner's decision** (upgrade, alert channel).
- **G. Anything surprising.**
