#!/bin/zsh
# Kairos Kit installer (macOS).
#
#   ./install.sh                     interactive
#   ./install.sh --yes               accept the defaults, no services
#   ./install.sh --home ~/MyKairos   data folder somewhere else (default ~/Kairos)
#   ./install.sh --use-existing      accept a data folder that already holds a
#                                    record this kit did not create
#   ./install.sh --demo              start the data folder from the demo record
#   ./install.sh --dashboard         install the dashboard as a login service
#   ./install.sh --daily 08:15       install the daily job search at that time
#   ./install.sh --schedule-only --daily 08:00
#                                    only (re)install the daily search; /setup uses this
#   ./install.sh --schedule-only --no-daily
#                                    only remove the daily search
#
# Other flags: --skip-npm (packages already installed),
#              --launchd-dir <dir> (write the service files there, not loaded;
#              for testing), --port <n> (dashboard port, default 3000).
#
# It never changes an existing data folder. A folder that already holds a
# record (profile.md, knowledge-base/ or applications/) that this kit did not
# create is refused unless --use-existing is given, so a second install on a
# Mac never writes into someone else's record.
#
# The data folder is recorded in .kairos-home at the kit root (not tracked by
# git). The MCP server, the dashboard, the scripts and /find all read it.
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${KAIROS_HOME:-$HOME/Kairos}"
YES=0 DEMO=0 DASHBOARD=0 DAILY="" SKIP_NPM=0 PORT=3000 SCHEDULE_ONLY=0 HOME_GIVEN=0 USE_EXISTING=0
LAUNCHD_DIR="$HOME/Library/LaunchAgents" LOAD_SERVICES=1
ASKED_DASHBOARD=0 ASKED_DAILY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --home) HOME_DIR="$2"; HOME_GIVEN=1; shift ;;
    --demo) DEMO=1 ;;
    --use-existing) USE_EXISTING=1 ;;
    --dashboard) DASHBOARD=1; ASKED_DASHBOARD=1 ;;
    --no-dashboard) DASHBOARD=0; ASKED_DASHBOARD=1 ;;
    --daily) DAILY="$2"; ASKED_DAILY=1; shift ;;
    --no-daily) DAILY=""; ASKED_DAILY=1 ;;
    --skip-npm) SKIP_NPM=1 ;;
    --schedule-only) SCHEDULE_ONLY=1 ;;
    --port) PORT="$2"; shift; [[ "$PORT" == <1024-65535> ]] || { print -u2 "--port takes a number from 1024 to 65535."; exit 1; } ;;
    --launchd-dir) LAUNCHD_DIR="$2"; LOAD_SERVICES=0; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 2 ;;
  esac
  shift
done
# A re-run keeps the data folder the first run recorded in .kairos-home
# (older installs wrote it into .mcp.json), unless --home or KAIROS_HOME says
# otherwise.
POINTER="$KIT/.kairos-home"
PREV=""
if [ -f "$POINTER" ]; then
  PREV="$(head -1 "$POINTER")"
elif [ -f "$KIT/.mcp.json" ]; then
  PREV="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j?.mcpServers?.kairos?.env?.KAIROS_HOME??"")}catch{}' "$KIT/.mcp.json" 2>/dev/null || true)"
fi
PREV="${PREV/#\~/$HOME}"
if [ "$HOME_GIVEN" = 0 ] && [ -z "${KAIROS_HOME:-}" ] && [ -n "$PREV" ]; then
  HOME_DIR="$PREV"
fi
HOME_DIR="${HOME_DIR/#\~/$HOME}"
if [ "$SCHEDULE_ONLY" = 1 ] && [ "$ASKED_DAILY" = 0 ]; then
  echo "--schedule-only needs --daily HH:MM or --no-daily"; exit 2
fi

ok()   { print -P "%F{green}✓%f $*"; }
warn() { print -P "%F{yellow}!%f $*"; }
fail() { print -P "%F{red}✗%f $*"; exit 1; }
ask()  { # ask "question" -> 0 for yes
  [ "$YES" = 1 ] && return 1
  [ -t 0 ] || return 1
  local a; read "a?$1 [y/N] "; [[ "$a" == [yY]* ]]
}

echo "Kairos Kit installer"
echo "  kit:         $KIT"
echo "  data folder: $HOME_DIR"
echo

