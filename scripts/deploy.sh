#!/usr/bin/env bash
set -e

COMMIT_ID="${1:-unknown}"
COMMIT_MSG="${2:-Auto deploy}"
LOG_FILE="/var/log/wppflow-backend-deploy.log"

exec >> "${LOG_FILE}" 2>&1

echo "=================================================="
echo "🚀 [CI/CD] WppFlow Backend Deployment triggered at $(date)"
echo "📌 Commit: ${COMMIT_ID} — ${COMMIT_MSG}"

export PATH="/opt/wppflow-runtime/node-v22.23.3-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export NODE_ENV="production"

cd /opt/wppflow-backend

echo "📥 Pulling latest changes from origin/main..."
git fetch origin main
git reset --hard origin/main

echo "📦 Installing production dependencies..."
npm install --omit=dev

echo "🗄️ Running database migrations..."
node src/db/migrate.js up

echo "🔄 Reloading PM2 process wppflow-backend-v3..."
pm2 restart wppflow-backend-v3 --update-env

echo "🩺 Verifying health check..."
sleep 4

HEALTH_URL="http://127.0.0.1:8080/health"
HEALTH_CHECK=$(curl -sf "${HEALTH_URL}" || true)

if echo "${HEALTH_CHECK}" | grep -q '"status":"ok"'; then
    echo "✅ [CI/CD] Deployment SUCCESS! Health check passed for ${COMMIT_ID}."
    echo "${HEALTH_CHECK}"
else
    echo "❌ [CI/CD] Deployment WARNING: Health check did not return status ok."
    echo "Response: ${HEALTH_CHECK}"
fi

echo "🏁 [CI/CD] Finished deployment at $(date)"
echo "=================================================="
