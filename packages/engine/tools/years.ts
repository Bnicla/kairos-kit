/**
 * A count of years on a résumé ("nine years writing for a public audience", "for more than six years").
 *
 * Seen in the run on other professions (15 November 2026): two summaries gave a number of years the
 * person never gave, one longer than the role it was said of. A count of years is a number like any
 * other, so it is checked:
 *
 *  - a count the knowledge base states itself ("wrote the newsletter for four years") is the person's own;
 *  - any other count is one the writer worked out from dates. It must fit the dates of the roles its
 *    sentence names (a title, else an employer, else every role). One longer than those dates allow is
 *    refused in code. One that fits is listed for the person: code can tell that the dates allow nine
 *    years, not that all nine were spent on what the sentence says.
 */
import type { Experience } from "@kairos/engine/kb/types";

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40,
};
const NUMBER = `\\d{1,2}|${Object.keys(WORDS).join("|")}`;
const YEARS = new RegExp(`(?:\\b(more than|over|nearly|almost|close to|about|around|roughly)\\s+)?\\b(${NUMBER})(\\+)?\\s+(?:plus\\s+)?years\\b(?!\\s*-?\\s*old)`, "gi");

export interface YearClaim {
  /** As written: "more than six years". */
  raw: string;
  years: number;
  /** "more than", "over", "6+": the time must be longer than the number. */
  more: boolean;
  /** "nearly", "almost", "close to": up to a year short. */
  nearly: boolean;
}

/**
 * Every count of years in a text. "A five-year plan" and "a two-year program" say how long a thing lasts, not how
 * long the person did something, and are not read (seven such lines in real résumés were read as counts at first).
 */
export function yearClaims(text: string): YearClaim[] {
  const out: YearClaim[] = [];
  for (const m of text.matchAll(YEARS)) {
    const word = m[2]!.toLowerCase();
    const years = /^\d/.test(word) ? Number(word) : WORDS[word]!;
    const lead = (m[1] ?? "").toLowerCase();
    out.push({ raw: m[0].trim(), years, more: /more than|over/.test(lead) || Boolean(m[3]) || /plus\s+years/i.test(m[0]), nearly: /nearly|almost|close to/.test(lead) });
  }
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A start or an end of a role as a year with a fraction; null when it cannot be read. `end`: the end of the month or year named. */
export function dateAsYears(value: unknown, end: boolean, now: Date): number | null {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s || /^(present|current|now|today|ongoing)$/.test(s)) return end ? now.getFullYear() + (now.getMonth() + 1) / 12 : null;
  const iso = /^(\d{4})(?:-(\d{1,2}))?/.exec(s);
  if (iso) {
    const y = Number(iso[1]);
    if (!iso[2]) return end ? y + 1 : y;
    const month = Math.min(12, Math.max(1, Number(iso[2])));
    return y + (end ? month : month - 1) / 12;
  }
  const named = /([a-z]{3})[a-z]*\.?\s+(\d{4})/.exec(s);
  if (named && MONTHS.includes(named[1]!)) {
    const month = MONTHS.indexOf(named[1]!) + 1;
    return Number(named[2]) + (end ? month : month - 1) / 12;
  }
  return null;
}

/** The years the given entries cover together, counted once where they overlap. Null when no entry has dates that can be read. */
export function yearsCovered(entries: Experience[], now: Date): number | null {
  const spans = entries
    .map((e) => [dateAsYears(e.frontmatter.start, false, now), dateAsYears(e.frontmatter.end, true, now)] as const)
    .filter((s): s is readonly [number, number] => s[0] !== null && s[1] !== null && s[1] >= s[0])
    .sort((a, b) => a[0] - b[0]);
  if (!spans.length) return null;
  let total = 0;
  let [from, to] = spans[0]!;
  for (const [a, b] of spans.slice(1)) {
    if (a <= to) to = Math.max(to, b);
    else {
      total += to - from;
      [from, to] = [a, b];
    }
  }
  return total + (to - from);
}

