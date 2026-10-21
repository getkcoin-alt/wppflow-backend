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
