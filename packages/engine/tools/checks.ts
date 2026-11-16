import type { Experience } from "@kairos/engine/kb/types";
import { worded } from "@kairos/engine/wording";
import { serializeExperience, stripUnverified } from "@kairos/engine/kb/experience";
import { BANNED_WORDS } from "@kairos/engine/prompts/voice";
import type { GeneratedResume, RequirementCoverageRow } from "@kairos/engine/types";
import { DEFAULT_ALLOWED_METRIC_STATUSES, registerEntries, type MetricStatus } from "@kairos/engine/metrics-register";
import { checkYears, dateAsYears, yearClaims } from "@kairos/engine/tools/years";

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
  rule: "em-dash" | "not-just-but" | "banned-word" | "empty-adverb" | "verb-clustering" | "leadin-not-title" | "third-person" | "first-person" | "verb-form" | "names-kb";
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
  // "where I built", "trained my shift": a résumé names no "I" (seen in a summary line, 15 November 2026).
  // "Phase I", "Type I" and the like are numerals, not the pronoun.
  // Addresses and links are not prose ("about.me/…").
  const prose = text.replace(/\S*[@/.]\S*\w/g, " ");
  const first = [...prose.matchAll(/\b(I|my|myself|me)\b/g)].filter((m) => m[1] !== "I" || !/\b(?:Phase|Type|Series|Class|Tier|Level|Part|Title|Stage|Grade|Category|Schedule|Division|Volume|Mark|Round|Section|Appendix|World War)\s+$/i.test(prose.slice(Math.max(0, m.index! - 14), m.index!)));
  if (first.length) out.push({ rule: "first-person", detail: `${[...new Set(first.map((m) => m[1]))].join(", ")} (résumés use implied first person: "Built…", not "I built…")` });
  const hits = text.match(/\b(himself|herself|he|she|his|him)\b/gi);
  if (hits) out.push({ rule: "third-person", detail: `${[...new Set(hits.map((h) => h.toLowerCase()))].join(", ")} (résumés use implied first person)` });
  // The personal knowledge base is never named on an outside-facing document
  // (CLAUDE.md); describe it ("a personal agentic system") instead.
  if (/\bkairos\b/i.test(text)) out.push({ rule: "names-kb", detail: `names "Kairos" (describe it, never name it on an outside-facing document)` });
  return out;
}

// "first-person" and "verb-form" are findings, not stops: the Writer puts them right, and a person who wants "I" on
// their résumé keeps it (the owner's decision of 15 November 2026).
export const isHardStyleViolation = (v: StyleViolation) => v.rule !== "empty-adverb" && v.rule !== "verb-clustering" && v.rule !== "first-person" && v.rule !== "verb-form";

const OPENING_VERBS = new Set(
  (
    "build run manage lead own write train hire schedule serve mentor hold drive design develop deliver create analyze analyse prepare produce support maintain " +
    "coordinate oversee direct handle track report present plan organize operate implement improve reduce increase grow launch ship test review teach advise partner " +
    "work help keep make take bring sell negotiate research conduct perform monitor ensure define establish execute facilitate guide coach supervise process resolve " +
    "respond load unload pick pack audit forecast budget model calculate reconcile draft edit publish translate collaborate communicate contribute participate assist " +
    "provide use apply automate migrate deploy configure install integrate document evaluate assess identify investigate recommend propose source recruit onboard " +
    "administer answer assemble collect compile complete enter file inspect repair stock order receive supply teach tutor grade cover staff"
  ).split(" "),
);

/**
 * The first word of a line and the one after it, past its list mark and its bold lead-in ("- **Hiring:** Hires,
 * schedules…" opens on "Hires"). Until 15 November 2026 the lead-in's own asterisks were read as a list mark, and
 * every line with a lead-in was skipped.
 */
function openingWord(line: string): { word: string; next: string } | null {
  const m = /^\s*(?:[-•]\s+|\*\s+)?(?:\*\*[^*]*\*\*\s*)?([A-Za-z]+)[\s,]*([A-Za-z0-9$]*)/.exec(line);
  return m ? { word: m[1]!, next: m[2] ?? "" } : null;
}

const AFTER_A_VERB = new Set("the a an all each every this these those my our its their second first third daily weekly monthly quarterly annual new two three four five six seven eight nine ten".split(" "));

/**
 * Lines that open in the present ("Run second shift", "Track the overtime hours") under a role the knowledge base
 * says has ended: what is finished is said in the past. A word that is also a thing ("Lead engineer", "Support
 * desk") is read as a verb only before a word that follows a verb ("the", a number, "weekly").
 */
export function presentInEndedRoles(gen: GeneratedResume, experiences: Experience[]): { company: string; word: string; line: string }[] {
  const out: { company: string; word: string; line: string }[] = [];
  for (const exp of gen.resume.experience) {
    const own = experiences.filter((e) => e.frontmatter.company.toLowerCase().trim() === exp.company.toLowerCase().trim());
    const titled = own.filter((e) => String(e.frontmatter.title ?? "").toLowerCase().trim() === (exp.title ?? "").toLowerCase().trim());
    const entries = titled.length ? titled : own;
    if (!entries.length || entries.some((e) => /^(present|current|now|today|ongoing|)$/i.test(String(e.frontmatter.end ?? "").trim()))) continue;
    for (const line of [exp.summary ?? "", ...exp.bullets]) {
      const o = openingWord(line);
      if (!o || !/^[A-Z][a-z]+$/.test(o.word) || !OPENING_VERBS.has(o.word.toLowerCase())) continue;
      if (AFTER_A_VERB.has(o.next.toLowerCase()) || /^[\d$]/.test(o.next)) out.push({ company: exp.company, word: o.word, line });
    }
  }
  return out;
}

