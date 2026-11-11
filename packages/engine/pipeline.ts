import { daysBetween } from "@kairos/engine/format";
import { ALL_STATUSES, STATUS_META } from "@kairos/engine/applications";
import type { IndexEntry } from "@kairos/engine/applications";

/**
 * Pipeline stages for the board, DERIVED from the one STATUS_META map in
 * lib/applications.ts. A new status automatically lands in its declared stage;
 * there is no second list to forget to update.
 */
const STAGE_LABELS: Record<"draft" | "applied" | "ongoing" | "closed", string> = {
  draft: "Draft",
  applied: "Applied",
  ongoing: "Ongoing",
  closed: "Closed",
};

export const STAGES = (Object.keys(STAGE_LABELS) as (keyof typeof STAGE_LABELS)[]).map((key) => ({
  key,
  label: STAGE_LABELS[key],
  statuses: ALL_STATUSES.filter((s) => STATUS_META[s].stage === key),
}));

// Band order for tie-breaking: better match floats up within the same day.
const BAND_RANK: Record<string, number> = { STRONG: 0, COMPETITIVE: 1, DEVELOPING: 2, WEAK: 3 };

/** The date a board card displays: applied date when set, else captured date. */
const cardDay = (a: IndexEntry) => (a.applied_at ?? a.captured_at ?? "").slice(0, 10);

export function groupByStage(apps: IndexEntry[]): Record<string, IndexEntry[]> {
  const out: Record<string, IndexEntry[]> = {};
  for (const s of STAGES) out[s.key] = [];
  for (const a of apps) out[STATUS_META[a.status]?.stage ?? "draft"].push(a);
  // Within each column: newest day first; same-day ties by match band.
  for (const s of STAGES) {
    out[s.key].sort((a, b) => {
      const byDay = cardDay(b).localeCompare(cardDay(a));
      if (byDay !== 0) return byDay;
      return (BAND_RANK[a.score_band ?? ""] ?? 4) - (BAND_RANK[b.score_band ?? ""] ?? 4);
    });
  }
  return out;
}

/** Applied cards older than this fold into a collapsed "waiting" group on the board. */
export const APPLIED_QUIET_DAYS = 21;

/**
 * Split the Applied column into recent cards and quiet ones (applied 3+ weeks
 * ago, no answer). Display only: statuses stay "applied", so the funnel and
 * the no-response count are unchanged.
 */
export function splitQuietApplied<T extends IndexEntry>(apps: T[], nowIso: string): { recent: T[]; quiet: T[] } {
  const recent: T[] = [];
  const quiet: T[] = [];
  for (const a of apps) {
    const at = a.applied_at ?? a.captured_at;
    (a.status === "applied" && at && daysBetween(at, nowIso) >= APPLIED_QUIET_DAYS ? quiet : recent).push(a);
  }
  return { recent, quiet };
}

export interface StaleSignal {
  text: string;
  tone: "info" | "warn" | "danger";
}

/** Nudge for applications that have gone quiet or are sitting undrafted-and-unsent. */
export function staleSignal(app: IndexEntry, nowIso: string): StaleSignal | null {
  if (app.status === "applied" && app.applied_at) {
    const d = daysBetween(app.applied_at, nowIso);
    if (d >= 21) return { text: `${d}d, no response — follow up`, tone: "danger" };
    if (d >= 10) return { text: `${d}d, no response`, tone: "warn" };
    return null;
  }
  if (["captured", "scored", "drafted"].includes(app.status)) {
    const d = daysBetween(app.captured_at, nowIso);
    if (d >= 14) return { text: `${d}d in draft, not sent`, tone: "danger" };
    if (d >= 7) return { text: `${d}d in draft, not sent`, tone: "warn" };
  }
  return null;
}
