#!/usr/bin/env bash
# Applies ai-keys.env (see ai-keys.example.env) to the server's .env, restarts the backend and deletes the keys file.
# Only the names listed below are accepted, empty values are skipped, and keys are never printed.
#
#   cd /opt/wppflow-backend && bash apply-ai-keys.sh            # or: bash scripts/apply-ai-keys.sh
#   KEYS_FILE=/path/ai-keys.env  ENV_FILE=/opt/wppflow-backend/.env  KEEP=1  bash scripts/apply-ai-keys.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEYS_FILE="${KEYS_FILE:-$HERE/ai-keys.env}"
[ -f "$KEYS_FILE" ] || KEYS_FILE="$HERE/../ai-keys.env"
ENV_FILE="${ENV_FILE:-/opt/wppflow-backend/.env}"
APP_NAME="${APP_NAME:-wppflow-backend-v3}"
ALLOWED=" GROQ_API_KEY GEMINI_API_KEY GOOGLE_API_KEY CEREBRAS_API_KEY MISTRAL_API_KEY NVIDIA_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY AI_SELF_BASE_URL AI_SELF_MODEL AI_SELF_API_KEY AI_PROVIDERS AI_REQUIRE_NO_TRAINING AI_GEMINI_DATA AI_GROQ_DATA AI_CEREBRAS_DATA AI_MISTRAL_DATA AI_NVIDIA_DATA AI_OPENROUTER_DATA AI_ANTHROPIC_DATA "

die() { echo "Error: $*" >&2; exit 1; }
[ -f "$KEYS_FILE" ] || die "Keys file not found: $KEYS_FILE (copy ai-keys.example.env to ai-keys.env and fill it in)."
[ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist. Run this on the server, or set ENV_FILE=..."

declare -A NEW=()
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  line="${line%$'\r'}"
  case "$line" in ''|'#'*|[[:space:]]*'#'*) continue ;; esac
  [[ "$line" == *=* ]] || die "Line $n is not NAME=value."
  name="${line%%=*}"; value="${line#*=}"
  name="${name//[[:space:]]/}"
  case "$ALLOWED" in *" $name "*) ;; *) die "Line $n: '$name' is not a setting this script knows." ;; esac
  [ -n "$value" ] || continue
  case "$value" in *[[:space:]\"\'\\\$\`]*) die "Line $n ($name): the value must not contain spaces, quotes, backslashes or \$." ;; esac
  NEW[$name]="$value"
done < "$KEYS_FILE"

[ "${#NEW[@]}" -gt 0 ] || die "Every value in $KEYS_FILE is empty: nothing to apply."

backup="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
cp "$ENV_FILE" "$backup"
tmp="$(mktemp)"
cp "$ENV_FILE" "$tmp"
for name in "${!NEW[@]}"; do
  grep -v "^${name}=" "$tmp" > "$tmp.2" || true
  mv "$tmp.2" "$tmp"
  printf '%s=%s\n' "$name" "${NEW[$name]}" >> "$tmp"
done
cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
chmod 600 "$ENV_FILE"

echo "Applied to $ENV_FILE (backup: $backup):"
for name in $(printf '%s\n' "${!NEW[@]}" | sort); do
  case "$name" in
    *KEY*) echo "  $name  set (${#NEW[$name]} characters)" ;;
    *) echo "  $name  ${NEW[$name]}" ;;
  esac
done

if [ "${KEEP:-}" != "1" ]; then
  if command -v shred >/dev/null 2>&1; then shred -u "$KEYS_FILE"; else rm -f "$KEYS_FILE"; fi
  echo "Deleted $KEYS_FILE."
fi

if [ "${NO_RESTART:-}" = "1" ]; then echo "Not restarting (NO_RESTART=1)."; exit 0; fi
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env >/dev/null && echo "Restarted $APP_NAME."
  sleep 6
  curl -fsS -m 10 "http://127.0.0.1:${PORT:-8080}/health" 2>/dev/null | grep -o '"ai":{[^}]*}' || echo "Could not read /health yet: check 'pm2 logs $APP_NAME'."
else
  echo "pm2 not found: restart the backend yourself."
fi
echo "Next: in the app open Admin, Riwo, and press \"Run a test\"."
