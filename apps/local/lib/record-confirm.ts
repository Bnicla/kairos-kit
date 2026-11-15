/**
 * The user's own approval for a write to their knowledge base (anti prompt-injection).
 *
 * Claude Code runs the conversation, so this server never sees what the user
 * typed and cannot check a fact against it (the hosted version's attribution
 * guard does that). Instead, every tool that puts facts into the knowledge base asks
 * the user directly through an MCP elicitation: Claude Code shows the request
 * to the user, outside the model, and only the user's Accept lets the write
 * through. A job posting that talks Claude into calling a save tool still
 * needs the user to approve exactly what would be saved.
 *
 * The preview shows only what is new against the file on record, so a long
 * role file does not bury the one line that changed.
 */

export type ElicitResult = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/** One choice the user makes in the confirmation, beside approving or declining it. */
export interface ChoiceField {
  type: "string";
  title: string;
  enum: string[];
  default?: string;
}

/**
 * What a client's own confirmation box does with a message, when that is less than showing it whole
 * as written. Measured in claude.ai on 15 November 2026: the box shows the first 4,000 characters of
 * a message and says that the rest is too long to show; it drops the line breaks; and it closes by
 * itself, answered "cancel", 53 seconds after the call began.
 */
export interface ConfirmationBox {
  /** The most characters of one message the box shows whole. A longer message is never sent: it would be shown cut. */
  maxChars: number;
  /** What one box should hold at most, so that it is read before the box closes; one item longer than this still gets a box. */
  aimChars: number;
  /** The box shows the message as one paragraph: it is written with marks between its parts, not with line breaks. */
  oneParagraph: boolean;
  /** The word for the user's yes in the last sentence, where clients name the button differently ("Approving"). */
  yes?: string;
}

/** The two server calls this needs (injected for tests). */
export interface Confirmer {
  supportsElicitation(): boolean;
  elicit(params: { message: string; requestedSchema: { type: "object"; properties: Record<string, ChoiceField>; required?: string[] } }): Promise<ElicitResult>;
  /** Set when the client's box shows less than the whole message, or shows it as one paragraph. */
  box?: ConfirmationBox;
  /** Set where the user can only approve or decline (an approval card, a yes in the chat): a confirmation offers no choice there. */
  noChoice?: boolean;
}

/** The most a confirmation shows. A longer change is refused, never cut: the user approves only what they saw. */
export const MAX_LINES = 150;
export const MAX_CHARS = 12_000;

/** The mark between two lines, and between two blocks, of a message a box shows as one paragraph. */
const LINE_MARK = " | ";
const BLOCK_MARK = " ◆ ";

/**
 * A message as the client's box will show it. With line breaks where the box keeps them. As one paragraph
 * where it drops them: an empty line becomes the mark between blocks, a line break the mark between lines.
 */
export function boxText(blocks: string[][], box?: ConfirmationBox): string {
  const kept = blocks.map((b) => b.map((l) => l.trimEnd()).filter((l) => l.trim() !== "")).filter((b) => b.length);
  if (!box?.oneParagraph) return kept.map((b) => b.join("\n")).join("\n\n");
  return kept.map((b) => b.map((l) => l.trim()).join(LINE_MARK)).join(BLOCK_MARK);
}

/** The most characters one message may have for this confirmer's box. */
export function boxLimit(c: Pick<Confirmer, "box">): number {
  return Math.min(MAX_CHARS, c.box?.maxChars ?? MAX_CHARS);
}

/** Why a message cannot be shown whole in this confirmer's box, or null when it can. */
export function tooLongFor(c: Pick<Confirmer, "box">, message: string): string | null {
  const max = boxLimit(c);
  if (message.length <= max && (c.box?.oneParagraph || message.split("\n").length <= MAX_LINES + 6)) return null;
  return `Nothing was saved: this change is too long to show whole in one confirmation (${message.length} characters; the confirmation shows ${max}), and a change is never shown cut. Save it in steps that fit: save the item first with part of its lines, then save it again with the rest added. The second confirmation shows only what is new.`;
}

