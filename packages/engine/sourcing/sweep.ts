/**
 * The sourcing sweep pipeline, lane-agnostic: boards → parallel fetch →
 * prefilter (dedupe vs applications + seen) → triage (injected model call) →
 * shortlist. The local script drives it with the Claude CLI (Max-billed);
 * the cloud route drives it with the student's API key. NO user-specific
 * criteria live here — the SearchProfile is data, loaded per user.
 */

import {
  fetchBoardDetailed,
  isLocationCountPlaceholder,
  WORKDAY_MAX_PAGES,
  WORKDAY_MAX_PAGES_DEEP,
  type FetchFailureKind,
  type FetchOptions,
} from "./adapters";
import {
  isPriorityShape,
  passesFunctionGate,
  prefilterAndRank,
  PREFILTER_GATES,
  type GateCount,
  type PrefilterGate,
  type ShapeCount,
} from "./filter";
import { registryKey } from "./registry-loader";
import { postingKey } from "./url-key";
import { allTriageRules, feedSearchTerms } from "./search-profile";
import {
  applyTriage,
  buildTriagePrompt,
  parseTriageResponse,
  type TriageGuardStats,
  type TriageVerdict,
} from "./triage";
import type { Posting, RankedPosting, RegistryEntry, SearchProfile } from "./types";

export interface SweepInput {
  registry: RegistryEntry[];
  /** Boards derived from the user's own applications — always swept first. */
  extraBoards?: RegistryEntry[];
  profile: SearchProfile;
  /** URLs to drop: previously seen/dismissed + already-tracked applications. */
  seenUrls: Set<string>;
  knownApplications: { company: string; role: string }[];
  /** Candidate summary for the triage prompt (top of profile.md). */
  profileSummary: string;
  /** Lane-specific model call: takes the triage prompt, returns raw text. Omit → deterministic top-N. */
  triage?: (prompt: string) => Promise<string>;
  /**
   * Deep-scan lane (weekly): NO recency cap — posting age becomes a ranking
   * penalty — restricted to priority shapes so triage volume stays sane.
   * Closes the miss class where an excellent posting open for six weeks was
   * permanently invisible to the capped daily sweep (2026-09-27).
   */
  deepScan?: boolean;
  /**
   * Filled with the canonical URL (no query string) of every posting fetched
   * this run, before any filtering. Lets the seen-ledger tell a role that
   * closed from one that only aged out of the recency window or was filtered.
   */
  liveUrls?: Set<string>;
  maxBoards?: number;
  /**
   * Most postings sent to triage in one run, over all batches (default
   * TRIAGE_TOTAL_CAP). The first batch is the best-ranked matches and stretch;
   * later batches carry only the priority shapes the first batch could not
   * hold. Each batch is one triage call, run one after another.
   */
  triageTotalCap?: number;
  concurrency?: number;
  /**
   * Per-ATS worker caps. Boards of one ATS mostly resolve to ONE shared host
   * (every Greenhouse board is boards-api.greenhouse.io), so global concurrency
   * alone hammers that host and earns 429s. Defaults are conservative for the
   * shared hosts; Workday is per-tenant (each its own host) so it runs wider.
   */
  perAtsConcurrency?: Partial<Record<RegistryEntry["ats"], number>>;
  onProgress?: (done: number, total: number, postings: number) => void;
  /** Diagnostics channel (e.g. why triage fell back). Silent-swallow is worse. */
  onLog?: (message: string) => void;
  now?: () => string;
}

/**
 * Gates after the prefilter, in order: a Greenhouse job already tracked under
 * its other host, then the triage squeeze (the drop_reason values).
 */
export const SWEEP_GATES = ["already_tracked", "over_cap", "triage_cut", "same_company", "below_cut"] as const;
export type SweepGate = (typeof SWEEP_GATES)[number];
export type FilterGate = PrefilterGate | SweepGate;
/** Every gate a fetched posting can be removed at, in pipeline order. */
export const FILTER_GATES: readonly FilterGate[] = [...PREFILTER_GATES, ...SWEEP_GATES];

/**
 * Above this share of unknown locations among the postings that matter, the
 * location data itself is suspect (a Workday detail format change, an ATS
 * renaming its location field) and the run says so. Measured 2026-11-05: 1.3%
 * with the Workday detail calls working (1 "N Locations" + 37 empty of 2,833),
 * about 13% without them (323 "N Locations").
 */
export const LOCATION_ALARM_SHARE = 0.05;

