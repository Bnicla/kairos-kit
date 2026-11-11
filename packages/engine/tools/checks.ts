import type { Experience } from "@kairos/engine/kb/types";
import { serializeExperience, stripUnverified } from "@kairos/engine/kb/experience";
import { BANNED_WORDS } from "@kairos/engine/prompts/voice";
import type { GeneratedResume, RequirementCoverageRow } from "@kairos/engine/types";

/**
 * Deterministic quality gates for generated résumés. These run at SAVE time in
 * lib/tools/ops.ts — after the model (or a human) authors the artifact — so the
 * three product promises hold no matter which driver produced it:
 *   1. grounding — every employer and metric traces to verified KB evidence
 *   2. style    — the house-style rules (N5) are machine-checked, not vibes
 *   3. ATS      — the résumé demonstrably carries the job ad's own language
 */

// --- Style ------------------------------------------------------------------

export interface StyleViolation {
  rule: "em-dash" | "not-just-but" | "banned-word" | "empty-adverb" | "verb-clustering" | "leadin-not-title" | "third-person" | "names-kb";
  detail: string;
}

const NOT_JUST = /\b(?:not\s+(?:just|only|merely)|isn't\s+just|it's\s+not\s+about)\b[^.\n]{0,80}\bbut\b/i;

/**
 * Configurable style policy (REQ-14 / DEC-7 content-agnostic engine). The
 * current house rules are the DEFAULTS, not constants baked into behavior:
 * a cloud user's Drive may carry a style-policy.json overriding any field
 * (per-user, eventually per-language). Omitted fields inherit the default.
 */
export interface StylePolicy {
  bannedWords: string[];
  banEmDashes: boolean;
  banNotJustBut: boolean;
  /** Max words for a bold bullet lead-in title. */
  leadinMaxWords: number;
  /** Empty-adverb list (soft violation). */
  emptyAdverbs: string[];
  /** Allow "orchestrat*" near AI/system vocabulary; flag it elsewhere. */
  contextualOrchestration: boolean;
}

export const DEFAULT_STYLE_POLICY: StylePolicy = {
  bannedWords: [...BANNED_WORDS],
  banEmDashes: true,
  banNotJustBut: true,
  leadinMaxWords: 4,
  emptyAdverbs: ["extremely", "incredibly", "deeply", "truly"],
  contextualOrchestration: true,
};

/** Merge a partial user policy onto the defaults (unknown fields ignored). */
export function resolveStylePolicy(partial?: Partial<StylePolicy> | null): StylePolicy {
  if (!partial) return DEFAULT_STYLE_POLICY;
  return {
    bannedWords: Array.isArray(partial.bannedWords) ? partial.bannedWords : DEFAULT_STYLE_POLICY.bannedWords,
    banEmDashes: partial.banEmDashes ?? DEFAULT_STYLE_POLICY.banEmDashes,
    banNotJustBut: partial.banNotJustBut ?? DEFAULT_STYLE_POLICY.banNotJustBut,
    leadinMaxWords: partial.leadinMaxWords ?? DEFAULT_STYLE_POLICY.leadinMaxWords,
    emptyAdverbs: Array.isArray(partial.emptyAdverbs) ? partial.emptyAdverbs : DEFAULT_STYLE_POLICY.emptyAdverbs,
    contextualOrchestration: partial.contextualOrchestration ?? DEFAULT_STYLE_POLICY.contextualOrchestration,
  };
}

