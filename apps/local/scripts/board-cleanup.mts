/**
 * Weekly board clean-up. Dry run by default; --apply performs the automatic,
 * reversible actions (archive stale Closed cards, dismiss stale or already
 * tracked Sourced cards, rebuild the board index). Decisions (stale drafts,
 * quiet interviews, long-silent applications) are only reported.
 * Usage: npm -w kairos-local run board-cleanup [-- --apply]
 * Rules: packages/engine/board-cleanup.ts (CLEANUP_RULES).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { rebuildApplicationsIndex, listApplicationFolders, type ApplicationMeta } from "@kairos/engine/applications";
import { planCleanup, CLEANUP_RULES, type SourcedEntry } from "@kairos/engine/board-cleanup";
import type { Store } from "@kairos/engine/store/types";

import { kairosHome } from "../../local/store/local-fs";
const HOME = kairosHome();
const APPS = join(HOME, "applications");
const SOURCING = join(HOME, "sourcing");
const APPLY = process.argv.includes("--apply");
const NOW = new Date();

const readJson = <T,>(p: string, fallback: T): T => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback);

const metas: ApplicationMeta[] = readdirSync(APPS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(APPS, d.name, "application-meta.json")))
  .map((d) => readJson<ApplicationMeta>(join(APPS, d.name, "application-meta.json"), null as never));
const backlog = readJson<SourcedEntry[]>(join(SOURCING, "backlog.json"), []);
const seen = readJson<Record<string, string>>(join(SOURCING, "seen.json"), {});

const plan = planCleanup(metas, backlog, new Set(Object.keys(seen)), NOW);
const R = CLEANUP_RULES;

console.log(`▸ Board clean-up ${APPLY ? "(applying)" : "(dry run; add --apply to act)"}\n`);
console.log(`Automatic:`);
console.log(`  archive ${plan.archive.length} Closed card(s) idle ${R.archiveClosedAfterDays}+ days`);
for (const a of plan.archive) console.log(`    · ${a.company} | ${a.role} (${a.status}, ${a.idleDays}d)`);
console.log(`  dismiss ${plan.dismissSourced.length} Sourced card(s)`);
for (const s of plan.dismissSourced) console.log(`    · ${s.company} | ${s.title} (${s.why})`);
console.log(`\nFor you to decide (nothing changed):`);
console.log(`  drafts unsent ${R.staleDraftDays}+ days: ${plan.decide.staleDrafts.length}`);
for (const d of plan.decide.staleDrafts) console.log(`    · ${d.company} | ${d.role} (${d.band ?? "unscored"}, ${d.days}d)`);
console.log(`  interviewing, no update ${R.quietInterviewDays}+ days: ${plan.decide.quietInterviewing.length}`);
for (const d of plan.decide.quietInterviewing) console.log(`    · ${d.company} | ${d.role} (${d.days}d)`);
console.log(`  applied, silent ${R.longAppliedDays}+ days: ${plan.decide.longApplied.length}`);
for (const d of plan.decide.longApplied) console.log(`    · ${d.company} | ${d.role} (${d.days}d)`);

if (APPLY) {
  const stamp = NOW.toISOString();
  for (const a of plan.archive) {
    const p = join(APPS, a.id, "application-meta.json");
    const m = readJson<ApplicationMeta>(p, null as never);
    writeFileSync(p, JSON.stringify({ ...m, archived: true }, null, 2));
  }
  if (plan.dismissSourced.length) {
    for (const s of plan.dismissSourced) seen[s.url] = stamp;
    writeFileSync(join(SOURCING, "seen.json"), JSON.stringify(seen, null, 2));
  }
  // Archive flags were written directly: rebuild the index so the board matches.
  const fsStore = {
    readJson: async <T,>(p: string[]) => readJson<T | null>(join(HOME, ...p), null),
    writeJson: async (p: string[], data: unknown) => {
      const f = join(HOME, ...p);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(data, null, 2));
      return f;
    },
    listFolders: async (p: string[]) =>
      readdirSync(join(HOME, ...p), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ name: d.name })),
  } as unknown as Store;
  await rebuildApplicationsIndex(fsStore, await listApplicationFolders(fsStore));
  console.log(`\n✓ applied: ${plan.archive.length} archived, ${plan.dismissSourced.length} sourced dismissed, index rebuilt.`);
}