/** Non-empty lines of `after` that are not in `before` (trimmed comparison). */
export function newLines(before: string | null | undefined, after: string): string[] {
  const had = new Set((before ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
  return after
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !had.has(l));
}

/** Non-empty lines of `before` that are gone from `after` (trimmed comparison). */
export function removedLines(before: string | null | undefined, after: string): string[] {
  return newLines(after, before ?? "");
}

/** The preview of a replaced file: what is new or changed, then what would be removed, then what moves. */
export function diffPreview(added: string[], removed: string[], moved: string[] = []): string[] {
  const out: string[] = [];
  if (added.length) out.push("New or changed:", ...added.map((l) => `+ ${l}`));
  if (removed.length) out.push(...(out.length ? [""] : []), "Removed:", ...removed.map((l) => `- ${l}`));
  if (moved.length) out.push(...(out.length ? [""] : []), "Moved to another section:", ...moved.map((l) => `~ ${l}`));
  return out;
}

/** Each non-empty line of a Markdown text with the heading it stands under ("" before the first heading). */
function linesBySection(text: string | null | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let section = "";
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    out.set(line, [...(out.get(line) ?? []), heading ? "(a heading)" : section]);
    if (heading) section = heading[1].trim();
  }
  return out;
}

/**
 * What changes between two Markdown texts, for a preview that leaves nothing
 * out. Beyond new and removed lines (newLines, removedLines) it finds the two
 * changes those miss, because they compare which lines exist and not where or
 * how often: a line that now stands under another heading, and a line that is
 * repeated or loses a copy.
 */
export function bodyChanges(before: string | null | undefined, after: string): { added: string[]; removed: string[]; moved: string[] } {
  const was = linesBySection(before);
  const now = linesBySection(after);
  const added: string[] = [];
  const removed: string[] = [];
  const moved: string[] = [];
  const under = (s: string) => (s === "" ? "the top of the file" : `"${s}"`);
  for (const [line, places] of now) {
    const had = was.get(line);
    if (!had) added.push(places.length > 1 ? `${line} (${places.length} times)` : line);
    else if (places.length > had.length) added.push(`${line} (repeated: ${places.length} times, ${had.length} before)`);
    else if (places.length < had.length) removed.push(`${line} (${had.length - places.length} of its ${had.length} copies)`);
    else {
      const from = [...had].sort();
      const to = [...places].sort();
      if (from.join("\n") !== to.join("\n")) moved.push(`${line} (from ${[...new Set(from)].map(under).join(", ")} to ${[...new Set(to)].map(under).join(", ")})`);
    }
  }
  for (const [line, places] of was) if (!now.has(line)) removed.push(places.length > 1 ? `${line} (${places.length} times)` : line);
  return { added, removed, moved };
}

/** The preview of a Markdown file that is replaced: new, removed, moved and repeated lines. */
export function markdownDiff(before: string | null | undefined, after: string): string[] {
  const c = bodyChanges(before, after);
  return diffPreview(c.added, c.removed, c.moved);
}

/** A JSON value as "path: value" lines, for a preview (keys in `skip` left out, e.g. timestamps). */
export function jsonLines(v: unknown, skip: string[] = [], prefix = ""): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => jsonLines(x, skip, `${prefix}[${i}]`));
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => (skip.includes(k) ? [] : jsonLines(x, skip, prefix ? `${prefix}.${k}` : k)));
  }
  return [`${prefix}: ${String(v)}`];
}

/** The preview of a JSON file's change: changed or new values, then removed ones. */
export function jsonDiff(before: unknown, after: unknown, skip: string[] = []): string[] {
  const a = jsonLines(before, skip).join("\n");
  const b = jsonLines(after, skip).join("\n");
  return diffPreview(newLines(a, b), removedLines(a, b));
}

/** Whether a preview fits in one confirmation. */
export function fits(lines: string[]): boolean {
  return lines.length <= MAX_LINES && lines.reduce((n, l) => n + l.length + 1, 0) <= MAX_CHARS;
}

/** Older callers: a preview as text, unchanged when it fits (askToSave refuses one that does not). */
export function clip(lines: string[]): string {
  return lines.join("\n");
}

/**
 * A value as a person reads it, with nothing left out: a list as its items,
 * an object as "key: value" pairs (its name first when it has one). A client
 * may show the confirmation as one paragraph, where raw JSON is hard to read.
 */
