import { DEFAULT_MAX_SOURCED_CARDS } from "../settings";
import { inExcludedLocation, passesFunctionGate } from "./filter";
import type { RankedPosting, SearchProfile } from "./types";
import { postingKey } from "./url-key";

/**
 * Persistent sourced backlog: the fix for run-scoped amnesia.
 *
 * Each sweep overwrites last-run.json, so an un-actioned card used to vanish
 * the moment the next run's triage made a different cut (observed 2026-09-07:
 * a Director role surfaced Wednesday was gone by Sunday with no user action).
 * The backlog accumulates every card that ever made the board across runs,
 * keyed by canonical URL, and retires entries only for a REASON:
 *   - actioned: the user tracked or dismissed it (url in seenUrls / tracked)
 *   - stale: not re-surfaced by any run within `staleAfterDays` (posting
 *     likely closed or decayed out of the recency window)
 *   - ineligible: a carried card that fails the CURRENT rules (`stillEligible`).
 *     Without this, a rule added on Tuesday never touched cards surfaced on
 *     Monday: cards from before a new exclusion stayed on the board.
 *   - waited out: a carried card first surfaced more than `maxCarryDays` ago.
 *     ATS feeds re-stamp posted_at on edits, so a weeks-old card kept being
 *     "re-surfaced" and never went stale.
 * Same-role duplicates (company + title under different URLs) collapse to one.
 * Cards whose triage band is in `dropBands` never make the board (the user asked on
 * 2026-10-08 to keep DEVELOPING reads off it; they stay in the run file).
 * Pure function; callers own file I/O.
 */

export interface BacklogEntry extends RankedPosting {
  /** First run that surfaced this card (ISO). */
  first_seen: string;
  /** Most recent run that surfaced it (ISO). */
  last_seen: string;
  /** Which board bucket it last appeared in. */
  bucket: "match" | "stretch";
  /** True when this entry did NOT appear in the latest run (carried over). */
  carried?: boolean;
}

export interface BacklogMergeInput {
  previous: BacklogEntry[];
  runSurvivors: RankedPosting[];
  runStretch: RankedPosting[];
  ranAt: string;
  /** Canonical URLs the user has actioned (dismissed/tracked) — always removed. */
  actionedUrls: Set<string>;
  /** Days an entry may go un-resurfaced before it is retired (default 14). */
  staleAfterDays?: number;
  /** Days since first_seen after which a carried (un-resurfaced) card retires. */
  maxCarryDays?: number;
  /** Current deterministic gates, re-applied to carried cards. */
  stillEligible?: (e: BacklogEntry) => boolean;
  /** Triage bands kept off the board entirely (untriaged cards always stay). */
  dropBands?: string[];
}

const canonical = postingKey;

export function mergeBacklog(input: BacklogMergeInput): BacklogEntry[] {
  const staleMs = (input.staleAfterDays ?? 14) * 24 * 60 * 60 * 1000;
  const ranAtMs = Date.parse(input.ranAt);
  const dayMs = 24 * 60 * 60 * 1000;
  const out = new Map<string, BacklogEntry>();

  // Seed with previous entries that are neither actioned, stale, waited out,
  // nor ineligible under today's rules. Age is recomputed so a carried card
  // never shows the frozen "0d" it had when it first surfaced.
  for (const e of input.previous) {
    const key = canonical(e.url);
    if (input.actionedUrls.has(key)) continue;
    if (ranAtMs - Date.parse(e.last_seen) > staleMs) continue;
    if (input.maxCarryDays !== undefined && ranAtMs - Date.parse(e.first_seen) > input.maxCarryDays * dayMs) continue;
    if (input.stillEligible && !input.stillEligible(e)) continue;
    const age_days = e.posted_at ? Math.max(0, Math.floor((ranAtMs - Date.parse(e.posted_at)) / dayMs)) : e.age_days;
    out.set(key, { ...e, age_days, carried: true });
  }

  // Fold in the fresh run: new entries start their clock; resurfaced entries
  // refresh last_seen and adopt the newer triage read (band/one-liner) while
  // keeping first_seen so the UI can show how long a card has waited.
  const fold = (list: RankedPosting[], bucket: BacklogEntry["bucket"]) => {
    for (const p of list) {
      const key = canonical(p.url);
      if (input.actionedUrls.has(key)) continue;
      const prev = out.get(key);
      out.set(key, {
        ...p,
        first_seen: prev?.first_seen ?? input.ranAt,
        last_seen: input.ranAt,
        bucket,
        carried: false,
      });
    }
  };
  fold(input.runSurvivors, "match");
  fold(input.runStretch, "stretch");

  // Fresh-first (the recency rule), carried cards after, oldest-waiting last.
  const sorted = [...out.values()].sort((a, b) => {
    if (!!a.carried !== !!b.carried) return a.carried ? 1 : -1;
    return b.last_seen.localeCompare(a.last_seen) || b.rank_score - a.rank_score;
  });
  // One card per role: the first in sort order (fresh, best-ranked) wins.
  const roles = new Set<string>();
  const dropBands = new Set(input.dropBands ?? []);
  return sorted.filter((e) => {
    if (e.guess_band && dropBands.has(e.guess_band)) return false;
    const role = `${e.company.toLowerCase()}|${e.title.trim().toLowerCase().replace(/\s+/g, " ")}`;
    if (roles.has(role)) return false;
    roles.add(role);
    return true;
  });
}

