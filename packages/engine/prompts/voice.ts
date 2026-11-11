/**
 * Kairos house style — the ONE shared writing standard applied to every piece of
 * candidate-facing text Kairos generates (résumé, cover letter, application
 * answers, and anything added later). Single source of truth: compose it into a
 * system prompt with `houseStyle(mode)` instead of repeating anti-AI-tell rules.
 *
 * Rules are the documented "tells" that make text read as machine-generated
 * (em dashes, "not just X but Y", tricolon stacking, buzzwords, uniform rhythm).
 * Applies to GENERATED text only — never to extraction, which must faithfully
 * preserve the candidate's own words.
 */
/**
 * Machine-checkable ban list — the single source both the prompt below and the
 * deterministic style gate (lib/tools/checks.ts) consume, so they can't drift.
 * Entries are matched case-insensitively at word boundaries; multi-word entries
 * are matched as phrases. "spearhead" covers inflections via prefix.
 * "orchestrat" is NOT here: it's legitimate AI terminology (agent/model
 * orchestration) but a tired power-verb in general use, so checks.ts flags it
 * context-sensitively (owner directive 2026-08-25) rather than banning outright.
 */
export const BANNED_WORDS: string[] = [
  "delve", "leverage", "utilize", "robust", "streamline", "harness",
  "spearhead", "testament", "landscape", "tapestry", "realm",
  "pivotal", "seamless", "foster", "garner", "underscore", "elevate",
  "navigate", "keen", "boasts", "passionate", "proven track record",
  "detail-oriented", "thrilled to apply", "excited to apply", "in today's",
  "ever-evolving", "relish", "wheelhouse",
];

export const HOUSE_STYLE_CORE = `WRITE LIKE A HUMAN, NOT AN AI. These are hard rules; each one is a documented tell that makes writing read as machine-generated:
- NO em dashes. None. Use a period, comma, colon, or rewrite the sentence. (This is the single biggest tell. Date ranges like "2022 - 2026" are fine.)
- NEVER use "not just X, but Y" / "it's not about X, it's Y" / "isn't just ... it's".
- At most ONE rule-of-three list in a passage; no stacked parallel clauses.
- Vary sentence length naturally, but never write a short sentence for effect: no punchlines, no one-line reveals ("The gate did say no."), no set-up-then-payoff.
- Plain words. BANNED: ${BANNED_WORDS.map((w) => (w.includes(" ") ? `"${w}"` : w)).join(", ")}.
- Cut superlatives and empty adverbs (extremely, incredibly, highly, deeply, truly, really).
- Be specific and concrete. Say the real thing rather than an abstraction.`;

/** Compose the house style for a system prompt. `mode` tunes format-specific notes. */
export function houseStyle(mode: "prose" | "resume"): string {
  const note =
    mode === "prose"
      ? `
- Use contractions (I've, it's, don't) where natural; zero contractions reads robotic.
- Prose only: no bold text, no bullet lists, no headers.`
      : `
- Résumé register: terse, high-signal bullets are good, and a short **bold thematic lead-in** on a bullet is an accepted résumé convention (not an AI tell here); the lead-in must be a condensed 2-4 word noun-phrase title, never a claim or slogan. Keep every metric exact.
- Vary the action verbs; never cluster Led / Orchestrated / Spearheaded / Pioneered.`;
  return `${HOUSE_STYLE_CORE}${note}`;
}
