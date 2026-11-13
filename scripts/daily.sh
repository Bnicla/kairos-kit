#!/bin/zsh
# Kairos Kit daily routine (launchd: com.kairos-kit.daily, set up by install.sh).
#   1. prune-closed      move drafts whose listing closed to the Closed column
#   2. harvest-registry  refresh the job-board list when older than 30 days (kept in $KAIROS_HOME/sourcing)
#   3. sourcing-run      fresh sweep + triage into the Sourced column
#   4. dream-watch       check your dream companies' career sites directly
# Writes $KAIROS_HOME/logs/daily.log (last run) and sourcing/daily-heartbeat.json.
set -u
KIT="$(cd "$(dirname "$0")/.." && pwd)"
# Same order as kairosHome(): KAIROS_HOME, then .kairos-home (written by install.sh), then ~/Kairos.
[ -z "${KAIROS_HOME:-}" ] && [ -f "$KIT/.kairos-home" ] && KAIROS_HOME="$(head -1 "$KIT/.kairos-home")"
export KAIROS_HOME="${KAIROS_HOME:-$HOME/Kairos}"
export PATH="${KAIROS_NODE_DIR:+$KAIROS_NODE_DIR:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
CLAUDE_BIN="$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")"
export CLAUDE_CLI_PATH="${CLAUDE_CLI_PATH:-$CLAUDE_BIN}"
# launchd has no keychain session. A long-lived token (claude setup-token)
# saved here lets the triage step call Claude; without it the sweep still runs
# but ships an unranked list.
TOKEN_FILE="${KAIROS_TOKEN_FILE:-$HOME/.config/kairos/claude-oauth-token}"
[ -f "$TOKEN_FILE" ] && export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_FILE")"
mkdir -p "$KAIROS_HOME/logs" "$KAIROS_HOME/sourcing"
# /setup part 14 can turn the daily run off; respect it even if the service is loaded.
SP="$KAIROS_HOME/sourcing/search-profile.json"
if [ -f "$SP" ] && [ "$(node -e 'try{const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p?.daily_run?.enabled))}catch{}' "$SP")" = "false" ]; then
  echo "daily run is off in search-profile.json (daily_run.enabled=false); nothing to do" > "$KAIROS_HOME/logs/daily.log"
  exit 0
fi
LOG="$KAIROS_HOME/logs/daily.log"
HEARTBEAT="$KAIROS_HOME/sourcing/daily-heartbeat.json"

run_status=ok
{
  echo "=== Kairos daily routine: $(date '+%Y-%m-%d %H:%M:%S') ==="
  cd "$KIT" || exit 1
  echo "--- prune-closed ---"
  npm -w kairos-local run prune-closed || run_status=degraded
  # The script harvests only when the job-board list in use is over 30 days
  # old. It writes the refreshed list to $KAIROS_HOME/sourcing/registry.json
  # and changes no file of the kit, so /update finds an unmodified checkout.
  echo "--- harvest-registry ---"
  npm -w kairos-local run harvest-registry || echo "harvest failed; sweeping with the current job-board list"
  echo "--- sourcing-run ---"
  npm -w kairos-local run sourcing-run || run_status=failed
  if [ "$(date +%u)" = "1" ]; then
    echo "--- deep scan (Mondays) ---"
    npm -w kairos-local run sourcing-run -- --deep || run_status=degraded
  fi
  if [ -f "$KIT/apps/local/scripts/dream-watch.mts" ]; then
    echo "--- dream-watch ---"
    npm -w kairos-local run dream-watch || run_status=degraded
  fi
  echo "=== done: $(date '+%H:%M:%S') ==="
} > "$LOG" 2>&1

printf '{"last_run":"%s","status":"%s"}\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$run_status" > "$HEARTBEAT"
