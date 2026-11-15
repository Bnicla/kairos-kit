/**
 * The text of the documents a knowledge base is being built from, kept while
 * the server runs, so that a first import can say which of its lines are in
 * the user's own document word for word.
 *
 * Why: the user approves a first import in a box they should be able to read
 * at a glance. A line that stands in their résumé as written is one they have
 * read already; it is counted. A line that does not is Claude's own wording
 * (or something a page talked it into adding); it is shown in full.
 *
 * What is kept, and where: the text of each document read through the tools
 * (prepare_extraction on the user's machine; prepare_extraction_text and
 * read_picked_files on the hosted connector), in memory only, attached to the
 * user's own store object and gone with it (the connector drops a store after
 * 15 idle minutes). Nothing is written anywhere. After a restart there is no
 * text to compare with, and the import then lists every line.
 */

const MAX_DOCUMENTS = 8;
const MAX_CHARS = 400_000;

interface Source {
  name: string;
  /** The text, lower case, with only letters and digits kept and one space between words. */
  flat: string;
}

const sources = new WeakMap<object, Source[]>();

/** Letters and digits in lower case, one space between words: what two writings of the same sentence share. */
export function flat(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Note a document's text for the knowledge base behind `store`. */
export function rememberSource(store: object, name: string, text: string): void {
  const list = sources.get(store) ?? [];
  const kept = list.filter((s) => s.name !== name);
  kept.push({ name, flat: ` ${flat(text.slice(0, MAX_CHARS))} ` });
  sources.set(store, kept.slice(-MAX_DOCUMENTS));
}

/** The names of the documents whose text is known for `store`. */
export function knownSources(store: object): string[] {
  return (sources.get(store) ?? []).map((s) => s.name);
}

/**
 * A line of a knowledge base file as the words to look for: without its list
 * mark and without its provenance tag.
 */
export function wordsOf(line: string): string {
  return flat(line.replace(/^\s*[-*]\s+/, "").replace(/\s*\[(?:R|C|F|\?)\]\s*$/i, ""));
}

/**
 * Whether a line stands in one of the documents word for word (its words, in
 * order, with nothing between them). A line of fewer than three words is too
 * short to say.
 */
export function inSources(store: object, line: string): boolean {
  const words = wordsOf(line);
  if (words.split(" ").length < 3) return false;
  return (sources.get(store) ?? []).some((s) => s.flat.includes(` ${words} `));
}

/**
 * Whether a short phrase (a skill, a search word, a size) stands in one of the
 * documents as whole words in order. One word is enough here: the question is
 * whether the document names it at all.
 */
export function phraseInSources(store: object, phrase: string): boolean {
  const words = flat(phrase);
  if (!words) return false;
  return (sources.get(store) ?? []).some((s) => s.flat.includes(` ${words} `));
}
