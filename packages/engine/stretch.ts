import type { Experience } from "@kairos/engine/kb/types";
import { serializeExperience, stripUnverified, untaggedFacts } from "@kairos/engine/kb/experience";
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
 * Deterministic and conservative: a sentence supports a claim when it holds a
 * verb of a supporting class (or the absolute word, or a synonym) and shares
 * content words with what the bullet attaches it to. Correction and "do not"
 * lines never support.
 */

export interface StretchFinding {
  kind: "denied" | "stretch";
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
      const t = tokens(sentence);
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

  // The summary aggregates across employers, so only the forbidden phrasings apply there.
  for (const line of gen.resume.executive_summary.split("\n").filter((l) => l.trim())) {
    const hit = denied.find((p) => containsPhrase(tokens(line), p));
    if (hit)
      findings.push({
        kind: "denied",
        company: "Executive summary",
        bullet: line,
        trigger: hit,
        detail: `the knowledge base says never to claim "${hit}"`,
      });
  }

  for (const exp of gen.resume.experience) {
    const own = byCompany.get(exp.company.toLowerCase().trim());
    if (!own) continue; // unknown employer already fails grounding
    const sentences = [...supportSentences(own, guard), ...extraSentences];
    for (const bullet of [exp.summary ?? "", ...exp.bullets].filter(Boolean)) {
      const flag = (trigger: string, detail: string, kind: StretchFinding["kind"] = "stretch") =>
        findings.push({ kind, company: exp.company, bullet, trigger, detail });

      const hit = denied.find((p) => containsPhrase(tokens(bullet), p));
      if (hit) {
        flag(hit, `the knowledge base says never to claim "${hit}"`, "denied");
        continue;
      }

      const seen = new Set<string>();
      for (const ts of clauses(bullet)) {
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
                w,
                aboutDecision || cls === "decision"
                  ? `no verified ${exp.company} fact says the candidate made this call (${objects.slice(0, 3).join(" / ")})`
                  : `no verified ${exp.company} fact says the candidate ${w} ${objects.slice(0, 3).join(" / ") || "this"}`,
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
            flag(abs, `"${abs}" is not in any verified ${exp.company} fact about ${objects.slice(0, 3).join(" / ") || "this"}`);
          }
        });
      }
    }
  }
  return findings;
}