/**
 * Lines that open on a verb in the third person ("Builds the forecast", "Mentors two analysts"). A résumé's lines are
 * in the implied first person: "Build", "Mentor" for what is still done, "Built" for what is finished. One role of the
 * run on other professions had "Own…", "Builds…" and "Rebuilt…" (15 November 2026).
 */
export function thirdPersonOpenings(gen: GeneratedResume): string[] {
  const lines = [...gen.resume.executive_summary.split("\n"), ...gen.resume.experience.flatMap((e) => [e.summary ?? "", ...e.bullets])];
  const out: string[] = [];
  for (const line of lines) {
    const first = openingWord(line)?.word;
    if (!first || !/^[A-Z][a-z]+s$/.test(first) || /ss$/.test(first)) continue;
    const w = first.toLowerCase();
    const base = w.endsWith("ies") ? `${w.slice(0, -3)}y` : OPENING_VERBS.has(w.slice(0, -1)) ? w.slice(0, -1) : w.slice(0, -2);
    if (OPENING_VERBS.has(base)) out.push(first);
  }
  return [...new Set(out)];
}

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
    | "unknown_organisation"
    /** A title under an employer that the knowledge base's entry for that employer does not hold. */
    | "unknown_title"
    /** A skills item that is neither in the person's own list nor in the words of a verified fact. */
    | "skill_not_held"
    /** A count of years longer than the dates of the roles it is said of. */
    | "years_exceed_dates"
    /** A count of years worked out from dates, stated nowhere in the knowledge base: listed for the person. */
    | "years_from_dates"
    /** A count of years in the summary that is not the one the person states of themselves. */
    | "years_not_the_persons"
    /** A role's dates that are not the knowledge base's for that entry; a year of an education row its entry does not hold. */
    | "dates_differ"
    /** A statement of what the person did not do, printed as a line of the résumé. */
    | "negative_statement"
    /** An audience ("presented to leadership") that no verified fact of the role names. */
    | "unknown_audience"
    /** A skill the person lists and the job ad names, left out of the Skills section: listed for the Writer. */
    | "listed_skill_left_out"
    /** A count in the summary that stands on no line and that the roles could add up to. */
    | "composed_total"
    /** An education row with no entry to stand on, or an issuer given where the entry names none. */
    | "education_differs"
    /** A share given of another whole: "30% of the site's volume" in the knowledge base, "30% of the shift's volume" on the résumé. */
    | "share_of_another_whole"
    /** A figure the knowledge base gives for one year, stated without that year. */
    | "year_left_out";
  detail: string;
  /** The line of the résumé the finding is about, when it is about one. */
  line?: string;
  /**
   * What the finding is about, in a form that is the same on every résumé ("dates|acme|2022-present",
   * "skills|event driven design"): a choice the user makes once is remembered under it (profile `resume_choices`).
   */
  key?: string;
}

/** Findings the candidate decides on (reported as warnings); every other kind blocks the save. */
/**
 * Findings that do not stop the save. The owner's decision of 15 November 2026: "the guardrails have to be suggestion
 * but not blocking. At the end of the day it is the user responsibility how they want to represent themselves."
 * Every check added that day is one of these: the save succeeds, the Writer puts right what it added itself, and
 * what the user wants kept is told to them and saved (tools/ops.ts). What stopped a save before that day still
 * does: an employer or an organisation the knowledge base does not know, a number or a count on no line of it, a
 * credential it does not hold, a source that names no entry.
 */
export const ADVISORY_GROUNDING: ReadonlySet<GroundingIssue["kind"]> = new Set([
  "ungrounded_skill",
  "skill_not_held",
  "listed_skill_left_out",
  "unknown_title",
  "dates_differ",
  "years_exceed_dates",
  "years_not_the_persons",
  "years_from_dates",
  "negative_statement",
  "unknown_audience",
  "composed_total",
  "education_differs",
  "share_of_another_whole",
  "year_left_out",
]);

/** A text as a key: lower case, letters and digits, one space between words, cut short. */
export const keyOf = (...parts: string[]) => parts.map((t) => t.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}+#%$]+/gu, " ").trim().slice(0, 80)).join("|");

/** An education or credential entry of the knowledge base, as the checks read it. */
export interface EducationRef {
  fileName: string;
  /** The school or the issuer, when the entry names one. */
  institution?: string;
  credential?: string;
  /** The whole entry: its fields and its lines. */
  text: string;
}

/** The entries read from the raw files `loadEducation` returns, with the file names `loadEducationEntries` gives. */
export function educationRef(fileName: string, frontmatter: Record<string, unknown>, body: string): EducationRef {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return { fileName, institution: str(frontmatter.institution), credential: str(frontmatter.credential), text: [...Object.values(frontmatter).map((v) => (typeof v === "string" || typeof v === "number" ? String(v) : "")), body].join("\n") };
}

const flatWords = (t: string) => ` ${t.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, " ").trim()} `;

interface DatePoint {
  year: number;
  month: number | null;
  present: boolean;
}
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SEASONS: Record<string, number> = { spring: 3, summer: 6, fall: 9, autumn: 9, winter: 12 };

