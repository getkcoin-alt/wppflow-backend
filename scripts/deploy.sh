#!/usr/bin/env bash
# Invoked by the deployer service after a push to main:  deploy.sh <commit> <message>
# Safe to run by hand too. Environment overrides exist mainly so the script can be tested.
set -uo pipefail

COMMIT_ID="${1:-unknown}"
COMMIT_MSG="${2:-Auto deploy}"
APP_DIR="${APP_DIR:-/opt/wppflow-backend}"
PM2_NAME="${PM2_NAME:-wppflow-backend-v3}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/health}"
LOG_FILE="${LOG_FILE:-/var/log/wppflow-backend-deploy.log}"
LOCK_FILE="${LOCK_FILE:-/var/lock/wppflow-backend-deploy.lock}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/wppflow}"
BACKUP_KEEP="${BACKUP_KEEP:-10}"
HEALTH_TRIES="${HEALTH_TRIES:-20}"
HEALTH_WAIT="${HEALTH_WAIT:-2}"
NODE_BIN_DIR="${NODE_BIN_DIR:-/opt/wppflow-runtime/node-v22.23.3-linux-x64/bin}"

# Everything lives in a function: bash reads the whole body before running it, so the
# `git reset --hard` below can replace this very file without corrupting the run.
main() {
  exec >>"${LOG_FILE}" 2>&1
  echo "=================================================="
  echo "🚀 [CI/CD] Backend deployment started $(date -u +%FT%TZ)"
  echo "📌 Commit: ${COMMIT_ID} — ${COMMIT_MSG}"

  export PATH="${NODE_BIN_DIR}:${PATH}"
  export NODE_ENV="production"

  # One deployment at a time; a second push waits instead of racing the first.
  exec 9>"${LOCK_FILE}"
  if ! flock -w 600 9; then
    echo "❌ Another deployment is still running after 10 minutes. Aborting."
    return 1
  fi

  cd "${APP_DIR}" || { echo "❌ ${APP_DIR} not found"; return 1; }
  local previous target
  previous="$(git rev-parse HEAD)"
  git fetch origin main || { echo "❌ git fetch failed"; return 1; }
  target="$(git rev-parse origin/main)"
  if [ "${previous}" = "${target}" ] && [ -z "${FORCE_DEPLOY:-}" ]; then
    echo "✅ Already running ${target:0:7}; nothing to deploy (set FORCE_DEPLOY=1 to redeploy)."
    return 0
  fi

  echo "📥 Updating ${previous:0:7} -> ${target:0:7}"
  git reset --hard "${target}" || return 1

  echo "📦 Installing production dependencies (exact lockfile versions)..."
  npm ci --omit=dev --ignore-scripts || { echo "❌ npm ci failed"; rollback "${previous}" "dependency install failed"; return 1; }

  backup_database "${target}"

  echo "🗄️ Applying database migrations..."
  node src/db/migrate.js up || { echo "❌ Migration failed (it ran in a transaction and was rolled back)"; rollback "${previous}" "migration failed"; return 1; }

  echo "🔄 Restarting ${PM2_NAME}..."
  pm2 restart "${PM2_NAME}" --update-env || { rollback "${previous}" "pm2 restart failed"; return 1; }

  if wait_healthy; then
    echo "✅ [CI/CD] Deployed ${target:0:7} — health check passed."
    return 0
  fi
  rollback "${previous}" "health check failed"
  return 1
}

wait_healthy() {
  local i body
  for ((i = 1; i <= HEALTH_TRIES; i++)); do
    sleep "${HEALTH_WAIT}"
    body="$(curl -sf --max-time 5 "${HEALTH_URL}" || true)"
    if echo "${body}" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
      echo "🩺 ${body}"
      return 0
    fi
  done
  echo "🩺 No healthy response from ${HEALTH_URL}; last body: ${body:-<none>}"
  return 1
}

# Best effort: a failed backup is logged but never blocks a deploy.
backup_database() {
  local url="${DATABASE_URL:-}"
  if [ -z "${url}" ] && [ -f .env ]; then
    url="$(grep -E '^DATABASE_URL=' .env | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
  fi
  if [ -z "${url}" ] || ! command -v pg_dump >/dev/null 2>&1; then
    echo "⚠️ Skipping database backup (pg_dump or DATABASE_URL unavailable)."
    return 0
  fi
  mkdir -p "${BACKUP_DIR}" && chmod 700 "${BACKUP_DIR}"
  local file="${BACKUP_DIR}/pre-${1:0:7}-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  if pg_dump "${url}" | gzip >"${file}"; then
    chmod 600 "${file}"
    echo "💾 Database backup: ${file}"
    ls -1t "${BACKUP_DIR}"/pre-*.sql.gz 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm -f
  else
    rm -f "${file}"
    echo "⚠️ Database backup failed; continuing."
  fi
}

# Code goes back to the last good commit. Migrations are additive and stay applied,
# so the previous release keeps working against the newer schema.
rollback() {
  local previous="$1" reason="$2"
  echo "↩️ Rolling back to ${previous:0:7} (${reason})"
  git reset --hard "${previous}" || return 1
  npm ci --omit=dev --ignore-scripts || true
  pm2 restart "${PM2_NAME}" --update-env || true
  if wait_healthy; then
    echo "✅ Rollback complete: ${previous:0:7} is serving again."
  else
    echo "🚨 Rollback did not restore a healthy service. Manual action required."
  fi
}

main "$@"
status=$?
echo "🏁 [CI/CD] Finished with exit code ${status} at $(date -u +%FT%TZ)"
exit "${status}"