/** First triage batch: the best-ranked matches and stretch postings (unchanged since 2026-09). */
export const TRIAGE_FIRST_MATCHES = 120;
export const TRIAGE_FIRST_STRETCH = 40;
/** Follow-up batches (priority shapes only): postings per triage call. */
export const TRIAGE_BATCH = 160;
/**
 * Most postings triaged per run, all batches together: 160 + three follow-up
 * batches of 160 at most, so four calls to the model in the worst case. The
 * dry run of 2026-11-05 had 203 over-cap priority shapes (two follow-up calls).
 */
export const TRIAGE_TOTAL_CAP = 640;

export interface FilterStats {
  /** Postings fetched (the prefilter's input). */
  input: number;
  /** Removed at each gate, in FILTER_GATES order; `priority` = priority-shape titles among them. */
  gates: Record<FilterGate, GateCount>;
  /** Kept, but on the stretch list: a location mismatch, fewer triage and board slots. */
  routed_to_stretch: ShapeCount;
  /** Final board: matches + stretch. */
  on_board: ShapeCount;
  /**
   * Location data health over the postings the sweep would rank: function
   * gate passed, inside the recency window (deep lane: priority shapes).
   * `unresolved_multi` still read "N Locations" after the Workday detail
   * calls; `empty` had no location at all.
   */
  location_health: {
    checked: number;
    unresolved_multi: number;
    empty: number;
    share: number;
    threshold: number;
    alarm: boolean;
  };
}

export interface SweepResultFile {
  version: 1;
  /** Which lane produced this file; absent on pre-deep-scan files = daily. */
  mode?: "daily" | "deep";
  ran_at: string;
  boards_swept: number;
  postings_fetched: number;
  prefilter_matches: number;
  prefilter_stretch: number;
  triaged: boolean;
  /**
   * When triage was requested but failed, the reason (e.g. expired CLI auth).
   * Null on a clean run. Lets the Sourced page warn that the list is the
   * UNRANKED deterministic fallback instead of silently degrading — the
   * fallback buries priority roles the model would have surfaced.
   * null/absent = triage ran (or was never requested).
   */
  triage_error?: string | null;
  /**
   * What the triage field guard removed: title/company/location fields replaced
   * for instruction-shaped text, and postings left out for unsafe URLs. Absent
   * when triage did not run.
   */
  triage_guard?: TriageGuardStats | null;
  /**
   * Triage calls made: `batches` calls over `postings` postings; `failed`
   * batches after the first returned nothing usable (their postings count as
   * over_cap). Absent when triage did not run.
   */
  triage_batches?: { batches: number; failed: number; postings: number } | null;
  /**
   * Board fetch accounting (REQ-6): a throttled or failing sweep must be
   * distinguishable from a quiet market. "gone" = 404/410 registry decay
   * (normal); "failed" = timeouts, network, 5xx, parse; "rate_limited" = 429s
   * that survived the retry. The UI warns when failed+rate_limited is material.
   * `boards_partial` (counted inside boards_ok) = boards whose first page came
   * back but a later list page failed (Workday paging); their postings are the
   * pages read before the failure.
   */
  fetch_stats?: {
    boards_ok: number;
    boards_gone: number;
    boards_failed: number;
    rate_limited: number;
    failures_by_ats: Record<string, number>;
    boards_partial?: number;
  };
  /**
   * Where the fetched postings went: how many each gate removed (and how many
   * of those were priority shapes), plus a location-data health check. A loss
   * class that grows shows up here before anyone notices a missing role
   * (miss audit, 2026-11-05). Absent on files written before it existed.
   */
  filter_stats?: FilterStats;
  profile: SearchProfile;
  survivors: RankedPosting[];
  stretch: RankedPosting[];
  /**
   * Priority shapes (head-of/director/principal/… titles on postings that
   * cleared the function gate) that the triage input cap cut before ANY
   * review. These must be LOUD, never silent members of `dropped`: one sweep
   * dropped hundreds of roles as over_cap, priority shapes among them, and
   * nothing surfaced it. Best-ranked first.
   */
  also_qualified?: RankedPosting[];
  /**
   * Roles that cleared the mechanical prefilter (function/location/recency) but
   * did NOT reach the final board — cut by the triage input cap, the triage
   * verdict, the one-per-company rule, or the final size cap. Surfaced on the
   * "view all sourced" page so a human can rescue a good role the squeeze
   * dropped. Each carries a `drop_reason`. Ranked best-first, bounded.
   */
  dropped: RankedPosting[];
}

