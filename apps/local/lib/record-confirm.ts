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

const MAX_LINES = 40;
const MAX_CHARS = 3000;

/** Non-empty lines of `after` that are not in `before` (trimmed comparison). */
export function newLines(before: string | null | undefined, after: string): string[] {
  const had = new Set((before ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
  return after
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !had.has(l));
}

/** Keep a preview readable: at most MAX_LINES lines and MAX_CHARS characters. */
export function clip(lines: string[]): string {
  const out: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (out.length >= MAX_LINES || size + l.length > MAX_CHARS) {
      out.push(`… and ${lines.length - out.length} more line(s)`);
      break;
    }
    out.push(l);
    size += l.length + 1;
  }
  return out.join("\n");
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
 * message to return to Claude when not (nothing is saved).
 */
export async function askToSave(c: Confirmer, what: string, preview: string): Promise<string | null> {
  if (!c.supportsElicitation()) {
    return "Nothing was saved. Kairos asks you to approve every change to your record in a confirmation from Claude Code, and this Claude Code did not offer one. Update Claude Code (claude update) and try again.";
  }
  const body = preview.trim() || "(no new text: the file is saved again unchanged)";
  let r: ElicitResult;
  try {
    r = await c.elicit({
      message: `Kairos: ${what}\n\n${body}\n\nAccept saves this to your record. Decline if you did not say it or it is wrong.`,
      requestedSchema: { type: "object", properties: {} },
    });
  } catch (e) {
    return `Nothing was saved: the confirmation could not be shown (${e instanceof Error ? e.message : String(e)}).`;
  }
  if (r.action === "accept") return null;
  return "Nothing was saved: the user did not approve this change. Do not try to save it again unless they ask.";
}
