/**
 * The product's word for what Kairos holds about the user is "knowledge base"
 * in every form of Kairos (the owner's decision of 14 November 2026). Until
 * then the connector said "record", and this file made the engine's own fixed
 * sentences follow. Nothing calls `sayRecord` any more: the sentences below
 * come back as written. The switch is kept for a form that would need another
 * word (Cloud has its own copy of the engine and its own words).
 *
 * `worded` is a template tag. It rewrites the fixed parts of a sentence, the
 * ones written in the source, and never a value put into it: a user's own
 * text can hold the words "knowledge base" (someone who built one at work)
 * and comes back unchanged.
 *
 *   worded`"${exp.company}" is not a knowledge-base experience`
 *
 * The setting is for the whole process and can only be turned on (the
 * connector does, when it starts). Nothing turns it off again.
 */
let record = false;

/** From now on the engine's fixed sentences say "record". Called by the connector when it starts. */
export function sayRecord(): void {
  record = true;
}

/** Whether the fixed sentences say "record" (the connector) or "knowledge base" (the local product). */
export const saysRecord = (): boolean => record;

/** A fixed piece of a sentence in the connector's words. The folder's path keeps its shape ("record/..."). */
export function recordWords(fixed: string): string {
  return fixed
    .replace(/knowledge-base\//g, "record/")
    .replace(/knowledge[- ]base/gi, (m) => (m[0] === "K" ? "Record" : "record"))
    .replace(/\bKB\b/g, "record");
}

/**
 * A text that is the engine's own from its first character to its last (a system prompt, an output
 * contract), in the product's words. Never for a text that holds a user's words: use `worded` there.
 */
export const wordedText = (fixed: string): string => (record ? recordWords(fixed) : fixed);

/** Template tag: the sentence as written, or with its fixed parts in the connector's words; the values are never changed. */
export function worded(fixed: TemplateStringsArray, ...values: unknown[]): string {
  let out = "";
  fixed.forEach((part, i) => {
    out += record ? recordWords(part) : part;
    if (i < values.length) out += String(values[i]);
  });
  return out;
}
