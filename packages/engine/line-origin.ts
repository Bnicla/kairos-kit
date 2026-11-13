import type { Experience } from "@kairos/engine/kb/types";
import { verifiedFacts } from "@kairos/engine/kb/experience";
import { contentStems, stretchGuard, summarySentences, SUMMARY } from "@kairos/engine/stretch";
import { auditSourceExperiences, claimNumbers, COVERAGE_TOKEN_OVERLAP } from "@kairos/engine/tools/checks";
import type { GeneratedResume, LineOrigin, OriginStrength } from "@kairos/engine/types";

/**
 * Line origins (2026-11-13): for every bullet, role intro and executive-summary
 * sentence of a résumé, the verified fact or facts of the record that the line
 * comes from. Computed here, in code; the model's `provenance_audit` is only
 * compared with the result. Before this, one audit entry was enough for a
 * save, its claim was not compared with its source, and a bullet needed none.
 *
 * A fact is one fact line of an entry's body tagged [R], [C] or [F]
 * (`verifiedFacts`): what `stripUnverified` keeps. Correction and "do not"
 * lines are left out, as in the stretch check. A bullet or a role intro is
 * matched to the facts of its own employer; a summary sentence to the facts of
 * any entry.
 *
 * Matching uses the words and numbers the other checks already compare: the
 * content words of the stretch check (`contentStems`: stopwords and numbers
 * dropped, endings stemmed) and the numbers of the number rule
 * (`claimNumbers`, with its test for whether a line states the same number).
 * The bold lead-in of a bullet is a title and is not matched. The fact that
 * shares the most with the line is taken first. A second and a third are added
 * (a bullet often joins two facts) while the line is not yet fully found and
 * each brings at least two of its words that the earlier ones lack, or one of
 * its numbers; once it is found, only a fact that brings a quarter of the
 * line's words is added, as a second source of its own.
 *
 * Two measures of a line against its facts:
 *  - overlap: the share of the line's content words that the facts hold;
 *  - order: the share of its adjacent content words (each word and the next)
 *    that also stand close together, within three words, in one of the facts.
 *    Shared words alone do not make an origin: an entry of fifty facts holds
 *    most of the vocabulary of any line about that job.
 *
 * Strength:
 *  - strong: overlap of at least 60%, every number of the line stated by the
 *    facts, and order of at least 20%. 60% is `COVERAGE_TOKEN_OVERLAP`, the
 *    share at which the requirements coverage check accepts a light paraphrase
 *    of one line, with the same rule on numbers.
 *  - partial: order of at least 10%, and either overlap of 60% (a number is
 *    missing, or the wording is not followed) or one fact alone holding 40% of
 *    the words. The line was rewritten further, or says more than the facts.
 *  - none: below that. No fact of the record was found for the line.
 * A summary sentence is a composition across roles: it is partial at an
 * overlap of 60% whatever its order (the facts shown are the lines that best
 * support it), and strong by the same rule as a bullet.
 *
 * The shares were set on counts (2026-11-13), on 301 distinct bullets of real
 * résumés written from a record of 159 facts:
 *  - under their own employer: 89% strong, 11% partial, none without origin;
 *  - under the wrong employer (the best of five): 99% without origin;
 *  - a list of words drawn at random from the other bullets of the same
 *    employer, of the same length: 62% strong on overlap alone. With the order
 *    rule: 4% strong, 8% partial, 88% without origin. Hence the order rule.
 *  - a lower partial bar (30% over three facts, or a number and one shared
 *    word) was met by 88% of the bullets under the wrong employer.
 *
 * What an origin is not: proof that the line is true. It says where the words
 * and the numbers of the line are in the record. A line that keeps the record's
 * words and changes one verb ("took part" to "led") has a strong origin;
 * whether it claims more than the fact says is the stretch check's question.
 *
 * A line with no origin is a finding for the user (rule "origin"), never a
 * block: the grounding and stretch rules already block what is clearly
 * unsupported. English only, as the word lists it relies on are.
 */