/** A start or an end as the knowledge base writes it ("2022-03", "2020", "present"); null when it cannot be read. */
function datePoint(value: unknown, end: boolean): DatePoint | null {
  const s = String(value ?? "").trim().toLowerCase();
  if (/^(present|current|now|today|ongoing)$/.test(s)) return end ? { year: 0, month: null, present: true } : null;
  const y = dateAsYears(s, false, new Date(0));
  if (y === null) return null;
  const month = /^\d{4}$/.test(s) ? null : Math.round((y - Math.floor(y)) * 12) + 1;
  return { year: Math.floor(y), month, present: false };
}

/** The first and the last date of a résumé row's dates ("Mar 2022 - Present", "2018 - 2022", "Spring 2025", "2024"). */
export function rowDates(dates: string): { start: DatePoint; end: DatePoint } | null {
  const points: DatePoint[] = [];
  for (const m of dates.toLowerCase().matchAll(/(?:\b([a-z]{3,9})\.?\s+)?\b((?:19|20)\d{2})\b|\b(present|current|now|today|ongoing)\b/g)) {
    if (m[3]) points.push({ year: 0, month: null, present: true });
    else {
      const word = m[1] ?? "";
      const month = MONTH_NAMES.indexOf(word.slice(0, 3)) >= 0 && !(word in SEASONS) ? MONTH_NAMES.indexOf(word.slice(0, 3)) + 1 : null;
      points.push({ year: Number(m[2]), month, present: false });
    }
  }
  if (!points.length || points[0]!.present) return null;
  return { start: points[0]!, end: points[points.length - 1]! };
}

/**
 * What the person did not do, said of themselves: the clause opens on the negation ("; did not lead the deal", "I did
 * not work on it", "but never managed a budget"). Not a result ("410 days without an injury", "with no downtime"), and
 * not a statement about something else ("so the report is not built by hand").
 */