/** Board registry entry from a job-ad URL, for the ATSes with public feeds. */
export function boardFromUrl(url: string | undefined): RegistryEntry | null {
  if (!url) return null;
  let m = url.match(/greenhouse\.io\/([A-Za-z0-9_-]+)\/jobs\/\d+/);
  if (m) return { ats: "greenhouse", slug: m[1].toLowerCase() };
  m = url.match(/jobs\.ashbyhq\.com\/([^/]+)\//);
  if (m) return { ats: "ashby", slug: m[1] };
  m = url.match(/jobs\.lever\.co\/([^/]+)\//);
  if (m) return { ats: "lever", slug: m[1] };
  m = url.match(/ats\.rippling\.com\/([^/]+)\/jobs\//);
  if (m) return { ats: "rippling", slug: m[1] };
  // SR company identifiers are case-insensitive in the API; keep URL case as-is.
  m = url.match(/jobs\.smartrecruiters\.com\/([A-Za-z0-9]+)\/\d/);
  if (m) return { ats: "smartrecruiters", slug: m[1] };
  m = url.match(/^https?:\/\/([a-z0-9-]+)\.bamboohr\.com\/careers/i);
  if (m && m[1].toLowerCase() !== "www") return { ats: "bamboohr", slug: m[1].toLowerCase() };
  return null;
}

const ghId = (u: string): string | null =>
  u.match(/gh_jid=(\d{6,})/)?.[1] ?? u.match(/greenhouse\.io\/[^/]+\/jobs\/(\d{6,})/)?.[1] ?? null;

/**
 * Postings the board could plausibly show: function gate passed, inside the
 * recency window (deep lane: priority shapes, any age). The adapters spend
 * extra detail calls (Workday "N Locations") only on these, and the location
 * health check counts only these.
 */
export function rankable(profile: SearchProfile, deepScan = false): (p: Posting) => boolean {
  return (p) =>
    passesFunctionGate(p.title, profile) &&
    (deepScan ? isPriorityShape(p.title, profile) : p.age_days === null || p.age_days <= profile.max_age_days);
}

/**
 * What the adapters need from the sweep, per lane: which postings deserve a
 * detail call, what to search a search-only site for, and how deep to page a
 * Workday list. Daily: stop once a newest-first list is past the recency
 * window, at most WORKDAY_MAX_PAGES pages. Deep: no recency stop, at most
 * WORKDAY_MAX_PAGES_DEEP pages. The search words and the titles worth a date
 * call come from the profile (its search or function terms, its function
 * gate). Shared with the miss audit so it sees what the sweep sees.
 */
export function sweepFetchOptions(profile: SearchProfile, deepScan = false): FetchOptions {
  return {
    resolveLocationFor: rankable(profile, deepScan),
    maxAgeDays: deepScan ? undefined : profile.max_age_days,
    workdayMaxPages: deepScan ? WORKDAY_MAX_PAGES_DEEP : WORKDAY_MAX_PAGES,
    searchTerms: feedSearchTerms(profile).terms,
    dateWorthy: (title) => passesFunctionGate(title, profile),
  };
}

/**
 * What the profile cannot find as written, in plain lines for the run log:
 * no function terms (nothing passes the function gate), and search words the
 * cap left out of the search-only sites.
 */
export function searchProfileWarnings(profile: SearchProfile): string[] {
  const out: string[] = [];
  if (!(profile.function_terms ?? []).some((t) => t.trim())) {
    out.push(
      "the search profile names no target role (function_terms is empty): no posting can pass the function gate, so this run finds nothing. Add the roles you are looking for to the search profile.",
    );
  }
  const { terms, left_out } = feedSearchTerms(profile);
  if (left_out.length) {
    out.push(
      `search-only job sites (Workday) are searched for ${terms.map((t) => `"${t}"`).join(", ")} only; not searched: ${left_out.map((t) => `"${t}"`).join(", ")}. Set search_terms in the search profile to choose the words.`,
    );
  }
  return out;
}

export type FetchStats = NonNullable<SweepResultFile["fetch_stats"]>;

export interface FetchBoardsInput {
  boards: RegistryEntry[];
  concurrency?: number;
  perAtsConcurrency?: SweepInput["perAtsConcurrency"];
  fetchOptions?: FetchOptions;
  onProgress?: (done: number, total: number, postings: number) => void;
}

/**
 * Fetch every board with the sweep's per-ATS worker caps and typed failure
 * accounting. Shared by the sweep and the miss audit, so the audit sees what
 * the sweep sees.
 */
export async function fetchBoards(input: FetchBoardsInput): Promise<{ postings: Posting[]; stats: FetchStats }> {
  const concurrency = input.concurrency ?? 24;
  const all: Posting[] = [];
  let done = 0;
  const stats: FetchStats = {
    boards_ok: 0,
    boards_gone: 0,
    boards_failed: 0,
    rate_limited: 0,
    failures_by_ats: {},
    boards_partial: 0,
  };
  const account = (ats: string, failure?: { kind: FetchFailureKind }, partial?: unknown) => {
    if (partial) stats.boards_partial!++;
    if (!failure) stats.boards_ok++;
    else if (failure.kind === "gone") stats.boards_gone++;
    else {
      if (failure.kind === "rate_limited") stats.rate_limited++;
      else stats.boards_failed++;
      stats.failures_by_ats[ats] = (stats.failures_by_ats[ats] ?? 0) + 1;
    }
  };

  // One queue per ATS, each with its own worker cap (shared hosts stay gentle),
  // all running concurrently up to the global budget.
  const PER_ATS_DEFAULT: Record<string, number> = {
    greenhouse: 6,
    lever: 6,
    ashby: 6,
    rippling: 4,
    workday: 12,
    smartrecruiters: 6, // api.smartrecruiters.com is one shared host, like Greenhouse
    bamboohr: 6, // one subdomain per company, but all on BambooHR's shared edge
  };
  const byAts = new Map<string, RegistryEntry[]>();
  for (const b of input.boards) {
    (byAts.get(b.ats) ?? byAts.set(b.ats, []).get(b.ats)!).push(b);
  }
  await Promise.all(
    [...byAts.entries()].flatMap(([ats, queue]) => {
      const workers = Math.min(
        input.perAtsConcurrency?.[ats as RegistryEntry["ats"]] ?? PER_ATS_DEFAULT[ats] ?? 4,
        concurrency,
      );
      return Array.from({ length: workers }, async () => {
        for (;;) {
          const entry = queue.shift();
          if (!entry) return;
          const { postings, failure, partial } = await fetchBoardDetailed(entry, undefined, input.fetchOptions);
          all.push(...postings);
          account(ats, failure, partial);
          done++;
          if (done % 100 === 0) input.onProgress?.(done, input.boards.length, all.length);
        }
      });
    }),
  );
  input.onProgress?.(done, input.boards.length, all.length);
  return { postings: all, stats };
}

export async function runSourcingSweep(input: SweepInput): Promise<SweepResultFile> {
  const concurrency = input.concurrency ?? 24;
  // One board per registryKey, first spelling kept: a Workday site listed as
  // "External" and "external" is one board (fetched twice before 2026-11-05).
  const dedup = new Map<string, RegistryEntry>();
  for (const e of [...(input.extraBoards ?? []), ...input.registry]) {
    const key = registryKey(e);
    if (!dedup.has(key)) dedup.set(key, e);
  }
  const boards = [...dedup.values()].slice(
    0,
    input.maxBoards === undefined ? undefined : input.maxBoards + (input.extraBoards?.length ?? 0),
  );

  for (const warning of searchProfileWarnings(input.profile)) input.onLog?.(warning);
  const fetchOptions = sweepFetchOptions(input.profile, input.deepScan);
  const worthLocation = fetchOptions.resolveLocationFor!;
  const { postings: all, stats } = await fetchBoards({
    boards,
    concurrency,
    perAtsConcurrency: input.perAtsConcurrency,
    fetchOptions,
    onProgress: input.onProgress,
  });
  for (const p of all) input.liveUrls?.add(postingKey(p.url));

  const hardFailures = stats.boards_failed + stats.rate_limited;
  if (boards.length > 0 && hardFailures / boards.length > 0.05) {
    input.onLog?.(
      `fetch degraded: ${hardFailures}/${boards.length} boards failed (${stats.rate_limited} rate-limited) — results may be incomplete. By ATS: ${JSON.stringify(stats.failures_by_ats)}`,
    );
  }

  // Greenhouse jobs surface under two hosts (job-boards.greenhouse.io and the
  // company careers page with ?gh_jid=) — dedupe tracked jobs by job id too.
  const knownGhIds = new Set<string>();
  for (const u of input.seenUrls) {
    const id = ghId(u);
    if (id) knownGhIds.add(id);
  }
  const notTracked = (p: Posting) => {
    const id = ghId(p.url);
    return !id || !knownGhIds.has(id);
  };

  const pre = prefilterAndRank(all, input.profile, input.seenUrls, input.knownApplications, {
    deepScan: input.deepScan,
  });
  const survivors = pre.survivors.filter(notTracked);
  const stretch = pre.stretch.filter(notTracked);

  const gates = {
    ...pre.stats.gates,
    ...Object.fromEntries(SWEEP_GATES.map((g) => [g, { removed: 0, priority: 0 }])),
  } as Record<FilterGate, GateCount>;
  const priority = (p: Posting) => (isPriorityShape(p.title, input.profile) ? 1 : 0);
  const drop = (gate: FilterGate, p: Posting) => {
    gates[gate].removed++;
    gates[gate].priority += priority(p);
  };
  for (const p of [...pre.survivors, ...pre.stretch]) if (!notTracked(p)) drop("already_tracked", p);

  // Triage batches. The first holds the best-ranked matches and stretch, as
  // before. A priority shape ranked below them used to be cut unreviewed as
  // over_cap (dry run 2026-11-05: 203 of 453); now follow-up batches carry
  // every such posting, best-ranked first, until the run total reaches the cap.
  // Non-priority postings past the first batch stay over_cap.
  const totalCap = Math.max(TRIAGE_FIRST_MATCHES + TRIAGE_FIRST_STRETCH, input.triageTotalCap ?? TRIAGE_TOTAL_CAP);
  const firstBatch = [...survivors.slice(0, TRIAGE_FIRST_MATCHES), ...stretch.slice(0, TRIAGE_FIRST_STRETCH)];
  const overflowPriority = [...survivors.slice(TRIAGE_FIRST_MATCHES), ...stretch.slice(TRIAGE_FIRST_STRETCH)]
    .filter((p) => isPriorityShape(p.title, input.profile))
    .slice(0, totalCap - firstBatch.length);
  const batches = [firstBatch];
  for (let i = 0; i < overflowPriority.length; i += TRIAGE_BATCH) batches.push(overflowPriority.slice(i, i + TRIAGE_BATCH));

  let verdicts = new Map<string, TriageVerdict>();
  let triageError: string | null = null;
  let triageGuard: TriageGuardStats | null = null;
  let triageBatches: SweepResultFile["triage_batches"] = null;
  const reviewed = new Set<string>(); // reached a triage call that answered
  if (input.triage && firstBatch.length > 0) {
    const guardStats: TriageGuardStats = { flagged_fields: 0, dropped_urls: 0 };
    triageGuard = guardStats;
    triageBatches = { batches: 0, failed: 0, postings: 0 };
    const rules = allTriageRules(input.profile);
    for (const [i, batch] of batches.entries()) {
      try {
        const batchGuard: TriageGuardStats = { flagged_fields: 0, dropped_urls: 0 };
        const prompt = buildTriagePrompt(batch, input.profileSummary, rules, batchGuard);
        guardStats.flagged_fields += batchGuard.flagged_fields;
        guardStats.dropped_urls += batchGuard.dropped_urls;
        triageBatches.batches++;
        triageBatches.postings += batch.length;
        const raw = await input.triage(prompt);
        const got = parseTriageResponse(raw, new Set(batch.map((c) => c.url)));
        if (got.size === 0) {
          if (i === 0) {
            triageError = "triage returned no parseable verdicts";
            input.onLog?.(`${triageError}; shipping deterministic top-N`);
            break;
          }
          triageBatches.failed++;
          input.onLog?.(`triage batch ${i + 1}/${batches.length} returned no parseable verdicts; its ${batch.length} priority postings stay unreviewed`);
          continue;
        }
        for (const [url, v] of got) verdicts.set(url, v);
        for (const c of batch) reviewed.add(c.url);
      } catch (err) {
        const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
        if (i === 0) {
          // Deterministic top-N ships, marked untriaged — but say WHY, and record it
          // so the failure surfaces to the user instead of silently degrading.
          triageError = msg;
          input.onLog?.(`triage unavailable (${triageError}); shipping deterministic top-N`);
          break;
        }
        triageBatches.failed++;
        input.onLog?.(`triage batch ${i + 1}/${batches.length} failed (${msg}); its ${batch.length} priority postings stay unreviewed`);
      }
    }
    if (guardStats.flagged_fields || guardStats.dropped_urls) {
      input.onLog?.(
        `triage guard: ${guardStats.flagged_fields} field(s) replaced for instruction-like text, ${guardStats.dropped_urls} posting(s) left out for unsafe URLs`,
      );
    }
  }
  // Untriaged run (no model, or the first call failed): the deterministic
  // top-N ships from the first batch, which counts as reviewed, as before.
  if (verdicts.size === 0) for (const c of firstBatch) reviewed.add(c.url);

  const finalMatches = applyTriage(survivors, verdicts, 25);
  const finalStretch = applyTriage(stretch, verdicts, 10);

  // "View all sourced": every prefilter survivor that did NOT make the final
  // board, tagged with why it was cut. These already cleared the mechanical
  // gates, so each is a plausible role a human might want to rescue.
  // Record EVERY cut with its reason (was 300, which truncated the audit
  // trail: 'did the sweep see role X?' became unanswerable for ~80 postings
  // per run). Full transparency costs a few hundred KB at most.
  const DROPPED_CAP = 2000;
  const onBoard = new Set([...finalMatches.list, ...finalStretch.list].map((p) => p.url));
  const dropReason = (p: RankedPosting): RankedPosting["drop_reason"] => {
    if (!reviewed.has(p.url)) return "over_cap";
    const v = verdicts.get(p.url);
    if (v && v.verdict !== "SHORTLIST") return "triage_cut";
    // Shortlisted (or triage unavailable) but still not on the board: the
    // one-per-company rule took the slot, else it fell below the size cap.
    const onBoardCompanies = new Set([...finalMatches.list, ...finalStretch.list].map((x) => x.company.toLowerCase()));
    return onBoardCompanies.has(p.company.toLowerCase()) ? "same_company" : "below_cut";
  };
  const allDropped: RankedPosting[] = [...survivors, ...stretch]
    .filter((p) => !onBoard.has(p.url))
    .map((p) => {
      const v = verdicts.get(p.url);
      return { ...p, drop_reason: dropReason(p), guess_band: v?.guess_band, one_liner: v?.one_liner };
    })
    .sort((a, b) => b.rank_score - a.rank_score);
  for (const p of allDropped) drop(p.drop_reason!, p);
  const dropped = allDropped.slice(0, DROPPED_CAP);

  const count = (list: Posting[]): ShapeCount => ({ count: list.length, priority: list.reduce((n, p) => n + priority(p), 0) });

  const health = { checked: 0, unresolved_multi: 0, empty: 0 };
  for (const p of all) {
    if (!worthLocation(p)) continue;
    health.checked++;
    if (isLocationCountPlaceholder(p.location)) health.unresolved_multi++;
    else if (!p.location.trim()) health.empty++;
  }
  const share = health.checked ? (health.unresolved_multi + health.empty) / health.checked : 0;
  const filterStats: FilterStats = {
    input: all.length,
    gates,
    routed_to_stretch: count(stretch),
    on_board: count([...finalMatches.list, ...finalStretch.list]),
    location_health: {
      ...health,
      share: Math.round(share * 1000) / 1000,
      threshold: LOCATION_ALARM_SHARE,
      alarm: share > LOCATION_ALARM_SHARE,
    },
  };

  // OVER_CAP must be LOUD for priority shapes: a head-of/director/principal
  // title the cap squeezed out was never even reviewed, and burying it in the
  // dropped array hid exactly the roles the profile hunts (hundreds of silent
  // drops in one sweep). Split them into their own list.
  const ALSO_QUALIFIED_CAP = 75;
  const alsoQualified = dropped
    .filter((p) => p.drop_reason === "over_cap" && isPriorityShape(p.title, input.profile))
    .slice(0, ALSO_QUALIFIED_CAP);
  const alsoQualifiedUrls = new Set(alsoQualified.map((p) => p.url));

  return {
    version: 1,
    mode: input.deepScan ? "deep" : "daily",
    ran_at: (input.now ?? (() => new Date().toISOString()))(),
    boards_swept: boards.length,
    postings_fetched: all.length,
    prefilter_matches: survivors.length,
    prefilter_stretch: stretch.length,
    triaged: finalMatches.triaged,
    triage_error: triageError,
    triage_guard: triageGuard,
    triage_batches: triageBatches,
    fetch_stats: stats,
    filter_stats: filterStats,
    profile: input.profile,
    survivors: finalMatches.list,
    stretch: finalStretch.list,
    also_qualified: alsoQualified,
    dropped: dropped.filter((p) => !alsoQualifiedUrls.has(p.url)),
  };
}