const flat = (t: string) => ` ${t.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/**
 * The entries a sentence names: by title when it names one (the longest title first, so that "Senior
 * Consultant" does not also count as "Consultant"), else by employer, else every entry given.
 */
export function entriesNamed(sentence: string, entries: Experience[]): { entries: Experience[]; by: "title" | "employer" | "none" } {
  let text = flat(sentence);
  const byTitle: Experience[] = [];
  const titled = entries.filter((e) => flat(String(e.frontmatter.title ?? "")).trim().length >= 6).sort((a, b) => String(b.frontmatter.title).length - String(a.frontmatter.title).length);
  const seen = new Set<string>();
  for (const e of titled) {
    const title = flat(String(e.frontmatter.title));
    if (seen.has(title)) {
      byTitle.push(e);
      continue;
    }
    if (!text.includes(title)) continue;
    seen.add(title);
    byTitle.push(e);
    text = text.split(title).join(" ");
  }
  if (byTitle.length) {
    // Two roles of the same title at two employers: the employer the sentence names decides, when it names one.
    const whole = flat(sentence);
    const atNamed = byTitle.filter((e) => whole.includes(flat(String(e.frontmatter.company ?? ""))));
    const chosen = atNamed.length ? atNamed : byTitle;
    // "Consultant" is also what a "Senior Consultant" is, and "product manager" what a "Senior Product Manager" is, at
    // the same employer or another: a title that another entry's title holds stands for both. ("Senior Consultant"
    // stands for itself alone.)
    const wider = entries.filter((e) => chosen.some((c) => c !== e && flat(String(e.frontmatter.title ?? "")).includes(flat(String(c.frontmatter.title ?? "")))));
    return { entries: entries.filter((e) => chosen.includes(e) || wider.includes(e)), by: "title" };
  }
  const whole = flat(sentence);
  const byEmployer = entries.filter((e) => flat(String(e.frontmatter.company ?? "")).trim().length >= 3 && whole.includes(flat(String(e.frontmatter.company))));
  if (byEmployer.length) return { entries: byEmployer, by: "employer" };
  return { entries, by: "none" };
}

export interface YearFinding {
  /** "exceeds": longer than the dates allow, refused. "from_dates": fits the dates and is stated nowhere, listed. */
  kind: "exceeds" | "from_dates";
  claim: string;
  where: string;
  /** What the dates give, in years. */
  covered: number;
  /** The roles the count was held against, as "Title at Employer". */
  roles: string[];
  /** The sentence the count stands in, and what in it named the roles ("none": every role of the scope). */
  sentence: string;
  by: "title" | "employer" | "none";
}

const fits = (c: YearClaim, covered: number) => (c.more ? covered > c.years : c.nearly ? covered >= c.years - 1 : c.years <= covered + 0.5);

/**
 * The counts of years in one text of a résumé that the knowledge base does not state itself.
 * `stated`: the verified text the count may be stated in (the role's own for a bullet, all of it for the summary).
 * `scope`: the entries a count may be held against when the sentence names none.
 */
export function checkYears(text: string, where: string, stated: string, scope: Experience[], all: Experience[], now: Date): YearFinding[] {
  const out: YearFinding[] = [];
  const own = new Set(yearClaims(stated).map((c) => c.years));
  // A bold lead-in is a label, not a role the sentence names ("**Retail Strategy Consultant:** Senior Consultant at …").
  for (const sentence of text.replace(/\*\*[^*\n]*\*\*/g, " ").split(/(?<=[.;!?])\s+|\n+/)) {
    for (const claim of yearClaims(sentence)) {
      if (own.has(claim.years)) continue;
      const named = entriesNamed(sentence, all);
      // A title names a role: the count is held against it. An employer named in a sentence about a career is often
      // one of several ("twelve years in payments, at Northwind and Harborline"), so it does not narrow the count.
      const held = named.by === "title" ? named.entries : scope;
      const covered = yearsCovered(held, now);
      if (covered === null) continue;
      const roles = held.map((e) => [e.frontmatter.title, e.frontmatter.company].filter(Boolean).join(" at "));
      out.push({ kind: fits(claim, covered) ? "from_dates" : "exceeds", claim: claim.raw, where, covered: Math.round(covered * 10) / 10, roles, sentence: sentence.replace(/^[\s\-*•]+/, "").replace(/\s+/g, " ").trim(), by: named.by });
    }
  }
  return out;
}