/** Minimum share of a line's content words in its facts for a strong origin. */
export const ORIGIN_STRONG = COVERAGE_TOKEN_OVERLAP;
/** Minimum share of a line's content words in ONE fact for a partial origin. */
export const ORIGIN_PARTIAL = 0.4;
/** Minimum share of a line's adjacent word pairs found close together in a fact: for a strong origin, and for any origin. */
export const ORIGIN_ORDER_STRONG = 0.2;
export const ORIGIN_ORDER_MIN = 0.1;
/** How far apart, in content words, two adjacent words of the line may stand in the fact. */
const ORDER_WINDOW = 3;
/** Minimum share of a line's content words a fact must bring to be added once the line is already found. */
const SECOND_SOURCE = 0.25;
/** At most this many facts for one line. */
const MAX_FACTS = 3;

export interface OriginFinding {
  rule: "origin";
  /** "none": no verified fact found for the line. "audit": the provenance_audit names a source that holds no fact for it. */
  kind: "none" | "audit";
  /** The employer of the line, or "Executive summary". */
  company: string;
  line: string;
  detail: string;
}

export interface OriginCounts {
  strong: number;
  partial: number;
  none: number;
}

export interface LineOriginReport {
  lines: LineOrigin[];
  counts: OriginCounts;
  findings: OriginFinding[];
}

interface Fact {
  experience_id: string;
  text: string;
  /** The content words of the fact, in order, each once. */
  seq: string[];
  stems: Set<string>;
}

const asFact = (experience_id: string, text: string): Fact => {
  const seq = contentStems(text);
  return { experience_id, text, seq, stems: new Set(seq) };
};

const idOf = (e: Experience) => String(e.frontmatter.id ?? "").trim() || e.fileName.replace(/\.md$/, "");

/** The verified facts of some entries, list marker and line wraps removed, correction lines left out. */
function factsOf(exps: Experience[], guard: RegExp): Fact[] {
  return exps.flatMap((e) =>
    verifiedFacts(e.body)
      .map((f) => f.text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim())
      .filter((text) => !guard.test(text.split(/(?<=[.;])\s+/)[0] ?? ""))
      .map((text) => asFact(idOf(e), text)),
  );
}

interface Trace {
  strength: OriginStrength;
  overlap: number;
  facts: Fact[];
}

/**
 * One line against a set of facts: the facts it comes from, and how much of it
 * they hold. `composed` is a summary sentence, written across several facts:
 * the floor on word order does not apply to it.
 */