export function show(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "none";
  if (Array.isArray(v)) {
    if (!v.length) return "(none)";
    return v.map(show).join(v.some((x) => x !== null && typeof x === "object") ? "; " : ", ");
  }
  if (typeof v === "object") {
    const { name, ...rest } = v as Record<string, unknown>;
    const named = typeof name === "string" && name.trim() !== "";
    const pairs = Object.entries(named ? rest : (v as Record<string, unknown>))
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${k}: ${show(x)}`)
      .join(", ");
    if (named) return pairs ? `${name} (${pairs})` : (name as string);
    return pairs || "(empty)";
  }
  return String(v);
}

/** Frontmatter fields that are new or changed, as "key: value" lines. */
export function changedFields(before: Record<string, unknown> | null | undefined, after: Record<string, unknown>, skip: string[] = []): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    if (v === undefined || skip.includes(k)) continue;
    const was = before?.[k];
    if (JSON.stringify(was) === JSON.stringify(v)) continue;
    out.push(was === undefined ? `${k}: ${show(v)}` : `${k}: ${show(was)} → ${show(v)}`);
  }
  return out;
}

/** Frontmatter fields that the new version no longer has, as "key: value" lines: saving drops them. */
export function removedFields(before: Record<string, unknown> | null | undefined, after: Record<string, unknown>, skip: string[] = []): string[] {
  return Object.entries(before ?? {})
    .filter(([k, v]) => v !== undefined && !skip.includes(k) && after[k] === undefined)
    .map(([k, v]) => `${k}: ${show(v)}`);
}

/**
 * The preview of a knowledge base file with frontmatter that is replaced whole (a role, an education entry): changed
 * and new fields and lines, the fields and lines that go, and the lines that move or are repeated.
 */
export function recordFileDiff(before: { data: Record<string, unknown>; content: string } | null | undefined, frontmatter: Record<string, unknown>, body: string, skip: string[] = []): string[] {
  const c = bodyChanges(before?.content, body);
  return diffPreview([...changedFields(before?.data, frontmatter, skip), ...c.added], [...removedFields(before?.data, frontmatter, skip), ...c.removed], c.moved);
}

/**
 * Ask the user to approve one write. Returns null when approved, or the
 * message to return to Claude when not (nothing is saved). A preview too long
 * to show in full is refused: the user approves only what they saw.
 */
export async function askToSave(
  c: Confirmer,
  what: string,
  preview: string | string[],
  verb = "saves this to your knowledge base",
  decline = "Decline if you did not say it or it is wrong.",
): Promise<string | null> {
  if (!c.supportsElicitation()) {
    return "Nothing was saved. Kairos asks you to approve every change to your knowledge base in a confirmation from Claude Code, and this Claude Code did not offer one. Update Claude Code (claude update) and try again.";
  }
  const lines = (Array.isArray(preview) ? preview : preview.split("\n")).map((l) => l.trimEnd());
  if (!c.box && !fits(lines)) {
    return `Nothing was saved: this change is too long to show in one confirmation (${lines.length} lines). Save it in smaller parts, for example a role's facts in two saves, so the user can read each one in full.`;
  }
  const body = lines.join("\n").trim() || "(no new text: the file is saved again unchanged)";
  // Where the client's box shows less than the whole message, or shows it as one paragraph, the message is written for that box.
  const message = c.box
    ? boxText([[`Kairos: ${what}`], ...body.split(/\n{2,}/).map((b) => b.split("\n")), [`${c.box.yes ?? "Accept"} ${verb}. ${decline}`]], c.box)
    : `Kairos: ${what}\n\n${body}\n\nAccept ${verb}. ${decline}`;
  const long = c.box ? tooLongFor(c, message) : null;
  if (long) return long;
  let r: ElicitResult;
  try {
    r = await c.elicit({
      message,
      requestedSchema: { type: "object", properties: {} },
    });
  } catch (e) {
    return `Nothing was saved: the confirmation could not be shown (${e instanceof Error ? e.message : String(e)}).`;
  }
  if (r.action === "accept") return null;
  return "Nothing was saved: the user did not approve this change. Do not try to save it again unless they ask.";
}
