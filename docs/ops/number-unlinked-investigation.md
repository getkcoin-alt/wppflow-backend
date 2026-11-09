<!-- Reusable brief: replace <EMAIL> and <LAST4>. Written for the case of one account whose number keeps getting unlinked. -->
# Follow-up: why does the WhatsApp number ending **<LAST4>** (account **<EMAIL>**) keep getting unlinked?

Same rules as the first brief, which still apply in full: **read-only**, SQL `SELECT` only, nothing printed in full (phone numbers: last 4 digits;
no `.env`, tokens or keys), no restarts, no `git`, no edits, never touch that number or its folder under `TOKEN_DIR`. This is one account.
Find out from the database, the logs and the request log what happened to its number, and report. Do not fix anything.

**What the owner saw:** the number was linked from its phone, then disconnected, and the linked device ("browser") **disappeared from the
phone's Linked devices**. It happened two to five times, and the inbox shows only old chats. Our server unlinks a phone in exactly one way: when
someone presses **Remove this number** (or the platform admin deletes a company), which logs the device out of WhatsApp. So the question is who or what did it.

## 1. Find the number (SELECT only)

```bash
export DATABASE_URL="$(grep -E '^DATABASE_URL=' /opt/wppflow-backend/.env | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
psql "$DATABASE_URL" -X -P pager=off <<'SQL'
-- A. the company of this account
SELECT t.id AS tenant_id, t.name AS company, t.status, t.plan, m.role
FROM users u JOIN memberships m ON m.user_id=u.id JOIN tenants t ON t.id=m.tenant_id
WHERE lower(u.email)='<EMAIL>';
-- B. its numbers, and ANY number in ANY company ending in <LAST4> (the same phone linked twice is a finding in itself)
SELECT t.name AS company, s.session_name, s.status,
       '…'||right(regexp_replace(coalesce(s.phone,''),'\D','','g'),4) AS phone,
       s.restore_on_start AS restore, s.reconnect_attempts AS reconnects, s.last_reconnect_at,
       s.connected_since, s.down_since, s.heartbeat_failures AS hb_fail, left(s.heartbeat_error,60) AS hb_error,
       left(s.last_error,160) AS last_error, s.created_at, s.updated_at
FROM whatsapp_sessions s JOIN tenants t ON t.id=s.tenant_id
WHERE s.tenant_id IN (SELECT m.tenant_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)='<EMAIL>')
   OR right(regexp_replace(coalesce(s.phone,''),'\D','','g'),4)='<LAST4>'
ORDER BY t.name, s.created_at;
-- C. what the app told the owner about its numbers
SELECT n.created_at, n.dedupe_key AS session_name, n.title, left(n.body,100) AS body
FROM notifications n
WHERE n.type='session' AND n.tenant_id IN (SELECT m.tenant_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)='<EMAIL>')
ORDER BY n.created_at DESC LIMIT 40;
SQL
# D. the history of each number, only if this server already has migration 052 (otherwise it says the table does not exist: fine)
psql "$DATABASE_URL" -X -P pager=off -c "SELECT created_at, session_name, event, cause, left(detail,100) AS detail FROM whatsapp_session_events WHERE tenant_id IN (SELECT m.tenant_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)='<EMAIL>') ORDER BY id DESC LIMIT 80" 2>&1 | head -90
```

Note each `session_name`, the times (`created_at`, `connected_since`, `down_since`), and whether the same last-4 appears under two companies.

## 2. What the server logged about it

```bash
S='<the session_name from B>'     # exact
cd ~/.pm2/logs
# the order in which WhatsApp's login reported things, for that number (line numbers keep the order if the lines carry no time)
grep -hnE "WhatsApp ${S}: " wppflow*-out.log* wppflow*-error.log* | sed -E 's/[A-Za-z0-9_+\/=-]{40,}/<hidden>/g' | tail -300
# the lines that explain an unlink, a timeout or a restart
grep -hnE "Session Unpaired|Auto Close Called|Phone not connected|WhatsApp logout for ${S}|Stopped [0-9]+ (leftover|orphaned) browser|Session (start|recovery) failed|Scriwo backend running on port" wppflow*-out.log* wppflow*-error.log* | tail -120
ls -la wppflow*; head -2 wppflow*-out.log
```

