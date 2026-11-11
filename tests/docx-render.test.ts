import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { DEFAULT_TEMPLATE, PAPER_TWIPS, markdownLetterToDocx, markdownResumeToDocx } from "@kairos/engine/docx-render";
import { resumeLengthPolicy } from "@kairos/engine/length-policy";
import type { Experience } from "@kairos/engine/kb/types";

/** Résumé and letter rendering without the Cloud app's template parser (that half stays in template.test.ts). */
const MD = `# Jane Doe
Denver · jane@example.com

## Professional Experience

### Acme | Denver
#### Product Manager | 2020 – 2022

- **Shipped:** Delivered the thing on time.
`;

describe("markdownResumeToDocx with no template (local-lane default)", () => {
  it("renders a document", async () => {
    const buf = await markdownResumeToDocx(MD);
    expect(buf.length).toBeGreaterThan(1000);
  });
});

const documentXml = async (buf: Buffer) =>
  (await (await JSZip.loadAsync(buf)).file("word/document.xml")!.async("string"));

describe("paper size", () => {
  it("defaults to A4, the size the default layout is calibrated on, set explicitly in the file", async () => {
    const xml = await documentXml(await markdownResumeToDocx(MD));
    expect(xml).toMatch(/<w:pgSz[^>]*w:w="11906"[^>]*w:h="16838"/);
  });

  it("renders US Letter when the template asks for it", async () => {
    const xml = await documentXml(await markdownResumeToDocx(MD, { template: { paper: "letter" } }));
    expect(xml).toMatch(/<w:pgSz[^>]*w:w="12240"[^>]*w:h="15840"/);
  });

  it("puts the right-aligned date tab at the text edge of the chosen paper", async () => {
    for (const paper of ["letter", "a4"] as const) {
      const xml = await documentXml(await markdownResumeToDocx(MD, { template: { paper } }));
      const edge = PAPER_TWIPS[paper].width - DEFAULT_TEMPLATE.pageMarginTwips * 2;
      expect(xml).toContain(`w:pos="${edge}"`);
    }
  });

  it("sets the paper on cover letters too", async () => {
    const xml = await documentXml(await markdownLetterToDocx("Jane Doe\n\nDear team,\n\nHello.", { template: { paper: "letter" } }));
    expect(xml).toMatch(/<w:pgSz[^>]*w:w="12240"/);
  });
});

const exp = (start: string, end: string): Experience =>
  ({ fileName: "x.md", frontmatter: { id: "x", company: "C", title: "T", start, end }, body: "" }) as unknown as Experience;

describe("resumeLengthPolicy (DEC-9)", () => {
  it("targets 1 page for early career, 2 for senior", () => {
    expect(resumeLengthPolicy([exp("2023", "present")], { nowYear: 2026 }).targetPages).toBe(1);
    expect(resumeLengthPolicy([exp("2010", "2012"), exp("2012", "present")], { nowYear: 2026 }).targetPages).toBe(2);
  });

  it("honors a user override", () => {
    expect(resumeLengthPolicy([exp("2023", "present")], { nowYear: 2026, override: 2 }).targetPages).toBe(2);
  });
});
