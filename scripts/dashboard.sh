#!/bin/zsh
# Kairos Kit dashboard as a service (launchd: com.kairos-kit.dashboard, set up
# by install.sh). Serves http://localhost:${KAIROS_PORT:-3000} to this computer only
# (bound to 127.0.0.1; access check in apps/local/middleware.ts). launchd restarts
# it if it stops. Run only one dashboard per checkout: two dev servers share
# .next and break each other.
set -u
KIT="$(cd "$(dirname "$0")/.." && pwd)"
# Same order as kairosHome(): KAIROS_HOME, then .kairos-home (written by install.sh), then ~/Kairos.
[ -z "${KAIROS_HOME:-}" ] && [ -f "$KIT/.kairos-home" ] && KAIROS_HOME="$(head -1 "$KIT/.kairos-home")"
export KAIROS_HOME="${KAIROS_HOME:-$HOME/Kairos}"
export PATH="${KAIROS_NODE_DIR:+$KAIROS_NODE_DIR:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
cd "$KIT/apps/local" || exit 1
export KAIROS_LOCAL_ONLY=1
exec npx next dev -H 127.0.0.1 -p "${KAIROS_PORT:-3000}"