/** Hard style violations (em dashes, banned words, "not just X but Y") + soft ones (adverbs). */
export function checkStyle(text: string, policy: StylePolicy = DEFAULT_STYLE_POLICY): StyleViolation[] {
  const out: StyleViolation[] = [];
  if (policy.banEmDashes) {
    const emDashes = (text.match(/—/g) ?? []).length;
    if (emDashes > 0) out.push({ rule: "em-dash", detail: `${emDashes} em dash(es) present` });
  }
  if (policy.banNotJustBut && NOT_JUST.test(text)) {
    out.push({ rule: "not-just-but", detail: `matches "not just X but Y" pattern` });
  }
  for (const w of policy.bannedWords) {
    const re = new RegExp(w.includes(" ") ? escapeRe(w) : `\\b${escapeRe(w)}\\w*`, "i");
    const m = text.match(re);
    if (m) out.push({ rule: "banned-word", detail: `"${m[0]}"` });
  }
  // "orchestration/orchestrate" is real AI terminology (agent orchestration,
  // model orchestration) but a worn-out power-verb in general use. Allow it only
  // when an AI/agent/system term sits nearby; flag it otherwise (owner directive).
  const orchEnabled = policy.contextualOrchestration && !policy.bannedWords.some((w) => w.startsWith("orchestrat"));
  const ORCH_CONTEXT = /\b(agent|agents|model|models|llm|llms|ai|ml|workflow|workflows|pipeline|pipelines|retrieval|rag|eval|evals|evaluation|service|services|microservice|task|tasks|container|kubernetes|prompt|prompts|tool|tools|system|systems|data)\b/i;
  for (const m of orchEnabled ? text.matchAll(/\borchestrat\w*/gi) : []) {
    const i = m.index ?? 0;
    const ctx = text.slice(Math.max(0, i - 60), i + m[0].length + 60);
    if (!ORCH_CONTEXT.test(ctx)) out.push({ rule: "banned-word", detail: `"${m[0]}" (generic power-verb; fine only in AI/agent context)` });
  }
  if (policy.emptyAdverbs.length) {
    const advRe = new RegExp(`\\b(${policy.emptyAdverbs.map(escapeRe).join("|")})\\b`, "gi");
    const adv = text.match(advRe);
    if (adv) out.push({ rule: "empty-adverb", detail: [...new Set(adv.map((a) => a.toLowerCase()))].join(", ") });
  }

  // Soft: the same opening verb on 4+ bullets reads as machine cadence, even
  // when the verb itself isn't banned (the "Drove/Drove/Drove" failure mode).
  const openers = [...text.matchAll(/^-\s+(?:\*\*[^*]+\*\*:?\s*)?(\w+)/gim)].map((m) => m[1].toLowerCase());
  const counts = new Map<string, number>();
  for (const o of openers) counts.set(o, (counts.get(o) ?? 0) + 1);
  const clustered = [...counts.entries()].filter(([, n]) => n >= 4);
  if (clustered.length) {
    out.push({
      rule: "verb-clustering",
      detail: clustered.map(([w, n]) => `"${w}" opens ${n} bullets`).join("; "),
    });
  }

  // HARD: a bold bullet lead-in must be a condensed noun-phrase TITLE
  // (≤4 words, label-like), never a claim, slogan, or sentence. Catches
  // "**Owned outcomes, not requirements:**" and
  // "**Intelligent automation that removes manual effort:**" (user feedback, 2026-07-28).
  // Parenthetical qualifiers like "(0-to-1, shipped)" are allowed and ignored.
  // Only bullet lead-ins are titles: bold at the start of a bullet AND
  // followed by a colon. Bold without a colon (education credentials, inline
  // emphasis) is exempt.
  for (const m of text.matchAll(/^[-*]\s+\*\*([^*]+?)(?::\*\*|\*\*:)/gm)) {
    const leadin = m[1].trim();
    const core = leadin.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    // Connectors (&, +, /) don't count: "Global Expansion & Roadmap Execution" is 4 words.
    const words = core.split(/\s+/).filter((w) => /\w/.test(w));
    const problems: string[] = [];
    const maxWords = policy.leadinMaxWords + 1; // one-word tolerance, matching historic behavior (4 → 5)
    if (words.length > maxWords) problems.push(`${words.length} words (max ${maxWords})`);
    if (core.includes(",")) problems.push("contains a comma (reads as a claim, not a title)");
    if (/\b(that|which|who)\b/i.test(core)) problems.push("contains a relative clause");
    if (problems.length) {
      out.push({ rule: "leadin-not-title", detail: `"${leadin}": ${problems.join("; ")}` });
    }
  }
  return out;
}

