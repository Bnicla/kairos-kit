/**
 * A preparation note as a view shows it. A preparation note is a Markdown file
 * in an application's folder (a brief, a reconstruction of an interview, a
 * review). The local dashboard lists them on the application page and renders
 * one as HTML (apps/local/lib/dashboard.ts, listPrepNotes and getPrepNote).
 * The connector's application page writes text only, so it takes the note as
 * blocks of text with the tags apart. The tags, their meaning and the title
 * are held here so that both pages agree.
 */
import { bodyBlocks, type RecordBlock } from "./record-view";

/** The tags of a preparation note and what each means, in the order the dashboard's note page writes them. */
export const NOTE_LEGEND: { tag: "C" | "?" | "K" | "rev"; meaning: string }[] = [
  { tag: "C", meaning: "confirmed" },
  { tag: "?", meaning: "assumption, not to say" },
  { tag: "K", meaning: "how it works" },
  { tag: "rev", meaning: "revised after review" },
];

/** The tags as the pattern that splits a line: the one the dashboard's note page marks ([C], [?], [K], [rev]). */
export const NOTE_TAGS = /(\[(?:C|\?|K|rev)\])/;

/** The longest note a view is given; a longer one is cut at a line's end, and the view says so. */
export const NOTE_MAX = 40_000;

/** A note's title: its file name without the extension, hyphens as spaces, as the dashboard's list writes it. */
export const noteTitle = (file: string): string => file.replace(/\.md$/, "").replace(/-/g, " ");

/**
 * A note's Markdown as blocks of text. Beyond what the knowledge base's blocks do: a table row becomes one
 * line with its cells apart, a quoted line loses its mark, a rule is dropped, and a link keeps its
 * words (the address is dropped: the page writes text and opens nothing).
 */
export function noteBlocks(markdown: string, max: number = NOTE_MAX): { blocks: RecordBlock[]; cut: boolean } {
  const lines: string[] = [];
  for (const raw of markdown.split("\n")) {
    let line = raw.replace(/^\s{0,3}>\s?/, "");
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      lines.push("");
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // A table: the line under the header (|---|---|) is dropped; each row stands alone.
      if (/^[\s|:-]+$/.test(line)) continue;
      const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim()).filter(Boolean);
      lines.push("", cells.join(" · "), "");
      continue;
    }
    line = line.replace(/!?\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))+(?:\s+"[^"]*")?\)/g, "$1");
    lines.push(line);
  }
  return bodyBlocks(lines.join("\n"), max, NOTE_TAGS);
}
