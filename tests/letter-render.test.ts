import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { markdownLetterToDocx } from "@kairos/engine/docx-render";

/** Regression: bold bullet lead-ins in a letter printed as literal "**" (2026-10-09). */
const documentXml = async (md: string) =>
  (await JSZip.loadAsync(await markdownLetterToDocx(md))).file("word/document.xml")!.async("string");

const LETTER = `Jane Doe
Denver · jane@example.com

October 9, 2026

Dear Hiring Team,

I built **Atlas** on a hosted model platform.

- **Eval-gated releases:** owned the readiness gate.
- **Agent guardrails:** verified every decision.

Best regards,

Jane Doe`;

describe("markdownLetterToDocx", () => {
  it("renders **bold** as bold runs, never as literal asterisks", async () => {
    const xml = await documentXml(LETTER);
    expect(xml).not.toContain("**");
    expect(xml).toMatch(/<w:b\/>[\s\S]*?Eval-gated releases:/);
  });

  it("turns a dash block into real bullet paragraphs", async () => {
    const xml = await documentXml(LETTER);
    expect((xml.match(/<w:numPr>/g) ?? []).length).toBe(2);
    expect(xml).not.toMatch(/<w:t[^>]*>- /);
  });
});