function trace(text: string, facts: Fact[], opts: { maxFacts?: number; composed?: boolean } = {}): Trace {
  const maxFacts = opts.maxFacts ?? MAX_FACTS;
  let words = contentStems(text.replace(/\*\*[^*]*\*\*/g, " "));
  if (words.length < 2) words = contentStems(text); // a line that is little more than its lead-in
  const numbers = claimNumbers(text);
  const left = new Set(words);
  const open = new Set(numbers);
  const chosen: Fact[] = [];
  const share = () => (words.length ? (words.length - left.size) / words.length : 0);
  let first = 0; // the share the first fact holds alone
  while (chosen.length < maxFacts && (left.size || open.size)) {
    const found = share() >= ORIGIN_STRONG && open.size === 0;
    let best: Fact | null = null;
    let bestGain = 0;
    for (const f of facts) {
      if (chosen.includes(f)) continue;
      let fresh = 0;
      for (const w of left) if (f.stems.has(w)) fresh++;
      if (found) {
        if (fresh < 2 || fresh / words.length < SECOND_SOURCE) continue;
      } else {
        let stated = 0;
        for (const n of open) if (n.statedIn(f.text)) stated++;
        // A number alone proves nothing: the fact must also share a word with the line.
        if (!(fresh >= 2 || (stated >= 1 && words.some((w) => f.stems.has(w))))) continue;
        fresh += stated;
      }
      if (fresh > bestGain) {
        best = f;
        bestGain = fresh;
      }
    }
    if (!best) break;
    chosen.push(best);
    for (const w of [...left]) if (best.stems.has(w)) left.delete(w);
    for (const n of [...open]) if (n.statedIn(best.text)) open.delete(n);
    if (chosen.length === 1) first = share();
  }
  const overlap = share();
  // Order: adjacent content words of the line that also stand close together in one of the facts.
  let close = 0;
  for (let i = 0; i + 1 < words.length; i++) {
    const near = (f: Fact) => {
      const a = f.seq.indexOf(words[i]!);
      const b = f.seq.indexOf(words[i + 1]!);
      return a >= 0 && b >= 0 && Math.abs(a - b) <= ORDER_WINDOW;
    };
    if (chosen.some(near)) close++;
  }
  const order = words.length > 1 ? close / (words.length - 1) : 0;
  const strength: OriginStrength =
    !chosen.length
      ? "none"
      : overlap >= ORIGIN_STRONG && open.size === 0 && order >= ORIGIN_ORDER_STRONG
        ? "strong"
        : order < ORIGIN_ORDER_MIN && !(opts.composed && overlap >= ORIGIN_STRONG)
          ? "none"
          : overlap >= ORIGIN_STRONG || first >= ORIGIN_PARTIAL
            ? "partial"
            : "none";
  return { strength, overlap, facts: strength === "none" ? [] : chosen };
}

