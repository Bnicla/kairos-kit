/**
 * Named context budgets for prompt assembly. Replaces bare `.slice(0, 12_000)`
 * calls scattered through agent code with three properties they lacked:
 *
 *   1. Budgets are named and colocated, so the total context spend of a prompt
 *      is auditable in one place instead of reverse-engineered from slices.
 *   2. Truncation is visible to the model — a clipped section ends with an
 *      explicit marker stating how much was omitted, instead of ending
 *      mid-sentence and silently pretending to be complete.
 *   3. Truncation is visible to the caller — the clipper accumulates a report
 *      (label, kept, omitted) that can be logged or attached to traces.
 *
 * Budgets are in characters, not tokens: every input here is English prose or
 * JSON (~4 chars/token), the budgets are safety rails rather than exact
 * packing, and counting characters keeps this dependency-free and exact.
 */

export interface ClipReport {
  label: string;
  budget: number;
  original: number;
  kept: number;
  clipped: boolean;
}

export interface Clipper {
  /** Truncate `text` to the named budget, cutting at a line boundary. */
  clip(label: string, text: string): string;
  reports: ClipReport[];
  /** One-line summary of what was clipped, or null if nothing was. */
  summary(): string | null;
}

export function makeClipper(budgets: Record<string, number>): Clipper {
  const reports: ClipReport[] = [];
  return {
    reports,
    clip(label: string, text: string): string {
      const budget = budgets[label];
      if (budget === undefined) throw new Error(`No context budget named "${label}"`);
      if (text.length <= budget) {
        reports.push({ label, budget, original: text.length, kept: text.length, clipped: false });
        return text;
      }
      // Cut at the last newline inside budget when one exists in the final
      // quarter — mid-line cuts read as corruption; a slightly shorter clean
      // cut doesn't.
      let cut = budget;
      const nl = text.lastIndexOf("\n", budget);
      if (nl >= budget * 0.75) cut = nl;
      const kept = text.slice(0, cut);
      reports.push({ label, budget, original: text.length, kept: cut, clipped: true });
      return `${kept}\n[…truncated: ${text.length - cut} of ${text.length} characters omitted to fit the ${label} context budget]`;
    },
    summary(): string | null {
      const clipped = reports.filter((r) => r.clipped);
      if (clipped.length === 0) return null;
      return clipped.map((r) => `${r.label} ${r.kept}/${r.original}`).join(", ");
    },
  };
}