# --- 0. Whose data folder is this? -------------------------------------------------
# A folder this kit made carries .kairos-kit. A folder recorded by an earlier
# run of this kit was already accepted. Anything else that holds a record is
# refused without --use-existing.
holds_record() { [ -e "$1/profile.md" ] || [ -d "$1/knowledge-base" ] || [ -d "$1/applications" ]; }
if [ -e "$HOME_DIR" ] && holds_record "$HOME_DIR" && [ ! -e "$HOME_DIR/.kairos-kit" ] \
   && [ "$HOME_DIR" != "$PREV" ] && [ "$USE_EXISTING" = 0 ]; then
  print -P "%F{red}✗%f $HOME_DIR already holds a Kairos record that this kit did not create."
  echo "  Nothing was changed. Choose one:"
  echo "    ./install.sh --home ~/KairosKit        a new data folder for this kit"
  echo "    ./install.sh --use-existing            use this record (the kit will write into it)"
  exit 1
fi
if [ "$SCHEDULE_ONLY" = 1 ]; then
  command -v node >/dev/null || fail "Node.js not found."
  NODE_DIR="$(dirname "$(command -v node)")"
  [ -d "$HOME_DIR" ] || fail "Data folder not found: $HOME_DIR (run ./install.sh first)"
else
# --- 1. Checks -----------------------------------------------------------------
[ "$(uname)" = "Darwin" ] || warn "This installer is written for macOS. Packages and the data folder will work elsewhere; the services will not."

command -v node >/dev/null || fail "Node.js not found. Install Node 22 (https://nodejs.org or 'brew install node@22') and re-run."
# 22.17 or newer within 22, or 24 and later (what the PDF renderer's Chromium package supports; 23 is not).
NODE_OK="$(node -p 'const [a,b]=process.versions.node.split(".").map(Number); (a===22&&b>=17)||a>=24')"
[ "$NODE_OK" = "true" ] || fail "Node $(node -v) found; Kairos Kit needs Node 22.17 or newer, or Node 24 or newer (brew install node@22)."
ok "Node $(node -v)"
NODE_DIR="$(dirname "$(command -v node)")"

if command -v claude >/dev/null; then
  ok "Claude Code CLI: $(claude --version 2>/dev/null | head -1)"
else
  warn "Claude Code CLI not found. Install it (https://claude.com/claude-code) and sign in with a Claude Pro or Max plan; Kairos runs inside it."
fi

if [ -x /Applications/LibreOffice.app/Contents/MacOS/soffice ] || command -v soffice >/dev/null; then
  ok "LibreOffice found (exact page counts for résumés)"
else
  warn "LibreOffice not found (optional). Without it, page fit is estimated instead of measured. 'brew install --cask libreoffice' adds it."
fi

case "$KIT" in
  "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*)
    warn "The kit is under Documents/Desktop/Downloads. macOS blocks background services from running scripts there; move it (e.g. ~/kairos-kit) if you want the dashboard service or the daily run." ;;
esac

# --- 2. Packages ------------------------------------------------------------------
if [ "$SKIP_NPM" = 0 ]; then
  echo "Installing packages (npm ci)…"
  (cd "$KIT" && npm ci --no-audit --no-fund) || fail "npm ci failed."
  ok "Packages installed"
else
  ok "Packages: skipped (--skip-npm)"
fi

# --- 3. Data folder -----------------------------------------------------------------
if [ -e "$HOME_DIR" ]; then
  ok "Data folder exists; using it as it is (nothing in it is changed): $HOME_DIR"
  # Other users of this Mac should not read it. Said, not changed.
  if [ -n "$(find "$HOME_DIR" -maxdepth 0 -perm -o=r 2>/dev/null)$(find "$HOME_DIR" -maxdepth 0 -perm -g=r 2>/dev/null)" ]; then
    warn "Other accounts on this Mac can read $HOME_DIR. To keep it to yourself: chmod 700 \"$HOME_DIR\""
  fi
  [ "$DEMO" = 1 ] && warn "--demo ignored: the data folder already exists."
else
  if [ "$DEMO" = 1 ]; then
    mkdir -p "$(dirname "$HOME_DIR")"
    cp -R "$KIT/demo" "$HOME_DIR"
    find "$HOME_DIR" -name .gitkeep -delete
    ok "Data folder created from the demo record: $HOME_DIR"
  else
    mkdir -p "$HOME_DIR"/{knowledge-base/experiences,knowledge-base/education,applications,sourcing,logs}
    ok "Data folder created: $HOME_DIR"
  fi
  : > "$HOME_DIR/.kairos-kit"
  chmod 700 "$HOME_DIR"
fi
print -r -- "$HOME_DIR" > "$POINTER"
ok "Data folder recorded in .kairos-home (read by the server, the dashboard and /find)"