/**
 * Résumés are written in implied first person ("Built…", "Owned…"). A pronoun
 * about the candidate ("Builds the agents himself", 2026-11-02) reads as someone
 * else describing them. Résumé-only: cover letters legitimately mention other
 * people. Run on the body, not the header that carries the name.
 */
export function checkResumePerson(text: string): StyleViolation[] {
  const out: StyleViolation[] = [];
  const hits = text.match(/\b(himself|herself|he|she|his|him)\b/gi);
  if (hits) out.push({ rule: "third-person", detail: `${[...new Set(hits.map((h) => h.toLowerCase()))].join(", ")} (résumés use implied first person)` });
  // The personal knowledge base is never named on an outside-facing document
  // (CLAUDE.md); describe it ("a personal agentic system") instead.
  if (/\bkairos\b/i.test(text)) out.push({ rule: "names-kb", detail: `names "Kairos" (describe it, never name it on an outside-facing document)` });
  return out;
}

export const isHardStyleViolation = (v: StyleViolation) =>
  v.rule !== "empty-adverb" && v.rule !== "verb-clustering";

// --- ATS coverage -----------------------------------------------------------

export interface AtsCoverage {
  /** matched/total over the extracted JD terms, 0..1 */
  coverage: number;
  matched: string[];
  missing: string[];
}

const STOPWORDS = new Set(
  ("the a an and or of to in for with on at by from as is are was were be been will would can could should our your their its this that these those you we they it what who whom whose which where when how why not no nor if then than into over under more most other others such own same so too very just also both each any all some few per via must may might do does did done has have had having across within without between about against during before after above below up down out off again further once here there ok").split(" "),
);

/**
 * Extract the job ad's salient vocabulary (acronyms, frequent terms, frequent
 * bigrams) and report how much of it the résumé actually carries. Heuristic and
 * advisory — a recruiter-read complement, not a guarantee — but it catches the
 * failure mode of a tailored résumé that never says the ad's own words.
 */
