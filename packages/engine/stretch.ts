import type { Experience } from "@kairos/engine/kb/types";
import { serializeExperience, stripUnverified, untaggedFacts } from "@kairos/engine/kb/experience";
import { claimNumbers, NUMBER_WORDS, proseOrganisations } from "@kairos/engine/tools/checks";
import type { GeneratedResume } from "@kairos/engine/types";

/**
 * Stretch check (2026-11-03): flags résumé bullets whose wording claims more
 * than the knowledge base says. Grounding (tools/checks.ts) proves numbers and
 * employers are real; this checks that agency and scope are real too.
 * Origin: three slips on 11/02 that grounding could not see ("Chose to build on
 * Vertex", "made Shepard's verification mandatory", "Drove build-versus-buy"),
 * each a true fact with an upgraded verb or an absolute word.
 *
 * Two kinds of finding:
 *  - denied: the bullet uses a phrasing the KB explicitly forbids (a quoted
 *    phrase after "do not" / "never" in a verified line). Blocks the save.
 *  - stretch: an ownership verb or an absolute word that no verified sentence
 *    of THAT employer supports together with its object. Advisory: the
 *    candidate decides keep / soften / drop. A "keep" is saved as a confirmed
 *    KB fact, which then supports the wording on the next run.
 *
 *  - drift (2026-11-12, also a "stretch" finding): the bullet restates a
 *    verified sentence whose own wording is weaker in kind. The record says the
 *    candidate took part ("member of the team that", "supported the launch")
 *    and the bullet leads or does the thing itself; the record says it was
 *    assessed ("evaluated", "recommended") and the bullet says it was put in
 *    place; the record says it was a pilot and the bullet says it was rolled
 *    out. Found by the provenance comparison, where these three passed.
 *
 *  - number (2026-11-13, a "stretch" finding): a number the employer's facts do
 *    state, attached to another result. The record says "cut onboarding time
 *    by 40%" and the bullet says "raised revenue by 40%": grounding finds the
 *    40% and passes. The clause that carries the number is compared with the
 *    verified lines of that employer that state the same number; when it
 *    shares no content word with any of them, the number is listed.
 *  - organisation (2026-11-13, a "stretch" finding): "At <Name>, …" opening a
 *    sentence, where the record names <Name> in a fact (a client, a partner)
 *    and not as an employer. A name the record never mentions blocks in
 *    grounding.
 *
 * The executive summary (2026-11-13) is read sentence by sentence with the
 * same rules. A summary sentence has no single employer: support is any
 * verified sentence of the record, or, when the sentence names an employer of
 * the record (its company name as the record writes it), a verified sentence
 * of that employer. A number of years, or a count, that no line of the record
 * states is a total composed across roles and is listed (rule "total"): the
 * record cannot prove it from one line, and it does not block. A number of
 * years is not listed when the dates of the record give it: the length of one
 * entry, of one employer or of the whole record, rounded down or to the
 * nearest year ("10+ years": at most the whole record).
 *
 * Deterministic and conservative: a sentence supports a claim when it holds a
 * verb of a supporting class (or the absolute word, or a synonym) and shares
 * content words with what the bullet attaches it to. Correction and "do not"
 * lines never support. English only: the verb lists, the absolutes, the
 * openers of the drift rule, "at" before an organisation and "years" are
 * English words.
 */

export interface StretchFinding {
  kind: "denied" | "stretch";
  /** The rule that gave the finding. */
  rule: "denied" | "ownership" | "absolute" | "drift" | "number" | "organisation" | "total";
  /** The employer of the bullet, or "Executive summary". */
  company: string;
  bullet: string;
  /** The word or phrase that triggered the finding, as written on the résumé. */
  trigger: string;
  detail: string;
}

type VerbClass = "responsibility" | "decision" | "initiative";

/**
 * Ownership verbs that trigger a check, by what they claim. Swaps between
 * plain delivery verbs ("defined", "set", "led", "ran", "built") are not
 * inflation and never trigger; they only serve as support.
 *  - responsibility: the candidate held the scope ("owned", "oversaw").
 *  - decision: the candidate made the call ("chose", "decided"). Only a decision verb
 *    supports it: "led" becoming "chose" is the slip this check exists for.
 *  - initiative: the candidate started or pushed it ("drove", "spearheaded"). Any
 *    ownership or delivery verb supports it, except when the object is itself
 *    a decision ("drove the foundation decision"): then it needs a decision verb.
 */
