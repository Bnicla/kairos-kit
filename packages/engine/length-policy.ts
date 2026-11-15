import type { Experience } from "@kairos/engine/kb/types";
import { stripUnverified } from "@kairos/engine/kb/experience";

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
/**
 * Verified words a knowledge base must hold before two pages are asked for. A two-page résumé runs to about 1,200
 * words; a person with fifteen years and one résumé read in holds a few hundred, and a target of two pages only
 * pushes the Writer to fill (the run on other professions, 15 November 2026).
 */
export const TWO_PAGES_NEED_WORDS = 1600;
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
  // What the person has told, in words: the facts that carry a tag (untagged lines are not evidence and do not count).
  const words = experiences.reduce((n, e) => n + stripUnverified(e).body.split(/\s+/).filter((w) => /\w/.test(w)).length, 0);
  if (opts.override) {
    return { targetPages: opts.override, totalYears, derivation: `user override (${opts.override} page${opts.override > 1 ? "s" : ""})` };
  }
  const senior = totalYears >= SENIOR_YEARS_THRESHOLD;
  const targetPages = senior && words >= TWO_PAGES_NEED_WORDS ? 2 : 1;
  return {
    targetPages,
    totalYears,
    derivation:
      senior && targetPages === 1
        ? `${totalYears} years of experience, and a knowledge base of ${words} words: one page (two pages need about ${TWO_PAGES_NEED_WORDS} words of facts)`
        : `${totalYears} years of experience → ${targetPages} page${targetPages > 1 ? "s" : ""} (threshold ${SENIOR_YEARS_THRESHOLD})`,
  };
}