export function checkAtsCoverage(jobText: string, resumeText: string): AtsCoverage {
  const resume = normalize(resumeText);

  // Acronyms / capitalized tech terms straight from the ad (AI, ML, PMO, GDPR…).
  // Pure A–Z only (no "MA/", "AI-" fragments), minus corporate boilerplate that
  // says nothing about fit.
  const ACRONYM_NOISE = new Set(["nyse", "hq", "usa", "eeo", "llc", "inc", "us", "uk", "eu", "ma", "ny", "tx", "ca", "co", "nh", "ut"]);
  const acronyms = [...new Set(jobText.match(/\b[A-Z][A-Z0-9&+]{1,9}\b/g) ?? [])]
    .filter((a) => a.length >= 2 && !/^\d+$/.test(a) && /^[A-Z]/.test(a))
    .map((a) => a.toLowerCase())
    .filter((a) => !ACRONYM_NOISE.has(a));

  const words = normalize(jobText)
    .split(/[^a-z0-9'+-]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  const unigrams = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([w]) => w);

  const bigrams = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const b = `${words[i]} ${words[i + 1]}`;
    bigrams.set(b, (bigrams.get(b) ?? 0) + 1);
  }
  const topBigrams = [...bigrams.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([b]) => b).slice(0, 10);

  const terms = [...new Set([...acronyms, ...topBigrams, ...unigrams])].slice(0, 30);
  // Stem-blind matching ("translate strategy" must match "translates strategy"):
  // compare with word-final s/es stripped on both sides. Advisory, so the slight
  // looseness is acceptable.
  const stem = (s: string) => s.replace(/(\w)(?:es|s)\b/g, "$1");
  const resumeStemmed = stem(resume);
  const hit = (t: string) => resume.includes(t) || resumeStemmed.includes(stem(t));
  const matched = terms.filter(hit);
  const missing = terms.filter((t) => !hit(t));
  return { coverage: terms.length ? matched.length / terms.length : 1, matched, missing };
}

// --- Grounding (anti-fabrication, mechanical) --------------------------------

export interface GroundingIssue {
  kind: "unknown_employer" | "ungrounded_metric" | "unknown_source" | "metric_source_mismatch";
  detail: string;
}

/**
 * Mechanically verify a generated résumé against the verified KB evidence:
 *  - every experience employer must be a KB experience company
 *  - every metric token in bullets/summaries must appear in the stripped
 *    ([?]-free) KB corpus — a metric the KB doesn't contain cannot ship
 *  - every metric inside an EXPERIENCE SECTION must additionally appear in the
 *    stripped text of THAT experience (source-bound: a real "40%" from company A
 *    cannot ground a "40%" claim written under company B — recombining true
 *    numbers into false claims is fabrication too). The executive summary stays
 *    corpus-wide, because it legitimately aggregates across roles.
 *  - every provenance_audit.source_experience must name a real KB file
 * `extraCorpus` admits curated non-experience sources (profile, education) and
 * also grounds section-level metrics (a summary line may cite profile facts).
 */
export function checkResumeGrounding(
  gen: GeneratedResume,
  experiences: Experience[],
  extraCorpus = "",
): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  const companies = new Set(experiences.map((e) => e.frontmatter.company.toLowerCase().trim()));
  const fileNames = new Set(experiences.map((e) => e.fileName.replace(/\.md$/, "")));
  const strippedByCompany = new Map<string, string>();
  for (const e of experiences) {
    const key = e.frontmatter.company.toLowerCase().trim();
    const text = normalizeMetrics(serializeExperience(stripUnverified(e)));
    // Two KB entries for the same employer merge (e.g. two roles at one company).
    strippedByCompany.set(key, (strippedByCompany.get(key) ?? "") + "\n" + text);
  }
  const extra = normalizeMetrics(extraCorpus);
  const corpus = [...strippedByCompany.values()].join("\n") + "\n" + extra;

  for (const exp of gen.resume.experience) {
    if (!companies.has(exp.company.toLowerCase().trim())) {
      issues.push({ kind: "unknown_employer", detail: `"${exp.company}" is not a knowledge-base experience` });
    }
  }

  // Corpus-wide pass: a metric found NOWHERE in verified evidence is fabricated.
  const prose = [
    gen.resume.executive_summary,
    ...gen.resume.experience.flatMap((e) => [e.summary ?? "", ...e.bullets]),
  ].join("\n");
  for (const token of extractMetricTokens(prose)) {
    if (!corpus.includes(token.normalized)) {
      issues.push({ kind: "ungrounded_metric", detail: `"${token.raw}" not found in any verified KB fact` });
    }
  }

  // Source-bound pass: within each experience section, metrics must come from
  // THAT experience (or the curated extraCorpus). Skip sections whose employer
  // is unknown — that already failed harder above.
  for (const exp of gen.resume.experience) {
    const own = strippedByCompany.get(exp.company.toLowerCase().trim());
    if (own === undefined) continue;
    const sectionText = [exp.summary ?? "", ...exp.bullets].join("\n");
    for (const token of extractMetricTokens(sectionText)) {
      if (!corpus.includes(token.normalized)) continue; // already reported as ungrounded_metric
      if (!own.includes(token.normalized) && !extra.includes(token.normalized)) {
        issues.push({
          kind: "metric_source_mismatch",
          detail: `"${token.raw}" under "${exp.company}" is not in that experience's verified facts (it exists elsewhere in the KB — a true number from one role cannot support a claim in another)`,
        });
      }
    }
  }

  // A source is grounded if it names a real KB experience by ANY of its
  // identifiers — file name, frontmatter id, or company. The guarantee is
  // "traces to a real experience", not "spelled one particular way".
  const ids = new Set(
    experiences.map((e) => (e.frontmatter.id ?? "").toLowerCase().trim()).filter(Boolean),
  );
  for (const entry of gen.provenance_audit) {
    const ref = entry.source_experience.replace(/\.md$/, "").trim();
    const known =
      fileNames.has(ref) ||
      ids.has(ref.toLowerCase()) ||
      companies.has(ref.toLowerCase()) ||
      ["profile", "education"].includes(ref.toLowerCase());
    if (!known) {
      issues.push({
        kind: "unknown_source",
        detail: `provenance source "${entry.source_experience}" is not a KB experience (use a file name, id, or company from the KB)`,
      });
    }
  }
  return issues;
}

