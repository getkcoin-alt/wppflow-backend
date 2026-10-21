# CI/CD Automated Deployment Pipeline

WppFlow Backend uses an automated CI/CD pipeline that instantly deploys to the production live server whenever code is pushed to `main`.

## Pipeline Architecture

```
Git Push to main ──▶ GitHub Webhook ──▶ Live VPS Nginx (SSL) ──▶ Deployer Service (:9095)
                                                                          │
                                                                   HMAC Verification
                                                                          │
                                                                          ▼
                                                             /opt/wppflow-backend/scripts/deploy.sh
                                                                          │
                                           ┌──────────────────────────────┼──────────────────────────────┐
                                           ▼                              ▼                              ▼
                                    git pull main                  npm install --omit=dev         node migrate.js
                                                                                                         │
                                                                                                         ▼
                                                                                                   pm2 restart
                                                                                                         │
                                                                                                         ▼
                                                                                                   /health check
```

## How It Works

1. **Trigger**: Whenever any commit is pushed or merged to branch `main` on `github.com/getkcoin-alt/wppflow-backend`.
2. **GitHub Webhook**: GitHub sends a signed `push` payload to `https://srv1628639.hstgr.cloud/api/deploy-webhook`.
3. **Authentication & Validation**: The Deployer service authenticates the request using HMAC-SHA256 signature verification with the repository secret.
4. **Automated Deployment**:
   - Fetches and resets working tree to `origin/main`.
   - Loads production `.env` with validated credentials (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `RESEND_API_KEY`).
   - Installs production dependencies.
   - Runs database migrations with advisory locking (`001_multitenant_core` -> `004_configure_superadmin`).
   - Gracefully reloads the PM2 worker (`wppflow-backend-v3`).
   - Executes post-deployment verification against `http://127.0.0.1:8080/health`.
5. **Logs & Audit**: All deployment runs, timestamps, commit hashes, and health responses are logged to `/var/log/wppflow-backend-deploy.log`.

