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

/** The two server calls this needs (injected for tests). */
export interface Confirmer {
  supportsElicitation(): boolean;
  elicit(params: { message: string; requestedSchema: { type: "object"; properties: Record<string, never>; required?: string[] } }): Promise<ElicitResult>;
}

/** The most a confirmation shows. A longer change is refused, never cut: the user approves only what they saw. */
export const MAX_LINES = 150;
export const MAX_CHARS = 12_000;

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
  if (!fits(lines)) {
    return `Nothing was saved: this change is too long to show in one confirmation (${lines.length} lines). Save it in smaller parts, for example a role's facts in two saves, so the user can read each one in full.`;
  }
  const body = lines.join("\n").trim() || "(no new text: the file is saved again unchanged)";
  let r: ElicitResult;
  try {
    r = await c.elicit({
      message: `Kairos: ${what}\n\n${body}\n\nAccept ${verb}. ${decline}`,
      requestedSchema: { type: "object", properties: {} },
    });
  } catch (e) {
    return `Nothing was saved: the confirmation could not be shown (${e instanceof Error ? e.message : String(e)}).`;
  }
  if (r.action === "accept") return null;
  return "Nothing was saved: the user did not approve this change. Do not try to save it again unless they ask.";
}