The lines that matter, in the order WhatsApp reports them: `notLogged` (a QR code is shown), `qrReadSuccess` (the phone scanned it), `isLogged`, `inChat` (the number is in),
`phoneNotConnected` then `autocloseCalled` (the chats had not loaded in time and the library closed the browser itself), **`disconnectedMobile`** (spelled like that:
the device stopped being registered, so the phone, WhatsApp or our Remove unlinked it; it also appears once, harmlessly, at the start of a number that was never linked),
`browserClose` (the browser went away), `Session Unpaired` (the library's own note), and a `Scriwo backend running on port` line (the server started: any number
starting up at that moment was cut off).

## 3. Did someone press "Remove this number"?

Our own log does not record requests, so use the web server's access log in front of the API (nginx, Caddy, Apache; find it with
`ls /var/log/nginx /var/log/caddy /var/log/apache2 2>/dev/null`; if there is none, say so):

```bash
# method, path and status only; long ids shortened; no client addresses
grep -hE '"(DELETE|POST) /api/sessions[^"]*"' /var/log/nginx/access.log* 2>/dev/null | sed -E 's/^[^[]*\[([^]]+)\][^"]*"([A-Z]+) ([^ ?"]+)[^"]*" ([0-9]+).*/\1 \2 \3 \4/' | tail -80
```
A `DELETE /api/sessions/<name>` shortly before a `disconnectedMobile` means someone pressed Remove. `POST /api/sessions/start` lines are scans and reconnects: how many, how far apart?

## 4. Was the server restarted while it was being linked?

```bash
grep -E "Backend deployment started|Deployed|Rolling back" /var/log/wppflow-backend-deploy.log | tail -30
pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s)){const e=p.pm2_env;console.log(JSON.stringify({name:p.name,restarts:e.restart_time,unstable:e.unstable_restarts,uptime_h:Math.round((Date.now()-e.pm_uptime)/36e5*10)/10}))}})'
last -x -n 10 reboot shutdown 2>/dev/null | head -10
dmesg -T 2>/dev/null | grep -iE "out of memory|oom-kill|killed process" | tail -10
```
A deploy, restart or OOM kill within a few minutes after a `qrReadSuccess` interrupts the first sync of the chats.

## 5. Is the same login in use twice?

```bash
export PATH=/opt/wppflow-runtime/node-v22.23.3-linux-x64/bin:$PATH
TOKENS=$(grep -E '^TOKEN_DIR=' /opt/wppflow-backend/.env | tail -1 | cut -d= -f2- | tr -d "\"'"); TOKENS=${TOKENS:-./tokens}
case "$TOKENS" in /*) ;; *) TOKENS="/opt/wppflow-backend/${TOKENS#./}";; esac
ls -la "$TOKENS" | head -40                      # any folder WITHOUT the tenant_<id>_ prefix is a legacy copy
grep -c '^LEGACY_SESSION_OWNERS=' /opt/wppflow-backend/.env   # 1 = legacy copies may exist (value not to be printed)
ps -eo pid,etimes,args | grep -E "user-data-dir" | grep -v " --type=" | grep -v grep | sed -E 's/.*--user-data-dir=([^ ]+).*/\1/' | sort | uniq -c   # a profile used by two browsers?
pm2 ls; ps -eo pid,etimes,args | grep -E "pm2.js|server.js" | grep -v grep | cut -c1-140   # more than one copy of the app?
du -sh "$TOKENS"/** 2>/dev/null | head
```
Ask the owner, and report the answer: is the same phone number (or the same `tokens` folder, or the same database) used by **any other copy** of Scriwo (an older
server, a staging copy, a laptop, another hosting account)? Two copies using one login make WhatsApp drop it.

## 6. Report (at most 60 lines, masked)

1. A **timeline** for the number: each scan / `qrReadSuccess`, each `inChat`, each `disconnectedMobile`, each `DELETE`, each deploy or restart, with times.
2. A **verdict** for each unlink, one of: (a) someone pressed Remove (the `DELETE` is there); (b) the server restarted during the first sync; (c) the chats did not
   finish loading (`qrReadSuccess` then `phoneNotConnected` / `autocloseCalled` within about three minutes); (d) `disconnectedMobile` with no `DELETE` and no restart:
   the phone or WhatsApp unlinked it; (e) the same login used twice; (f) other / not enough evidence (say what is missing).
3. Anything else odd (disk, memory, the same last-4 under two companies, repeated scans minutes apart).
