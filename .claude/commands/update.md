---
description: Pull the latest Kairos Kit. Your data folder is not touched.
---

# /update: get the latest kit

The kit is code; the student's data folder (`KAIROS_HOME`, default `~/Kairos`)
is outside it and is never changed by an update. Arguments: `$ARGUMENTS`

1. In the kit folder, run `git status --porcelain`. If files are modified, list
   them and ask whether to keep them aside (`git stash push -m "before update"`)
   or stop. Never discard them.
2. `git pull --ff-only`. If it cannot fast-forward, stop and say so; do not
   merge or rebase on the student's behalf.
3. `npm ci` (packages may have changed).
4. `npm test`. Report failures plainly; they do not affect the data.
5. Say what changed: `git log --oneline <old>..HEAD` (the old commit from step 2),
   in plain words, and whether a restart of Claude Code is needed (it is when
   files under `apps/local/mcp/` or `.claude/` changed).
6. If the dashboard runs as a service, restart it:
   `launchctl kickstart -k gui/$(id -u)/com.kairos-kit.dashboard`.
7. If a stash was made in step 1, offer to restore it with `git stash pop`.
8. Call `setup_status`. If the update added settings that are not set yet,
   name the parts to re-run with `/setup --section <name>`.
