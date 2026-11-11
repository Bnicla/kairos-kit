/** Pure formatting helpers safe for both server and client components. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ISO → "Jul 6" (same year) or "Jul 6, 2025" (other years). */
export function fmtDate(iso: string | undefined | null, refYear?: number): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return refYear && y === refYear ? base : `${base}, ${y}`;
}

/** Whole days between two ISO dates (b - a), floored. */
export function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}