const TRIGGERS: Record<VerbClass, string[]> = {
  responsibility: ["owned", "owns", "oversaw", "oversees", "headed", "directed", "managed"],
  decision: ["chose", "decided", "selected", "mandated"],
  initiative: [
    "drove", "drives", "spearheaded", "championed", "pioneered", "initiated", "established",
    "conceived", "invented", "architected", "founded", "cofounded",
  ],
};

const DELIVERY = [
  "led", "leads", "ran", "set", "defined", "built", "created", "designed", "wrote", "delivered",
  "launched", "shipped", "developed", "introduced", "implemented", "put", "made", "handled",
  "reduced", "grew", "increased", "cut", "achieved", "reached", "doubled", "migrated", "scaled",
  "responsible", "owner",
];

const CLASS_OF = new Map<string, VerbClass>(
  (Object.entries(TRIGGERS) as [VerbClass, string[]][]).flatMap(([cls, vs]) => vs.map((v) => [v, cls] as const)),
);

const ALL_TRIGGERS = [...TRIGGERS.responsibility, ...TRIGGERS.decision, ...TRIGGERS.initiative];
const SUPPORTS: Record<VerbClass, Set<string>> = {
  responsibility: new Set([...ALL_TRIGGERS, ...DELIVERY]),
  decision: new Set(TRIGGERS.decision),
  initiative: new Set([...ALL_TRIGGERS, ...DELIVERY]),
};

/** Objects that make any ownership verb a claim to have made the call. */
const DECISION_OBJECTS = new Set(["decision", "call", "choice"]);

/**
 * Absolutes that turn a true fact into a bigger one, with the words that
 * support each in the KB. "first" counts only as "the first ..." (not
 * "voice-first" or "shipped ... first").
 */
const ABSOLUTES: Record<string, string[]> = {
  mandatory: ["mandatory", "mandated", "required", "must"],
  sole: ["sole", "solely", "alone", "only"],
  solely: ["sole", "solely", "alone", "only"],
  "single handedly": ["single handedly", "alone", "solo"],
  entire: ["entire", "whole", "all", "full"],
  "company wide": ["company wide", "across the company", "all teams"],
  "org wide": ["org wide", "organization wide", "all teams"],
  "organization wide": ["org wide", "organization wide", "all teams"],
  "enterprise wide": ["enterprise wide", "across the enterprise"],
  every: ["every", "all", "each", "any", "always", "systematic", "systematically"],
  always: ["always", "every", "all", "each", "systematic", "systematically"],
  "the first": ["first"],
};

const ABSOLUTE_SEQS = Object.keys(ABSOLUTES).map((a) => a.split(" "));

const STOPWORDS = new Set(
  "a an the and or of to for in on at by with from into onto as is was were be been being it its this that these those his her their our my we he she they i me him them who which what when where how than then so such not no nor but if also both each per via across over under within without about after before during between through up out off more most other some any all own same very can will just only first every set".split(
    " ",
  ),
);

/**
 * A sentence that corrects or forbids never counts as support. When a line
 * opens with one (a CORRECTION entry, "decision taken before he joined"), the
 * whole line is about what NOT to claim and none of it supports.
 */
const GUARD_TERMS = "do not|don't|never|correction|supersedes|not his|not hers|not theirs|predates";

/**
 * The guard regex. "(taken|made) before X joined" names the candidate as he,
 * she, they, or by first name (from profile.md `name`), so a KB written in
 * the third person by name is read the same way.
 */
export function stretchGuard(candidateName?: string): RegExp {
  const first = (candidateName ?? "").trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z\u00c0-\u024f'-]/g, "");
  const who = ["he", "she", "they", ...(first ? [first] : [])].join("|");
  return new RegExp(`\\b(${GUARD_TERMS}|(taken|made) before (${who}) joined)\\b`, "i");
}