/**
 * The one way the board's backlog is built from a run: today's profile rules
 * applied to carried cards, the profile's recency window as the carry limit, weak triage
 * reads kept off. Shared by the sweep itself and by the daily wrapper's merge
 * of CLOUD results (which arrive as last-run.json only; until 2026-10-11 they
 * never reached the backlog, so the Sourced column froze on the last local run).
 */
export function mergeBacklogForProfile(input: {
  previous: BacklogEntry[];
  runSurvivors: RankedPosting[];
  runStretch: RankedPosting[];
  ranAt: string;
  actionedUrls: Set<string>;
  profile: SearchProfile;
  knownApplications: { company: string; role: string }[];
}): BacklogEntry[] {
  // Trimmed: ATS titles sometimes carry a trailing space ("Senior Principal
  // Product Manager "), which let an already-closed role back on the board.
  const pair = (company: string, title: string) => `${company.trim().toLowerCase()}|${title.trim().toLowerCase()}`;
  const known = new Set(input.knownApplications.map((a) => pair(a.company, a.role)));
  const eligible = (e: RankedPosting) =>
    passesFunctionGate(e.title, input.profile) &&
    !inExcludedLocation(e, input.profile) &&
    !known.has(pair(e.company, e.title));
  return mergeBacklog({
    previous: input.previous,
    // A run produced elsewhere (the cloud) may predate a rule or an application.
    runSurvivors: input.runSurvivors.filter(eligible),
    runStretch: input.runStretch.filter(eligible),
    ranAt: input.ranAt,
    actionedUrls: input.actionedUrls,
    maxCarryDays: input.profile.max_age_days,
    dropBands: ["DEVELOPING", "WEAK"],
    stillEligible: eligible,
  });
}

/** Split a backlog into the two board buckets, preserving order. */
export function backlogBuckets(entries: BacklogEntry[]): {
  matches: BacklogEntry[];
  stretch: BacklogEntry[];
} {
  return {
    matches: entries.filter((e) => e.bucket === "match"),
    stretch: entries.filter((e) => e.bucket === "stretch"),
  };
}

/**
 * How many sourced cards the board column shows when the search profile sets
 * no `board.max_sourced_cards`: a long column reads as "too many jobs", and a
 * realistic pace is 3-5 applications a week. The rest stay on the
 * All-sourced page, nothing is dismissed.
 */
export const SOURCED_COLUMN_LIMIT = DEFAULT_MAX_SOURCED_CARDS;

const BAND_ORDER: Record<string, number> = { STRONG: 0, COMPETITIVE: 1, DEVELOPING: 2, WEAK: 3 };

/** Best cards first: location matches before stretch, then band, then freshest, then rank score. */
export function topSourced<T extends { location_fit?: string; guess_band?: string; age_days?: number | null; rank_score?: number }>(
  cards: T[],
  limit = SOURCED_COLUMN_LIMIT,
): T[] {
  return [...cards]
    .sort(
      (a, b) =>
        (a.location_fit === "stretch" ? 1 : 0) - (b.location_fit === "stretch" ? 1 : 0) ||
        (BAND_ORDER[a.guess_band ?? ""] ?? 4) - (BAND_ORDER[b.guess_band ?? ""] ?? 4) ||
        (a.age_days ?? 99) - (b.age_days ?? 99) ||
        (b.rank_score ?? 0) - (a.rank_score ?? 0),
    )
    .slice(0, limit);
}
