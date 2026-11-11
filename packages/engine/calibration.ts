/**
 * Outcome calibration (the eval nobody can fake): does the scorer's band
 * actually predict real-world conversion to interviews?
 *
 * Every application carries a predicted band (STRONG/COMPETITIVE/...) from
 * BEFORE submission and, over time, a real outcome (recruiter screen reached,
 * rejected, listing expired, still pending). This module turns that history
 * into an honest calibration table with small-n confidence intervals.
 *
 * Methodology notes, stated rather than hidden:
 * - The scorer predicts "will this application earn a first interview", so the
 *   positive label is reaching ANY interview stage; what happens after the
 *   first screen is out of the scorer's scope.
 * - "Decided" = interviewed OR rejected/expired without interview. Withdrawn
 *   applications are censored (candidate's choice, not the market's verdict).
 * - Still-pending applications are censored but reported, and a conservative
 *   rate (pending counted as failures) is published alongside, so the headline
 *   number can never be flattered by young applications.
 */

export interface CalibrationInput {
  /** Predicted band at scoring time; undefined = never scored. */
  band?: "STRONG" | "COMPETITIVE" | "DEVELOPING" | "WEAK" | string;
  recommendation?: string;
  /** Ever actually submitted. */
  applied: boolean;
  /** Ever reached any interview stage (screen counts). */
  interviewed: boolean;
  /** Terminal without interview: rejected or listing expired. */
  closedWithoutInterview: boolean;
  /** Candidate withdrew — censored. */
  withdrawn: boolean;
}

export interface BandRow {
  band: string;
  applied: number;
  interviews: number;
  rejectedOrExpired: number;
  pending: number;
  /** interviews / (interviews + rejectedOrExpired); null when nothing decided. */
  decidedRate: number | null;
  /** Wilson 95% interval over decided outcomes; null when nothing decided. */
  decidedCI: [number, number] | null;
  /** interviews / (applied - withdrawn): pending counted as failures. */
  conservativeRate: number | null;
}

export interface CalibrationReport {
  totalApplied: number;
  totalInterviews: number;
  totalPending: number;
  totalWithdrawn: number;
  byBand: BandRow[];
  byRecommendation: BandRow[];
  /** Honest headline: is the band ordering monotone on decided outcomes? */
  monotone: boolean | null;
  caveats: string[];
}

/** Wilson score interval — behaves sanely at the small n this data lives at. */
export function wilsonInterval(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

const BAND_ORDER = ["STRONG", "COMPETITIVE", "DEVELOPING", "WEAK"];

function rowFor(label: string, apps: CalibrationInput[]): BandRow {
  const nonWithdrawn = apps.filter((a) => !a.withdrawn);
  const interviews = nonWithdrawn.filter((a) => a.interviewed).length;
  const rejected = nonWithdrawn.filter((a) => !a.interviewed && a.closedWithoutInterview).length;
  const pending = nonWithdrawn.length - interviews - rejected;
  const decided = interviews + rejected;
  return {
    band: label,
    applied: apps.length,
    interviews,
    rejectedOrExpired: rejected,
    pending,
    decidedRate: decided ? interviews / decided : null,
    decidedCI: decided ? wilsonInterval(interviews, decided) : null,
    conservativeRate: nonWithdrawn.length ? interviews / nonWithdrawn.length : null,
  };
}

export function computeCalibration(apps: CalibrationInput[]): CalibrationReport {
  const applied = apps.filter((a) => a.applied);
  const caveats: string[] = [];

  const unscored = applied.filter((a) => !a.band).length;
  if (unscored) caveats.push(`${unscored} applied application(s) were never scored and are excluded from band rows`);

  const bands = new Map<string, CalibrationInput[]>();
  for (const a of applied) {
    if (!a.band) continue;
    (bands.get(a.band) ?? bands.set(a.band, []).get(a.band)!).push(a);
  }
  const byBand = [...bands.entries()]
    .sort(([a], [b]) => {
      const ia = BAND_ORDER.indexOf(a), ib = BAND_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .map(([band, list]) => rowFor(band, list));

  const recs = new Map<string, CalibrationInput[]>();
  for (const a of applied) {
    if (!a.recommendation) continue;
    (recs.get(a.recommendation) ?? recs.set(a.recommendation, []).get(a.recommendation)!).push(a);
  }
  const byRecommendation = [...recs.entries()].map(([rec, list]) => rowFor(rec, list));

  // Monotonicity: each better band's decided rate ≥ the next, over rows with
  // at least one decided outcome. Null when fewer than two comparable rows.
  const comparable = byBand.filter((r) => r.decidedRate !== null && BAND_ORDER.includes(r.band));
  let monotone: boolean | null = null;
  if (comparable.length >= 2) {
    monotone = comparable.every((r, i) => i === 0 || comparable[i - 1].decidedRate! >= r.decidedRate!);
  }

  const all = rowFor("ALL", applied);
  if (all.pending > 0) {
    caveats.push(`${all.pending} application(s) still pending — decided rates exclude them; conservative rates count them as failures`);
  }
  const smallest = Math.min(...byBand.map((r) => r.interviews + r.rejectedOrExpired).filter((n) => n > 0));
  if (Number.isFinite(smallest) && smallest < 10) {
    caveats.push("small-sample data: read the intervals, not the point estimates");
  }

  return {
    totalApplied: applied.length,
    totalInterviews: all.interviews,
    totalPending: all.pending,
    totalWithdrawn: applied.filter((a) => a.withdrawn).length,
    byBand,
    byRecommendation,
    monotone,
    caveats,
  };
}

/** Derive a CalibrationInput from an application meta's status facts. */
export function toCalibrationInput(meta: {
  score_band?: string;
  recommendation?: string;
  status: string;
  applied_at?: string;
  status_history?: { status: string }[];
}): CalibrationInput {
  const history = new Set((meta.status_history ?? []).map((h) => h.status));
  const applied = Boolean(meta.applied_at) || history.has("applied");
  const interviewed = history.has("interviewing") || meta.status === "interviewing" || meta.status === "offer" || history.has("offer");
  const withdrawn = meta.status === "withdrawn";
  const closedWithoutInterview = !interviewed && (meta.status === "rejected" || meta.status === "expired");
  return {
    band: meta.score_band,
    recommendation: meta.recommendation,
    applied,
    interviewed,
    closedWithoutInterview,
    withdrawn,
  };
}