/** Words after which an ownership verb still has the candidate as its subject. */
const CLAUSE_JOINERS = new Set(["and", "then", "also", "personally", "jointly", "later"]);

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\bversus\b/g, "vs")
    .replace(/[^a-z0-9'+\-]+/g, " ")
    .replace(/-/g, " ")
    .trim();

const tokens = (s: string) => norm(s).split(/\s+/).filter(Boolean);

const stem = (w: string) => w.replace(/'s$/, "").replace(/(?:ing|ed|es|s)$/, "") || w;

const contentWords = (ws: string[]) => ws.filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d/.test(w)).map(stem);

/**
 * The content words of a text, stemmed, each once: what the rules of this file
 * compare. Exported for the line origins (line-origin.ts), which match a
 * résumé line to a fact with the same words the number rule counts.
 */
export const contentStems = (text: string): string[] => [...new Set(contentWords(tokens(text)))];

/** A bullet as clauses of tokens. The bold lead-in is a title, not a claim, and is dropped. */
const clauses = (bullet: string): string[][] =>
  bullet
    .replace(/\*\*[^*]*\*\*/g, " ")
    .split(/[.;:,()!?]|\s[—–-]\s/)
    .map(tokens)
    .filter((c) => c.length);

/** Non-guard sentences, tokenized. */
function textSentences(text: string, guard: RegExp): string[][] {
  const out: string[][] = [];
  for (const line of text.split("\n")) {
    const sentences = line.split(/(?<=[.;])\s+/);
    if (guard.test(sentences[0] ?? "")) continue;
    for (const sentence of sentences) {
      if (guard.test(sentence)) continue;
      // "Supported the launch: wrote the test plan". A colon opens the
      // candidate's own part, as "by" does; the drift rule reads it that way.
      const t = tokens(sentence.replace(/:\s/g, " by "));
      if (t.length) out.push(t);
    }
  }
  return out;
}

/** Verified, non-guard sentences of one employer's experiences (frontmatter included). */
const supportSentences = (exps: Experience[], guard: RegExp) =>
  exps.flatMap((e) => textSentences(serializeExperience(stripUnverified(e)), guard));

/**
 * Phrases the KB forbids: quoted text that follows "do not" / "never" /
 * "supersedes" in the same sentence, e.g. `never "I made the build-vs-buy
 * call"`. A quote the sentence permits is skipped: `never state a figure beyond
 * "tens of millions"` approves that phrase, and a quote in a later sentence
 * ("the honest form is ...", "the playbook ("road book")") is not covered by
 * the negation. A leading "I" is dropped so the phrase matches résumé bullets.
 */
export function deniedPhrases(exps: Experience[]): string[] {
  const out = new Set<string>();
  for (const e of exps) {
    // A fact with no tag is left out of the evidence, but a denial written on
    // one still binds: dropping it would let the forbidden wording through.
    const lines = [...serializeExperience(stripUnverified(e)).split("\n"), ...untaggedFacts(e.body).map((u) => u.text)];
    for (const line of lines) {
      for (const sentence of line.split(/(?<=[.;])\s+/)) {
        const m = sentence.match(/\b(do not|don't|never|supersedes)\b/i);
        if (!m || m.index === undefined) continue;
        const rest = sentence.slice(m.index);
        for (const q of rest.matchAll(/["“]([^"”]{4,80})["”]/g)) {
          if (/\b(beyond|other than|except|than|instead of|rather than)\b/i.test(rest.slice(0, q.index))) continue;
          const phrase = norm(q[1]!).replace(/^i /, "");
          if (phrase.split(" ").length >= 2) out.add(phrase);
        }
      }
    }
  }
  return [...out];
}

// --- Drift: the record's wording is weaker in kind ---------------------------

/** How a verified sentence opens when the candidate took part rather than led. */
const PARTICIPATION_OPENERS = [
  ["member", "of"], ["part", "of"], ["supported"], ["support"], ["supports"], ["supporting"], ["assisted"], ["assist"],
  ["helped"], ["help"], ["contributed"], ["contribute"], ["participated"], ["took", "part"], ["take", "part"],
  ["shadowed"], ["sat", "on"], ["served", "on"],
];
/** Words that keep the participation visible on the résumé. */
const PARTICIPATION_KEPT =
  /\b(?:member|support\w*|assist\w*|help\w*|contribut\w*|participat\w*|part of|took part|take part|alongside|jointly|collaborat\w*|worked with|working with|sat on|served on|shadow\w*|team that|co led|co authored|co wrote|co built|co designed|co developed)\b/;
const LEAD_VERBS = new Set([
  "led", "leads", "headed", "directed", "managed", "manages", "owned", "owns", "drove", "drives", "ran", "runs",
  "spearheaded", "oversaw", "oversees", "architected", "orchestrated", "championed",
]);

const ASSESSMENT_OPENERS = ["evaluated", "assessed", "explored", "researched", "investigated", "compared", "proposed", "recommended", "scoped", "studied"];
const ASSESSMENT_KEPT = /\b(?:evaluat\w*|assess\w*|explor\w*|research\w*|investigat\w*|compar\w*|propos\w*|recommend\w*|scop\w*|stud(?:y|ied|ies)|analy[sz]\w*|review\w*)\b/;
const IMPLEMENT_VERBS = new Set([
  "implemented", "built", "deployed", "launched", "shipped", "adopted", "migrated", "introduced", "ran", "runs", "operated",
  "operates", "integrated", "delivered", "productionized", "established", "rolled", "used", "uses", "moved", "replaced",
  "led", "created", "developed", "installed", "stood",
]);

const PILOT_WORDS = new Set(["pilot", "piloted", "pilots", "piloting", "trial", "trialled", "trialed", "trials", "poc", "beta"]);
const PILOT_KEPT = /\b(?:pilot\w*|trial\w*|poc|proof of concept|beta|prototype\w*|test\w*|experiment\w*)\b/;
const ROLLOUT_VERBS = new Set([
  "rolled", "launched", "deployed", "released", "shipped", "introduced", "implemented", "adopted", "scaled",
  "standardized", "standardised", "moved", "migrated", "established", "led", "delivered",
]);

/** Past forms that do not end in "ed", for reading the first word of a summary clause as a verb. */
const IRREGULAR_PAST = new Set(
  "wrote built ran led took won grew cut drove made set taught brought sold held kept began chose spoke gave sent spent met found did came went rebuilt rewrote oversaw".split(" "),
);
const isVerb = (w: string) => /ed$/.test(w) || IRREGULAR_PAST.has(w) || LEAD_VERBS.has(w) || IMPLEMENT_VERBS.has(w) || ROLLOUT_VERBS.has(w);

const startsWithAny = (s: string[], openers: string[][]) => {
  const t = s[0] === "i" ? s.slice(1) : s;
  return openers.find((o) => o.every((p, k) => t[k] === p));
};

/** Same word family by a shared opening of four letters ("moved" / "move", "launched" / "launch", "rolled" / "rollout"). */
const sameFamily = (a: string, b: string) => a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4);

interface Drift {
  trigger: string;
  detail: string;
}

/**
 * One clause of a bullet against the verified sentences of its employer. The
 * clause is matched to the sentences that share the most content words with
 * it; it drifts only if every one of those opens (or, for a pilot, reads) in
 * the weaker kind, the bullet keeps no word of that kind, and no other
 * verified sentence supports the stronger verb with the same objects.
 */
function clauseDrift(ts: string[], bulletNorm: string, sentences: string[][], verbOnly = false): Drift | null {
  const verb = ts[0] === "i" ? ts[1] : ts[0];
  if (!verb) return null;
  // A summary clause often opens on a noun ("Card authorization for …"): only a verb can drift.
  if (verbOnly && !isVerb(verb)) return null;
  const words = [...new Set(contentWords(ts.slice(ts.indexOf(verb) + 1)))];
  if (words.length < 2) return null;
  let best = 0;
  let matches: string[][] = [];
  for (const s of sentences) {
    const stems = new Set(s.map(stem));
    const score = words.filter((w) => stems.has(w)).length;
    if (score > best) {
      best = score;
      matches = [s];
    } else if (score === best && score > 0) matches.push(s);
  }
  if (best < 3 && !(best >= 2 && best / words.length >= 0.6)) return null;
  const quote = (s: string[]) => s.filter((t) => t !== "r").slice(0, 14).join(" ");

  // Took part, now leads or does it.
  if (!PARTICIPATION_KEPT.test(bulletNorm) && matches.every((s) => startsWithAny(s, PARTICIPATION_OPENERS))) {
    const s = matches[0]!;
    // The part the candidate supported or the team did: up to "by", where their own action starts.
    const by = s.indexOf("by");
    const scope = by > 0 ? s.slice(0, by) : s;
    const takesTeamsVerb = scope.slice(1).some((w) => !STOPWORDS.has(w) && sameFamily(w, verb));
    if ((LEAD_VERBS.has(verb) || takesTeamsVerb) && !supported(sentences.filter((x) => !startsWithAny(x, PARTICIPATION_OPENERS)), LEAD_VERBS, words.slice(0, 4))) {
      return { trigger: verb, detail: `the record says "${quote(s)}": the candidate took part, the bullet says "${verb}"` };
    }
  }
  // Assessed, now in place.
  if (IMPLEMENT_VERBS.has(verb) && !ASSESSMENT_KEPT.test(bulletNorm) && matches.every((s) => ASSESSMENT_OPENERS.includes(s[0] === "i" ? s[1]! : s[0]!))) {
    const s = matches[0]!;
    if (!s.some((w) => IMPLEMENT_VERBS.has(w)) && !supported(sentences.filter((x) => !matches.includes(x)), IMPLEMENT_VERBS, words.slice(0, 4))) {
      return { trigger: verb, detail: `the record says "${quote(s)}": it was assessed, the bullet says "${verb}"` };
    }
  }
  // A pilot, now a rollout.
  if (ROLLOUT_VERBS.has(verb) && !PILOT_KEPT.test(bulletNorm) && matches.every((s) => s.some((w) => PILOT_WORDS.has(w)))) {
    const s = matches[0]!;
    if (!s.some((w) => ROLLOUT_VERBS.has(w)) && !supported(sentences.filter((x) => !matches.includes(x)), ROLLOUT_VERBS, words.slice(0, 4))) {
      return { trigger: verb, detail: `the record says "${quote(s)}": it was a pilot, the bullet says "${verb}"` };
    }
  }
  return null;
}

// --- Numbers: the result a number is attached to ------------------------------

/** Where a clause ends: sentence punctuation, a comma, a dash between spaces, a bracket. */
const CLAUSE_END = /[.;:!?](?=\s|$)|,\s|\s[—–-]\s|[()]/g;
const SENTENCE_END = /[.;:!?](?=\s|$)/g;

/** The stretch of text around `index`, between two boundaries. */
function spanAt(text: string, index: number, boundary: RegExp): string {
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(boundary)) {
    const at = m.index ?? 0;
    if (at < index) start = at + m[0].length;
    else {
      end = at;
      break;
    }
  }
  return text.slice(start, end);
}

export interface NumberSupport {
  /** The number as written on the résumé. */
  raw: string;
  /** True for a plain count ("12 engineers"), false for a metric token ("40%"). */
  count: boolean;
  /** How many of the given lines state the same number. */
  stated: number;
  /** Content words of the clause that carries the number (the number and what it counts left out). */
  words: number;
  /** How many of them the closest line that states the number shares. */
  shared: number;
  /** That line. */
  line: string;
}

/**
 * Each number of a résumé line against the evidence lines that state it. The
 * clause is the text between two commas, dashes, brackets or sentence ends; a
 * clause of fewer than two content words is widened to its sentence.
 */
export function numberSupport(text: string, lines: string[]): NumberSupport[] {
  const clean = text.replace(/\*\*/g, "");
  return claimNumbers(text).map((n) => {
    const own = new Set(tokens(n.raw).map(stem));
    const wordsOf = (span: string) => [...new Set(contentWords(tokens(span)))].filter((w) => !own.has(w));
    let words = wordsOf(spanAt(clean, n.index, CLAUSE_END));
    if (words.length < 2) words = wordsOf(spanAt(clean, n.index, SENTENCE_END));
    const carrying = lines.filter((l) => n.statedIn(l));
    let shared = 0;
    let line = carrying[0] ?? "";
    for (const l of carrying) {
      const stems = new Set(tokens(l).map(stem));
      const k = words.filter((w) => stems.has(w)).length;
      if (k > shared) {
        shared = k;
        line = l;
      }
    }
    return { raw: n.raw, count: n.count, stated: carrying.length, words: words.length, shared, line };
  });
}

/** A date of the record ("2021-08", "2021", a parsed date, "present") as a count of months; null when unreadable. */
function monthOf(v: unknown, month: number, now: Date): number | null {
  const text = v instanceof Date ? v.toISOString().slice(0, 7) : String(v ?? "").trim();
  if (/^(?:present|current|now|ongoing|today)$/i.test(text)) return now.getFullYear() * 12 + now.getMonth() + 1;
  const m = text.match(/^(\d{4})(?:-(\d{1,2}))?/);
  return m ? +m[1]! * 12 + (m[2] ? +m[2] : month) : null;
}

/**
 * The lengths, in years, that the dates of the record give: each entry, each
 * employer (first start to last end) and the whole record. A date with no
 * month counts from January (a start) or to December (an end).
 */
function recordSpans(byCompany: Map<string, Experience[]>, now = new Date()): number[] {
  const spans: number[] = [];
  const range = (exps: Experience[]) => {
    const starts = exps.map((e) => monthOf(e.frontmatter.start, 1, now)).filter((y): y is number => y !== null);
    const ends = exps.map((e) => monthOf(e.frontmatter.end, 12, now)).filter((y): y is number => y !== null);
    if (starts.length && ends.length) spans.push((Math.max(...ends) - Math.min(...starts) + 1) / 12);
  };
  for (const exps of byCompany.values()) {
    for (const e of exps) range([e]);
    range(exps);
  }
  range([...byCompany.values()].flat());
  return spans.filter((y) => y > 0);
}

/** A number of years: "9 years", "10+ years", "nearly nine years", "a 12-year career". */
const YEARS = /(?<![\w.,])(\d{1,2}(?:\.\d)?|[a-z]+)\+?(?:\s+|-)(?:plus\s+)?years?\b/gi;

/** The numbers of years a text states, in digits. */
function yearsStated(text: string): { raw: string; value: string; atLeast: boolean }[] {
  const out: { raw: string; value: string; atLeast: boolean }[] = [];
  for (const m of text.matchAll(YEARS)) {
    const value = /^\d/.test(m[1]!) ? m[1]!.replace(/^0+(?=\d)/, "") : NUMBER_WORDS[m[1]!.toLowerCase()];
    // "10+ years", "more than ten years": a lower bound.
    const atLeast = /\+|\bplus\b/.test(m[0]) || /\b(?:more than|over|at least)\s+$/i.test(text.slice(0, m.index ?? 0));
    if (value) out.push({ raw: m[0], value, atLeast });
  }
  return out;
}

/** Every token of the phrase appears in order in the bullet, within a small window. */
function containsPhrase(bulletTokens: string[], phrase: string): boolean {
  const want = phrase.split(" ").map(stem);
  const have = bulletTokens.map(stem);
  for (let start = 0; start < have.length; start++) {
    if (have[start] !== want[0]) continue;
    let i = 1;
    for (let j = start + 1; j < have.length && j <= start + want.length + 3 && i < want.length; j++) {
      if (have[j] === want[i]) i++;
    }
    if (i === want.length) return true;
  }
  return false;
}

/** Content words the trigger attaches to: a few after it, and a few before for absolutes. */
function objectWords(ts: string[], at: number, before: number): string[] {
  const after = contentWords(ts.slice(at + 1, at + 8)).slice(0, 4);
  const prior = before ? contentWords(ts.slice(Math.max(0, at - 6), at)).slice(-before) : [];
  return [...new Set([...prior, ...after])];
}

/** Some sentence holds a matching word or phrase and shares content words with the claim. */
function supported(sentences: string[][], words: Iterable<string>, objects: string[]): boolean {
  const seqs = [...words].map((w) => w.split(" "));
  const need = Math.min(2, objects.length);
  return sentences.some((s) => {
    if (!s.some((_t, at) => seqs.some((q) => q.every((p, k) => s[at + k] === p)))) return false;
    if (need === 0) return true;
    const stems = new Set(s.map(stem));
    return objects.filter((o) => stems.has(o)).length >= need;
  });
}

/** Minimum content words a number's clause must share with a line that states the number. */
const NUMBER_MIN_SHARED = 1;

export const SUMMARY = "Executive summary";

/** The executive summary as the sentences the checks read, in order (a line break also ends a sentence). */
export const summarySentences = (summary: string): string[] =>
  summary
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z*"“(])/).filter((x) => x.trim()));

/**
 * `extraSupport` is the candidate's own curated writing (profile, base résumé):
 * wording they wrote themselves supports a claim under any employer it matches.
 */
export function checkResumeStretch(
  gen: GeneratedResume,
  experiences: Experience[],
  extraSupport = "",
  opts: { candidateName?: string } = {},
): StretchFinding[] {
  const guard = stretchGuard(opts.candidateName);
  const findings: StretchFinding[] = [];
  const byCompany = new Map<string, Experience[]>();
  for (const e of experiences) {
    const key = e.frontmatter.company.toLowerCase().trim();
    byCompany.set(key, [...(byCompany.get(key) ?? []), e]);
  }
  const denied = deniedPhrases(experiences);
  const extraSentences = textSentences(extraSupport, guard);
  // Verified, non-guard lines: what a number is compared with.
  const verifiedLines = (exps: Experience[]) =>
    exps.flatMap((e) => serializeExperience(stripUnverified(e)).split("\n")).filter((l) => l.trim() && !guard.test(l.split(/(?<=[.;])\s+/)[0] ?? ""));
  const extraLines = extraSupport.split("\n").filter((l) => l.trim());
  const companyNames = experiences.map((e) => e.frontmatter.company);
  const recordedText = experiences.map((e) => serializeExperience(stripUnverified(e))).join("\n");

  /**
   * One bullet, role intro or summary sentence against its support: the
   * verified sentences and lines of one employer (a bullet) or of the scope a
   * summary sentence has. `scope` names that support in the finding.
   */
  const checkUnit = (company: string, bullet: string, sentences: string[][], lines: string[], scope: string, summary = false) => {
    const flag = (rule: StretchFinding["rule"], trigger: string, detail: string) =>
      findings.push({ kind: "stretch", rule, company, bullet, trigger, detail });
    const of = scope ? `${scope} ` : "";
    const seen = new Set<string>();
    const bulletNorm = norm(bullet);
    for (const ts of clauses(bullet)) {
      const drift = clauseDrift(ts, bulletNorm, sentences, summary);
      if (drift && !seen.has(`drift:${drift.trigger}`)) {
        seen.add(`drift:${drift.trigger}`);
        seen.add(drift.trigger); // one finding per verb: the drift names the record's own sentence
        flag("drift", drift.trigger, drift.detail);
      }
      ts.forEach((w, i) => {
        // Ownership verb, only where the candidate is its implied subject:
        // the start of a clause or right after "and"/"then".
        const cls = CLASS_OF.get(w);
        if (cls && (i === 0 || CLAUSE_JOINERS.has(ts[i - 1]!)) && !seen.has(w)) {
          seen.add(w);
          const objects = objectWords(ts, i, 0);
          // "the foundation decision on ..." is a call; "a decision culture" is not.
          const aboutDecision = ts
            .slice(i + 1, i + 6)
            .some((t, k, rest) => DECISION_OBJECTS.has(t) && /^(on|to|of|that|for|between|)$/.test(rest[k + 1] ?? ""));
          const support = aboutDecision ? SUPPORTS.decision : SUPPORTS[cls];
          if (!supported(sentences, support, objects)) {
            flag(
              "ownership",
              w,
              aboutDecision || cls === "decision"
                ? `no verified ${of}fact says the candidate made this call (${objects.slice(0, 3).join(" / ")})`
                : `no verified ${of}fact says the candidate ${w} ${objects.slice(0, 3).join(" / ") || "this"}`,
            );
          }
        }

        const seq = ABSOLUTE_SEQS.find((a) => a.every((p, k) => ts[i + k] === p));
        if (!seq) return;
        const abs = seq.join(" ");
        if (seen.has(`abs:${abs}`)) return;
        seen.add(`abs:${abs}`);
        const objects = objectWords(ts, i + seq.length - 1, 2);
        if (!supported(sentences, ABSOLUTES[abs]!, objects)) {
          flag("absolute", abs, `"${abs}" is not in any verified ${of}fact about ${objects.slice(0, 3).join(" / ") || "this"}`);
        }
      });
    }

    // A number the support states, attached to another result.
    for (const n of numberSupport(bullet, lines)) {
      if (n.stated && n.words >= 2 && n.shared < NUMBER_MIN_SHARED && !seen.has(`n:${n.raw}`)) {
        seen.add(`n:${n.raw}`);
        flag("number", n.raw, `number attached to another result: the record states "${n.raw.split(" ")[0]}" in "${clip(n.line)}", and the résumé gives it to something else`);
      }
    }

    // "At <Name>, …": a client or a partner of the record given as the place of work.
    for (const org of proseOrganisations(bullet, companyNames, recordedText, extraSupport)) {
      if (org.opening && org.status === "recorded" && !seen.has(`org:${org.name}`)) {
        seen.add(`org:${org.name}`);
        flag("organisation", org.name, `"At ${org.name}" gives it as a place of work: the record names ${org.name} in a fact, not as an employer`);
      }
    }
  };

  // The summary, sentence by sentence. It has no single employer: support is
  // the whole verified record, or the employers the sentence names.
  const all = [...byCompany.values()].flat();
  const allSentences = [...supportSentences(all, guard), ...extraSentences];
  const allLines = [...verifiedLines(all), ...extraLines];
  const first = experiences.map((e) => String(e.frontmatter.start ?? "").slice(0, 4)).filter((y) => /^\d{4}$/.test(y)).sort()[0];
  const ends = experiences.map((e) => String(e.frontmatter.end ?? "").slice(0, 4));
  const last = ends.some((y) => !/^\d{4}$/.test(y)) ? "the present" : ends.sort().pop();
  const spans = recordSpans(byCompany);
  for (const line of gen.resume.executive_summary.split("\n").filter((l) => l.trim())) {
    const hit = denied.find((p) => containsPhrase(tokens(line), p));
    if (hit) {
      findings.push({
        kind: "denied",
        rule: "denied",
        company: SUMMARY,
        bullet: line,
        trigger: hit,
        detail: `the knowledge base says never to claim "${hit}"`,
      });
      continue;
    }
    for (const sentence of summarySentences(line)) {
      const named = [...byCompany.values()].filter((exps) => sentence.includes(exps[0]!.frontmatter.company.trim()));
      const scope = named.flat();
      const sentences = scope.length ? [...supportSentences(scope, guard), ...extraSentences] : allSentences;
      const lines = scope.length ? [...verifiedLines(scope), ...extraLines] : allLines;
      checkUnit(SUMMARY, sentence, sentences, lines, named.map((exps) => exps[0]!.frontmatter.company.trim()).join(" or "), true);
      const flag = (rule: StretchFinding["rule"], trigger: string, detail: string) =>
        findings.push({ kind: "stretch", rule, company: SUMMARY, bullet: sentence, trigger, detail });
      // Totals. A number of years that no line states and the dates of the
      // record do not give (one role, one employer, the whole record; a
      // lower bound such as "10+ years" within the whole record), then a
      // count that no line states.
      for (const y of yearsStated(sentence)) {
        const n = Number(y.value);
        if (allLines.some((l) => yearsStated(l).some((s) => s.value === y.value))) continue;
        if (y.atLeast ? n <= Math.floor(Math.max(0, ...spans)) : spans.some((span) => n === Math.floor(span) || n === Math.round(span))) continue;
        flag("total", y.raw, `no line of the record states "${y.raw}", and its dates do not give it${first ? ` (the roles run from ${first} to ${last})` : ""}. A total composed across roles is the candidate's to confirm`);
      }
      for (const n of numberSupport(sentence, lines)) {
        if (n.stated) continue;
        if (scope.length && numberSupport(sentence, allLines).some((m) => m.raw === n.raw && m.stated)) {
          flag("number", n.raw, `the record states "${n.raw.split(" ")[0]}" under another employer, not under ${named.map((exps) => exps[0]!.frontmatter.company.trim()).join(" or ")}`);
        } else if (n.count) {
          flag("total", n.raw, `no line of the record states "${n.raw}". A total composed across roles is the candidate's to confirm`);
        }
      }
    }
  }

  for (const exp of gen.resume.experience) {
    const own = byCompany.get(exp.company.toLowerCase().trim());
    if (!own) continue; // unknown employer already fails grounding
    const sentences = [...supportSentences(own, guard), ...extraSentences];
    const lines = [...verifiedLines(own), ...extraLines];
    for (const bullet of [exp.summary ?? "", ...exp.bullets].filter(Boolean)) {
      const hit = denied.find((p) => containsPhrase(tokens(bullet), p));
      if (hit) {
        findings.push({ kind: "denied", rule: "denied", company: exp.company, bullet, trigger: hit, detail: `the knowledge base says never to claim "${hit}"` });
        continue;
      }
      checkUnit(exp.company, bullet, sentences, lines, exp.company);
    }
  }
  return findings;
}

const clip = (s: string, n = 110) => {
  const t = s.replace(/\s+/g, " ").replace(/^[-*]\s+/, "").replace(/\s*\[[RCF]\]\s*$/, "").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
