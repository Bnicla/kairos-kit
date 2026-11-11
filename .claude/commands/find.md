---
description: Run the job search now and show the new matches.
---

# /find: run the job search now

Follow the `kairos` skill (Workflow S for the search settings). Arguments: `$ARGUMENTS`

1. Call `get_search_profile`. If it is marked derived (not confirmed), say the
   search would run on guesses and offer `/setup --section goals` first. Continue
   if the student wants to.
2. Run the search from the kit folder, in the background (it takes a few
   minutes). Use the workspace that has the script:
   - `npm -w kairos-local run sourcing-run` when `apps/local/package.json` has a
     `sourcing-run` script;
   - otherwise `npm -w kairos-local run sourcing-run`.
   Then the dream-company check, the same way, with `dream-watch` (skip it when
   the search profile has no `dream_companies`).
3. When it finishes, report from its output: how many new jobs ("NEW since last
   run"), the shortlist with company, title, place and the one-line reason, and
   any dream-company hits. Note anything listed as "VANISHED" (a job that closed).
4. Point to the board (http://localhost:3000, Sourced column) and offer
   `/score <link>` for any job they want to look at.

If the output says triage was skipped or failed, say plainly that the list is
not ranked, and why (usually the long-lived token for scheduled runs is missing:
see docs/getting-started.md). Do not retry in a loop.
