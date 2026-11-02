#!/usr/bin/env bash
# Adds or replaces an AI provider's key in the server's .env. The key is typed at a hidden prompt, so it never appears on the
# screen, in the shell history, in a process list or in a log. Run it on the server:
#
#   cd /opt/wppflow-backend && bash scripts/add-ai-key.sh groq
#   bash scripts/add-ai-key.sh list            # which providers are set (never shows a key)
#   bash scripts/add-ai-key.sh order           # choose the order they are tried in
#   bash scripts/add-ai-key.sh self            # your own GPUs or any OpenAI-compatible server
#
# Providers: groq gemini cerebras mistral nvidia openrouter anthropic
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/wppflow-backend/.env}"
APP_NAME="${APP_NAME:-wppflow-backend-v3}"

declare -A VAR=(
  [groq]=GROQ_API_KEY [gemini]=GEMINI_API_KEY [cerebras]=CEREBRAS_API_KEY [mistral]=MISTRAL_API_KEY
  [nvidia]=NVIDIA_API_KEY [openrouter]=OPENROUTER_API_KEY [anthropic]=ANTHROPIC_API_KEY
)

die() { echo "Error: $*" >&2; exit 1; }
[ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist. Run this from the server, or set ENV_FILE=..."

# set NAME VALUE: replaces the line if there is one, adds it if not
set_var() {
  local name="$1" value="$2"
  case "$value" in *[[:space:]\"\'\\\$\`]*) die "The value must not contain spaces, quotes, backslashes or \$." ;; esac
  [ -n "$value" ] || die "Nothing was entered."
  cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
  local tmp; tmp="$(mktemp)"
  grep -v "^${name}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$name" "$value" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  chmod 600 "$ENV_FILE"
}
unset_var() { grep -v "^${1}=" "$ENV_FILE" > "$ENV_FILE.tmp" || true; cat "$ENV_FILE.tmp" > "$ENV_FILE"; rm -f "$ENV_FILE.tmp"; }
restart() {
  if [ "${NO_RESTART:-}" = "1" ]; then echo "Not restarting (NO_RESTART=1)."; return; fi
  command -v pm2 >/dev/null || { echo "pm2 not found: restart the backend yourself."; return; }
  pm2 restart "$APP_NAME" --update-env >/dev/null
  echo "Restarted $APP_NAME."
}
ask_secret() { local v; read -rsp "$1: " v; echo >&2; printf '%s' "$v"; }

cmd="${1:-}"
case "$cmd" in
  list)
    for p in "${!VAR[@]}"; do
      if grep -q "^${VAR[$p]}=." "$ENV_FILE"; then echo "$p: key set"; else echo "$p: -"; fi
    done | sort
    grep -q "^AI_SELF_BASE_URL=." "$ENV_FILE" && echo "self: $(grep '^AI_SELF_BASE_URL=' "$ENV_FILE" | cut -d= -f2-)" || echo "self: -"
    echo "order: $(grep '^AI_PROVIDERS=' "$ENV_FILE" | cut -d= -f2- || true)"
    ;;
  order)
    read -rp "Providers in the order to try them, separated by commas (for example groq,gemini,openrouter): " list
    list="${list// /}"; [ -n "$list" ] || die "Nothing was entered."
    set_var AI_PROVIDERS "$list"; restart ;;
  self)
    read -rp "Address of the server, ending in /v1 (for example http://10.0.0.5:8000/v1): " url
    read -rp "Model name: " model
    key="$(ask_secret 'API key (leave empty if it needs none)')"
    set_var AI_SELF_BASE_URL "$url"; set_var AI_SELF_MODEL "$model"
    if [ -n "$key" ]; then set_var AI_SELF_API_KEY "$key"; else unset_var AI_SELF_API_KEY; fi
    restart ;;
  remove)
    p="${2:-}"; [ -n "${VAR[$p]:-}" ] || die "Usage: add-ai-key.sh remove <provider>"
    unset_var "${VAR[$p]}"; restart ;;
  groq|gemini|cerebras|mistral|nvidia|openrouter|anthropic)
    key="$(ask_secret "Paste the $cmd key (it will not be shown)")"
    set_var "${VAR[$cmd]}" "$key"
    echo "Saved ${VAR[$cmd]} (${#key} characters)."
    restart ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