interface MetricToken {
  raw: string;
  normalized: string;
}

/**
 * Pull the tokens that would constitute fabrication if invented: money, percents,
 * "40+"-style scale counts, M/B/k-suffixed magnitudes, and large exact numbers.
 * Years (1900–2099), date ranges, and "N+ years" tenure math are excluded —
 * they're derivable, not claims.
 */
export function extractMetricTokens(text: string): MetricToken[] {
  const out: MetricToken[] = [];
  const re = /(?:[$€£]\s?\d[\d.,]*\s?[MBKmbk]?\+?)|(?:\d[\d.,]*\s?%)|(?:\b\d[\d,]*\+)|(?:\b\d{1,3}(?:,\d{3})+\b)|(?:\b\d+(?:\.\d+)?\s?[MBK]\b\+?)/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const after = text.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 12);
    if (/^\s*(years?|yrs?)\b/i.test(after)) continue; // tenure math, not a claim
    const bare = raw.replace(/[^0-9]/g, "");
    if (bare.length === 4 && +bare >= 1900 && +bare <= 2099) continue; // year
    out.push({ raw, normalized: normalizeMetrics(raw) });
  }
  return out;
}

// --- Requirements coverage --------------------------------------------------

/**
 * Minimum share of an evidence quote's content tokens that must appear in ONE
 * résumé line for the light-paraphrase fallback to accept it.
 */
export const COVERAGE_TOKEN_OVERLAP = 0.6;

export interface RequirementCoverageSummary {
  rows: number;
  covered: number;
  partial: number;
  gap: number;
  gaps: { requirement: string; priority: RequirementCoverageRow["priority"]; note: string | null }[];
}

export interface RequirementCoverageCheck {
  /** Hard failures: a covered/partial row whose evidence is missing or not on the résumé. */
  errors: string[];
  /** Advisory: gap rows to surface, or a table too short to be complete. */
  warnings: string[];
  summary: RequirementCoverageSummary;
}

/**
 * Check the requirements coverage table against the rendered résumé markdown.
 *
 * Evidence-matching rule for "covered" and "partial" rows:
 *  1. Exact excerpt. Both sides are normalized (markdown markers stripped,
 *     curly quotes and dash variants unified, whitespace collapsed, lowercase;
 *     leading/trailing quotes, ellipses and end punctuation trimmed from the
 *     evidence). The evidence passes when it is a substring of the résumé.
 *  2. Light-paraphrase fallback. The evidence is compared with each résumé line
 *     (a bullet, a summary line, the skills line, a role heading). It passes
 *     when at least COVERAGE_TOKEN_OVERLAP (60%) of its content tokens
 *     (stopwords dropped, plurals stemmed) appear in a single line AND every
 *     number-bearing token it quotes ("$20M", "90%", "40+") is in that same line.
 *     Matching per line, not across the whole document, stops a quote stitched
 *     together from scattered words from passing; the number rule stops a
 *     paraphrase from citing a figure the line does not contain.
 * A covered/partial row without evidence, or whose evidence fails both tests,
 * is an error naming the row. Gap rows are never matched; they are listed as a
 * warning so the caller surfaces them. Fewer than 3 rows is a warning (the ad
 * almost always states more requirements than that).
 */
