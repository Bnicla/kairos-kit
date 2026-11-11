import { checkStyle, isHardStyleViolation, type StyleViolation } from "@kairos/engine/tools/checks";
import { compileBannedPatterns, type VoiceSettings } from "@kairos/engine/settings";

/**
 * Deterministic anti-slop gate for candidate-facing PROSE (cover letters,
 * outreach, free-text application answers). The résumé gate (checkStyle)
 * catches vocabulary; letters fail on rhetoric: attention hooks, colon
 * reveals, mic-drop one-liners, the same rhetorical move made twice in
 * different words. Every family below is a pattern rejected in a real
 * draft or a documented AI tell.
 *
 * Families are matched on the letter BODY (header, date, greeting and
 * sign-off stripped), case-insensitively.
 */

export interface ProseViolation {
  rule:
    | StyleViolation["rule"]
    | "attention-hook"
    | "hook-repeated"
    | "reveal-setup"
    | "mic-drop"
    | "rhetorical-question"
    | "stock-closer"
    | "sycophancy"
    | "bridge-claim"
    | "jd-parroting"
    | "i-opener-run"
    | "slop-phrase"
    | "contrastive-reframe"
    | "significance-tail"
    | "tricolon"
    | "i-opener-share"
    | "one-line-paragraphs"
    | "no-specifics"
    | "structure";
  detail: string;
  hard: boolean;
}