const NEGATIVE =
  /(?:^|[.;,:(]\s*|\b(?:and|but|though|although|while)\s+)(?:I\s+)?(?:(?:did|do|was|am|have|had)\s+not|didn't|don't|wasn't|haven't|hadn't|never)\s+(?:[a-z]+)|\bnot\s+(?:responsible for|involved in|part of|the lead)\b|\bno\s+(?:direct|formal)\s+(?:reports?|responsibility|ownership|authority)\b/i;

const SHARE_ENDS = new Set("is are was were be been for in at by to and or which that with from over during comes came goes went of on per as".split(" "));
const SHARE_SKIPS = new Set("the a an its their our my all total overall".split(" "));

/** Every "N% of <something>" in a text: the percentage, and the words that say what it is a share of. */
export function sharesOf(text: string): { raw: string; percent: string; whole: string[] }[] {
  const out: { raw: string; percent: string; whole: string[] }[] = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?%\s+of\s+((?:[\p{L}\p{N}'’-]+\s*){1,6})/gu)) {
    const words: string[] = [];
    const kept: string[] = [];
    for (const w of m[2]!.trim().split(/\s+/)) {
      const plain = w.toLowerCase().replace(/['’]s$/, "").replace(/[^\p{L}\p{N}]/gu, "");
      if (SHARE_ENDS.has(plain)) break;
      kept.push(w);
      if (plain && !SHARE_SKIPS.has(plain)) words.push(plain.length > 4 ? plain.replace(/s$/, "") : plain);
      if (words.length === 4) break;
    }
    if (words.length) out.push({ raw: `${m[1]}% of ${kept.join(" ")}`, percent: m[1]!, whole: words });
  }
  return out;
}

const AUDIENCE_VERB = /\b(?:present|report|brief|pitch|demonstrat|demo|recommend|escalat|communicat|explain|show|deliver)(?:e|ed|s|es|ing|ted|ting|ned|ning)?\b[^.;:!?]{0,80}?\bto\s+((?:(?:the|a|an|its|their|senior|executive|company|division|plant|site|regional|global|client|c)\s+|-)*[a-z][a-z-]*)/gi;
const AUDIENCES = new Set("leadership executives executive management board ceo cfo coo cto cio vp vps directors director stakeholders investors clients client customers customer partners regulators committee suite managers manager leaders".split(" "));

/**
 * Audiences a line gives to something the person presented or reported ("presented it to leadership") that the
 * evidence given does not name. Only the plain words for an audience are read; a name ("the division CFO") is held
 * by the organisation and title checks.
 */
export function unknownAudiences(line: string, evidence: string): string[] {
  const held = wordSet(evidence);
  const out: string[] = [];
  for (const m of line.matchAll(AUDIENCE_VERB)) {
    const phrase = m[1]!.trim();
    const head = phrase.split(/[\s-]+/).pop()!.toLowerCase();
    if (!AUDIENCES.has(head)) continue;
    const [stemmed] = [...wordSet(head)];
    if (stemmed && !held.has(stemmed) && !held.has(head)) out.push(`to ${phrase}`);
  }
  return [...new Set(out)];
}

/** Whether a source label names an education or credential entry: by its file name, its school or issuer, or its credential. */
export function namesEducation(label: string, education: EducationRef[]): boolean {
  const ref = label.replace(/\.md\b/, "").trim().toLowerCase();
  if (!ref) return false;
  const names = education.flatMap((e) => [e.fileName.replace(/\.md$/, ""), e.institution ?? "", e.credential ?? ""]).map((n) => n.toLowerCase().trim()).filter(Boolean);
  if (names.includes(ref)) return true;
  const head = ref.split(/\s*(?:\(|\[|—|–|\s-\s|:|,|\||\/)/)[0]!.trim();
  if (head && names.includes(head)) return true;
  return names.some((name) => name.length >= 3 && ref.startsWith(name) && !/[a-z0-9]/.test(ref[name.length] ?? ""));
}

/**
 * Whether the knowledge base holds this title for one of the entries given (the entries of one employer):
 * the entry's own title, a shortening of it ("Teaching Assistant" for "Teaching Assistant, Data Structures"),
 * or a title one of its verified lines states in these words.
 */
export function titleHeld(title: string, entries: Experience[], own = ""): boolean {
  const wanted = flatWords(title);
  if (!wanted.trim()) return true;
  // A title the person wrote themselves, in their own résumé or their own summary, is theirs under any entry. What the
  // profile says they look for (its headline, its target roles) is not a title they held: seen in claude.ai on
  // 15 November 2026, "Frontend Engineer" was put on an internship unremarked because the headline said "Junior Frontend Engineer".
  if (own && own.split("\n").some((line) => flatWords(line).includes(wanted))) return true;
  return entries.some((e) => {
    const stripped = stripUnverified(e);
    return [String(e.frontmatter.title ?? ""), ...stripped.body.split("\n")].some((line) => flatWords(line).includes(wanted));
  });
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
 *  - every plain count ("a team of 12", "40 users", "three clinics") must appear
 *    as a number in the verified text of that employer (2026-11-12: the
 *    provenance comparison showed a count the KB never states passed the gate).
 *    In the summary the number may be anywhere in the evidence; a count found
 *    nowhere blocks, unless the knowledge base could add up to it across roles (see
 *    `composableTotal`): the stretch check then lists it as a total
 *  - a credential (skills line or prose) must be in the verified evidence, and
 *    so must every education entry when the knowledge base holds education; a named
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
    /** The knowledge base holds education entries (they are in `extraCorpus`): check the résumé's education against them. */
    educationRecorded?: boolean;
    /** The company the résumé is written for. Naming it inside a sentence ("the design team at Acme") is not a claim to have worked there. */
    targetCompany?: string;
    /** The education and credential entries: a line may name one as its source, and a résumé's education row is held against the entry it names. */
    educationEntries?: EducationRef[];
    /** The person's own list of skills (profile `skills`) and the job ad's text: a listed skill the ad names and the Skills section lacks is listed. */
    statedSkills?: string[];
    jobText?: string;
    /** Today, for a role that is still held (tests give a fixed day). */
    now?: Date;
    /**
     * The person's own curated writing beyond `extraCorpus` (their reference résumé, their summary blocks): a title or a
     * count of years they wrote there themselves is theirs.
     */
    ownWriting?: string;
    /** The texts a title may be the person's own from: their own résumé and summary. Without it, the extra corpus and `ownWriting`. */
    ownTitles?: string;
  } = {},
): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  const companies = new Set(experiences.map((e) => e.frontmatter.company.toLowerCase().trim()));
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
    const key = exp.company.toLowerCase().trim();
    if (!companies.has(key)) {
      issues.push({ kind: "unknown_employer", detail: worded`"${exp.company}" is not a knowledge-base experience` });
      continue;
    }
    // The title is the knowledge base's own for that employer. A project has a name and no title: its row may carry none.
    const own = experiences.filter((e) => e.frontmatter.company.toLowerCase().trim() === key);
    const project = own.every((e) => e.frontmatter.kind === "project");
    const title = (exp.title ?? "").trim();
    if (project && (!title || /^project$/i.test(title))) continue;
    if (!titleHeld(title, own, opts.ownTitles ?? `${extraCorpus}\n${opts.ownWriting ?? ""}`)) {
      issues.push({
        kind: "unknown_title",
        key: keyOf("title", exp.company, title),
        detail: worded`"${title}" under "${exp.company}" is not a title the knowledge base holds for that entry (it holds ${own.map((e) => `"${e.frontmatter.title ?? ""}"`).join(", ")}). Use the knowledge base's title as it is${project ? ", or none: this entry is a project" : ""}`,
      });
    }
  }

  // Counts of years. One the knowledge base states is the person's own; any other was worked out from dates, and must
  // fit the dates of the roles its sentence names (tools/years.ts). Too long: refused. Fits: listed for the person.
  const now = opts.now ?? new Date();
  const allRaw = [...rawByCompany.values(), extraCorpus, opts.ownWriting ?? ""].join("\n");
  const yearFindings = [
    ...checkYears(gen.resume.executive_summary, "summary", allRaw, experiences, experiences, now),
    ...gen.resume.experience.flatMap((exp) => {
      const key = exp.company.toLowerCase().trim();
      const own = experiences.filter((e) => e.frontmatter.company.toLowerCase().trim() === key);
      if (!own.length) return [];
      const sameTitle = own.filter((e) => flatWords(String(e.frontmatter.title ?? "")) === flatWords(exp.title ?? ""));
      return checkYears([exp.summary ?? "", ...exp.bullets].join("\n"), `under "${exp.company}"`, `${rawByCompany.get(key) ?? ""}\n${extraCorpus}\n${opts.ownWriting ?? ""}`, sameTitle.length ? sameTitle : own, experiences, now);
    }),
  ];
  // The person's own figure stands. Where their profile or their own résumé states a count of years of themselves
  // ("seven years in corporate finance"), a summary sentence that names no title gives that figure, not one worked out
  // from dates ("Eight years", true by the dates and not what the person says).
  const ownFigures = yearClaims(`${extraCorpus}\n${opts.ownWriting ?? ""}`);
  const summaryFindings = yearFindings.filter((f) => f.where === "summary" && ownFigures.length > 0 && f.by !== "title");
  for (const f of summaryFindings) {
    issues.push({
      kind: "years_not_the_persons",
      key: keyOf("years", f.claim),
      line: f.sentence,
      detail: worded`"${f.claim}" (summary): the person states their own count of years (${[...new Set(ownFigures.map((c) => `"${c.raw}"`))].join(", ")}). Their figure stands: write it as they did, or ask them whether it has changed`,
    });
  }
  for (const f of yearFindings.filter((x) => !summaryFindings.includes(x))) {
    const roles = f.roles.length > 3 ? `${f.roles.length} roles` : f.roles.join("; ");
    issues.push(
      f.kind === "exceeds"
        ? { kind: "years_exceed_dates", key: keyOf("years", f.claim), line: f.sentence, detail: worded`"${f.claim}" (${f.where}): the dates of ${roles} give ${f.covered} years. Write the count the dates give for what the sentence says, or leave the count out` }
        : { kind: "years_from_dates", key: keyOf("years", f.claim), line: f.sentence, detail: worded`"${f.claim}" (${f.where}) is stated nowhere in the knowledge base: it was worked out from the dates of ${roles} (${f.covered} years). Ask the person whether it is true of what the sentence says, or leave the count out` },
    );
  }

  // Corpus-wide pass: a metric found NOWHERE in verified evidence is fabricated.
  const prose = resumeClaimText(gen);
  for (const token of extractMetricTokens(prose)) {
    if (!corpus.includes(token.normalized)) {
      issues.push({ kind: "ungrounded_metric", detail: worded`"${token.raw}" not found in any verified KB fact` });
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
          detail: worded`"${token.raw}" under "${exp.company}" is not in that experience's verified facts (it exists elsewhere in the KB — a true number from one role cannot support a claim in another)`,
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
    // "Five products", "three markets": a total composed across roles is on no single line. Until 15 November 2026 it
    // was let through and listed; a number that stands nowhere now stops the save, and the message says that it may be
    // a total the person can confirm.
    // "Five products", "three markets": a total composed across roles is on no single line. When the knowledge base
    // could add up to it, the save is not stopped: the total is a finding, for the person to confirm.
    if (composableTotal(token, entryTexts)) {
      issues.push({ kind: "composed_total", key: keyOf("total", token.raw), detail: worded`"${token.raw}" (summary): no line of the knowledge base states this count. It may be a total across roles: leave it out, or ask the person and save it as a fact of theirs` });
      continue;
    }
    issues.push({ kind: "ungrounded_count", detail: worded`"${token.raw}" (summary): the number ${token.value} is not in any verified KB fact` });
  }
  for (const exp of gen.resume.experience) {
    const own = numbersByCompany.get(exp.company.toLowerCase().trim());
    if (own === undefined) continue;
    for (const token of extractCountTokens([exp.summary ?? "", ...exp.bullets].join("\n"))) {
      if (own.has(token.value) || extraNumbers.has(token.value)) continue;
      issues.push(
        allNumbers.has(token.value)
          ? { kind: "count_source_mismatch", detail: worded`"${token.raw}" under "${exp.company}": the number ${token.value} is not in that experience's verified facts (it exists elsewhere in the KB)` }
          : { kind: "ungrounded_count", detail: worded`"${token.raw}" under "${exp.company}": the number ${token.value} is not in any verified KB fact` },
      );
    }
  }

  // Organisations named in prose. An employer of the knowledge base, or a name a
  // verified fact, the profile or the education record holds, is accepted; a
  // name found nowhere is an organisation the knowledge base does not know.
  const companyNames = experiences.map((e) => e.frontmatter.company);
  const recorded = [...rawByCompany.values()].join("\n");
  const evidenceAll = [recorded, extraCorpus, opts.ownWriting ?? ""].join("\n");
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
      issues.push({ kind: "unknown_organisation", detail: worded`"at ${org.name}" (${unit.where}): "${org.name}" is not an employer of the knowledge base and is named in no verified fact` });
    }
  }

  // Dates. A row's first and last date are the start and the end of an entry of that employer (two roles at one
  // employer may be written as one row, from the first one's start to the last one's end). A year that differs, or a
  // month where both sides give one, stops the save.
  for (const exp of gen.resume.experience) {
    const own = experiences.filter((e) => e.frontmatter.company.toLowerCase().trim() === exp.company.toLowerCase().trim());
    if (!own.length) continue;
    const found = rowDates(exp.dates);
    if (!found) {
      issues.push({ kind: "dates_differ", key: keyOf("dates", exp.company, exp.dates), detail: worded`"${exp.dates}" under "${exp.company}": no year can be read in these dates. Write the entry's own dates` });
      continue;
    }
    const same = (row: DatePoint, value: unknown, end: boolean) => {
      const kb = datePoint(value, end);
      return kb === null ? null : row.present || kb.present ? row.present === kb.present : row.year === kb.year && (row.month === null || kb.month === null || row.month === kb.month);
    };
    const starts = own.map((e) => same(found.start, e.frontmatter.start, false));
    const ends = own.map((e) => same(found.end, e.frontmatter.end, true));
    if (starts.every((x) => x === null) && ends.every((x) => x === null)) continue; // the entries carry no dates that can be read
    if (!starts.some((x) => x !== false) || !ends.some((x) => x !== false)) {
      issues.push({
        kind: "dates_differ",
        key: keyOf("dates", exp.company, `${found.start.year} ${found.end.present ? "present" : found.end.year}`),
        detail: worded`"${exp.dates}" under "${exp.company}": the knowledge base holds ${own.map((e) => `${String(e.frontmatter.start ?? "?")} to ${String(e.frontmatter.end ?? "?")}`).join("; ")} for that entry. Write its dates as they are`,
      });
    }
  }

  // A share keeps its whole, and a figure of one year keeps its year. Seen in the second run on other professions
  // (15 November 2026): "about 30% of Sierra Crest's volume" became "about 30% of the shift's volume", and "kept
  // on-time departure above 97% in 2015" became, in the summary, "kept on-time departure above 97%".
  const scopes = [
    { where: "summary", text: gen.resume.executive_summary, evidence: evidenceAll },
    ...gen.resume.experience.flatMap((exp) => {
      const own = rawByCompany.get(exp.company.toLowerCase().trim());
      return own === undefined ? [] : [exp.summary ?? "", ...exp.bullets].map((text) => ({ where: `under "${exp.company}"`, text, evidence: `${own}\n${extraCorpus}` }));
    }),
  ];
  for (const unit of scopes) {
    const held = unit.evidence.split(/\n|(?<=[.;])\s+/);
    for (const sentence of unit.text.split(/(?<=[.;!?])\s+|\n+/)) {
      for (const share of sharesOf(sentence)) {
        const theirs = held.flatMap((l) => sharesOf(l)).filter((x) => x.percent === share.percent);
        if (!theirs.length || theirs.some((x) => share.whole.every((w) => x.whole.includes(w)))) continue;
        // Only the same thing given to another owner: "the shift's volume" for "Sierra Crest's volume". The same share
        // said in other words ("of support requests" for "of tickets") is a rewording, not another whole; read as a
        // finding it was raised on thirty of the owner's own résumés.
        const head = share.whole[share.whole.length - 1];
        if (!theirs.some((x) => x.whole[x.whole.length - 1] === head)) continue;
        issues.push({
          kind: "share_of_another_whole",
          key: keyOf("share", share.raw),
          line: sentence.trim(),
          detail: worded`"${share.raw}" (${unit.where}): the knowledge base gives this share of something else ("${theirs[0]!.raw}"). Say what it is a share of in the person's own words`,
        });
      }
      // Only a rate: "above 97% in 2015" is a figure of that year. The year in "a $2.1M packing line in 2023" says
      // when the work was done, and a line may leave it out.
      for (const token of extractMetricTokens(sentence).filter((t) => t.raw.includes("%"))) {
        const lines = held.filter((l) => normalizeMetrics(l).includes(token.normalized));
        const years = lines.map((l) => /\b(?:in|during|for|through|throughout|over)\s+((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}|\d{2}))?\b/.exec(l));
        if (!lines.length || years.some((y) => !y)) continue;
        const given = [...new Set(years.map((y) => y![1]!))];
        if (given.some((y) => sentence.includes(y))) continue;
        issues.push({
          kind: "year_left_out",
          key: keyOf("year", token.raw, given.join(" ")),
          line: sentence.trim(),
          detail: worded`"${token.raw}" (${unit.where}): the knowledge base gives this figure for ${given.join(" and ")} ("${lines[0]!.replace(/^\s*[-*]\s+/, "").replace(/\s*\[[RCF]\]\s*$/, "").trim().slice(0, 120)}"). Say the year with it, or leave the figure out`,
        });
      }
    }
  }

  // What the person did not do is context for the Writer, never a line ("…; did not lead the deal").
  for (const unit of proseUnits) {
    for (const sentence of unit.text.split(/(?<=[.;!?])\s+|\n+/)) {
      const m = NEGATIVE.exec(sentence);
      if (m) issues.push({ kind: "negative_statement", key: keyOf("negative", sentence), line: sentence.trim(), detail: worded`"${m[0]}" (${unit.where}): a résumé says what the person did, never what they did not do. Leave the statement out; it limits what the other lines may claim` });
    }
  }

  // An audience the person did not give ("the plant manager presented it" becoming "presented it to leadership").
  for (const exp of gen.resume.experience) {
    const own = rawByCompany.get(exp.company.toLowerCase().trim());
    if (own === undefined) continue;
    for (const line of [exp.summary ?? "", ...exp.bullets]) for (const a of unknownAudiences(line, `${own}\n${extraCorpus}`)) issues.push({ kind: "unknown_audience", key: keyOf("audience", exp.company, a), line, detail: worded`"${a}" under "${exp.company}": no verified fact of that role names this audience. Say who it was in the person's own words, or leave the audience out` });
  }
  for (const a of unknownAudiences(gen.resume.executive_summary, evidenceAll)) issues.push({ kind: "unknown_audience", key: keyOf("audience", "summary", a), line: gen.resume.executive_summary, detail: worded`"${a}" (summary): no verified fact names this audience. Say who it was in the person's own words, or leave the audience out` });

  // Skills, credentials and education. A credential (on the skills line or
  // in prose) and an education entry must sit on one line of the verified
  // evidence. A named tool or acronym on the skills line that the evidence
  // never mentions is reported, not blocked: skills lines are themes in the
  // candidate's own words, and only their named terms can be checked.
  // The person's own writing (their reference résumé, their summary blocks) is their own list as much as the profile's.
  const evidence = [...rawByCompany.values(), extraCorpus, opts.ownWriting ?? ""].join("\n");
  const evidenceLines = evidence.split("\n").map(wordSet).filter((w) => w.size);
  const evidenceWords = new Set(evidenceLines.flatMap((w) => [...w]));
  const evidenceTerms = termSet(evidence);
  const onOneLine = (words: string[]) => evidenceLines.some((line) => words.every((w) => line.has(w)));
  const credentialIssue = (phrase: string, where: string) => {
    // The name must be on one line; the marker word itself ("certified") need not be.
    const words = [...wordSet(phrase)].filter((w) => !CREDENTIAL_MARKER.test(w));
    if (words.length && !onOneLine(words)) {
      issues.push({ kind: "ungrounded_credential", detail: worded`"${phrase.trim()}" (${where}) is not a credential in the verified KB evidence` });
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
      issues.push({ kind: "ungrounded_skill", key: keyOf("skills", skill), line: skill, detail: worded`"${skill}" (skills): ${missing.map((m) => `"${m}"`).join(", ")} appears nowhere in the verified KB evidence` });
    }
    // Every skill and every language listed stands in the knowledge base: on the person's own list, or in the words of
    // a verified fact. Never a label of the writer's ("Editorial leadership", "Safety program management": the run on
    // other professions). A heading before a colon is checked too, unless it is one of the plain section words.
    // (An item already named above for a tool the evidence never mentions is not named twice.)
    if (!missing.length) {
      const label = colon > 0 ? skill.slice(0, colon).trim() : "";
      const parts = [
        ...(label && !SKILL_HEADINGS.has(label.toLowerCase()) ? [label] : []),
        ...(colon > 0 ? skill.slice(colon + 1) : skill).replace(/\([^)]*\)/g, " ").split(/[,;·]|\s[&\/]\s/).map((x) => x.trim()).filter(Boolean),
      ];
      // A plural is the same skill: "REST APIs" where the fact says "a REST API".
      const heldOnALine = (words: string[]) => evidenceLines.some((line) => words.every((w) => line.has(w) || line.has(w.replace(/s$/, "")) || line.has(`${w}s`)));
      const notHeld = parts.filter((part) => {
        const words = [...wordSet(part)];
        return words.length > 0 && !heldOnALine(words);
      });
      if (notHeld.length) {
        issues.push({
          kind: "skill_not_held",
          key: keyOf("skills", skill),
          line: skill,
          detail: worded`${notHeld.map((m) => `"${m}"`).join(", ")} (skills): not in the person's own list of skills and in the words of no verified fact. Use their list as they wrote it, or the words a fact uses; to add a skill, ask them and save it to their profile first`,
        });
      }
    }
  }
  // A skill the person lists themselves and the job ad names, left out of the Skills section: listed for the Writer.
  if (opts.statedSkills?.length && opts.jobText) {
    const ad = flatWords(opts.jobText);
    const section = flatWords((gen.resume.skills ?? []).join(" , "));
    for (const listed of opts.statedSkills) {
      const names = [listed.replace(/\([^)]*\)/g, " "), ...[...listed.matchAll(/\(([^)]*)\)/g)].flatMap((m) => m[1]!.split(","))].map((x) => flatWords(x)).filter((x) => x.trim().length > 1);
      if (names.some((n) => ad.includes(n)) && !names.some((n) => section.includes(n))) {
        issues.push({ kind: "listed_skill_left_out", key: keyOf("left out", listed), detail: worded`"${listed}" is on the person's own list of skills and the job ad names it; the Skills section leaves it out. Add it as they wrote it` });
      }
    }
  }
  for (const phrase of credentialPhrases(prose)) credentialIssue(phrase, "résumé text");
  // Every school, degree, licence and certificate is held against the knowledge base: an education entry, or what the
  // person wrote themselves (their profile, their own résumé). With education entries on file a row they do not hold
  // stops the save, as before; with none (it let any row through until 15 November 2026) the row is a finding.
  for (const ed of gen.resume.education ?? []) {
    const institution = [...wordSet(ed.institution)];
    const credential = [...wordSet(ed.credential)];
    const known = credential.filter((w) => evidenceWords.has(w)).length;
    if ((institution.length && !onOneLine(institution)) || (credential.length && known * 2 < credential.length)) {
      issues.push(
        opts.educationRecorded
          ? { kind: "ungrounded_credential", detail: worded`"${ed.credential}, ${ed.institution}" (education) is not in the verified KB evidence` }
          : { kind: "education_differs", key: keyOf("education", ed.credential, ed.institution), detail: worded`"${ed.credential}, ${ed.institution}" (education) is not in the knowledge base, which holds no education entry. Leave the row out, or ask the person and save the entry (save_education)` },
      );
      continue;
    }
    // A certificate whose entry names no school and no issuer is written with none: "Google" and "Online course" were
    // given as schools in the run on other professions, each a word of the entry's own line. Where the entry names a
    // school, the check above holds (its name in the person's words, on one line of the evidence).
    const entries = (opts.educationEntries ?? []).filter((e) => e.credential && credential.filter((w) => wordSet(e.text).has(w)).length * 2 >= credential.length);
    if (entries.length && ed.institution.trim() && !entries.some((e) => e.institution)) {
      issues.push({ kind: "education_differs", key: keyOf("education", ed.credential, ed.institution), detail: worded`"${ed.credential}, ${ed.institution}" (education): the knowledge base's entry for this credential names no school or issuer. Leave it empty` });
      continue;
    }
    // Its years are the entry's own (or, with no entry, those of a line of the evidence that holds the credential).
    const years = [...(ed.dates ?? "").matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => m[0]);
    const held = entries.length ? entries.map((e) => e.text).join("\n") : evidence.split("\n").filter((l) => credential.filter((w) => wordSet(l).has(w)).length * 2 >= credential.length).join("\n");
    const missing = years.filter((y) => !held.includes(y));
    if (missing.length) issues.push({ kind: "dates_differ", key: keyOf("education dates", ed.credential, missing.join(" ")), detail: worded`"${ed.credential}" (education): ${missing.join(", ")} is not a year the knowledge base holds for it. Write the year it holds, or none` });
  }

  // A source is grounded if it names a real KB experience by ANY of its
  // identifiers (see `auditSourceExperiences`).
  // An education or credential entry is a source too: a line about a degree or a certificate names it.
  const namesKnownSource = (label: string): boolean => auditSourceExperiences(label, experiences) !== null || namesEducation(label, opts.educationEntries ?? []);
  for (const entry of gen.provenance_audit) {
    if (!namesKnownSource(entry.source_experience)) {
      issues.push({
        kind: "unknown_source",
        detail: worded`provenance source "${entry.source_experience}" is not an entry of the knowledge base (use the file name, id or employer of a role, or the file name of an education or credential entry)`,
      });
    }
  }
  return issues;
}

