/**
 * Fold the adopted run (last-run.json) into the persistent sourced backlog.
 *
 * The cloud sweep cannot do this itself: it has no applications folder and no
 * seen.json, so it cannot know what the user has already tracked or dismissed.
 * The Mac's daily wrapper pulls last-run.json from the sweep-results branch and
 * then runs this, so the board's Sourced column shows cloud results under the
 * same rules as a local sweep (re-gated, aged out, deduped).
 *
 *   npm -w kairos-local run backlog-merge
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeBacklogForProfile, type BacklogEntry } from "@kairos/engine/sourcing/backlog";
import type { StoredSearchProfile } from "@kairos/engine/sourcing/search-profile";
import type { RankedPosting } from "@kairos/engine/sourcing/types";
import { postingKey } from "@kairos/engine/sourcing/url-key";

import { kairosHome } from "../../local/store/local-fs";
const KAIROS = kairosHome();
const OUT_DIR = join(KAIROS, "sourcing");
const readJson = <T,>(name: string, fallback: T): T =>
  existsSync(join(OUT_DIR, name)) ? (JSON.parse(readFileSync(join(OUT_DIR, name), "utf8")) as T) : fallback;

const run = readJson<{ ran_at?: string; survivors?: RankedPosting[]; stretch?: RankedPosting[] } | null>("last-run.json", null);
if (!run?.ran_at) {
  console.log("backlog-merge: no last-run.json to merge");
  process.exit(0);
}
const profile = readJson<StoredSearchProfile | null>("search-profile.json", null);
if (!profile) {
  console.error("backlog-merge: no search-profile.json; refusing to merge without rules");
  process.exit(1);
}

// Actioned = dismissed (seen.json) or tracked (an application's source_url).
const actionedUrls = new Set(Object.keys(readJson<Record<string, unknown>>("seen.json", {})).map(postingKey));
const knownApplications: { company: string; role: string }[] = [];
const APPS = join(KAIROS, "applications");
if (existsSync(APPS)) {
  for (const folder of readdirSync(APPS, { withFileTypes: true })) {
    const metaPath = join(APPS, folder.name, "application-meta.json");
    if (!folder.isDirectory() || !existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { company?: string; role?: string; source_url?: string };
    if (meta.company && meta.role) knownApplications.push({ company: meta.company, role: meta.role });
    if (meta.source_url) actionedUrls.add(postingKey(meta.source_url));
  }
}

const previous = readJson<BacklogEntry[]>("backlog.json", []);
const backlog = mergeBacklogForProfile({
  previous,
  runSurvivors: run.survivors ?? [],
  runStretch: run.stretch ?? [],
  ranAt: run.ran_at,
  actionedUrls,
  profile,
  knownApplications,
});
const path = join(OUT_DIR, "backlog.json");
writeFileSync(`${path}.tmp`, JSON.stringify(backlog, null, 1));
renameSync(`${path}.tmp`, path);
const fresh = backlog.filter((b) => !b.carried).length;
console.log(`backlog-merge: ${previous.length} → ${backlog.length} cards (${fresh} from the run of ${run.ran_at.slice(0, 16)}, ${backlog.length - fresh} carried)`);