export function checkRequirementCoverage(
  rows: RequirementCoverageRow[],
  resumeMarkdown: string,
): RequirementCoverageCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const haystack = normalizeEvidenceText(resumeMarkdown);
  const lines = resumeMarkdown
    .split("\n")
    .map((l) => evidenceTokens(normalizeEvidenceText(l)))
    .filter((t) => t.length > 0)
    .map((t) => new Set(t));

  rows.forEach((row, i) => {
    if (row.status === "gap") return;
    const label = `requirement_coverage[${i}] "${clip(row.requirement, 80)}" (${row.status})`;
    const evidence = row.evidence?.trim() ?? "";
    if (!evidence) {
      errors.push(
        `${label} has no evidence: quote the résumé line that demonstrates it, or mark the row "gap" with an honest note`,
      );
      return;
    }
    const needle = normalizeEvidenceText(evidence).replace(/^["'.…\s]+|["'.,;:…\s]+$/g, "");
    if (needle && haystack.includes(needle)) return;

    const content = evidenceTokens(needle);
    const numbers = content.filter((t) => /\d/.test(t));
    let best = 0;
    let bestMissingNumbers: string[] = [];
    for (const line of lines) {
      const overlap = content.length ? content.filter((t) => line.has(t)).length / content.length : 0;
      const missingNumbers = numbers.filter((n) => !line.has(n));
      if (overlap >= COVERAGE_TOKEN_OVERLAP && missingNumbers.length === 0) return;
      if (overlap > best) {
        best = overlap;
        bestMissingNumbers = missingNumbers;
      }
    }
    const why =
      best >= COVERAGE_TOKEN_OVERLAP
        ? `the closest line lacks ${bestMissingNumbers.join(", ")}`
        : `best single-line token overlap ${Math.round(best * 100)}%, needs ${Math.round(COVERAGE_TOKEN_OVERLAP * 100)}%`;
    errors.push(`${label}: evidence is not on the résumé (${why}): "${clip(evidence, 120)}"`);
  });

  const gaps = rows
    .filter((r) => r.status === "gap")
    .map((r) => ({ requirement: r.requirement, priority: r.priority, note: r.note?.trim() || null }));
  if (gaps.length) {
    warnings.push(
      `requirement coverage: ${gaps.length} gap${gaps.length === 1 ? "" : "s"} to surface: ` +
        gaps.map((g) => `${g.requirement} (${g.priority})${g.note ? `: ${g.note}` : ""}`).join("; "),
    );
  }
  if (rows.length < 3) {
    warnings.push(
      `requirement coverage: only ${rows.length} row${rows.length === 1 ? "" : "s"}; the ad likely states more requirements (some may have been skipped)`,
    );
  }

  const count = (s: RequirementCoverageRow["status"]) => rows.filter((r) => r.status === s).length;
  return {
    errors,
    warnings,
    summary: { rows: rows.length, covered: count("covered"), partial: count("partial"), gap: count("gap"), gaps },
  };
}

/** Comparison form for coverage evidence: plain text, unified punctuation, collapsed whitespace, lowercase. */
function normalizeEvidenceText(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\*/g, "")
    .toLowerCase()
    .replace(/[’‘´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content tokens of normalized text: stopwords dropped, then plurals stemmed and thousands separators removed. */
function evidenceTokens(normalized: string): string[] {
  const raw = normalized.match(/[a-z0-9$€£%+#&]+(?:[.,'-][a-z0-9$€£%+#&]+)*/g) ?? [];
  return raw
    .filter((t) => !STOPWORDS.has(t))
    .map((t) => (/\d/.test(t) ? t.replace(/(\d),(?=\d{3})/g, "$1") : stemPlural(t)));
}

function stemPlural(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// --- helpers ----------------------------------------------------------------

const normalize = (s: string) => s.toLowerCase().replace(/[’']/g, "'");
/** Comparison form for metric matching: lowercase, no commas/spaces. */
const normalizeMetrics = (s: string) => s.toLowerCase().replace(/[,\s]/g, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