/** "This caught my eye" moves. One is already a template; two is the repetition to flag. */
const ATTENTION_HOOKS: RegExp[] = [
  /\bcaught my (?:attention|eye)\b/i,
  /\bstood out to me\b/i,
  /\b(?:one|a) (?:line|phrase|sentence|detail|thing) in (?:your|the) (?:posting|job (?:ad|description)|listing)\b/i,
  /\b(?:immediately |really )?(?:resonate[sd]?|resonating) with me\b/i,
  /\bdrew me (?:in|to)\b/i,
  /\bwhat (?:excites|draws|attracts) me\b/i,
  /\bI(?:'m| am) (?:excited|thrilled|delighted|eager) (?:to|about|by)\b/i,
  /\bI was (?:excited|thrilled|delighted) to (?:see|read|come across)\b/i,
  /\bwhen I (?:saw|read|came across) (?:your|the|this)\b/i,
];

/** Set-up-then-reveal constructions: the sentence exists to deliver a punchline. */
const REVEAL_SETUPS: RegExp[] = [
  /\bhere(?:'s| is) (?:why|the thing|what|how)\b/i,
  /\bthe (?:thing|truth|reality|catch|kicker|short version) is\b/i,
  /\b(?:my|the) (?:main |key |real |big )?(?:takeaway|lesson|retrospective|insight|conclusion)(?: was| is)?(?: simple| plain| clear)?:/i,
  /\b(?:my|the) (?:main |key |real )?(?:takeaway|lesson) (?:was|is) (?:simple|plain|clear)\b/i,
  /\b(?:put|said) (?:simply|another way|differently)\b/i,
  /\bin (?:short|other words|a word)\b/i,
  /\bthat(?:'s| is) (?:exactly |precisely )?(?:why|what|where)\b/i,
  /\bI learned (?:that|this|it) (?:one )?the hard way\b/i,
  /\bwhich brings me to\b/i,
];

/** Closers every generated letter ends with. */
const STOCK_CLOSERS: RegExp[] = [
  /\bI(?:'d| would) welcome the (?:chance|opportunity)\b/i,
  /\bI look forward to (?:the opportunity|hearing|discussing|speaking)\b/i,
  /\b(?:eager|keen|excited) to (?:discuss|explore|learn more|contribute|bring)\b/i,
  /\bwould love the (?:chance|opportunity)\b/i,
  /\bthank you for (?:your|considering)\b.*\b(?:time|consideration|application)\b/i,
  /\bI(?:'d| would) like to hear how\b/i,
];

/** Flattery of the employer and fit-claims that say nothing. */
const SYCOPHANCY: RegExp[] = [
  /\b(?:perfect|ideal|natural|great|strong) (?:fit|match|sandbox|opportunity|next step)\b/i,
  /\baligns? (?:perfectly|closely|well|directly) with\b/i,
  /\b(?:massive|seismic|fundamental|tectonic) shift\b/i,
  /\byour (?:innovative|impressive|inspiring|incredible|exciting) (?:culture|mission|work|team|vision)\b/i,
  /\bat the intersection of\b/i,
  /\bI thrive (?:in|where|when|on)\b/i,
  /\bmore than ever\b/i,
  /\bat the forefront of\b/i,
  /\b(?:cutting-edge|groundbreaking|industry-leading|renowned) (?:approach|work|company|mission|platform|team)\b/i,
  /\b(?:your|the company's) (?:commitment|dedication|passion) to\b/i,
  /\bI (?:believe|am confident|feel) (?:that )?(?:I|my)\b[^.]{0,40}\b(?:great|strong|ideal|perfect|good) (?:fit|match|candidate)\b/i,
  /\bwould (?:be|make) a (?:valuable|great|strong) (?:addition|asset)\b/i,
];

/** Bridges that assert two things are "the same" instead of showing it. */
const BRIDGE_CLAIMS: RegExp[] = [
  /\b(?:is|are|was) (?:exactly |essentially )?the same (?:problem|idea|ideas|challenge|lesson|thing|question)s?\b/i,
  /\bthe same (?:ideas?|principles?|lessons?) I(?:'ve| have) been\b/i,
  /\bthat (?:separation|lesson|principle|discipline) is (?:what|exactly)\b/i,
  /\bthat(?:'s| is) (?:close to|similar to|much like) what\b/i,
];

/**
 * Phrases over-represented in model prose (slop lexicons; letter register).
 * The default banned-phrase list: the profile's `voice.banned_patterns`
 * extends it, or replaces it with `voice.replace_default_patterns: true`.
 */
const SLOP_PHRASES: RegExp[] = [
  /\bfirst-hand\b|\bfirsthand\b/i,
  /\bhit the ground running\b/i,
  /\bwear many hats\b/i,
  /\bmove the needle\b/i,
  /\b(?:unique|rare) (?:blend|combination|mix) of\b/i,
  /\bbridg(?:e|es|ing) the gap\b/i,
  /\bdeep(?:ly)? (?:passion|passionate|commitment)\b/i,
  /\bin (?:the|this) (?:fast-paced|rapidly (?:changing|evolving))\b/i,
  /\bgame[- ]changer\b/i,
  /\bnorth star\b/i,
  /\bunlock(?:s|ing|ed)? (?:value|potential|growth)\b/i,
  /\bdouble down\b/i,
  /\bnobody could argue with\b/i,
  /\balready paid for\b/i,
  /\bthe kind of (?:gate|thing|work|problem|leader|person) (?:I|that)\b/i,
  /\bat scale\b.*\bat scale\b/i,
];

/**
 * Contrastive reframes beyond "not just X but Y" (Antislop paper, Appendix L):
 * "not because X but because Y", "Not X. Not Y.", "It's not X. It's Y."
 */
const CONTRASTIVE: RegExp[] = [
  /\bnot (?:because|about)\b[^.]{0,80}\bbut (?:because|about)\b/i,
  /,\s*not (?:just|only|merely)\b/i,
  /\bWhat I (?:haven't|have not|didn't|did not)\b[^.]{0,160}\.\s*What I (?:have|did|do)\b/i,
  /\b(?:rather|instead) than (?:only|just|merely)\b/i,
  /(?:^|[.!?]\s+)Not [^.]{1,60}\. Not [^.]{1,60}\./,
  /\b(?:it|this|that)(?:'s| is) not (?:a |an |the )?[^.]{1,50}\. (?:it|this|that)(?:'s| is)\b/i,
  /\bno longer\b[^.!?]{1,80}[.!?]\s*(?:it|they)(?:'s| is| are)\b/i,
];

/** A trailing "-ing" clause that inflates significance (Wikipedia, Signs of AI writing). */
const SIGNIFICANCE_TAIL = /,\s*(?:highlighting|underscoring|emphasizing|showcasing|reflecting|fostering|demonstrating|cementing|reinforcing)\b/gi;

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z"“(])/;

/** Strip header, date, greeting and sign-off; keep body paragraphs and bullets. */
export function letterBody(text: string): string {
  const blocks = text.trim().split(/\n{2,}/);
  const greeting = blocks.findIndex((b) => /^(?:dear|hello|hi)\b/i.test(b.trim()));
  let body = greeting >= 0 ? blocks.slice(greeting + 1) : blocks;
  // Drop the sign-off: trailing short blocks ("Best regards,", the name).
  while (body.length && body[body.length - 1].trim().split(/\s+/).length <= 4) body = body.slice(0, -1);
  return body.join("\n\n");
}

const sentencesOf = (body: string) =>
  body
    .split(/\n+/)
    .map((l) => l.replace(/^[-*•]\s+(?:\*\*[^*]+\*\*:?\s*)?/, "").replace(/\*\*/g, ""))
    .flatMap((l) => l.split(SENTENCE_SPLIT))
    .map((s) => s.trim())
    .filter((s) => /\w/.test(s));

const ngrams = (words: string[], n: number) => {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
};
const wordsOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9%$'\s-]/g, " ").split(/\s+/).filter(Boolean);

/**
 * Shape check: name first, greeting, then a real body. A generated letter once
 * came back body-first with "[The above three paragraphs are the body.]" after
 * the greeting, and the body-only checks below saw nothing (2026-10-09).
 */
function checkStructure(text: string): ProseViolation[] {
  const out: ProseViolation[] = [];
  const blocks = text.trim().split(/\n{2,}/);
  const greeting = blocks.findIndex((b) => /^(?:dear|hello|hi)\b/i.test(b.trim()));
  if (greeting < 0) out.push({ rule: "structure", detail: "no greeting line (\"Dear …,\")", hard: true });
  else if (greeting > 3) out.push({ rule: "structure", detail: "text before the header: the letter must start with the name, contact line, date, then the greeting", hard: true });
  const placeholder = text.match(/\[[^\]]{0,120}\]/);
  if (placeholder) out.push({ rule: "structure", detail: `placeholder left in the letter: "${placeholder[0]}"`, hard: true });
  const bodyWords = letterBody(text).split(/\s+/).filter(Boolean).length;
  if (greeting >= 0 && bodyWords < 80) out.push({ rule: "structure", detail: `body after the greeting is only ${bodyWords} words`, hard: true });
  return out;
}

export function checkProse(text: string, opts: { jobText?: string; voice?: VoiceSettings } = {}): ProseViolation[] {
  const out: ProseViolation[] = checkStructure(text);
  // Style checks run on everything except the header/greeting/sign-off; if the
  // shape is broken, check the whole text so a misplaced body is never skipped.
  const body = out.length ? text : letterBody(text);

  for (const v of checkStyle(body)) out.push({ rule: v.rule, detail: v.detail, hard: isHardStyleViolation(v) });

  const hits = (family: RegExp[]) =>
    family.flatMap((re) => [...body.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))].map((m) => m[0]));

  const hooks = hits(ATTENTION_HOOKS);
  for (const h of hooks) out.push({ rule: "attention-hook", detail: `"${h}": say the observation itself, not that it caught your eye`, hard: true });
  if (hooks.length > 1) out.push({ rule: "hook-repeated", detail: `${hooks.length} attention hooks (${hooks.map((h) => `"${h}"`).join(", ")}): the same move made twice`, hard: true });

  for (const h of hits(REVEAL_SETUPS)) out.push({ rule: "reveal-setup", detail: `"${h}": state the point directly instead of setting it up`, hard: true });
  for (const h of hits(STOCK_CLOSERS)) out.push({ rule: "stock-closer", detail: `"${h}": stock closing line`, hard: true });
  for (const h of hits(SYCOPHANCY)) out.push({ rule: "sycophancy", detail: `"${h}"`, hard: true });
  const userBanned = compileBannedPatterns(opts.voice?.banned_patterns);
  const banned = opts.voice?.replace_default_patterns ? userBanned : [...SLOP_PHRASES, ...userBanned];
  for (const h of hits(banned)) out.push({ rule: "slop-phrase", detail: `"${h}"`, hard: true });
  for (const h of hits(CONTRASTIVE)) out.push({ rule: "contrastive-reframe", detail: `"${h.slice(0, 80)}"`, hard: true });
  for (const m of body.matchAll(SIGNIFICANCE_TAIL)) out.push({ rule: "significance-tail", detail: `"${m[0].trim()}": end the sentence at the fact`, hard: true });
  for (const h of hits(BRIDGE_CLAIMS)) out.push({ rule: "bridge-claim", detail: `"${h}": show the link with a fact instead of asserting sameness`, hard: false });

  // Sentence-shape checks always use the clean body: header lines are short by nature.
  const sentences = sentencesOf(letterBody(text));
  // Mic-drop one-liners ("The gate did say no."): very short declaratives used for rhythm.
  const shorts = sentences.filter((s) => s.split(/\s+/).length <= 5 && !/^(?:thanks|thank you)/i.test(s));
  if (shorts.length > 1) out.push({ rule: "mic-drop", detail: `${shorts.length} punchline-length sentences: ${shorts.map((s) => `"${s}"`).join(", ")}`, hard: true });
  else if (shorts.length === 1) out.push({ rule: "mic-drop", detail: `"${shorts[0]}": check it carries information, not rhythm`, hard: false });

  for (const s of sentences.filter((x) => x.endsWith("?"))) out.push({ rule: "rhetorical-question", detail: `"${s}"`, hard: true });

  // Three sentences in a row opening with "I" reads like a list of claims.
  let run = 0;
  for (const s of sentences) {
    run = /^I\b/.test(s) ? run + 1 : 0;
    if (run === 3) {
      out.push({ rule: "i-opener-run", detail: `three consecutive sentences open with "I" (at "${s.slice(0, 40)}…")`, hard: false });
      break;
    }
  }

  // Density, not presence: one list of three is human, a letter built on them is not.
  const tricolons = sentences.filter((x) => /\b\w+(?:\s\w+){0,3}, \w+(?:\s\w+){0,3},? and \w+/.test(x));
  if (tricolons.length >= 2) out.push({ rule: "tricolon", detail: `${tricolons.length} sentences built on a list of three`, hard: false });

  const iShare = sentences.length ? sentences.filter((x) => /^I\b/.test(x)).length / sentences.length : 0;
  if (sentences.length >= 6 && iShare > 0.4) out.push({ rule: "i-opener-share", detail: `${Math.round(iShare * 100)}% of sentences open with "I"`, hard: false });

  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p && !/^[-*•]\s/.test(p));
  const oneLiners = paragraphs.filter((p) => sentencesOf(p).length === 1 && !/:$/.test(p));
  if (oneLiners.length >= 2) out.push({ rule: "one-line-paragraphs", detail: `${oneLiners.length} one-sentence paragraphs`, hard: false });

  // Specificity floor: every paragraph names something real (a number or a proper noun mid-sentence).
  for (const p of paragraphs.filter((x) => !/:$/.test(x))) {
    if (!/\d/.test(p) && !/(?<=[a-z,;]\s)[A-Z][a-zA-Z'’]+/.test(p)) {
      out.push({ rule: "no-specifics", detail: `paragraph names nothing concrete: "${p.slice(0, 60)}…"`, hard: false });
    }
  }

  // Parroting the posting: long verbatim runs copied from the job ad. Quoting
  // one phrase on purpose is fine; echoing it repeatedly is a template tell.
  if (opts.jobText) {
    const jd = ngrams(wordsOf(opts.jobText), 6);
    const copied = new Set<string>();
    for (const s of sentences) for (const g of ngrams(wordsOf(s), 6)) if (jd.has(g)) copied.add(s);
    if (copied.size > 1) {
      out.push({
        rule: "jd-parroting",
        detail: `${copied.size} sentences copy 6+ words verbatim from the posting: ${[...copied].map((s) => `"${s.slice(0, 60)}…"`).join(", ")}`,
        hard: false,
      });
    }
  }
  return out;
}

export const hardProseViolations = (v: ProseViolation[]) => v.filter((x) => x.hard);
