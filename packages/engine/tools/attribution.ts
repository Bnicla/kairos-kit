/**
 * Attribution guard (anti prompt-injection for KB writes).
 *
 * The tailoring agent reads UNTRUSTED text (the job-ad snapshot fetched from an
 * arbitrary URL) in the same context where it holds `save_confirmed_fact`. A
 * malicious posting could instruct the model to store fabricated "confirmed"
 * facts, which the grounding gate would then treat as verified evidence for
 * every future résumé. This module provides the mechanical control: a fact may
 * be written only when its content is substantively derived from something the
 * CANDIDATE actually said in the conversation.
 *
 * Design: normalized token overlap. We extract the significant tokens of the
 * candidate fact and require that a threshold share of them appear in the
 * user-authored messages. Numbers get special treatment: an unattributed number
 * is exactly the fabrication vector we exist to block, so every numeric token
 * in the fact must appear in user text verbatim (post-normalization).
 * Paraphrase survives token overlap; injected content from the snapshot does
 * not, because the snapshot never enters the attribution corpus.
 */

const STOP = new Set(
  (
    "the a an and or of to in for with on at by from as is are was were be been being " +
    "will would can could should shall may might must do does did done has have had having " +
    "i me my mine we us our ours you your yours he him his she her hers it its they them their theirs " +
    "this that these those there here when where which who whom whose what why how " +
    "not no nor so too very just also both each any all some few more most other same such only own " +
    "into over under about against between during before after above below again further then once " +
    "yes yeah yep ok okay right well like really actually basically kind sort bit lot"
  ).split(/\s+/),
);

/** Lowercase, strip punctuation to spaces, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'%$€£+.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Significant word tokens (stopwords and short words removed). */
function wordTokens(text: string): string[] {
  return normalize(text)
    .split(" ")
    .map((t) => t.replace(/^[.'%$€£+]+|[.'%$€£+]+$/g, ""))
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d/.test(t));
}

/** Numeric tokens, comparison-normalized (no commas, keep symbols/suffixes). */
function numberTokens(text: string): string[] {
  return (text.match(/[$€£]?\d[\d,.]*\s?[%MBKmbk+]*/g) ?? []).map((n) =>
    n.toLowerCase().replace(/[,\s]/g, ""),
  );
}

// Candidates write "three PMs" as often as "3 PMs"; both must attribute.
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40",
  fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90",
  hundred: "100", thousand: "1000", million: "1000000", billion: "1000000000",
};

/** Digit strings implied by spelled-out numbers in the text. */
function wordNumberTokens(text: string): string[] {
  return normalize(text)
    .split(" ")
    .map((w) => NUMBER_WORDS[w])
    .filter((n): n is string => Boolean(n));
}

export interface AttributionResult {
  attributed: boolean;
  /** share of the fact's significant word tokens found in user text, 0..1 */
  overlap: number;
  /** numeric tokens in the fact that no user message contains */
  unsupportedNumbers: string[];
  reason: string | null;
}

export interface AttributionOptions {
  /** minimum share of significant word tokens that must appear in user text */
  threshold?: number;
}

/**
 * Is `content` substantively derived from what the user actually wrote?
 * `userMessages` must contain ONLY candidate-authored chat messages — never the
 * system context, never tool results, and above all never the job-ad snapshot.
 */
export function checkAttribution(
  content: string,
  userMessages: string[],
  opts: AttributionOptions = {},
): AttributionResult {
  const threshold = opts.threshold ?? 0.5;
  const userCorpus = normalize(userMessages.join("\n"));
  const userWords = new Set(wordTokens(userMessages.join("\n")));
  const userNumbers = new Set([
    ...numberTokens(userMessages.join("\n")),
    ...wordNumberTokens(userMessages.join("\n")),
  ]);

  if (!userCorpus) {
    return {
      attributed: false,
      overlap: 0,
      unsupportedNumbers: numberTokens(content),
      reason: "no user messages to attribute to",
    };
  }

  const words = wordTokens(content);
  // Stem-blind containment: "launched" matches user's "launch" and vice versa.
  const matchesUser = (t: string) =>
    userWords.has(t) ||
    userCorpus.includes(t) ||
    [...userWords].some((u) => u.length >= 4 && (t.startsWith(u) || u.startsWith(t)));
  const hit = words.filter(matchesUser).length;
  const overlap = words.length ? hit / words.length : 1;

  const unsupportedNumbers = numberTokens(content).filter((n) => {
    if (userNumbers.has(n)) return false;
    // "3" inside "3 pms" etc.: accept a bare-number match too.
    const bare = n.replace(/[^0-9.]/g, "");
    return !(bare && [...userNumbers].some((u) => u.replace(/[^0-9.]/g, "") === bare));
  });

  if (unsupportedNumbers.length) {
    return {
      attributed: false,
      overlap,
      unsupportedNumbers,
      reason: `numbers not stated by the candidate: ${unsupportedNumbers.join(", ")}`,
    };
  }
  if (overlap < threshold) {
    return {
      attributed: false,
      overlap,
      unsupportedNumbers: [],
      reason: `only ${(overlap * 100).toFixed(0)}% of the fact's words trace to candidate messages (need ${threshold * 100}%)`,
    };
  }
  return { attributed: true, overlap, unsupportedNumbers: [], reason: null };
}
