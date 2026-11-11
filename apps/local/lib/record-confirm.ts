/**
 * The user's own approval for a write to their record (anti prompt-injection).
 *
 * Claude Code runs the conversation, so this server never sees what the user
 * typed and cannot check a fact against it (the hosted version's attribution
 * guard does that). Instead, every tool that puts facts into the record asks
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

/** The preview of a replaced file: what is new or changed, then what would be removed. */
export function diffPreview(added: string[], removed: string[]): string[] {
  const out: string[] = [];
  if (added.length) out.push("New or changed:", ...added.map((l) => `+ ${l}`));
  if (removed.length) out.push(...(out.length ? [""] : []), "Removed:", ...removed.map((l) => `- ${l}`));
  return out;
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

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

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

/**
 * Ask the user to approve one write. Returns null when approved, or the
 * message to return to Claude when not (nothing is saved). A preview too long
 * to show in full is refused: the user approves only what they saw.
 */
export async function askToSave(
  c: Confirmer,
  what: string,
  preview: string | string[],
  verb = "saves this to your record",
  decline = "Decline if you did not say it or it is wrong.",
): Promise<string | null> {
  if (!c.supportsElicitation()) {
    return "Nothing was saved. Kairos asks you to approve every change to your record in a confirmation from Claude Code, and this Claude Code did not offer one. Update Claude Code (claude update) and try again.";
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