/**
 * The knowledge base entries a provenance source label names, by ANY of their
 * identifiers: file name, frontmatter id, or company. The guarantee is "traces
 * to a real experience", not "spelled one particular way": a label that adds a
 * title or a detail ("Acme (Senior PM)", "Education: B.S. ...") is read by its
 * head. Seven of eight blocked saves in the provenance run of 2026-11-12 were
 * such labels, none about a fact. Returns an empty list for the curated
 * sources (profile, education), which are not entries, and null when the label
 * names nothing in the knowledge base.
 */
export function auditSourceExperiences(label: string, experiences: Experience[]): Experience[] | null {
  const ref = label.replace(/\.md\b/, "").trim().toLowerCase();
  const namesOf = (e: Experience) =>
    [e.fileName.replace(/\.md$/, ""), e.frontmatter.id ?? "", e.frontmatter.company].map((n) => String(n).toLowerCase().trim()).filter(Boolean);
  const exact = (r: string) => experiences.filter((e) => namesOf(e).includes(r));
  const curated = (r: string) => r === "profile" || r === "education";
  if (curated(ref)) return [];
  const whole = exact(ref);
  if (whole.length) return whole;
  if (/^(?:education|profile)\b/.test(ref)) return [];
  const head = ref.split(/\s*(?:\(|\[|—|–|\s-\s|:|,|\||\/)/)[0]!.trim();
  if (head && curated(head)) return [];
  const byHead = head ? exact(head) : [];
  if (byHead.length) return byHead;
  const byPrefix = experiences.filter((e) => namesOf(e).some((name) => name.length >= 3 && ref.startsWith(name) && !/[a-z0-9]/.test(ref[name.length] ?? "")));
  return byPrefix.length ? byPrefix : null;
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
 * sources it may use: the verified knowledge base (unverified facts removed), plus
 * `extraCorpus` (profile, education, the posting itself). Each returned token
 * is a number the writer could not have taken from the knowledge base.
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
   * company: an employer of the knowledge base. extra: named in the profile, the base
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
 * is left out. Each name is looked up in the knowledge base: the employers first, then
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
    // knowledge base writes the whole as one name ("Crane & Wills Advisory").
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
 * at least two record entries, and the count is no larger than the knowledge base can
 * add up to: the numbers it states for that thing, plus one for every line
 * that mentions it. "Led 60 engineers" over a knowledge base that mentions 3 and 15
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

/** Headings of a skills line that name no skill: "Languages: English (native)", "Tools: SQL". */
const SKILL_HEADINGS = new Set("languages language tools tool skills technical software certifications methods platforms programming data other systems core additional".split(" "));
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

// --- Questions asked of the person -------------------------------------------

const LEADING = /\b(?:such as|e\.g\.|for example|for instance|like (?:a|an|the)?\s*[A-Z][\w+#.-]*|or something (?:else|similar)|or similar|or the like|etc\.?)(?=[\s,).?]|$)|\((?:[^()]*(?:\bor\b|,)[^()]*)\)/;

/**
 * Questions that suggest their answer: an example ("such as", "for example", "like" followed by a tool's name),
 * or a list of options in brackets ("(SQS, RabbitMQ)"). Seen in the run on other professions: "did you use an
 * email tool (like" two named tools "…)", "Was that Kafka, or something else (SQS, RabbitMQ)". A question asks
 * whether something happened, or where; the person supplies the rest.
 */
export function leadingQuestions(questions: unknown[]): { question: string; marker: string }[] {
  const out: { question: string; marker: string }[] = [];
  for (const q of questions) {
    if (typeof q !== "string") continue;
    const m = LEADING.exec(q);
    if (m) out.push({ question: q, marker: m[0].trim() });
  }
  return out;
}