# --- 4. .mcp.json -------------------------------------------------------------------
# Claude Code starts project MCP servers from the kit folder, so the paths stay
# relative. The data folder comes from .kairos-home, so this file is the same
# for everyone and git sees no change (older installs wrote an env block here).
cat > "$KIT/.mcp.json" <<JSON
{
  "mcpServers": {
    "kairos": {
      "command": "npx",
      "args": ["tsx", "apps/local/mcp/server.ts"]
    }
  }
}
JSON
ok ".mcp.json written (MCP server 'kairos')"

# --- 5. Optional services (launchd) ---------------------------------------------------
if [ "$ASKED_DASHBOARD" = 0 ] && ask "Run the dashboard at login (http://localhost:$PORT)?"; then DASHBOARD=1; fi
if [ "$ASKED_DAILY" = 0 ] && ask "Run the job search every morning?"; then
  read "DAILY?Time (HH:MM, default 08:15): "; DAILY="${DAILY:-08:15}"
fi
fi # end of the full install (skipped by --schedule-only)

# A value inside the service file's XML: &, <, >, " and ' escaped (a folder name may hold any of them).
xml() { local v="$1"; v="${v//&/&amp;}"; v="${v//</&lt;}"; v="${v//>/&gt;}"; v="${v//\"/&quot;}"; v="${v//\'/&apos;}"; print -r -- "$v"; }

plist() { # plist <label> <script> [hour minute]
  local label="$1" script="$2" hour="${3:-}" minute="${4:-}" file="$LAUNCHD_DIR/$1.plist"
  mkdir -p "$LAUNCHD_DIR" "$HOME_DIR/logs"
  {
    cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml "$label")</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>$(xml "$script")</string></array>
  <key>WorkingDirectory</key><string>$(xml "$KIT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KAIROS_HOME</key><string>$(xml "$HOME_DIR")</string>
    <key>KAIROS_NODE_DIR</key><string>$(xml "$NODE_DIR")</string>
    <key>KAIROS_PORT</key><string>$PORT</string>
  </dict>
  <key>StandardOutPath</key><string>$(xml "$HOME_DIR/logs/$label.out.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$HOME_DIR/logs/$label.err.log")</string>
XML
    if [ -n "$hour" ]; then
      echo "  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$hour</integer><key>Minute</key><integer>$minute</integer></dict>"
    else
      echo "  <key>RunAtLoad</key><true/>"
      echo "  <key>KeepAlive</key><true/>"
    fi
    echo "</dict>"
    echo "</plist>"
  } > "$file"
  plutil -lint "$file" >/dev/null 2>&1 || fail "Invalid service file: $file"
  if [ "$LOAD_SERVICES" = 1 ]; then
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$file" || fail "Could not load $label (launchctl bootstrap failed)"
    launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || fail "$label did not register with launchd"
    ok "Service loaded: $label"
  else
    ok "Service file written (not loaded): $file"
  fi
}

if [ "$DASHBOARD" = 1 ]; then
  plist com.kairos-kit.dashboard "$KIT/scripts/dashboard.sh"
fi
if [ -n "$DAILY" ]; then
  [[ "$DAILY" =~ ^([01]?[0-9]|2[0-3]):[0-5][0-9]$ ]] || fail "--daily needs HH:MM, got '$DAILY'"
  H="${DAILY%%:*}" M="${DAILY##*:}"
  plist com.kairos-kit.daily "$KIT/scripts/daily.sh" "$((10#$H))" "$((10#$M))"
  ok "Daily job search: every day at $DAILY (log: $HOME_DIR/logs/daily.log)"
elif [ "$ASKED_DAILY" = 1 ]; then
  # --no-daily: remove a schedule installed earlier.
  F="$LAUNCHD_DIR/com.kairos-kit.daily.plist"
  if [ "$LOAD_SERVICES" = 1 ]; then launchctl bootout "gui/$(id -u)/com.kairos-kit.daily" 2>/dev/null || true; fi
  if [ -f "$F" ]; then rm -f "$F"; ok "Daily job search removed"; else ok "Daily job search: not installed"; fi
fi

[ "$SCHEDULE_ONLY" = 1 ] && exit 0

# --- 6. Next steps -----------------------------------------------------------------
echo
ok "Done."
echo "Next:"
echo "  1. cd \"$KIT\" && claude"
echo "  2. Approve the 'kairos' MCP server when Claude Code asks."
echo "  3. Type /setup. It asks for your documents or interviews you."
[ "$DASHBOARD" = 1 ] || echo "  Dashboard any time: npm run dev  (http://localhost:3000)"
echo "  Guide: docs/getting-started.md"
