# Kairos Kit: notes for Claude

This repository is Kairos Kit, a career-operations system for one user: the
student who installed it. The **kairos** MCP server (`apps/local/mcp/server.ts`)
stores everything in the user's data folder, `KAIROS_HOME` (default `~/Kairos`),
outside this repository. The skill `.claude/skills/kairos/SKILL.md` holds the
workflows: building the knowledge base, scoring a posting, tailoring a résumé, cover
letters on request, application questions, sourcing preferences, interview prep.

Rules:
1. Before any answer about the user's applications, call `list_applications`.
   The board is the truth; earlier conversation is out of date.
2. Never invent experience, numbers, titles or dates. Facts come from the
   user's knowledge base or from the user, and every saved fact keeps its source.
3. Change data only through the MCP tools (`save_*`, `set_application_status`).
   After a direct file edit, call `rebuild_index`.
4. The user's data never goes into this repository. Do not copy files from
   `KAIROS_HOME` into the kit, and do not commit personal details.
5. Cover letters only when the user asks for one.

Commands:
- Tests: `npm test`. Typecheck: `npm run typecheck`. Personal-data scan: `npm run scan`.
- Dashboard: `npm run dev` (http://localhost:3000), unless the installer set it
  up to start at login (on a Mac the service `com.kairos-kit.dashboard`; on
  Windows the Startup file "Kairos Kit dashboard.cmd"). Run only one dashboard
  at a time.
- Résumé from a spec: `npx tsx apps/local/scripts/tailor-resume.mts <spec.json>`.
- Job search now: `npm -w kairos-local run sourcing-run`.
- The daily run is `scripts/daily.sh` on a Mac and `scripts/daily.mjs` on
  Windows (Task Scheduler: "Kairos Kit daily search"); its log is
  `logs/daily.log` in the data folder.
- The installer is `./install.sh` on a Mac and `node install.mjs` on Windows,
  with the same options. On Windows the Bash tool is Git Bash, which has no
  zsh and no `launchctl`: never run `./install.sh` there. Commands written with
  `node`, `npm`, `npx` and `git` are the same on both.
