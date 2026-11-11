import type { Experience } from "@kairos/engine/kb/types";

/**
 * Seniority-aware résumé length (DEC-9, local-spec §16): early-career résumés
 * should be a tight single page; experienced ones earn two. Derived from the
 * KB's date spans so students default to 1 page without configuration; a user
 * preference (profile.md `target_pages`) overrides the derivation.
 */
export interface LengthPolicy {
  targetPages: 1 | 2;
  totalYears: number;
  derivation: string;
}

const SENIOR_YEARS_THRESHOLD = 8;
const EARLY_YEARS_THRESHOLD = 3;

export type CareerStage = "early" | "mid" | "senior";

/**
 * Career stage from the KB's date spans — the single derivation shared by the
 * length policy and the stage-aware health check. "early" = students and
 * first-job seekers (<3y), "senior" = 8y+ (matches the 2-page threshold).
 */
export function careerStage(experiences: Experience[], nowYear?: number): CareerStage {
  const { totalYears } = resumeLengthPolicy(experiences, { nowYear });
  if (totalYears < EARLY_YEARS_THRESHOLD) return "early";
  if (totalYears < SENIOR_YEARS_THRESHOLD) return "mid";
  return "senior";
}

export function resumeLengthPolicy(
  experiences: Experience[],
  opts: { override?: 1 | 2; nowYear?: number } = {},
): LengthPolicy {
  const now = opts.nowYear ?? new Date().getFullYear();
  let earliest = now;
  let latest = 0;
  for (const e of experiences) {
    const start = parseInt(String(e.frontmatter.start), 10);
    const end = e.frontmatter.end === "present" ? now : parseInt(String(e.frontmatter.end), 10);
    if (!Number.isNaN(start)) earliest = Math.min(earliest, start);
    if (!Number.isNaN(end)) latest = Math.max(latest, end);
  }
  const totalYears = Math.max(0, latest - earliest);
  if (opts.override) {
    return { targetPages: opts.override, totalYears, derivation: `user override (${opts.override} page${opts.override > 1 ? "s" : ""})` };
  }
  const targetPages = totalYears >= SENIOR_YEARS_THRESHOLD ? 2 : 1;
  return {
    targetPages,
    totalYears,
    derivation: `${totalYears} years of experience → ${targetPages} page${targetPages > 1 ? "s" : ""} (threshold ${SENIOR_YEARS_THRESHOLD})`,
  };
}
