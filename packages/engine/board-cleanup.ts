import type { ApplicationMeta } from "@kairos/engine/applications";

/**
 * Weekly board clean-up plan (user request, 2026-10-25: "run the usual clean up
 * process; if we don't have one, it's time we do"). Pure function over the
 * application metas and the sourced backlog, so it can be tested and dry-run.
 *
 * Automatic (safe, reversible) actions:
 *   - archive Closed cards (rejected / withdrawn / expired) untouched for a week
 *   - dismiss Sourced cards that are stale or already tracked on the board
 * Decisions left to the user (reported, never applied):
 *   - draft cards sitting unsent for two weeks or more
 *   - interviewing cards with no update for two weeks (follow up or close)
 *   - applied cards with no answer for eight weeks (still Applied; just listed)
 */

export const CLEANUP_RULES = {
  archiveClosedAfterDays: 7,
  staleDraftDays: 14,
  quietInterviewDays: 14,
  longAppliedDays: 56,
  staleSourcedDays: 14,
} as const;

const CLOSED = new Set(["rejected", "withdrawn", "expired"]);
const DRAFT = new Set(["captured", "scored", "drafted"]);

export interface SourcedEntry {
  url: string;
  company: string;
  title: string;
  age_days?: number | null;
}

export interface CleanupPlan {
  archive: { id: string; company: string; role: string; status: string; idleDays: number }[];
  dismissSourced: { url: string; company: string; title: string; why: "stale" | "already on the board" }[];
  decide: {
    staleDrafts: { id: string; company: string; role: string; band?: string; days: number }[];
    quietInterviewing: { id: string; company: string; role: string; days: number }[];
    longApplied: { id: string; company: string; role: string; days: number }[];
  };
}

const days = (from: string | undefined, now: Date) =>
  from ? Math.floor((now.getTime() - Date.parse(from)) / 86_400_000) : 0;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function planCleanup(
  metas: ApplicationMeta[],
  backlog: SourcedEntry[],
  seenUrls: Set<string>,
  now: Date = new Date(),
): CleanupPlan {
  const plan: CleanupPlan = {
    archive: [],
    dismissSourced: [],
    decide: { staleDrafts: [], quietInterviewing: [], longApplied: [] },
  };
  const R = CLEANUP_RULES;
  const onBoard = new Set<string>();

  for (const m of metas) {
    onBoard.add(`${norm(m.company)}|${norm(m.role)}`);
    if (m.source_url) onBoard.add(m.source_url.split("?")[0]);
    if (m.archived) continue;
    const idle = days(m.updated_at, now);
    if (CLOSED.has(m.status)) {
      if (idle >= R.archiveClosedAfterDays)
        plan.archive.push({ id: m.id, company: m.company, role: m.role, status: m.status, idleDays: idle });
    } else if (DRAFT.has(m.status)) {
      const age = days(m.captured_at, now);
      if (age >= R.staleDraftDays)
        plan.decide.staleDrafts.push({ id: m.id, company: m.company, role: m.role, band: m.score_band, days: age });
    } else if (m.status === "interviewing") {
      if (idle >= R.quietInterviewDays)
        plan.decide.quietInterviewing.push({ id: m.id, company: m.company, role: m.role, days: idle });
    } else if (m.status === "applied") {
      const since = days(m.applied_at ?? m.captured_at, now);
      if (since >= R.longAppliedDays && idle >= R.longAppliedDays)
        plan.decide.longApplied.push({ id: m.id, company: m.company, role: m.role, days: since });
    }
  }

  for (const s of backlog) {
    const url = s.url.split("?")[0];
    if (seenUrls.has(url)) continue;
    if (onBoard.has(url) || onBoard.has(`${norm(s.company)}|${norm(s.title)}`))
      plan.dismissSourced.push({ url, company: s.company, title: s.title, why: "already on the board" });
    else if ((s.age_days ?? 0) >= R.staleSourcedDays)
      plan.dismissSourced.push({ url, company: s.company, title: s.title, why: "stale" });
  }
  return plan;
}
