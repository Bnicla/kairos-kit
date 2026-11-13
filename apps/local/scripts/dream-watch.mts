/**
 * Dream-company watcher: direct career-API monitoring for the companies the
 * user lists in sourcing/search-profile.json `dream_companies`, INCLUDING the
 * ones the board sweep cannot see (proprietary career sites). Fetchers live in
 * packages/engine/sourcing/dream-watch.ts; entries with ats "browser" (sites
 * that block direct calls) are printed as a reminder to check in a browser.
 *
 * Hits each company's own JSON endpoint, filters titles through the same
 * function gate as the sweep, diffs against sourcing/dream-seen.json, and
 * writes sourcing/dream-watch.json (read by humans and by the daily log).
 * A source that fails is reported loudly, never silently skipped.
 *
 *   npm -w kairos-local run dream-watch
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { passesFunctionGate } from "@kairos/engine/sourcing/filter";
import { planDreamWatch, fetchDreamCompany, type DreamJob } from "@kairos/engine/sourcing/dream-watch";
import type { SearchProfile } from "@kairos/engine/sourcing/types";
import { kairosHome } from "../../local/store/local-fs";

const OUT_DIR = join(kairosHome(), "sourcing");
mkdirSync(OUT_DIR, { recursive: true });
const profilePath = join(OUT_DIR, "search-profile.json");
if (!existsSync(profilePath)) {
  console.log("▸ Dream watch: no sourcing/search-profile.json yet (run the sweep or the preferences conversation first). Nothing to watch.");
  process.exit(0);
}
const profile: SearchProfile = JSON.parse(readFileSync(profilePath, "utf8"));
const plan = planDreamWatch(profile);
for (const bad of plan.invalid) console.error(`  ! dream_companies: ${bad}`);
if (!plan.fetchable.length && !plan.browser.length) {
  console.log("▸ Dream watch: no dream_companies in the search profile. Add some to have their career sites checked daily.");
  process.exit(0);
}
// The function gate below keeps only titles with one of the profile's function
// terms. With none, every posting would be dropped without a word.
if (!(profile.function_terms ?? []).some((t) => t.trim())) {
  console.error("▸ Dream watch: the search profile names no target role (function_terms is empty), so no posting can match. Add the roles you are looking for, then run it again.");
  process.exit(0);
}
const SOURCES:[string, () => Promise<DreamJob[]>][] = plan.fetchable.map((c) => [c.name, () => fetchDreamCompany(c, profile)]);

// --- Run ----------------------------------------------------------------------
const seenPath = join(OUT_DIR, "dream-seen.json");
const seen: Record<string, string> = existsSync(seenPath)
  ? JSON.parse(readFileSync(seenPath, "utf8"))
  : {};
const firstRun = Object.keys(seen).length === 0;

const all: DreamJob[] = [];
const failures: string[] = [];
for (const [name, fn] of SOURCES) {
  try {
    const jobs = (await fn()).filter((j) => passesFunctionGate(j.title, profile));
    console.log(`  ${name}: ${jobs.length} relevant postings`);
    all.push(...jobs);
  } catch (e) {
    const msg = `${name}: FAILED (${e instanceof Error ? e.message : e})`;
    failures.push(msg);
    console.error(`  ! ${msg}`);
  }
}

const fresh = all.filter((j) => !seen[j.url]);
const now = new Date().toISOString();
for (const j of all) if (!seen[j.url]) seen[j.url] = now;
writeFileSync(seenPath, JSON.stringify(seen, null, 1));
const dwPath = join(OUT_DIR, "dream-watch.json");
writeFileSync(dwPath + ".tmp", JSON.stringify(
  { ran_at: now, first_run: firstRun, sources_failed: failures, total: all.length, new: fresh },
  null, 1,
));
renameSync(dwPath + ".tmp", dwPath);

console.log(`\n▸ Dream watch: ${all.length} relevant roles across ${SOURCES.length - failures.length}/${SOURCES.length} sources`);
if (failures.length) console.log(`  ⚠ failed sources: ${failures.join(" | ")}`);
if (firstRun) {
  console.log(`  (first run: baseline recorded, ${all.length} roles marked seen; future runs report only NEW postings)`);
} else if (fresh.length) {
  console.log(`\n★ NEW since last run:`);
  for (const j of fresh) console.log(`  ${j.company} — ${j.title} (${j.location.slice(0, 60)})\n    ${j.url}`);
} else {
  console.log("  no new postings since last run");
}
for (const c of plan.browser) {
  console.log(`\n▸ ${c.name}: check in a browser${c.url ? ` at ${c.url}` : ""}${c.script ? `, running ${c.script} as page JavaScript there` : ""} (its feed blocks direct calls).`);
}
