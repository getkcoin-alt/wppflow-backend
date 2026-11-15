# Why is app.scriwo.com slow? Read-only checklist for the server (srv1628639)

Nothing here changes anything. Run on the VPS and paste the output back. Start with `curl -s http://localhost:<port>/health | jq .vitals` (or
the public address): load, memory, event-loop delay, database connections waiting, browsers, the slowest request and job in the last ten
minutes (see `server-vitals.md`). They often name the cause before anything below is needed.

What was measured from outside (14 Nov, about 06:00-07:00 UTC):
- One request at a time: 1-2.5 s per call (the simplest endpoint, with no database, 0.3-0.6 s).
- Eleven at once: the simplest endpoint (no database) answers one request about every 0.3 s (1.4 s to 3.5 s for the eleven). A static page on Vercel
  answers the same eleven in 0.5 s. So the machine is the bottleneck, not the network and not the database size (16,786 contacts, 1,282 chats).
- Sign-in takes 10-20 s. Five numbers of one company are all DISCONNECTED; the server has tried to bring them back 13, 3, 0, 0 and 4 times.

## Important: the slowness comes in waves
A 6-minute probe (one tiny request every 2 s, 14 Nov, started 09:52:06 UTC = 15:22 IST) showed: for the first 2.5 minutes the simplest endpoint
stalled eight times for 3-13 s (09:52:16, 09:52:25, 09:53:05, 09:54:00, 09:54:15 (12.8 s), 09:54:20, 09:54:27, 09:54:35 UTC); for the next 3.5
minutes it was normal (0.4-0.6 s) with no stall. So run steps 1 and 2 WHILE a wave is on (`vmstat 1 180` for three minutes is enough to catch
one; note the clock time), and compare the wave times with the `restore` events in step 5: every restore is one browser launch.
Other periodic work (scheduled jobs in pm2 logs, backups, log rotation, autovacuum) is worth ruling out the same way.

## 1. Is the machine starved? (CPU, memory, disk)
    uptime; nproc; free -m
    vmstat 1 5            # look at: r (queue) vs cores, si/so (swapping), wa (disk wait), st (CPU stolen by the host)
    df -h /; iostat -x 1 3 2>/dev/null | tail -20

## 2. What is using it? (look for leftover Chromium browsers)
    ps -eo pid,ppid,pcpu,pmem,etime,args --sort=-pcpu | cut -c1-170 | head -15
    pgrep -fc chrom; pgrep -af chrom | cut -c1-150 | head     # expected: 0 while no number is connected
    dmesg -T 2>/dev/null | grep -iE "out of memory|killed process" | tail -5

## 3. The app and the proxy
    pm2 describe wppflow-backend-v3 | grep -E "status|restarts|uptime|memory|cpu"
    pm2 logs wppflow-backend-v3 --lines 300 --nostream | grep -iE "timeout|ECONN|exceeded|Pool|crash|killed|Failed to launch" | tail -30
    tail -n 150 /var/log/nginx/error.log | cut -c1-220     # upstream timed out? worker_connections?

## 4. The database
    sudo -u postgres psql -c "select state,count(*) from pg_stat_activity group by 1;"
    sudo -u postgres psql -c "select pid, now()-query_start as running, left(query,90) from pg_stat_activity where state='active' order by running desc limit 8;"
    sudo -u postgres psql -c "select pg_size_pretty(pg_database_size(current_database()));"

## 5. Why do numbers keep being retried?
    cd /opt/wppflow-backend && node scripts/diagnose-numbers.mjs     # each number's state and event history (cause of every drop and retry)
    du -sh "$TOKEN_DIR"/* 2>/dev/null | sort -h | tail -8            # saved WhatsApp logins (browser profiles) - very large ones slow the disk

## Reading the result
- r in vmstat above the core count, or st above 10: the host is short of CPU -> bigger plan, or remove what is eating it.
- Several chrom processes while no number is connected, or old ones (etime of hours): leftover browsers -> `pkill -f chrom` once, then watch whether they come back.
- si/so above 0 or free memory near 0: out of memory -> bigger plan, fewer browsers.
- Long "active" queries in step 4: send me the query text (first 90 characters is enough).
- diagnose-numbers: many "disconnected ... retry" lines with the same cause tell what keeps failing.
