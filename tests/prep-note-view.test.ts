import { describe, expect, it } from "vitest";
import { NOTE_LEGEND, NOTE_MAX, noteBlocks, noteTitle } from "@kairos/engine/prep-note-view";
import { bodyBlocks } from "@kairos/engine/record-view";

/**
 * A preparation note as a view shows it (packages/engine/prep-note-view.ts):
 * the note's Markdown as blocks of text, with its own tags apart. All text is fictional.
 */
describe("a preparation note as a view shows it", () => {
  const flat = (markdown: string) => noteBlocks(markdown).blocks.map((b) => `${b.kind}: ${b.parts.map((p) => (p.tag ? `<${p.tag}>` : p.text)).join("")}`);

  it("keeps a note's four tags apart, and no other bracket", () => {
    expect(flat("- Shipped the feature. [C]\n- They use Postgres. [?]\n- How billing works. [K]\n- Shorter answer. [rev]\n- A résumé fact. [R] and [F], [c], [Rev], [1]")).toEqual([
      "item: Shipped the feature. <C>",
      "item: They use Postgres. <?>",
      "item: How billing works. <K>",
      "item: Shorter answer. <rev>",
      "item: A résumé fact. [R] and [F], [c], [Rev], [1]",
    ]);
    expect(NOTE_LEGEND.map((l) => l.tag)).toEqual(["C", "?", "K", "rev"]);
    // The knowledge base's own blocks are as they were: [K] and [rev] are text there, [R] and [F] are tags.
    expect(bodyBlocks("- A fact. [R] [K] [rev] [F]").blocks[0].parts).toEqual([{ text: "A fact. " }, { text: "[R]", tag: "R" }, { text: " [K] [rev] " }, { text: "[F]", tag: "F" }]);
  });

  it("writes a table as one line per row, drops rules and quote marks, and keeps a link's words", () => {
    const note = ["# Brief", "", "---", "", "| Question | Answer |", "|:--|--:|", "| Why us? | The clinic work [C] |", "", "> A quoted line", "> on two lines.", "", "***", "See [the ad](https://example.com/a_(b)) and ![logo](x.png \"Logo\").", "<img src=x onerror=alert(1)>"];
    expect(flat(note.join("\n"))).toEqual([
      "heading: Brief",
      "text: Question · Answer",
      "text: Why us? · The clinic work <C>",
      "text: A quoted line on two lines.",
      // Markup stays text: the page writes characters, never HTML.
      "text: See the ad and logo. <img src=x onerror=alert(1)>",
    ]);
    // A list item that only looks like a rule is a rule; a line of text with dashes in it is text.
    expect(flat("- - -\nA line - with - dashes")).toEqual(["text: A line - with - dashes"]);
  });

  it("cuts a note longer than the limit at a line's end and says so; an empty note has no line", () => {
    const long = noteBlocks("- A line of ordinary length about the interview. [C]\n".repeat(2000));
    expect(long.cut).toBe(true);
    expect(long.blocks.reduce((n, b) => n + b.parts.reduce((m, p) => m + p.text.length, 0), 0)).toBeLessThanOrEqual(NOTE_MAX);
    expect(noteBlocks("")).toEqual({ blocks: [], cut: false });
    expect(noteBlocks("\n\n---\n")).toEqual({ blocks: [], cut: false });
  });

  it("names a note by its file name, as the dashboard's list does", () => {
    expect(noteTitle("interview-brief.md")).toBe("interview brief");
    expect(noteTitle("round-2_reconstruction.md")).toBe("round 2_reconstruction");
  });
});
