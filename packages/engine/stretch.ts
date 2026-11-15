import type { Experience } from "@kairos/engine/kb/types";
import { worded } from "@kairos/engine/wording";
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
 *    verified sentence whose own wording is weaker in kind. The knowledge base says the
 *    candidate took part ("member of the team that", "supported the launch")
 *    and the bullet leads or does the thing itself; the knowledge base says it was
 *    assessed ("evaluated", "recommended") and the bullet says it was put in
 *    place; the knowledge base says it was a pilot and the bullet says it was rolled
 *    out. Found by the provenance comparison, where these three passed.
 *
 *    Extended on 2026-11-15 (the outside audit's verb swaps, tests/stretch.test.ts): after a
 *    fact that says the candidate took part, any verb of doing drifts ("contributed to the
 *    guide" becoming "created the guide"), unless it is the candidate's own action, which the
 *    fact states after "by"; "one of three engineers who wrote" is taking part; a bullet that
 *    opens on the role ("Owner of …") leads; and a fact that says the work was shared ("worked
 *    with", "co-led") drifts when the bullet leads it, or does alone what was done jointly.
 *    Not covered: shared work written as a plain delivery verb ("worked with the data team on
 *    the model" becoming "built the model"), and any swap the fact's opening words do not show.
 *
 *  - number (2026-11-13, a "stretch" finding): a number the employer's facts do
 *    state, attached to another result. The knowledge base says "cut onboarding time
 *    by 40%" and the bullet says "raised revenue by 40%": grounding finds the
 *    40% and passes. The clause that carries the number is compared with the
 *    verified lines of that employer that state the same number; when it
 *    shares no content word with any of them, the number is listed.
 *  - organisation (2026-11-13, a "stretch" finding): "At <Name>, …" opening a
 *    sentence, where the knowledge base names <Name> in a fact (a client, a partner)
 *    and not as an employer. A name the knowledge base never mentions blocks in
 *    grounding.
 *
 * The executive summary (2026-11-13) is read sentence by sentence with the
 * same rules. A summary sentence has no single employer: support is any
 * verified sentence of the knowledge base, or, when the sentence names an employer of
 * the knowledge base (its company name as the knowledge base writes it), a verified sentence
 * of that employer. A number of years, or a count, that no line of the knowledge base
 * states is a total composed across roles and is listed (rule "total"): the
 * knowledge base cannot prove it from one line, and it does not block. A number of
 * years is not listed when the dates of the knowledge base give it: the length of one
 * entry, of one employer or of the whole knowledge base, rounded down or to the
 * nearest year ("10+ years": at most the whole knowledge base).
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

type VerbClass = "responsibility" | "decision" | "initiative" | "charge";

/**
 * Findings that stop the save since the guardrails of 15 November 2026: the knowledge base says less than the line
 * does, in kind. It says the person took part, supported, assisted, was a member or shared the work, and the line
 * leads, owns, runs or does the thing; it says it was assessed or piloted, and the line puts it in place; it gives a
 * result to something else, and the line makes it the person's doing; it names their role, and the line runs it; or
 * the line says they taught, and no fact does. The way through is the person's own confirmation of the stronger
 * fact, saved as theirs: never a rewording. An ownership verb or an absolute that no fact supports, a number on
 * another result, a client as a place of work and a total stay the person's to decide (keep, soften, drop).
 */
export const claimsMoreThanTheFact = (f: StretchFinding): boolean => f.kind === "stretch" && (f.rule === "drift" || (f.rule === "ownership" && TRIGGERS.charge.includes(f.trigger)));

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
  // The candidate taught the class themselves (15 November 2026: a teaching assistant who held office hours and
  // graded became "Taught a 120-student section"). Only a fact that says they taught supports it.
  charge: ["taught", "teaches", "instructed", "lectured"],
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

// The verbs of charge are not ownership verbs: a fact that says "owned" or "led" does not say "taught".
const ALL_TRIGGERS = [...TRIGGERS.responsibility, ...TRIGGERS.decision, ...TRIGGERS.initiative];
const SUPPORTS: Record<VerbClass, Set<string>> = {
  responsibility: new Set([...ALL_TRIGGERS, ...DELIVERY]),
  decision: new Set(TRIGGERS.decision),
  initiative: new Set([...ALL_TRIGGERS, ...DELIVERY]),
  // A fact that names the candidate as the one who teaches supports it; "teaching assistant" does not.
  charge: new Set([...TRIGGERS.charge, "teach", "lecturer", "lecture", "lectures", "instructor", "professor", "teacher", "tutor", "tutored"]),
};

/**
 * "…, leading the school's audience-facing writing", "now running a second shift": a lead claimed in the middle
 * of a sentence, where the clause rules do not look (15 November 2026). Supported by a verified sentence that
 * holds a word of leading and shares the objects.
 */
const LEAD_GERUNDS = new Set(["leading", "managing", "heading", "directing", "overseeing", "running", "supervising"]);
const LEAD_SUPPORT = new Set([
  "led", "leads", "lead", "leading", "leader", "ran", "runs", "run", "running", "managed", "manages", "manage", "managing", "manager",
  "headed", "head", "heading", "directed", "director", "directing", "oversaw", "oversees", "oversee", "overseeing", "supervised", "supervise",
  "supervisor", "supervising", "chaired", "chair", "owned", "owns", "owner", "responsible", "captain", "president", "founder", "founded",
]);

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

// --- Drift: the knowledge base's wording is weaker in kind ---------------------------

/** How a verified sentence opens when the candidate took part rather than led. */
const PARTICIPATION_OPENERS = [
  ["member", "of"], ["part", "of"], ["supported"], ["support"], ["supports"], ["supporting"], ["assisted"], ["assist"],
  ["helped"], ["help"], ["contributed"], ["contribute"], ["participated"], ["took", "part"], ["take", "part"],
  ["shadowed"], ["sat", "on"], ["served", "on"],
  // One of several: "one of three engineers who wrote", "one of a team of five that ran", "among the engineers who".
  ["one", "of"], ["among"],
];
/** Words that keep the participation visible on the résumé. */
/**
 * "support", "help" and "assist" count when they are the candidate's verb ("supported", "helping") or name what
 * the candidate gave ("support for the launch", "help with"). As a plain noun they name a thing ("the support
 * platform", "customer support team", "help desk") and keep nothing in view (2026-11-15).
 */
const PARTICIPATION_KEPT =
  /\b(?:member|support(?:ed|ing)|support(?= (?:to|for|of|on|in|with)\b)|assist(?:ed|ing|ance)|help(?:ed|ing)|help(?= (?:to|for|with|on)\b)|contribut\w*|participat\w*|part of|took part|take part|alongside|jointly|collaborat\w*|worked with|working with|sat on|served on|shadow\w*|team that|one of|among|co \w+)\b/;
/**
 * How a verified sentence opens when the work was shared (2026-11-15): the candidate worked with others, or led
 * or made the thing jointly ("co-led", "co-wrote"). The bullet drifts when it leads the thing alone, or does
 * alone what was done jointly, and no word of it keeps the others in view.
 */
const SHARED_OPENERS = [["worked", "with"], ["working", "with"], ["collaborated"], ["partnered"], ["jointly"], ["alongside"], ["teamed"], ["co"]];
/** Words that keep the others in view on the résumé, beyond the participation words. */
const SHARED_KEPT = /\b(?:with|together|joint\w*|shared|team)\b/;
/** A bullet that opens on the role itself ("Owner of the migration", "Lead on the rollout", "Responsible for …") claims the lead as a lead verb does. */
const LEAD_NOUNS = new Set(["owner", "lead", "leader", "head", "responsible", "accountable"]);
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

/** Past forms whose other forms do not share their opening letters. */
const BASE_OF: Record<string, string> = {
  wrote: "write", written: "write", built: "build", ran: "run", led: "lead", took: "take", taken: "take", made: "make", drove: "drive", driven: "drive",
  grew: "grow", grown: "grow", held: "hold", taught: "teach", brought: "bring", sold: "sell", kept: "keep", began: "begin", begun: "begin",
  chose: "choose", chosen: "choose", spoke: "speak", spoken: "speak", gave: "give", given: "give", sent: "send", spent: "spend", met: "meet",
  found: "find", did: "do", done: "do", won: "win", rebuilt: "rebuild", rewrote: "rewrite", oversaw: "oversee",
};
/** One form for the forms of a verb: "wrote", "writing", "writes" and "write" are the same action. */
const baseForm = (w: string) =>
  (BASE_OF[w] ?? w)
    .replace(/(?:ing|ed|es|s)$/, "")
    .replace(/([b-df-hj-np-tv-z])\1$/, "$1")
    .replace(/e$/, "");
const sameAction = (a: string, b: string) => sameFamily(a, b) || baseForm(a) === baseForm(b);

interface Drift {
  trigger: string;
  detail: string;
}

/** Forms of a verb that state what something did or was, beyond the past forms `isVerb` reads. */
const FINITE = new Set(["went", "was", "were", "is", "are", "has", "had", "rose", "fell", "won", "became", "dropped", "stayed", "remained", "stood", "came"]);
const OTHER_SUBJECTS = new Set(["the", "a", "an", "its", "their", "it", "they", "this", "that", "these", "those"]);
/**
 * A verified sentence whose subject is not the candidate: "the site went 410 days without a lost-time injury",
 * "the firm won 2", "a partner led the engagement". It states a result; it does not say the candidate brought it about.
 */
const anothersResult = (s: string[]) => {
  if (s.includes("i") || !OTHER_SUBJECTS.has(s[0]!)) return false;
  // The subject is another party, named in the first words: "the plant manager", "the firm", "a partner", "the site",
  // "the client's pilot". A sentence that opens on a thing of the candidate's own ("the dashboard …", "a new model:
  // designed and shipped …") is not read this way: it stopped real lines when it was (15 November 2026).
  const agent = s.slice(1, 4).findIndex((w) => OTHER_PARTIES.has(w));
  if (agent < 0) return false;
  const rest = s.slice(agent + 2, agent + 10);
  const verb = rest.findIndex((w) => isVerb(w) || FINITE.has(w));
  const label = rest.indexOf("by");
  return verb >= 0 && (label < 0 || verb < label);
};
const OTHER_PARTIES = new Set(
  (
    "manager managers director directors partner partners team teams client clients firm company cfo ceo coo cto vp owner controller controllers teammate teammates " +
    "colleague colleagues engineers engineer staff committee board customer customers vendor vendors agency department site plant store school district division " +
    "group unit supervisor principal professor founder founders leadership executives investors buyer buyers supplier suppliers"
  ).split(" "),
);

const ROLE_NOUNS = new Set([
  "analyst", "consultant", "associate", "assistant", "intern", "coordinator", "specialist", "member", "engineer", "developer",
  "representative", "clerk", "technician", "operator", "volunteer", "contributor", "participant", "researcher", "writer", "designer",
]);
/**
 * A verified sentence that names the candidate's role on something and no action of theirs: "Analyst then
 * consultant on 7 engagements: market sizing, customer surveys". Not a field of the entry ("title: …").
 */
const namesARole = (s: string[]) => {
  if (s[1] === "by") return false;
  const by = s.indexOf("by");
  const head = by > 0 ? s.slice(0, by) : s;
  return head.slice(0, 4).some((w) => ROLE_NOUNS.has(w)) && !s.some((w) => isVerb(w) || FINITE.has(w) || LEAD_SUPPORT.has(w));
};

/**
 * One clause of a bullet against the verified sentences of its employer. The
 * clause is matched to the sentences that share the most content words with
 * it; it drifts only if every one of those opens (or, for a pilot, reads) in
 * the weaker kind, the bullet keeps no word of that kind, and no other
 * verified sentence supports the stronger verb with the same objects.
 */
function clauseDrift(ts: string[], bulletNorm: string, sentences: string[][], verbOnly = false, sub = false): Drift | null {
  // "Sole owner of …", "Single-handedly ran …": the word of degree is the absolutes' to judge; the claim is the word after it.
  const from = ts[0] === "i" ? 1 : 0;
  const verb = ts[from] === "sole" || ts[from] === "solely" ? ts[from + 1] : ts[from];
  if (!verb) return null;
  // A summary clause often opens on a noun ("Card authorization for …"): only a verb can drift.
  if (verbOnly && !isVerb(verb)) return null;
  // Another's action, now the candidate's, read from the verb: the clause opens on a verb that the knowledge base
  // gives to something else ("the firm won 2" becoming "Won 2 of 3 bids", "the plant manager presented it" becoming
  // "and presented it") and to the candidate nowhere for this thing. Read before the clause's own words are counted:
  // such a clause is often two words long.
  if (isVerb(verb)) {
    const theirs = sentences.filter((x) => anothersResult(x) && x.some((w) => sameAction(w, verb)));
    const about = new Set(contentWords(tokens(bulletNorm)));
    const own = sentences.filter((x) => !anothersResult(x) && x.some((w) => sameAction(w, verb)) && x.filter((w) => about.has(stem(w))).length >= 2);
    if (theirs.length && !own.length) {
      const said = theirs[0]!.filter((t) => t !== "r").slice(0, 14).join(" ");
      return { trigger: verb, detail: `the knowledge base says "${said}": it states that result, not that the candidate brought it about, and the bullet says "${verb}"` };
    }
  }
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
    // Any other verb of doing ("contributed to the guide" becoming "created the guide", 2026-11-15) claims the thing
    // itself, unless it is the candidate's own action, which the sentence states after "by".
    const ownAction = by > 0 && matches.every((m) => m.indexOf("by") > 0 && m.slice(m.indexOf("by") + 1).some((w) => sameAction(w, verb)));
    const doesIt = isVerb(verb) && !ownAction;
    // In the second action of a line ("wrote the test plan and ran the sessions"), a verb the fact gives the candidate
    // after "by" is their own, also when it is a verb of leading: "ran acceptance sessions" is what they did.
    const leads = (LEAD_VERBS.has(verb) && !(sub && ownAction)) || (!verbOnly && LEAD_NOUNS.has(verb));
    const others = sentences.filter((x) => !startsWithAny(x, PARTICIPATION_OPENERS));
    if ((leads || (takesTeamsVerb && !(sub && ownAction)) || doesIt) && !supported(others, LEAD_VERBS, words.slice(0, 4)) && !supported(others, [verb], words.slice(0, 4))) {
      return { trigger: verb, detail: `the knowledge base says "${quote(s)}": the candidate took part, the bullet says "${verb}"` };
    }
  }
  // Shared, now alone: led jointly or worked with others, and the bullet leads it, or does alone what was done jointly.
  if (!PARTICIPATION_KEPT.test(bulletNorm) && !SHARED_KEPT.test(bulletNorm) && matches.every((s) => startsWithAny(s, SHARED_OPENERS))) {
    const s = matches[0]!;
    const t = s[0] === "i" ? s.slice(1) : s;
    // "co-led" reads as the two words "co led": the verb that was shared is the second.
    const jointVerb = t[0] === "co" ? t[1] : undefined;
    const alone = LEAD_VERBS.has(verb) || (!verbOnly && LEAD_NOUNS.has(verb)) || (jointVerb !== undefined && sameAction(verb, jointVerb));
    const others = sentences.filter((x) => !startsWithAny(x, SHARED_OPENERS) && !startsWithAny(x, PARTICIPATION_OPENERS));
    if (alone && !supported(others, LEAD_VERBS, words.slice(0, 4)) && !supported(others, [verb], words.slice(0, 4))) {
      return { trigger: verb, detail: `the knowledge base says "${quote(s)}": the work was shared, the bullet says "${verb}" alone` };
    }
  }
  // Another's result, now the candidate's doing: "the site went 410 days without a lost-time injury" becoming
  // "kept the site at 410 days" (15 November 2026).
  if (isVerb(verb) && matches.every(anothersResult)) {
    const s = matches[0]!;
    const own = sentences.filter((x) => !anothersResult(x));
    if (!supported(own, [verb], words.slice(0, 4)) && !supported(own, LEAD_VERBS, words.slice(0, 4))) {
      return { trigger: verb, detail: `the knowledge base says "${quote(s)}": it states that result, not that the candidate brought it about, and the bullet says "${verb}"` };
    }
  }
  // A role on something, now running it: "Analyst then consultant on 7 engagements: market sizing" becoming "Ran market sizing".
  if (LEAD_VERBS.has(verb) && matches.every(namesARole)) {
    const s = matches[0]!;
    const others = sentences.filter((x) => !namesARole(x));
    if (!supported(others, LEAD_VERBS, words.slice(0, 4))) {
      return { trigger: verb, detail: `the knowledge base says "${quote(s)}": it names the candidate's role on it, the bullet says "${verb}"` };
    }
  }
  // Assessed, now in place.
  if (IMPLEMENT_VERBS.has(verb) && !ASSESSMENT_KEPT.test(bulletNorm) && matches.every((s) => ASSESSMENT_OPENERS.includes(s[0] === "i" ? s[1]! : s[0]!))) {
    const s = matches[0]!;
    if (!s.some((w) => IMPLEMENT_VERBS.has(w)) && !supported(sentences.filter((x) => !matches.includes(x)), IMPLEMENT_VERBS, words.slice(0, 4))) {
      return { trigger: verb, detail: `the knowledge base says "${quote(s)}": it was assessed, the bullet says "${verb}"` };
    }
  }
  // A pilot, now a rollout.
  if (ROLLOUT_VERBS.has(verb) && !PILOT_KEPT.test(bulletNorm) && matches.every((s) => s.some((w) => PILOT_WORDS.has(w)))) {
    const s = matches[0]!;
    if (!s.some((w) => ROLLOUT_VERBS.has(w)) && !supported(sentences.filter((x) => !matches.includes(x)), ROLLOUT_VERBS, words.slice(0, 4))) {
      return { trigger: verb, detail: `the knowledge base says "${quote(s)}": it was a pilot, the bullet says "${verb}"` };
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

/** A date of the knowledge base ("2021-08", "2021", a parsed date, "present") as a count of months; null when unreadable. */
function monthOf(v: unknown, month: number, now: Date): number | null {
  const text = v instanceof Date ? v.toISOString().slice(0, 7) : String(v ?? "").trim();
  if (/^(?:present|current|now|ongoing|today)$/i.test(text)) return now.getFullYear() * 12 + now.getMonth() + 1;
  const m = text.match(/^(\d{4})(?:-(\d{1,2}))?/);
  return m ? +m[1]! * 12 + (m[2] ? +m[2] : month) : null;
}

/**
 * The lengths, in years, that the dates of the knowledge base give: each entry, each
 * employer (first start to last end) and the whole knowledge base. A date with no
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

/** Titles before a name, written with a capital: a full stop after one never ends a sentence. In small letters "ms" and "mt" are units, and end one. */
const TITLE = new Set(["dr", "mr", "mrs", "ms", "prof", "st", "mt"]);
/** Abbreviations that are always followed by what they belong to: a full stop after one never ends a sentence. */
const ABBREVIATION_NEVER_ENDS = new Set(["vs", "no", "approx", "est", "dept", "univ", "e.g", "i.e"]);
/** Abbreviations that close a name: a full stop after one may or may not end the sentence. */
const ABBREVIATION_MAY_END = new Set(["inc", "ltd", "corp", "co", "llc", "jr", "sr"]);
/** A word that starts a sentence in a résumé: a past or -ing verb form, a common irregular past, or a function word. */
const SENTENCE_START =
  /^(?:[A-Z][a-z]*(?:ed|ing)|Built|Ran|Won|Wrote|Grew|Drove|Made|Took|Held|Kept|Sold|Taught|Brought|Cut|Set|Spent|Rebuilt|Oversaw|Began|Chose|Gave|Got|Rose|Saw|Sent|Spoke|Stood|Went|Did|Has|Have|Had|Is|Are|Was|Were|The|A|An|I|He|She|They|We|It|This|That|These|Those|Now|Currently|Also|Seeking|Looking|Known|My|Our|His|Her|Their|As|In|At|With|For|On|After|Before|During|Since|While|When)\b/;

/**
 * Whether the full stop that closes `before` (the text up to and including it) ends a sentence, `next`
 * being the text after the white space that follows. The rule looks at the whole token the full stop
 * closes (from the last white space, without an opening bracket, quote or bold mark):
 *  - a full stop inside a number ("3.6", "$1.5M") is never followed by white space, so it is never asked about;
 *  - a token that holds anything but letters and inner full stops is not an abbreviation and ends the
 *    sentence: a digit ("€15M.", "$2B.", "50k.", "Q3.", "2024.", "1st."), a sign ("40%.", "AT&T.", "R&D.");
 *  - after a title written with a capital (Dr., Ms., Prof., St.) or a linking abbreviation (vs., No.,
 *    e.g., i.e.) the sentence goes on;
 *  - after a capital letter that is a word by itself (an initial, "J."), a dotted abbreviation ("B.S.",
 *    "Ph.D.", "U.S.": pieces of at most four letters, one of them a single letter, so "Node.js." is not
 *    one) or the abbreviation that closes a name ("Inc.", "Ltd.", "Jr."), the sentence goes on unless
 *    the next word reads as the start of one ("Led", "Built", "The", "Currently");
 *  - after anything else it ends, as before.
 * "?" and "!" always end a sentence.
 */
function endsSentence(before: string, next: string): boolean {
  if (!before.endsWith(".")) return true;
  const token = (/(\S+)\.$/.exec(before)?.[1] ?? "").replace(/^[(["“'*_]+/, "");
  if (!/^[A-Za-z]+(?:\.[A-Za-z]+)*$/.test(token)) return true; // a number, an amount, a bracket, a quote: not an abbreviation
  const word = token.toLowerCase();
  if (ABBREVIATION_NEVER_ENDS.has(word) || (TITLE.has(word) && /^[A-Z]/.test(token))) return false;
  const pieces = token.split(".");
  const initial = /^[A-Z]$/.test(token);
  const dotted = pieces.length > 1 && pieces.every((x) => x.length <= 4) && pieces.some((x) => x.length === 1);
  if (!initial && !dotted && !ABBREVIATION_MAY_END.has(word)) return true;
  return SENTENCE_START.test(next.replace(/^[*"“(]+/, ""));
}

/** A line of the summary without the mark of a list item ("- ", "* ", "• ", "1. "), so that a summary written as a list reads as its lines. */
const withoutListMark = (line: string) => line.replace(/^\s*(?:[-*+•–]|\d{1,2}[.)])\s+(?=\S)/, "");

/**
 * The executive summary as the sentences the checks read, in order. A line break ends a sentence;
 * so does a full stop, a "?" or a "!" followed by white space and a capital, a quote, a bracket or a
 * bold mark, except after an abbreviation (endsSentence).
 */
export const summarySentences = (summary: string): string[] =>
  summary
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((raw) => {
      const line = withoutListMark(raw);
      const out: string[] = [];
      let from = 0;
      for (const m of line.matchAll(/(?<=[.!?])\s+(?=[A-Z*"“(])/g)) {
        const at = m.index!;
        if (!endsSentence(line.slice(from, at), line.slice(at + m[0].length))) continue;
        out.push(line.slice(from, at));
        from = at + m[0].length;
      }
      out.push(line.slice(from));
      return out.filter((x) => x.trim());
    });

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
    // "Leads retail engagements, including a grocery chain, a home goods retailer and a regional pharmacy chain": the
    // lead is claimed of each thing the list names. Where the knowledge base says the candidate took part in one of
    // them ("Supported the due diligence of a regional pharmacy chain… A partner led the engagement"), that is a
    // drift, though the clause with the verb names none of them (the second run on other professions, 15 November 2026).
    let leading: string | undefined;
    for (const ts of clauses(bullet)) {
      const opens = ts[0] === "i" ? ts[1] : ts[0];
      if (opens && (LEAD_VERBS.has(opens) || opens === "lead" || opens === "leading")) leading = opens === "leading" || opens === "lead" ? "leads" : opens;
      else if (opens && isVerb(opens)) leading = undefined;
      else if (leading && !ts.some((w) => isVerb(w) || FINITE.has(w))) {
        const items = ts.join(" ").split(/\s+(?:and|or)\s+/).map((x) => x.replace(/^(?:including|such as|like|from|across|for|with|among)\s+/, "").replace(/^(?:the|a|an)\s+/, "").split(" ").filter(Boolean));
        for (const item of items) {
          const drift = clauseDrift([leading, ...item], bulletNorm, sentences, false, false);
          if (drift && !seen.has(`drift:${drift.trigger}`)) {
            seen.add(`drift:${drift.trigger}`);
            seen.add(drift.trigger);
            flag("drift", drift.trigger, drift.detail);
          }
        }
      }
    }
    for (const ts of clauses(bullet)) {
      // The clause, and each part of it that starts a new action of the candidate's ("cut mis-picks … and kept the site …").
      // Only where the clause is the candidate's own action: after "the app was demonstrated to the class and used by
      // classmates", "used" is still the app's.
      // (A clause can also start in the middle of the candidate's own sentence, after the full stop of "1.9%".)
      const own = !OTHER_SUBJECTS.has(ts[0]!);
      const starts = [0, ...(own ? ts.flatMap((w, i) => ((w === "and" || w === "then") && i > 0 && ts[i + 1] !== undefined && isVerb(ts[i + 1]!) ? [i + 1] : [])) : [])];
      for (const [k, at] of starts.entries()) {
        const drift = clauseDrift(ts.slice(at, starts[k + 1] !== undefined ? starts[k + 1]! - 1 : undefined), bulletNorm, sentences, summary || at > 0, at > 0);
        if (drift && !seen.has(`drift:${drift.trigger}`)) {
          seen.add(`drift:${drift.trigger}`);
          seen.add(drift.trigger); // one finding per verb: the drift names the knowledge base's own sentence
          flag("drift", drift.trigger, drift.detail);
        }
      }
      ts.forEach((w, i) => {
        // A lead claimed in the middle of a sentence ("…, leading the school's writing").
        if (!LEAD_GERUNDS.has(w) || seen.has(w)) return;
        const objects = objectWords(ts, i, 0);
        if (objects.length < 2 || supported(sentences, LEAD_SUPPORT, objects)) return;
        seen.add(w);
        flag("ownership", w, `no verified ${of}fact says the candidate led ${objects.slice(0, 3).join(" / ")}`);
      });
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
        flag("number", n.raw, `number attached to another result: the knowledge base states "${n.raw.split(" ")[0]}" in "${clip(n.line)}", and the résumé gives it to something else`);
      }
    }

    // "At <Name>, …": a client or a partner of the knowledge base given as the place of work.
    for (const org of proseOrganisations(bullet, companyNames, recordedText, extraSupport)) {
      if (org.opening && org.status === "recorded" && !seen.has(`org:${org.name}`)) {
        seen.add(`org:${org.name}`);
        flag("organisation", org.name, `"At ${org.name}" gives it as a place of work: the knowledge base names ${org.name} in a fact, not as an employer`);
      }
    }
  };

  // The summary, sentence by sentence. It has no single employer: support is
  // the whole verified knowledge base, or the employers the sentence names.
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
        detail: worded`the knowledge base says never to claim "${hit}"`,
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
      // knowledge base do not give (one role, one employer, the whole knowledge base; a
      // lower bound such as "10+ years" within the whole knowledge base), then a
      // count that no line states.
      for (const y of yearsStated(sentence)) {
        const n = Number(y.value);
        if (allLines.some((l) => yearsStated(l).some((s) => s.value === y.value))) continue;
        if (y.atLeast ? n <= Math.floor(Math.max(0, ...spans)) : spans.some((span) => n === Math.floor(span) || n === Math.round(span))) continue;
        flag("total", y.raw, `no line of the knowledge base states "${y.raw}", and its dates do not give it${first ? ` (the roles run from ${first} to ${last})` : ""}. A total composed across roles is the candidate's to confirm`);
      }
      for (const n of numberSupport(sentence, lines)) {
        if (n.stated) continue;
        if (scope.length && numberSupport(sentence, allLines).some((m) => m.raw === n.raw && m.stated)) {
          flag("number", n.raw, `the knowledge base states "${n.raw.split(" ")[0]}" under another employer, not under ${named.map((exps) => exps[0]!.frontmatter.company.trim()).join(" or ")}`);
        } else if (n.count) {
          flag("total", n.raw, `no line of the knowledge base states "${n.raw}". A total composed across roles is the candidate's to confirm`);
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
        findings.push({ kind: "denied", rule: "denied", company: exp.company, bullet, trigger: hit, detail: worded`the knowledge base says never to claim "${hit}"` });
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