const byCompanyOf = (experiences: Experience[]) => {
  const map = new Map<string, Experience[]>();
  for (const e of experiences) {
    const key = e.frontmatter.company.toLowerCase().trim();
    map.set(key, [...(map.get(key) ?? []), e]);
  }
  return map;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The origin of every line of a résumé, in reading order: summary sentences, then each role's intro and bullets. */
export function computeLineOrigins(gen: GeneratedResume, experiences: Experience[], opts: { candidateName?: string } = {}): LineOrigin[] {
  const guard = stretchGuard(opts.candidateName);
  const byCompany = byCompanyOf(experiences);
  const all = factsOf(experiences, guard);
  const line = (position: Pick<LineOrigin, "kind" | "role" | "bullet" | "sentence">, text: string, facts: Fact[]): LineOrigin => {
    const t = trace(text, facts, { composed: position.kind === "summary" });
    return { ...position, text, strength: t.strength, overlap: round2(t.overlap), facts: t.facts.map((f) => ({ experience_id: f.experience_id, fact: f.text })) };
  };
  const out: LineOrigin[] = summarySentences(gen.resume.executive_summary ?? "").map((s, i) => line({ kind: "summary", sentence: i }, s, all));
  (gen.resume.experience ?? []).forEach((exp, role) => {
    const own = factsOf(byCompany.get(String(exp.company ?? "").toLowerCase().trim()) ?? [], guard);
    if (exp.summary?.trim()) out.push(line({ kind: "role_intro", role }, exp.summary, own));
    (exp.bullets ?? []).forEach((b, bullet) => out.push(line({ kind: "bullet", role, bullet }, b, own)));
  });
  return out;
}

export function countOrigins(lines: LineOrigin[]): OriginCounts {
  const n = (s: OriginStrength) => lines.filter((l) => l.strength === s).length;
  return { strong: n("strong"), partial: n("partial"), none: n("none") };
}

const clip = (s: string, n = 110) => {
  const t = s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The origins, and what the user decides on:
 *  - a line with no origin: confirm the fact it rests on (it is then saved to
 *    the record and found on the next save), reword it closer to the record,
 *    or drop it;
 *  - a provenance_audit entry whose named source holds no fact for the line
 *    its claim is about, while another entry does. The claim is matched to a
 *    résumé line by the same rule (60% of its content words on one line, and
 *    its numbers); an entry whose claim matches no line, or that names the
 *    profile or the education record, is not compared.
 */
export function checkLineOrigins(gen: GeneratedResume, experiences: Experience[], opts: { candidateName?: string } = {}): LineOriginReport {
  const guard = stretchGuard(opts.candidateName);
  const lines = computeLineOrigins(gen, experiences, opts);
  const companyOf = (l: LineOrigin) => (l.kind === "summary" ? SUMMARY : (gen.resume.experience[l.role!]?.company ?? ""));
  const findings: OriginFinding[] = lines
    .filter((l) => l.strength === "none" && (contentStems(l.text).length > 0 || claimNumbers(l.text).length > 0))
    .map((l) => ({
      rule: "origin" as const,
      kind: "none" as const,
      company: companyOf(l),
      line: l.text,
      detail:
        l.kind === "summary"
          ? "no verified fact of the record was found for this sentence"
          : `no verified fact of the ${companyOf(l)} record was found for this line`,
    }));

  const asFacts: Fact[] = lines.map((l, i) => asFact(String(i), l.text));
  const seen = new Set<string>();
  for (const entry of gen.provenance_audit ?? []) {
    const named = auditSourceExperiences(entry.source_experience, experiences);
    if (!named?.length) continue;
    const about = trace(entry.claim, asFacts, { maxFacts: 1 });
    if (about.strength !== "strong") continue;
    const target = lines[Number(about.facts[0]!.experience_id)]!;
    if (target.strength === "none") continue; // already listed
    const namedIds = new Set(named.map(idOf));
    if (target.facts.some((f) => namedIds.has(f.experience_id))) continue;
    if (trace(target.text, factsOf(named, guard), { composed: target.kind === "summary" }).strength !== "none") continue;
    const key = `${lines.indexOf(target)}|${[...namedIds].join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const found = [...new Set(target.facts.map((f) => f.experience_id))].join(", ");
    findings.push({
      rule: "origin",
      kind: "audit",
      company: companyOf(target),
      line: target.text,
      detail: `the provenance audit names "${clip(entry.source_experience, 60)}" for this line; that entry holds no fact for it, and the facts found are in ${found}`,
    });
  }
  return { lines, counts: countOrigins(lines), findings };
}

export interface OriginSummary extends OriginCounts {
  /** The lines with no origin: the user confirms the fact, rewords the line or drops it. */
  no_origin: { company: string; line: string }[];
  /** provenance_audit entries whose named source holds no fact for the line. */
  audit_disagreements: { company: string; line: string; why: string }[];
}

/** The compact form a save returns to the model: counts, the lines with no origin, the audit disagreements. */
export function summarizeOrigins(report: LineOriginReport): OriginSummary {
  return {
    ...report.counts,
    no_origin: report.findings.filter((f) => f.kind === "none").map((f) => ({ company: f.company, line: f.line })),
    audit_disagreements: report.findings.filter((f) => f.kind === "audit").map((f) => ({ company: f.company, line: f.line, why: f.detail })),
  };
}

const STRENGTHS = new Set<unknown>(["strong", "partial", "none"]);
const KINDS = new Set<unknown>(["bullet", "role_intro", "summary"]);

/**
 * The origins of a résumé read back from `resume.json`: those the save
 * recorded (`saved: true`; malformed entries are skipped), or, for a résumé
 * saved before 2026-11-13, computed now against the record as it is today.
 */
export function readLineOrigins(gen: GeneratedResume, experiences: Experience[], opts: { candidateName?: string } = {}): { lines: LineOrigin[]; saved: boolean } {
  if (Array.isArray(gen.line_origins)) {
    const lines = gen.line_origins.filter(
      (l): l is LineOrigin => !!l && KINDS.has(l.kind) && STRENGTHS.has(l.strength) && typeof l.text === "string" && Array.isArray(l.facts) && l.facts.every((f) => !!f && typeof f.fact === "string"),
    );
    return { lines, saved: true };
  }
  return { lines: computeLineOrigins(gen, experiences, opts), saved: false };
}
