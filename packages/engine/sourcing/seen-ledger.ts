import type { RankedPosting } from "./types";
import { postingKey } from "./url-key";

/**
 * Persistent seen-ledger for the main sweep — the audit trail dream-watch has
 * had all along (dream-seen.json), extended with dispositions.
 *
 * The 2026-09-27 post-mortem's deadliest gap after the dead scheduler: the
 * sweep had NO memory of what it had ever surfaced, so "did we ever see this
 * role, and what did we do with it?" was unanswerable, and a shortlisted role
 * could quietly stop appearing with no one the wiser. The ledger records every
 * posting the sweep ever surfaced, keyed by canonical URL, with what became of
 * it and how old it already was at first sight (a 40-day age at first sight is
 * itself the signature of a coverage gap). Pure function; callers own file I/O
 * (~/Kairos/sourcing/sweep-seen.json).
 */

export type Disposition = "shortlisted" | "stretch" | "also_qualified" | "dropped";

export interface SeenLedgerEntry {
  company: string;
  title: string;
  location: string;
  url: string;
  /** First run that surfaced this posting (ISO). */
  first_seen: string;
  /** Most recent run that surfaced it (ISO). */
  last_seen: string;
  /** Posting age (days) when the sweep FIRST saw it; large = coverage gap. */
  age_at_first_sight: number | null;
  /** What the most recent sighting did with it. */
  disposition: Disposition;
  /** Why it was dropped, when disposition is "dropped". */
  drop_reason?: RankedPosting["drop_reason"];
  /** Sticky: it made the shortlist at least once, whatever happened later. */
  ever_shortlisted?: boolean;
  /**
   * Set (once) when a previously shortlisted, un-actioned role stopped
   * appearing on the board AND the shortlist. Before 2026-09-27 such a role
   * disappeared silently, with no alert. Cleared if it is sighted again.
   */
  vanished_at?: string;
  /** Lane of the most recent sighting. */
  last_lane?: "daily" | "deep";
}

/** Keyed by canonical URL (query string stripped). */
export type SeenLedger = Record<string, SeenLedgerEntry>;

export interface LedgerRunInput {
  previous: SeenLedger;
  survivors: RankedPosting[];
  stretch: RankedPosting[];
  alsoQualified?: RankedPosting[];
  dropped?: RankedPosting[];
  ranAt: string;
  lane: "daily" | "deep";
  /** Canonical URLs the user tracked/dismissed — never alerted on. */
  actionedUrls: Set<string>;
  /**
   * Canonical URLs still live on the board (the backlog): a shortlisted role
   * absent from THIS run but still carried on the board has not vanished.
   */
  boardUrls?: Set<string>;
  /**
   * Canonical URLs of every posting the ATSes returned this run, before
   * filtering. A shortlisted role still in this set is open: it aged out of
   * the recency window or was filtered, it did not vanish (2026-11-02: dating
   * Greenhouse by first_published aged 27 live roles out and all 27 alerted).
   */
  liveUrls?: Set<string>;
}

export interface LedgerUpdateResult {
  ledger: SeenLedger;
  /** First-ever sightings that made shortlist/stretch/also-qualified. */
  newlySurfaced: SeenLedgerEntry[];
  /**
   * Previously shortlisted roles that vanished THIS run (gone from the run,
   * the board, and un-actioned). Daily lane only — the deep lane's universe
   * is different, so its absences prove nothing.
   */
  vanishedShortlisted: SeenLedgerEntry[];
}

const canonical = postingKey;

/**
 * Re-key a stored ledger with postingKey, merging entries that are the same
 * posting under two spellings (Workday site-name case). The merged entry keeps
 * the earliest first sighting, the latest sighting's fields, and the sticky
 * shortlist flag; a vanished mark survives only if no copy was seen after it.
 */
export function rekeyLedger(previous: SeenLedger): SeenLedger {
  const out: SeenLedger = {};
  for (const [rawKey, e] of Object.entries(previous)) {
    const key = canonical(rawKey);
    const other = out[key];
    if (!other) { out[key] = e; continue; }
    const [older, newer] = other.last_seen <= e.last_seen ? [other, e] : [e, other];
    const firstSight = older.first_seen <= newer.first_seen ? older : newer;
    const vanished = newer.vanished_at && newer.vanished_at >= newer.last_seen ? newer.vanished_at : undefined;
    out[key] = {
      ...newer,
      first_seen: firstSight.first_seen,
      age_at_first_sight: firstSight.age_at_first_sight,
      ever_shortlisted: older.ever_shortlisted || newer.ever_shortlisted || undefined,
      vanished_at: vanished,
    };
  }
  return out;
}

export function updateSeenLedger(input: LedgerRunInput): LedgerUpdateResult {
  const ledger: SeenLedger = rekeyLedger(input.previous);
  const newlySurfaced: SeenLedgerEntry[] = [];
  const sighted = new Set<string>();

  const fold = (list: RankedPosting[] | undefined, disposition: Disposition) => {
    for (const p of list ?? []) {
      const key = canonical(p.url);
      if (sighted.has(key)) continue; // fold order = best disposition wins
      sighted.add(key);
      const prev = ledger[key];
      const entry: SeenLedgerEntry = {
        company: p.company,
        title: p.title,
        location: p.location,
        url: p.url,
        first_seen: prev?.first_seen ?? input.ranAt,
        last_seen: input.ranAt,
        // First sight only: later sightings must not overwrite the number
        // that says how late the sweep was to this posting.
        age_at_first_sight: prev ? prev.age_at_first_sight : p.age_days,
        disposition,
        drop_reason: disposition === "dropped" ? p.drop_reason : undefined,
        ever_shortlisted: prev?.ever_shortlisted || disposition === "shortlisted" || undefined,
        vanished_at: undefined, // sighted again = not vanished
        last_lane: input.lane,
      };
      ledger[key] = entry;
      if (!prev && disposition !== "dropped") newlySurfaced.push(entry);
    }
  };
  fold(input.survivors, "shortlisted");
  fold(input.stretch, "stretch");
  fold(input.alsoQualified, "also_qualified");
  fold(input.dropped, "dropped");

  const vanishedShortlisted: SeenLedgerEntry[] = [];
  if (input.lane === "daily") {
    for (const [key, e] of Object.entries(ledger)) {
      if (!e.ever_shortlisted || e.vanished_at) continue;
      // A role last sighted by the DEEP lane is outside the daily window —
      // its absence from a daily run proves nothing. Only the next deep scan
      // (which re-sights it if still open) keeps its record honest.
      if (e.last_lane === "deep") continue;
      if (sighted.has(key) || input.actionedUrls.has(key)) continue;
      if (input.boardUrls?.has(key) || input.liveUrls?.has(key)) continue;
      ledger[key] = { ...e, vanished_at: input.ranAt };
      vanishedShortlisted.push(ledger[key]);
    }
  }

  return { ledger, newlySurfaced, vanishedShortlisted };
}
