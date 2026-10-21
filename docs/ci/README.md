# CI/CD pipeline

```
 pull request ──▶ GitHub Actions "CI" (tests) ──▶ review ──▶ merge to main
                                                                │
 push to main ──▶ GitHub Actions "CI" again                     ▼
                                      GitHub webhook ──▶ VPS deployer (:9095, HMAC-verified)
                                                                │
                                                                ▼
                                                  /opt/wppflow-backend/scripts/deploy.sh
```

## Continuous integration (`.github/workflows/ci.yml`)

Runs on every pull request and every push to `main`: installs with `npm ci`, syntax-checks `scripts/deploy.sh`,
and runs `npm test` against a disposable PostgreSQL 16 with Redis available. Nothing in the tests touches production
data or a real WhatsApp/email provider.

**Make it a gate (one-time, GitHub settings):** Settings → Branches → add a rule for `main` that requires a pull request
and the status check **Backend tests**. The deploy webhook fires on pushes to `main`, so this is what stops untested
code from being deployed.

## Continuous deployment (`scripts/deploy.sh`)

The VPS deployer runs `scripts/deploy.sh <commit> <message>` on each push to `main`. The script lives in this repository,
so improving the pipeline never needs a change on the server. It:

1. takes a lock so overlapping pushes deploy one after another;
2. skips the run if the server already has that commit (`FORCE_DEPLOY=1` overrides);
3. `git reset --hard origin/main` and `npm ci --omit=dev` (exact lockfile versions);
4. backs up the database with `pg_dump` to `/var/backups/wppflow/pre-<sha>-<time>.sql.gz` (last 10 kept, mode 600);
5. applies pending migrations (each in a transaction);
6. `pm2 restart wppflow-backend-v3 --update-env`;
7. polls `/health` for up to 40 s and requires `"status":"ok"`;
8. **if anything fails, restores the previous commit, reinstalls and restarts it, and exits non-zero.**

Migrations are additive and stay applied after a rollback, so the previous release keeps running against the newer schema.
Restore a database backup manually only if a migration itself corrupted data:
`gunzip -c /var/backups/wppflow/<file>.sql.gz | psql "$DATABASE_URL"`.

Logs: `/var/log/wppflow-backend-deploy.log`. Server configuration (`.env`) is never touched by a deploy; new settings are
added there once, by hand (see `.env.example`).

## Deploy order for changes that touch both repositories

Merge and let the backend deploy finish (check the log for `Deployed`) **before** merging the frontend, because Vercel
publishes the frontend as soon as `main` moves.

## If a push to `main` does not deploy

`/health` reports what is actually running: `build.commit` (compare with `main`), `build.startedAt` and
`schemaVersion` (the latest applied migration). If `build.commit` is old, the deploy did not happen; if the commit is
new but `schemaVersion` is old, a migration failed and the release was rolled back.

Symptoms: `/health` still shows a long `uptime` (it resets on every restart) and new routes return "Endpoint not found".

1. `tail -n 60 /var/log/wppflow-backend-deploy.log` — a run that started leaves a banner and ends with `Finished with exit code …`.
   No banner means the webhook never reached the deployer: GitHub → repository Settings → Webhooks → Recent Deliveries
   → Redeliver.
2. `cd /opt/wppflow-backend && git log --oneline -1` — compare with `main`.
3. Run the same deploy by hand: `/opt/wppflow-backend/scripts/deploy.sh manual "manual redeploy"`
   (add `FORCE_DEPLOY=1` in front to redeploy the commit that is already checked out).
4. `Another deployment is still running` in the log means a previous run holds `/var/lock/wppflow-backend-deploy.lock`;
   check `ps aux | grep deploy.sh` before removing anything.

Every step of `deploy.sh` has a time limit (git fetch 2 min, install 15 min, backup 10 min, migrations 10 min) and
migrations give up after 20 seconds if a table is locked, so a stuck step ends in an automatic rollback and releases the
deploy lock instead of blocking later deploys.
