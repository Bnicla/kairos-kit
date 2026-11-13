import type { Experience } from "@kairos/engine/kb/types";
import { serializeExperience, stripUnverified } from "@kairos/engine/kb/experience";
import { BANNED_WORDS } from "@kairos/engine/prompts/voice";
import type { GeneratedResume, RequirementCoverageRow } from "@kairos/engine/types";
import { DEFAULT_ALLOWED_METRIC_STATUSES, registerEntries, type MetricStatus } from "@kairos/engine/metrics-register";

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
  kind:
    | "unknown_employer"
    | "ungrounded_metric"
    | "unknown_source"
    | "metric_source_mismatch"
    | "ungrounded_count"
    | "count_source_mismatch"
    | "ungrounded_credential"
    | "ungrounded_skill"
    | "unknown_organisation";
  detail: string;
}

/** Findings the candidate decides on (reported as warnings); every other kind blocks the save. */
export const ADVISORY_GROUNDING: ReadonlySet<GroundingIssue["kind"]> = new Set(["ungrounded_skill"]);

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
 *  - every plain count ("a team of 12", "40 users", "three clinics") must appear
 *    as a number in the verified text of that employer (2026-11-12: the
 *    provenance comparison showed a count the KB never states passed the gate).
 *    In the summary the number may be anywhere in the evidence; a count found
 *    nowhere blocks, unless the record could add up to it across roles (see
 *    `composableTotal`): the stretch check then lists it as a total
 *  - a credential (skills line or prose) must be in the verified evidence, and
 *    so must every education entry when the record holds education; a named
 *    tool or acronym on the skills line found nowhere in it is reported, not
 *    blocked
 *  - an organisation named in prose after "at" ("At Acme, I …", "two years at
 *    Acme"), in the summary, a role intro or a bullet, must be named somewhere
 *    in the verified evidence: an employer written into a sentence is checked
 *    like one written as a section heading
 * `extraCorpus` admits curated non-experience sources (profile, education) and
 * also grounds section-level metrics (a summary line may cite profile facts).
 */
export function checkResumeGrounding(
  gen: GeneratedResume,
  experiences: Experience[],
  extraCorpus = "",
  opts: {
    /** The record holds education entries (they are in `extraCorpus`): check the résumé's education against them. */
    educationRecorded?: boolean;
    /** The company the résumé is written for. Naming it inside a sentence ("the design team at Acme") is not a claim to have worked there. */
    targetCompany?: string;
  } = {},
): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  const companies = new Set(experiences.map((e) => e.frontmatter.company.toLowerCase().trim()));
  const fileNames = new Set(experiences.map((e) => e.fileName.replace(/\.md$/, "")));
  const strippedByCompany = new Map<string, string>();
  const rawByCompany = new Map<string, string>();
  for (const e of experiences) {
    const key = e.frontmatter.company.toLowerCase().trim();
    const raw = serializeExperience(stripUnverified(e));
    const text = normalizeMetrics(raw);
    // Two KB entries for the same employer merge (e.g. two roles at one company).
    strippedByCompany.set(key, (strippedByCompany.get(key) ?? "") + "\n" + text);
    rawByCompany.set(key, (rawByCompany.get(key) ?? "") + "\n" + raw);
  }
  const extra = normalizeMetrics(extraCorpus);
  const corpus = [...strippedByCompany.values()].join("\n") + "\n" + extra;

  for (const exp of gen.resume.experience) {
    if (!companies.has(exp.company.toLowerCase().trim())) {
      issues.push({ kind: "unknown_employer", detail: `"${exp.company}" is not a knowledge-base experience` });
    }
  }

  // Corpus-wide pass: a metric found NOWHERE in verified evidence is fabricated.
  const prose = resumeClaimText(gen);
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

  // Plain counts. Same two passes as the metrics: a count found nowhere is
  // invented; a count under an employer must be a number of THAT employer.
  const extraNumbers = numbersIn(extraCorpus);
  const allNumbers = new Set(extraNumbers);
  const numbersByCompany = new Map<string, Set<string>>();
  for (const [key, raw] of rawByCompany) {
    const set = numbersIn(raw);
    numbersByCompany.set(key, set);
    for (const n of set) allNumbers.add(n);
  }
  const entryTexts = experiences.map((e) => serializeExperience(stripUnverified(e)));
  for (const token of extractCountTokens(gen.resume.executive_summary)) {
    if (allNumbers.has(token.value)) continue;
    // "Five products", "three markets": a total composed across roles is on no
    // single line. When the record could add up to it, the save is not blocked
    // and the stretch check lists the total for the candidate to confirm.
    if (composableTotal(token, entryTexts)) continue;
    issues.push({ kind: "ungrounded_count", detail: `"${token.raw}" (summary): the number ${token.value} is not in any verified KB fact` });
  }
  for (const exp of gen.resume.experience) {
    const own = numbersByCompany.get(exp.company.toLowerCase().trim());
    if (own === undefined) continue;
    for (const token of extractCountTokens([exp.summary ?? "", ...exp.bullets].join("\n"))) {
      if (own.has(token.value) || extraNumbers.has(token.value)) continue;
      issues.push(
        allNumbers.has(token.value)
          ? { kind: "count_source_mismatch", detail: `"${token.raw}" under "${exp.company}": the number ${token.value} is not in that experience's verified facts (it exists elsewhere in the KB)` }
          : { kind: "ungrounded_count", detail: `"${token.raw}" under "${exp.company}": the number ${token.value} is not in any verified KB fact` },
      );
    }
  }

  // Organisations named in prose. An employer of the record, or a name a
  // verified fact, the profile or the education record holds, is accepted; a
  // name found nowhere is an organisation the record does not know.
  const companyNames = experiences.map((e) => e.frontmatter.company);
  const recorded = [...rawByCompany.values()].join("\n");
  const proseUnits = [
    { where: "summary", text: gen.resume.executive_summary },
    ...gen.resume.experience.flatMap((exp) => [exp.summary ?? "", ...exp.bullets].map((text) => ({ where: `under "${exp.company}"`, text }))),
  ];
  const target = opts.targetCompany?.trim() ? [opts.targetCompany] : [];
  for (const unit of proseUnits) {
    for (const org of proseOrganisations(unit.text, companyNames, recorded, extraCorpus)) {
      if (org.status !== "unknown") continue;
      // "At <the hiring company>, I …" opening a sentence is still a claim to have worked there.
      if (!org.opening && target.length && proseOrganisations(`at ${org.name}`, target, "")[0]?.status === "company") continue;
      issues.push({ kind: "unknown_organisation", detail: `"at ${org.name}" (${unit.where}): "${org.name}" is not an employer of the knowledge base and is named in no verified fact` });
    }
  }

  // Skills, credentials and education. A credential (on the skills line or
  // in prose) and an education entry must sit on one line of the verified
  // evidence. A named tool or acronym on the skills line that the evidence
  // never mentions is reported, not blocked: skills lines are themes in the
  // candidate's own words, and only their named terms can be checked.
  const evidence = [...rawByCompany.values(), extraCorpus].join("\n");
  const evidenceLines = evidence.split("\n").map(wordSet).filter((w) => w.size);
  const evidenceWords = new Set(evidenceLines.flatMap((w) => [...w]));
  const evidenceTerms = termSet(evidence);
  const onOneLine = (words: string[]) => evidenceLines.some((line) => words.every((w) => line.has(w)));
  const credentialIssue = (phrase: string, where: string) => {
    // The name must be on one line; the marker word itself ("certified") need not be.
    const words = [...wordSet(phrase)].filter((w) => !CREDENTIAL_MARKER.test(w));
    if (words.length && !onOneLine(words)) {
      issues.push({ kind: "ungrounded_credential", detail: `"${phrase.trim()}" (${where}) is not a credential in the verified KB evidence` });
    }
  };
  for (const skill of gen.resume.skills ?? []) {
    const segments = skill.split(/[(),;]|\s[&\/]\s/).map((x) => x.trim()).filter(Boolean);
    const credentials = segments.filter((seg) => CREDENTIAL_RE.test(seg));
    for (const seg of credentials) credentialIssue(seg, "skills");
    // "Data stores: Postgres, Redis": the part before the colon is a category
    // label in the writer's words, and each item after it is a name.
    const colon = skill.indexOf(":");
    const items = colon > 0 ? skill.slice(colon + 1).split(/[(),;]|\s[&\/]\s/).map((x) => x.trim()).filter(Boolean) : segments;
    const rest = items.filter((seg) => !credentials.includes(seg));
    const missing = namedTerms(rest, colon > 0 || segments.length === 1).filter((t) => !GENERIC_ACRONYMS.has(singular(t.toLowerCase()))).filter((t) => !evidenceTerms.has(t.toLowerCase()) && !evidenceTerms.has(singular(t.toLowerCase())));
    if (missing.length) {
      issues.push({ kind: "ungrounded_skill", detail: `"${skill}" (skills): ${missing.map((m) => `"${m}"`).join(", ")} appears nowhere in the verified KB evidence` });
    }
  }
  for (const phrase of credentialPhrases(prose)) credentialIssue(phrase, "résumé text");
  // Without an education record there is nothing to check an entry against:
  // a user who keeps education only on the résumé is not blocked.
  for (const ed of opts.educationRecorded ? (gen.resume.education ?? []) : []) {
    const institution = [...wordSet(ed.institution)];
    const credential = [...wordSet(ed.credential)];
    const known = credential.filter((w) => evidenceWords.has(w)).length;
    if ((institution.length && !onOneLine(institution)) || (credential.length && known * 2 < credential.length)) {
      issues.push({ kind: "ungrounded_credential", detail: `"${ed.credential}, ${ed.institution}" (education) is not in the verified KB evidence` });
    }
  }

  // A source is grounded if it names a real KB experience by ANY of its
  // identifiers — file name, frontmatter id, or company. The guarantee is
  // "traces to a real experience", not "spelled one particular way": a label
  // that adds a title or a detail ("Acme (Senior PM)", "Education: B.S. ...")
  // is read by its head. Seven of eight blocked saves in the provenance run of
  // 2026-11-12 were such labels, none about a fact.
  const ids = new Set(
    experiences.map((e) => (e.frontmatter.id ?? "").toLowerCase().trim()).filter(Boolean),
  );
  const lowerFiles = new Set([...fileNames].map((f) => f.toLowerCase()));
  const namesKnownSource = (label: string): boolean => {
    const ref = label.replace(/\.md\b/, "").trim().toLowerCase();
    const exact = (r: string) => lowerFiles.has(r) || ids.has(r) || companies.has(r) || r === "profile" || r === "education";
    if (exact(ref)) return true;
    if (/^(?:education|profile)\b/.test(ref)) return true;
    const head = ref.split(/\s*(?:\(|\[|—|–|\s-\s|:|,|\||\/)/)[0]!.trim();
    if (head && exact(head)) return true;
    return [...companies, ...ids, ...lowerFiles].some((name) => name.length >= 3 && ref.startsWith(name) && !/[a-z0-9]/.test(ref[name.length] ?? ""));
  };
  for (const entry of gen.provenance_audit) {
    if (!namesKnownSource(entry.source_experience)) {
      issues.push({
        kind: "unknown_source",
        detail: `provenance source "${entry.source_experience}" is not a KB experience (use a file name, id, or company from the KB)`,
      });
    }
  }
  return issues;
}

/** The résumé text whose numbers are checked: the summary, and each role's summary and bullets. */
export function resumeClaimText(gen: GeneratedResume): string {
  return [
    gen.resume.executive_summary,
    ...gen.resume.experience.flatMap((e) => [e.summary ?? "", ...e.bullets]),
  ].join("\n");
}

// --- Metrics register (number statuses) -------------------------------------

export interface MetricStatusIssue {
  /** The number as written in the document. */
  number: string;
  /** Name, section and status of the register entry it matches. */
  entry: string;
  section: string;
  status: MetricStatus;
}

/** Comparison form of a number for the register: the metric form, without a sentence's closing "." or ",". */
const registerKey = (normalized: string) => normalized.replace(/[.,]+$/, "");

/**
 * Numbers in a document that the metrics register does not allow there.
 *
 * A number matches a register entry when it is written anywhere in the entry:
 * on its header line (`**name** — STATUS note`) or in the bullets under it
 * (baseline, outcome, caveats). It is refused when every entry it matches has
 * a status outside `allowed`; one allowed entry carrying the same number is
 * enough to let it through. Numbers the register does not hold, entries
 * written with no status word, and a missing or empty register produce no
 * issue: the grounding check alone decides those, as before.
 */
export function registerBlockedNumbers(
  text: string,
  registerRaw: string | null | undefined,
  allowed: readonly MetricStatus[] = DEFAULT_ALLOWED_METRIC_STATUSES,
): MetricStatusIssue[] {
  if (!registerRaw?.trim()) return [];
  const entries = registerEntries(registerRaw).map((e) => ({
    ...e,
    numbers: new Set(extractMetricTokens(e.text).map((t) => registerKey(t.normalized))),
  }));
  const out: MetricStatusIssue[] = [];
  const seen = new Set<string>();
  for (const token of extractMetricTokens(text)) {
    const key = registerKey(token.normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    const matches = entries.filter((e) => e.numbers.has(key));
    if (!matches.length || matches.some((e) => allowed.includes(e.status))) continue;
    const m = matches[0];
    out.push({ number: token.raw.trim(), entry: m.name, section: m.section, status: m.status });
  }
  return out;
}

/** One sentence naming each refused number and its entry, for a save error. */
export function describeMetricStatusIssues(issues: MetricStatusIssue[], allowed: readonly MetricStatus[] = DEFAULT_ALLOWED_METRIC_STATUSES): string {
  return (
    issues.map((i) => `"${i.number}" matches the metrics-register entry "${i.entry}" (${i.status}, under "${i.section}")`).join("; ") +
    `. Only ${allowed.join(" and ")} numbers may appear in a document: remove the number, or have the user settle its status in the register first.`
  );
}

interface MetricToken {
  raw: string;
  normalized: string;
  /** Where the token starts in the text. */
  index: number;
}

/**
 * Pull the tokens that would constitute fabrication if invented: money, percents,
 * "40+"-style scale counts, M/B/k-suffixed magnitudes, and large exact numbers.
 * Years (1900–2099), date ranges, and "N+ years" tenure math are excluded —
 * they're derivable, not claims.
 */
/**
 * Numbers in a free-form document (a cover letter) that appear nowhere in the
 * sources it may use: the verified record (unverified facts removed), plus
 * `extraCorpus` (profile, education, the posting itself). Each returned token
 * is a number the writer could not have taken from the record.
 */
export function ungroundedNumbers(text: string, experiences: Experience[], extraCorpus = ""): string[] {
  const corpus = experiences.map((e) => normalizeMetrics(serializeExperience(stripUnverified(e)))).join("\n") + "\n" + normalizeMetrics(extraCorpus);
  return [...new Set(extractMetricTokens(text).filter((t) => !corpus.includes(t.normalized)).map((t) => t.raw))];
}

export function extractMetricTokens(text: string): MetricToken[] {
  const out: MetricToken[] = [];
  const re = /(?:[$€£]\s?\d[\d.,]*\s?[MBKmbk]?\+?)|(?:\d[\d.,]*\s?%)|(?:\b\d[\d,]*\+)|(?:\b\d{1,3}(?:,\d{3})+\b)|(?:\b\d+(?:\.\d+)?\s?[MBK]\b\+?)/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const after = text.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 12);
    if (/^\s*(years?|yrs?)\b/i.test(after)) continue; // tenure math, not a claim
    const bare = raw.replace(/[^0-9]/g, "");
    if (bare.length === 4 && +bare >= 1900 && +bare <= 2099) continue; // year
    out.push({ raw, normalized: normalizeMetrics(raw), index: m.index ?? 0 });
  }
  return out;
}

export interface CountToken {
  /** The number with the word after it, as written. */
  raw: string;
  /** The number in digits ("12", "1.8"). */
  value: string;
  /** Where the number starts in the text (bold markers removed). */
  index: number;
}

export const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60",
  seventy: "70", eighty: "80", ninety: "90", hundred: "100",
};

