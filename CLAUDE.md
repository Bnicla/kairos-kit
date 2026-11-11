# Kairos Kit: notes for Claude

This repository is Kairos Kit, a career-operations system for one user: the
student who installed it. The **kairos** MCP server (`apps/local/mcp/server.ts`)
stores everything in the user's data folder, `KAIROS_HOME` (default `~/Kairos`),
outside this repository. The skill `.claude/skills/kairos/SKILL.md` holds the
workflows: building the record, scoring a posting, tailoring a résumé, cover
letters on request, application questions, sourcing preferences, interview prep.

Rules:
1. Before any answer about the user's applications, call `list_applications`.
   The board is the truth; earlier conversation is out of date.
2. Never invent experience, numbers, titles or dates. Facts come from the
   user's record or from the user, and every saved fact keeps its source.
3. Change data only through the MCP tools (`save_*`, `set_application_status`).
   After a direct file edit, call `rebuild_index`.
4. The user's data never goes into this repository. Do not copy files from
   `KAIROS_HOME` into the kit, and do not commit personal details.
5. Cover letters only when the user asks for one.

Commands:
- Tests: `npm test`. Typecheck: `npm run typecheck`. Personal-data scan: `npm run scan`.
- Dashboard: `npm run dev` (http://localhost:3000), unless `install.sh` set it up
  as the service `com.kairos-kit.dashboard`. Run only one dashboard at a time.
- Résumé from a spec: `npx tsx apps/local/scripts/tailor-resume.mts <spec.json>`.
- Job search now: `npm -w kairos-local run sourcing-run`.
- The daily run is `scripts/daily.sh`; its log is `$KAIROS_HOME/logs/daily.log`.
