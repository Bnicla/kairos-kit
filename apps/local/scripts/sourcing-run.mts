/**
 * Sourcing sweep, local lane: thin driver over the engine's runSourcingSweep.
 * ALL user-specific criteria come from ~/Kairos (search-profile.json, derived
 * from profile.md on first run) — nothing personal lives in this file.
 * Triage runs headless through the Claude Code CLI (Max-billed); if the CLI is
 * unavailable the deterministic top-N ships instead, marked untriaged.
 *
 *   npm -w kairos-local run sourcing-run
 *   npm -w kairos-local run sourcing-run -- --max-boards 800   (cap for quick runs)
 *   npm -w kairos-local run sourcing-run -- --deep             (weekly deep scan:
 *     no recency cap, age ranks instead of gating, priority shapes only;
 *     writes deep-scan.json and leaves last-run.json/backlog untouched)
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import matter from "gray-matter";
import { boardFromUrl, FILTER_GATES, runSourcingSweep, type FilterGate } from "@kairos/engine/sourcing/sweep";
import {
  deriveSearchProfile,
  type CandidateProfileFrontmatter,
  type StoredSearchProfile,
} from "@kairos/engine/sourcing/search-profile";
import { mergeBacklogForProfile, type BacklogEntry } from "@kairos/engine/sourcing/backlog";
import { updateSeenLedger, type SeenLedger } from "@kairos/engine/sourcing/seen-ledger";
import type { RegistryEntry } from "@kairos/engine/sourcing/types";
import { resolveRegistry } from "@kairos/engine/sourcing/registry-loader";
import { postingKey } from "@kairos/engine/sourcing/url-key";
import { kairosHome } from "../../local/store/local-fs";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, "../../../packages/engine/sourcing/registry.json");
const KAIROS = kairosHome();
const OUT_DIR = join(KAIROS, "sourcing");

const argIdx = process.argv.indexOf("--max-boards");
const MAX_BOARDS = argIdx > -1 ? parseInt(process.argv[argIdx + 1], 10) : undefined;
// Deep scan (weekly): no recency cap, age as a ranking penalty, priority
// shapes only. Its own output file so the daily board is never overwritten.
const DEEP = process.argv.includes("--deep");

// -- Search profile: stored file wins; first run derives from profile.md ------
mkdirSync(OUT_DIR, { recursive: true });
const profilePath = join(OUT_DIR, "search-profile.json");
let searchProfile: StoredSearchProfile;
if (existsSync(profilePath)) {
  searchProfile = JSON.parse(readFileSync(profilePath, "utf8"));
} else {
  const fm = existsSync(join(KAIROS, "profile.md"))
    ? (matter(readFileSync(join(KAIROS, "profile.md"), "utf8")).data as CandidateProfileFrontmatter)
    : {};
  searchProfile = deriveSearchProfile(fm);
  writeFileSync(profilePath, JSON.stringify(searchProfile, null, 2));
  console.log("▸ No search-profile.json yet — derived one from profile.md (edit via the preferences conversation).");
}

// -- Dedupe inputs + boards from the user's own applications ------------------
const APPS = join(KAIROS, "applications");
const knownApplications: { company: string; role: string }[] = [];
const seenUrls = new Set<string>(
  existsSync(join(OUT_DIR, "seen.json"))
    ? Object.keys(JSON.parse(readFileSync(join(OUT_DIR, "seen.json"), "utf8"))).map(postingKey)
    : [],
);
const extraBoards: RegistryEntry[] = [];
if (existsSync(APPS)) {
  for (const folder of readdirSync(APPS, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const metaPath = join(APPS, folder.name, "application-meta.json");
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      company?: string; role?: string; source_url?: string;
    };
    if (meta.company && meta.role) knownApplications.push({ company: meta.company, role: meta.role });
    if (meta.source_url) {
      seenUrls.add(postingKey(meta.source_url));
      const board = boardFromUrl(meta.source_url);
      if (board) extraBoards.push(board);
    }
  }
}

let profileSummary = "";
try {
  profileSummary = readFileSync(join(KAIROS, "profile.md"), "utf8").slice(0, 1500);
} catch {}
if (searchProfile.notes) profileSummary += `\n\nSourcing notes: ${searchProfile.notes}`;

const seed = JSON.parse(readFileSync(REGISTRY, "utf8"));
let dataCopy: unknown = null;
try { dataCopy = JSON.parse(readFileSync(join(OUT_DIR, "registry.json"), "utf8")); } catch {}
const resolved = resolveRegistry(dataCopy, seed);
if (resolved.source === "seed") console.log("▸ Registry: using committed seed (no harvested copy at ~/Kairos/sourcing/registry.json)");
if (resolved.staleness) console.error(`⚠️  ${resolved.staleness}`);
if (resolved.duplicates_removed) console.log(`▸ Registry: ${resolved.duplicates_removed} repeated boards skipped (same board, other spelling)`);
const registry = resolved.registry.entries;

console.log(
  DEEP
    ? `▸ DEEP SCAN: sweeping up to ${MAX_BOARDS ?? registry.length} boards · NO recency cap (age ranks) · priority shapes only`
    : `▸ Sweeping up to ${MAX_BOARDS ?? registry.length} boards · recency cap ${searchProfile.max_age_days}d`,
);
const liveUrls = new Set<string>();
const result = await runSourcingSweep({
  liveUrls,
  registry,
  extraBoards,
  profile: searchProfile,
  seenUrls,
  knownApplications,
  profileSummary,
  deepScan: DEEP,
  maxBoards: MAX_BOARDS,
  onLog: (m) => console.log(`\n  ${m}`),
  onProgress: (done, total, postings) =>
    process.stdout.write(`\r  ${done}/${total} boards · ${postings} postings`),
  // Called once per triage batch (sequentially): the first batch, then any
  // follow-up batches of priority shapes the first could not hold.
  triage: async (prompt) => {
    const claude = process.env.CLAUDE_CLI_PATH || "claude";
    console.log(`\n▸ Triage via ${claude === "claude" ? "claude CLI" : claude}`);
    // Self-sufficient auth: interactive keychain sessions expire, and only the
    // launchd path exported the headless token — so MANUAL runs shipped the
    // unranked fallback whenever the session was stale (observed 2026-09-09).
    // Read the token file here so every entry point authenticates the same way.
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      const tokenPath = join(homedir(), ".config", "kairos", "claude-oauth-token");
      if (existsSync(tokenPath)) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = readFileSync(tokenPath, "utf8").trim();
        console.log("  (headless token loaded from ~/.config/kairos/claude-oauth-token)");
      }
    }
    // Feed the prompt over STDIN, not argv: a large argv echoes the whole
    // prompt back inside error messages (burying the real stderr) and courts
    // arg-length limits as the candidate list grows. Retry once on failure —
    // a 20-minute sweep should not ship the unranked fallback because of one
    // transient CLI error (observed 2026-09-08).
    const run = async () => {
      // Triage only writes text, and its prompt is posting text: no tools, no MCP servers, no saved session.
      const child = execFileAsync(claude, ["-p", "--tools", "", "--strict-mcp-config", "--no-session-persistence"], { timeout: 8 * 60_000, maxBuffer: 10 * 1024 * 1024 });
      child.child.stdin?.write(prompt);
      child.child.stdin?.end();
      const { stdout } = await child;
      return stdout;
    };
    try {
      return await run();
    } catch (e) {
      const err = e as { stderr?: string; code?: number; message?: string };
      console.log(`\n  triage attempt 1 failed (exit ${err.code ?? "?"}): ${(err.stderr || err.message || "").slice(0, 300)} — retrying once`);
      return await run();
    }
  },
});

// Atomic writes: the board (and any concurrent reader) must never observe a
// half-written file. A mid-run read of last-run.json previously produced an
// unranked partial list that was mistaken for final results (2026-09-07).
const writeJsonAtomic = (name: string, data: unknown) => {
  const path = join(OUT_DIR, name);
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 1));
  renameSync(`${path}.tmp`, path);
};
// Persistent backlog (daily lane only): cards accumulate across runs until
// actioned or stale, so a role surfaced Wednesday still exists on the board
// Sunday. The deep scan's universe is different — it must not churn the board.
const actionedUrls = new Set([...seenUrls].map(postingKey));
let backlog: BacklogEntry[] | null = null;
if (!DEEP) {
  const backlogPath = join(OUT_DIR, "backlog.json");
  const previousBacklog: BacklogEntry[] = existsSync(backlogPath)
    ? JSON.parse(readFileSync(backlogPath, "utf8"))
    : [];
  backlog = mergeBacklogForProfile({
    previous: previousBacklog,
    runSurvivors: result.survivors,
    runStretch: result.stretch,
    ranAt: result.ran_at,
    actionedUrls,
    profile: searchProfile,
    knownApplications,
  });
}

// Seen-ledger (post-mortem 2026-09-27): permanent memory of every posting the
// sweep ever surfaced, with disposition and age at first sight — so "did the
// sweep ever see role X?" has an answer, new roles are reported as NEW, and a
// previously shortlisted role that disappears un-actioned triggers an alert
// instead of vanishing silently.
const ledgerPath = join(OUT_DIR, "sweep-seen.json");
const previousLedger: SeenLedger = existsSync(ledgerPath)
  ? JSON.parse(readFileSync(ledgerPath, "utf8"))
  : {};
const firstLedgerRun = Object.keys(previousLedger).length === 0;
const { ledger, newlySurfaced, vanishedShortlisted } = updateSeenLedger({
  previous: previousLedger,
  survivors: result.survivors,
  stretch: result.stretch,
  alsoQualified: result.also_qualified,
  dropped: result.dropped,
  ranAt: result.ran_at,
  lane: DEEP ? "deep" : "daily",
  actionedUrls,
  boardUrls: new Set((backlog ?? []).map((b) => postingKey(b.url))),
  liveUrls,
});
writeJsonAtomic("sweep-seen.json", ledger);

// The run file carries the ledger's headlines so the dashboard can render
// them next to the shortlist (daily → last-run.json; deep → deep-scan.json).
const alertShape = (e: { url: string; company: string; title: string; location: string; last_seen: string; disposition: string }) => ({
  url: e.url, company: e.company, title: e.title, location: e.location, last_seen: e.last_seen, disposition: e.disposition,
});
writeJsonAtomic(DEEP ? "deep-scan.json" : "last-run.json", {
  ...result,
  new_since_last_run: newlySurfaced.map(alertShape),
  vanished_shortlisted: vanishedShortlisted.map(alertShape),
});
if (backlog) {
  writeJsonAtomic("backlog.json", backlog);
  const carried = backlog.filter((b) => b.carried).length;
  if (carried > 0) console.log(`▸ Backlog: ${backlog.length} live cards (${carried} carried from earlier runs, un-actioned)`);
}

// Optional after-triage hook (search-profile.json `after_triage_hook`): a
// module whose default export receives the run result, for extra logging such
// as a second model scoring the same postings. It never changes the result; a
// failing hook is reported and skipped.
if (searchProfile.after_triage_hook && result.triaged) {
  const hook = searchProfile.after_triage_hook;
  const hookPath = isAbsolute(hook) ? hook : join(HERE, "../../..", hook);
  try {
    const mod = (await import(pathToFileURL(hookPath).href)) as {
      default: (ctx: { result: typeof result; deep: boolean; kairosHome: string; outDir: string }) => Promise<void> | void;
    };
    await mod.default({ result, deep: DEEP, kairosHome: KAIROS, outDir: OUT_DIR });
  } catch (e) {
    console.log(`▸ After-triage hook skipped (non-fatal): ${(e as Error).message?.slice(0, 200)}`);
  }
}

if (result.fetch_stats) {
  const s = result.fetch_stats;
  const hard = s.boards_failed + s.rate_limited;
  console.log(
    `▸ Fetch: ${s.boards_ok} ok · ${s.boards_gone} gone (registry decay) · ${s.boards_failed} failed · ${s.rate_limited} rate-limited` +
      (s.boards_partial ? ` · ${s.boards_partial} partial (a later Workday page failed)` : ""),
  );
  if (hard > 0 && hard / (s.boards_ok + s.boards_gone + hard) > 0.05) {
    console.error(`⚠️  FETCH DEGRADED — results may be incomplete. Failures by ATS: ${JSON.stringify(s.failures_by_ats)}`);
  }
}

// Per-gate losses (miss audit, 2026-11-05): where every fetched posting went,
// and how many priority shapes each gate removed.
if (result.filter_stats) {
  const f = result.filter_stats;
  const LABEL: Record<FilterGate, string> = {
    duplicate_url: "duplicate URL",
    duplicate_role: "same role, other URL",
    seen: "seen or dismissed",
    known_application: "already an application",
    no_function_term: "no function term",
    exclude_term: "exclude term",
    excluded_company: "excluded company",
    excluded_location: "excluded location",
    non_us: "outside the US",
    too_old: `older than ${searchProfile.max_age_days}d`,
    not_priority_shape: "not a priority shape",
    secondary_bar: "secondary-city bar",
    weak_stretch: "weak stretch",
    company_cap: "per-company cap",
    already_tracked: "already tracked (job id)",
    over_cap: "over triage cap",
    triage_cut: "triage SKIP",
    same_company: "one per company",
    below_cut: "below board cut",
  };
  const n = (x: number) => x.toLocaleString("en-US");
  const row = (label: string, count: number, priority: number) =>
    `  ${label.padEnd(24)}${n(count).padStart(9)}  ${n(priority).padStart(6)} priority`;
  console.log(`▸ Filter: ${n(f.input)} fetched → ${f.on_board.count} on board (${f.on_board.priority} priority). Removed per gate:`);
  for (const g of FILTER_GATES) console.log(row(LABEL[g], f.gates[g].removed, f.gates[g].priority));
  console.log(row("(stretch list, kept)", f.routed_to_stretch.count, f.routed_to_stretch.priority));
  const h = f.location_health;
  if (h.alarm) {
    console.error(
      `⚠️  LOCATION DATA: ${(h.share * 100).toFixed(1)}% of ${n(h.checked)} rankable postings have no usable location ` +
        `(${n(h.unresolved_multi)} "N Locations", ${n(h.empty)} empty; alarm above ${h.threshold * 100}%). ` +
        `Check the Workday detail calls and the adapters' location fields.`,
    );
  } else {
    console.log(`  location data: ${(h.share * 100).toFixed(1)}% unknown of ${n(h.checked)} rankable (${h.unresolved_multi} "N Locations", ${h.empty} empty)`);
  }
}

if (result.triage_batches) {
  const b = result.triage_batches;
  console.log(`▸ Triage: ${b.postings} postings in ${b.batches} batch${b.batches === 1 ? "" : "es"}${b.failed ? ` (${b.failed} follow-up batch(es) failed; their priority postings are listed below as ALSO QUALIFIED)` : ""}`);
}

if (result.triage_guard) {
  const g = result.triage_guard;
  console.log(`▸ Triage guard: ${g.flagged_fields} field(s) replaced for instruction-like text · ${g.dropped_urls} posting(s) left out for unsafe URLs`);
}

if (result.triage_error) {
  const authExpired = /auth|oauth|expired|authenticate/i.test(result.triage_error);
  console.error(
    `\n⚠️  TRIAGE FAILED: ${result.triage_error}\n` +
      `   The list below is the UNRANKED deterministic fallback — it buries your\n` +
      `   priority roles (Chief of Staff, Group PM) instead of ranking them.\n` +
      (authExpired
        ? `   FIX: the Claude CLI login expired. Mint a long-lived headless token:\n` +
          `        claude setup-token\n` +
          `   Then re-run:  npm -w kairos-local run sourcing-run\n`
        : `   Check the triage model call and re-run.\n`),
  );
}

console.log(
  `\n▸ Shortlist${result.triaged ? "" : " (UNTRIAGED fallback)"}: ${result.survivors.length} matches + ${result.stretch.length} stretch (from ${result.postings_fetched} postings)`,
);
for (const p of result.survivors) {
  console.log(
    `  [${p.guess_band ?? "?"}|${p.age_days === null ? "?" : p.age_days + "d"}] ${p.company} — ${p.title} (${p.location || "n/a"})${p.one_liner ? ` · ${p.one_liner}` : ""}`,
  );
}
console.log("\nStretch (location mismatch, otherwise strong):");
for (const p of result.stretch) {
  console.log(
    `  [${p.guess_band ?? "?"}|${p.age_days === null ? "?" : p.age_days + "d"}] ${p.company} — ${p.title} (${p.location || "n/a"})${p.one_liner ? ` · ${p.one_liner}` : ""}`,
  );
}

// Priority shapes the triage cap squeezed out unreviewed — LOUD, per the
// Post-mortem: hundreds of silent over_cap drops in one sweep.
if (result.also_qualified?.length) {
  console.log(`\n⚠️  ALSO QUALIFIED (capped, never reviewed by triage): ${result.also_qualified.length} priority-shape roles`);
  for (const p of result.also_qualified) {
    console.log(`  [${p.age_days === null ? "?" : p.age_days + "d"}] ${p.company} — ${p.title} (${p.location || "n/a"})`);
  }
}

if (firstLedgerRun) {
  console.log(`\n▸ Seen-ledger: first run — baseline recorded (${Object.keys(ledger).length} postings); future runs report only NEW roles.`);
} else if (newlySurfaced.length) {
  console.log(`\n★ NEW since last run (never surfaced before): ${newlySurfaced.length}`);
  for (const e of newlySurfaced) {
    console.log(`  [${e.disposition}${e.age_at_first_sight === null ? "" : `|${e.age_at_first_sight}d old at first sight`}] ${e.company} — ${e.title}\n    ${e.url}`);
  }
} else {
  console.log("\n▸ Seen-ledger: no never-before-seen roles this run.");
}

if (vanishedShortlisted.length) {
  console.log(`\n🚨 VANISHED: ${vanishedShortlisted.length} previously SHORTLISTED role(s) are no longer listed on their job boards — closed. If still wanted, act now:`);
  for (const e of vanishedShortlisted) {
    console.log(`  ${e.company} — ${e.title} (last seen ${e.last_seen.slice(0, 10)})\n    ${e.url}`);
  }
}

console.log(
  DEEP
    ? "\n✓ sourcing/deep-scan.json written; the All-sourced page shows it as the deep-scan section."
    : "\n✓ sourcing/last-run.json written; Sourced column reads it.",
);