/** A number after one of these is a label ("phase 2", "top 10"), not a count. */
const LABEL_BEFORE = new Set(
  "phase tier level version step stage wave round type grade series gen generation sprint release quarter year day week month top no number page section priority sev rank figure table chapter class category item rule track cohort batch season volume vol web".split(" "),
);

const COUNT_UNIT =
  "person|people|member|engineer|developer|designer|analyst|site|country|market|team|city|state|school|store|product|week|month|day|hour|minute|strong";

/**
 * Plain counts: a bare number (digits, or two to twelve spelled out) that the
 * metric tokens do not cover, such as "a team of 12", "40 users", "3 clinics",
 * "4-person team" or "1.8 billion entries". Excluded, as not being claims:
 * years and "N years" tenure, labels ("Phase 2", "Top 10"), a number after a
 * capitalized name inside a sentence ("Python 3", "Series B 2"), and anything
 * glued to letters or symbols ("p99", "24/7", "Q3", "$5", "12%").
 */
export function extractCountTokens(text: string): CountToken[] {
  const out: CountToken[] = [];
  const clean = text.replace(/\*\*/g, "");
  const push = (raw: string, value: string, index: number) => out.push({ raw: raw.replace(/\s+/g, " ").trim(), value: value.replace(/^0+(?=\d)/, ""), index });

  const digits = /(?<![\w.,$€£#\/@-])(\d{1,7}(?:\.\d+)?)(?=\s+[A-Za-z(]|[.,;:)]?(?:\s|$))/g;
  for (const m of clean.matchAll(digits)) {
    const value = m[1]!;
    const at = m.index ?? 0;
    const after = clean.slice(at + value.length, at + value.length + 24);
    const before = clean.slice(Math.max(0, at - 40), at);
    if (/^\s*(?:years?|yrs?)\b/i.test(after)) continue; // tenure math, not a claim
    if (/^\s?(?:%|[MBKmbk]\b|\+)/.test(after)) continue; // a metric token, checked above
    if (/^\d{4}$/.test(value) && +value >= 1900 && +value <= 2099) continue; // year
    if (ellipticalTenure(clean.slice(Math.max(0, at - 90), at), after)) continue;
    const prev = before.match(/([A-Za-z][\w.+#'’-]*)\s*$/);
    if (prev) {
      const word = prev[1]!;
      if (LABEL_BEFORE.has(word.toLowerCase())) continue;
      const lead = before.slice(0, prev.index).trimEnd();
      // A capitalized word inside a sentence names a product or a version ("Python 3").
      if (/^[A-Z]/.test(word) && lead && !/[.;:!?•\n-]$/.test(lead)) continue;
    }
    const next = after.match(/^\s+([A-Za-z][\w-]*)/);
    push(next ? `${value} ${next[1]}` : value, value, at);
  }

  const hyphen = new RegExp(`(?<![\\w.,$€£#\\/@-])(\\d{1,4})-(?:${COUNT_UNIT})\\b`, "gi");
  for (const m of clean.matchAll(hyphen)) push(m[0], m[1]!, m.index ?? 0);

  const spelled = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+([a-z][\w-]*)/gi;
  for (const m of clean.matchAll(spelled)) {
    if (/^(?:years?|yrs?)$/i.test(m[2]!)) continue;
    if (ellipticalTenure(clean.slice(Math.max(0, (m.index ?? 0) - 90), m.index ?? 0), ` ${m[2]}`)) continue;
    push(m[0], NUMBER_WORDS[m[1]!.toLowerCase()]!, m.index ?? 0);
  }
  return out;
}

/** "Twelve years in design, with more than six in analytics": the second number is still years. */
const ellipticalTenure = (before: string, after: string) => /\byears?\b[^.;\n]*$/i.test(before) && /^\s+(?:in|at|as|on|with)\b/i.test(after);

/**
 * Every number the evidence states as a plain number: digits (thousands commas
 * removed) and spelled-out numbers. Money and percentages are left out (they
 * cannot ground a count), and so are the parts of a date ("2021-08").
 */
function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  const clean = text.replace(/\*\*/g, "");
  for (const m of clean.matchAll(/(?<![\w.$€£]|\d[-,\/])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?!\d|\s?%|[-\/]\d)/g)) {
    out.add(`${m[1]!.replace(/,/g, "").replace(/^0+(?=\d)/, "")}${m[2] ?? ""}`);
  }
  for (const m of clean.toLowerCase().matchAll(/\b[a-z]+\b/g)) {
    const n = NUMBER_WORDS[m[0]];
    if (n) out.add(n);
  }
  return out;
}

/** One number of a résumé line, with a test for whether a line of evidence states it. */
export interface ClaimNumber {
  /** The number as written ("40%", "12 engineers", "three clinics"). */
  raw: string;
  /** Where it starts in the text, once the bold markers are removed. */
  index: number;
  /** True for a plain count ("12 engineers"), false for a metric token ("40%", "$5M"). */
  count: boolean;
  /** For a plain count, the word after the number (what is counted). */
  unit?: string;
  /** True when the line of evidence states the same number. */
  statedIn(line: string): boolean;
}

/** Every checked number of a résumé line: the metric tokens and the plain counts. */
export function claimNumbers(text: string): ClaimNumber[] {
  const clean = text.replace(/\*\*/g, "");
  return [
    ...extractMetricTokens(clean).map((t) => ({ raw: t.raw.trim(), index: t.index, count: false, statedIn: (line: string) => normalizeMetrics(line).includes(registerKey(t.normalized)) })),
    ...extractCountTokens(clean).map((t) => ({
      raw: t.raw,
      index: t.index,
      count: true,
      ...(/\s/.test(t.raw) ? { unit: t.raw.split(" ")[1]! } : {}),
      statedIn: (line: string) => numbersIn(line).has(t.value),
    })),
  ];
}

// --- Organisations named in prose --------------------------------------------

export interface ProseOrganisation {
  /** The name as written after "at". */
  name: string;
  /** "At <Name>, …" opening a sentence: the name is given as the place of work. */
  opening: boolean;
  /**
   * company: an employer of the record. extra: named in the profile, the base
   * résumé or the education record. recorded: named in a verified fact (a
   * client, a partner, a site). unknown: named nowhere.
   */
  status: "company" | "extra" | "recorded" | "unknown";
}

const ORG_WORD = "[A-Z][A-Za-z0-9&+]*(?:[.'’-][A-Za-z0-9&+]+)*";
const ORG_NAME = `${ORG_WORD}(?:\\s+(?:(?:of|and|for|the|de|&)\\s+)?${ORG_WORD})*`;
const AT_ORG = new RegExp(`(?<![\\w-])(At|at)\\s+(?:the\\s+)?(${ORG_NAME})`, "g");

/** Capitalized words after "at" that name a time, a stage or a rank, not an organisation. */
const NOT_ORG = new Set(
  "january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday q1 q2 q3 q4 h1 h2 fy ga mvp ipo eol eoy p0 p1 p2 series phase level stage tier day year launch scale peak fortune".split(" "),
);
/** "at Director level", "at Fortune 500 companies": the capitalized words qualify the noun after them. */
const ORG_QUALIFIES = /^\s+(?:\d+\s+)?(?:level|scale|stage|grade|tier|speed|pace|rate|time|launch|close|size|risk|cost|volume|companies|firms|startups|start-ups|banks|schools|universities|clients|customers|retailers|agencies|organisations|organizations|institutions|enterprises|brands|hospitals|insurers)\b/i;
/** "aimed at", "priced at": the word after "at" is a target or a value, not a place. */
const AT_OF_A_VERB = /\b(?:aimed|targeted|directed|looked|pointed|geared|priced|valued|capped|set)\s*$/i;

const ORG_NOISE = new Set("the and of for de inc llc ltd corp co company corporation plc gmbh sa".split(" "));
const orgTokens = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/['’]s\b/g, "").split(/[^a-z0-9+]+/).filter((w) => w && !ORG_NOISE.has(w));

/**
 * Organisations a résumé line names after "at": "At Acme, I built …", "two
 * years at Acme Robotics". A name is read as a run of capitalized words (with
 * "of", "and", "&" between them); the bold lead-in of a bullet is a title and
 * is left out. Each name is looked up in the record: the employers first, then
 * the profile, base résumé and education (`extra`), then the verified facts
 * (`recorded`). A name of several words is found when it, or its first two
 * words or more, appear together. English only: the rule reads the word "at".
 */
export function proseOrganisations(text: string, companies: string[], recorded: string, extra = ""): ProseOrganisation[] {
  const out: ProseOrganisation[] = [];
  const clean = text.replace(/\*\*[^*]*\*\*/g, " ");
  const matches = [...clean.matchAll(AT_ORG)];
  if (!matches.length) return out;
  const companyTokens = companies.map(orgTokens).filter((c) => c.length);
  const phrase = (s: string) => ` ${orgTokens(s).join(" ")} `;
  const recordedText = phrase(recorded);
  const extraText = phrase(extra);
  // Strict: the name is an employer's name (or part of it), or is written as such in the evidence.
  // Loose: the name starts with a known name and adds words ("Acme Robotics Fleet Software").
  const statusOf = (name: string, loose: boolean): ProseOrganisation["status"] | null => {
    const t = orgTokens(name);
    if (!t.length) return null;
    if (companyTokens.some((c) => t.every((w) => c.includes(w)) || (loose && c.every((w) => t.includes(w))))) return "company";
    for (let n = t.length; n >= (loose ? Math.min(2, t.length) : t.length); n--) {
      const head = ` ${t.slice(0, n).join(" ")} `;
      if (extraText.includes(head)) return "extra";
      if (recordedText.includes(head)) return "recorded";
    }
    return "unknown";
  };
  for (const m of matches) {
    const at = m.index ?? 0;
    const before = clean.slice(0, at).trimEnd();
    const after = clean.slice(at + m[0].length);
    // "Acme's London office": the name ends at the possessive.
    const words = m[2]!.split(/\s+/);
    const owner = words.findIndex((w) => /['’]s$/.test(w));
    const name = (owner >= 0 ? words.slice(0, owner + 1) : words).join(" ").replace(/['’]s$/, "");
    if (NOT_ORG.has(words[0]!.toLowerCase()) || AT_OF_A_VERB.test(before) || (owner < 0 && ORG_QUALIFIES.test(after))) continue;
    const opening = m[1] === "At" && (before === "" || /[.!?;:•\n-]$/.test(before));
    // "at Acme and Borealis": two names, each looked up on its own, unless the
    // record writes the whole as one name ("Crane & Wills Advisory").
    const strict = statusOf(name, false);
    if (!strict) continue;
    const parts = strict === "unknown" ? name.split(/\s+(?:and|&)\s+/) : [name];
    for (const part of parts) {
      const status = strict === "unknown" ? statusOf(part, true) : strict;
      if (status) out.push({ name: part, opening, status });
    }
  }
  return out;
}

/**
 * Whether a count of the summary can be a total composed across roles: what it
 * counts ("products" in "five products") is mentioned in the verified text of
 * at least two record entries, and the count is no larger than the record can
 * add up to: the numbers it states for that thing, plus one for every line
 * that mentions it. "Led 60 engineers" over a record that mentions 3 and 15
 * engineers is not a total.
 */
export function composableTotal(token: CountToken, entryTexts: string[]): boolean {
  const unit = /\s/.test(token.raw) ? stemPlural(token.raw.split(" ")[1]!.toLowerCase()) : "";
  if (!unit || unit.length < 3) return false;
  let entries = 0;
  let bound = 0;
  for (const text of entryTexts) {
    let mentioned = false;
    for (const line of text.split("\n")) {
      const words = line.toLowerCase().replace(/(\d),(?=\d{3})/g, "$1").split(/[^a-z0-9.]+/).filter(Boolean);
      if (!words.some((w) => stemPlural(w.replace(/\.+$/, "")) === unit)) continue;
      mentioned = true;
      bound += 1;
      words.forEach((w, i) => {
        const n = /^\d+(?:\.\d+)?$/.test(w) ? Number(w) : Number(NUMBER_WORDS[w] ?? NaN);
        // "3 clinics", "3 new clinics": the number sits just before what it counts.
        if (!Number.isNaN(n) && words.slice(i + 1, i + 4).some((x) => stemPlural(x.replace(/\.+$/, "")) === unit)) bound += n;
      });
    }
    if (mentioned) entries++;
  }
  return entries >= 2 && Number(token.value) <= bound;
}

/** A skills-line entry (or one segment of it) that names a credential rather than a skill. */
const CREDENTIAL_RE = /\b(?:certif\w*|licen[sc]\w*|accredit\w*|chartered|credential\w*|diploma|pmp|capm|cspo|csm|psm|cfa|cpa|cissp|cisa|cism|itil|prince2|ccna|ccnp|cka|ckad|phr|sphr|frm)\b/i;

const SKILL_STOPWORDS = new Set("and or of the a an in on for to with at by from as via including incl etc e g i e".split(" "));

/** Words of a phrase for evidence matching: lowercase, light plural/verb stemming, "certified/certification" folded. */
function wordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9+#]+/)) {
    if (!raw || SKILL_STOPWORDS.has(raw)) continue;
    if (raw.length === 1 && !/[a-z]/.test(raw)) continue;
    out.add(/^certif/.test(raw) ? "certif" : raw.length > 4 ? raw.replace(/(?:ing|ed|es|s)$/, "") : raw);
  }
  return out;
}

const CREDENTIAL_ACRONYMS = "PMP|CAPM|CSPO|CSM|PSM|CFA|CPA|CISSP|CISA|CISM|ITIL|PRINCE2|CCNA|CCNP|CKA|CKAD|PHR|SPHR|FRM";

/**
 * Credential claims in prose: "Certified Scrum Product Owner", "AWS Solutions
 * Architect certification", or one of the common credential acronyms. Only
 * capitalized names are read, so "certified 40 partners" and "the company's
 * safety certification" are not claims of a credential.
 */
export function credentialPhrases(text: string): string[] {
  const out = new Set<string>();
  const clean = text.replace(/\*\*/g, "");
  const name = "(?:[A-Z][\\w+#-]*(?:\\s+(?:of|in|for)\\s+|\\s+)){0,5}[A-Z][\\w+#-]*";
  for (const m of clean.matchAll(new RegExp(`\\b(?:[Cc]ertified|[Ll]icensed|[Cc]hartered|[Aa]ccredited)\\s+(${name})`, "g"))) out.add(`Certified ${m[1]}`);
  for (const m of clean.matchAll(new RegExp(`\\b(${name})\\s+(?:[Cc]ertification|[Cc]ertificate|[Cc]ertified|[Ll]icen[sc]e|[Cc]redential)\\b`, "g"))) out.add(`${m[1]} certification`);
  for (const m of clean.matchAll(new RegExp(`\\b(?:${CREDENTIAL_ACRONYMS})\\b`, "g"))) out.add(m[0]);
  return [...out];
}

/** Business shorthand that says nothing checkable about the candidate. */
const GENERIC_ACRONYMS = new Set("kpi okr mvp prd roi b2b b2c gtm ux ui qa cx smb".split(" "));

const CREDENTIAL_MARKER = /^(?:certif|licen[sc]\w*|accredit\w*|chartered|credential\w*)$/;

const singular = (t: string) => t.replace(/s$/, "");

/** Tokens of the evidence for named-term lookup, lowercase, with singular forms. */
function termSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const t = raw.replace(/^\.+|\.+$/g, "");
    if (!t) continue;
    out.add(t);
    out.add(singular(t));
    for (const part of t.split(".")) if (part) out.add(part);
  }
  return out;
}

/**
 * The named terms of a skills entry, given as its segments: acronyms ("RAG",
 * "KPIs"), names with a digit, an inner capital or a symbol ("M365",
 * "PostgreSQL", "C++"), and capitalized words other than a segment's first
 * word ("Google Maps SDK" gives Maps and SDK). An entry that is one single
 * word is a named term ("Kafka"). Ordinary words are themes, not names.
 */
export function namedTerms(segments: string[], wholeEntry = segments.length === 1): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    const tokens = segment.split(/[\s\/&|→·•:-]+/).map((t) => t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/g, "")).filter(Boolean);
    tokens.forEach((t, i) => {
      if (!/[A-Za-z]/.test(t)) return;
      const named =
        /[A-Z]{2,}/.test(t) ||
        (/\d/.test(t) && /[A-Za-z]/.test(t)) ||
        /[a-z][A-Z]/.test(t) ||
        /[+#]/.test(t) ||
        (/^[A-Z][a-z]/.test(t) && (i > 0 || (wholeEntry && tokens.length === 1)));
      if (named) out.push(t);
    });
  }
  return [...new Set(out)];
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
