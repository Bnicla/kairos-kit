import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import {
  atsExpectFromMarkdown,
  checkAtsText,
  normalizeDateRangeDashes,
  type AtsExpect,
} from "@kairos/engine/ats-text";
import { generatedResumeToMarkdown, markdownResumeToHtml } from "@kairos/engine/resume-render";
import { markdownResumeToDocx } from "@kairos/engine/docx-render";
import { checkPdfAts, extractPdfText } from "@/lib/pdf-render";
import type { GeneratedResume } from "@kairos/engine/types";

// A pdftotext -layout style extraction of a clean, single-column résumé.
const filler =
  "Built the evaluation sets and the release gates for the assistant across markets, and ran the weekly review with the feature teams. ";
const CLEAN = `JANE DOE   —   Product Leader
Denver, CO · +1 (303) 555-0142 · jane.doe@example.com · linkedin.com/in/janedoe

EXECUTIVE SUMMARY
● Product leader with a decade at Globex and Acme. ${filler}

PROFESSIONAL EXPERIENCE

ACME                                                              Denver, CO
Principal Product Manager                                     2022 - Present
● Launch Gates: ${filler}
● Test Data: ${filler}

GLOBEX                                                            Paris, France
Product Manager                                                  2018 - 2022
● Release Automation: ${filler}

EDUCATION
● Master of Business Administration, Westbrook School of Management

SKILLS
Agent evaluation · Model release gates · Prototyping
`;

const EXPECT: AtsExpect = {
  name: "Jane Doe",
  email: "jane.doe@example.com",
  phone: "+1 (303) 555-0142",
  sectionOrder: ["Executive Summary", "Professional Experience", "Education", "Skills"],
  companies: ["Acme", "Globex"],
  companiesSection: "Professional Experience",
};

const rulesOf = (text: string, expect: AtsExpect = EXPECT) => checkAtsText(text, expect).issues.map((i) => i.rule);

describe("checkAtsText: clean layer", () => {
  it("passes a clean single-column extraction", () => {
    const r = checkAtsText(CLEAN, EXPECT);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("rule: empty-layer", () => {
  it("flags a layer under ~500 characters and suppresses the contact/order findings it implies", () => {
    const r = checkAtsText("JANE DOE\n\n", EXPECT);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toEqual(["empty-layer"]);
  });

  it("does not flag a full résumé", () => {
    expect(rulesOf(CLEAN)).not.toContain("empty-layer");
  });
});

describe("rule: unicode-date-dash", () => {
  it.each([
    ["en dash", "2022 – 2026"],
    ["em dash", "2026—Present"],
    ["figure dash", "2019 ‒ 2020"],
    ["horizontal bar", "2018 ― 2019"],
    ["minus sign", "2017 − 2018"],
    ["dash before Present only", "Advisor – Present"],
    ["month-year range", "Jan 2020 – Mar 2021"],
  ])("flags a year/Present joined to a %s", (_label, range) => {
    const text = CLEAN.replace("2018 - 2022", range);
    const issue = checkAtsText(text, EXPECT).issues.find((i) => i.rule === "unicode-date-dash");
    expect(issue).toBeDefined();
    expect(issue!.detail).toContain(range.replace(/\s+/g, " "));
  });

  it("counts every range and lists samples", () => {
    const text = CLEAN.replace("2022 - Present", "2022 – Present").replace("2018 - 2022", "2018 – 2022");
    const issue = checkAtsText(text, EXPECT).issues.find((i) => i.rule === "unicode-date-dash")!;
    expect(issue.detail).toMatch(/^2 date range/);
    expect(issue.detail).toContain('"2022 – Present"');
    expect(issue.detail).toContain('"2018 – 2022"');
  });

  it("ignores ASCII-hyphen ranges and en dashes in prose", () => {
    const text = CLEAN.replace("decade at", "decade of cost–benefit work at").replace("Prototyping", "pages 12–14");
    expect(rulesOf(text)).not.toContain("unicode-date-dash");
  });
});

describe("rule: broken-glyphs", () => {
  it("flags (cid:NN) markers", () => {
    const issue = checkAtsText(CLEAN.replace("Launch Gates", "(cid:76)(cid:85)nch Gates"), EXPECT).issues.find(
      (i) => i.rule === "broken-glyphs",
    );
    expect(issue?.detail).toMatch(/2 \(cid:NN\) marker/);
  });

  it("flags U+FFFD replacement characters", () => {
    const issue = checkAtsText(CLEAN.replace("Test Data", "Test D�ta"), EXPECT).issues.find(
      (i) => i.rule === "broken-glyphs",
    );
    expect(issue?.detail).toMatch(/1 U\+FFFD/);
  });

  it("does not flag a clean layer", () => {
    expect(rulesOf(CLEAN)).not.toContain("broken-glyphs");
  });
});

describe("rule: contact-missing", () => {
  it("matches the name case-insensitively and across a line break", () => {
    expect(rulesOf(CLEAN.replace("JANE DOE", "Jane\nDoe"))).not.toContain("contact-missing");
  });

  it("compares phones by digits only, with or without the country code", () => {
    expect(rulesOf(CLEAN.replace("+1 (303) 555-0142", "303.555.0142"))).not.toContain("contact-missing");
    expect(rulesOf(CLEAN.replace("+1 (303) 555-0142", "+1 303 555 0142"))).not.toContain("contact-missing");
  });

  it("flags an email carried only by a hyperlink label", () => {
    const issues = checkAtsText(CLEAN.replace("jane.doe@example.com", "Email"), EXPECT).issues;
    expect(issues).toEqual([expect.objectContaining({ rule: "contact-missing", detail: expect.stringContaining("jane.doe@example.com") })]);
  });

  it("flags a missing phone and a missing name", () => {
    const text = CLEAN.replace("+1 (303) 555-0142 · ", "").replace("JANE DOE", "J. D.");
    const details = checkAtsText(text, EXPECT).issues.filter((i) => i.rule === "contact-missing").map((i) => i.detail);
    expect(details).toHaveLength(2);
    expect(details.join(" ")).toMatch(/Phone/);
    expect(details.join(" ")).toMatch(/Name/);
  });

  it("does not match a different phone number", () => {
    expect(rulesOf(CLEAN.replace("555-0142", "555-0199"))).toContain("contact-missing");
  });
});

describe("rule: reading-order", () => {
  it("flags sections that come out of the text in a different order (two-column interleave)", () => {
    // A sidebar column puts SKILLS beside the summary, so it precedes EXPERIENCE.
    const text = CLEAN.replace("EXECUTIVE SUMMARY", "EXECUTIVE SUMMARY                    SKILLS").replace(
      /\nSKILLS\n/,
      "\n",
    );
    const issue = checkAtsText(text, EXPECT).issues.find((i) => i.rule === "reading-order");
    expect(issue?.detail).toMatch(/Section "Skills"/);
  });

  it("flags employers out of order even when the summary names them in order", () => {
    // Swap the two experience blocks; the summary still says "Globex and Acme".
    const acme = CLEAN.slice(CLEAN.indexOf("ACME"), CLEAN.indexOf("GLOBEX  "));
    const globex = CLEAN.slice(CLEAN.indexOf("GLOBEX  "), CLEAN.indexOf("EDUCATION"));
    const swapped = CLEAN.replace(acme + globex, globex + acme);
    const issue = checkAtsText(swapped, EXPECT).issues.find((i) => i.rule === "reading-order");
    expect(issue?.detail).toMatch(/Employer "Globex"/);
  });

  it("reports a heading absent from the layer", () => {
    const issue = checkAtsText(CLEAN.replace("EDUCATION", "TRAINING"), EXPECT).issues.find((i) => i.rule === "reading-order");
    expect(issue?.detail).toBe('Section "Education" not found in the text layer.');
  });

  it("passes when headings are in document order", () => {
    expect(rulesOf(CLEAN)).not.toContain("reading-order");
  });

  it("skips the order and contact rules when no expectations are given", () => {
    expect(checkAtsText(CLEAN.replace("jane.doe@example.com", "Email")).ok).toBe(true);
  });
});

describe("normalizeDateRangeDashes", () => {
  it.each([
    ["2022 – 2026", "2022 - 2026"],
    ["2022–2026", "2022 - 2026"],
    ["2026 — Present", "2026 - Present"],
    ["2019 – Mar 2021", "2019 - Mar 2021"],
    ["Jan 2020 – Mar 2021", "Jan 2020 - Mar 2021"],
    ["2017 − 2018", "2017 - 2018"],
    ["#### PM | 2020 – 2022", "#### PM | 2020 - 2022"],
  ])("%s → %s", (input, out) => {
    expect(normalizeDateRangeDashes(input)).toBe(out);
  });

  it("leaves en dashes in prose untouched", () => {
    const prose = "A cost–benefit review – then pages 12–14, 2,000–3,000 utterances, and the 2024 roadmap – shipped.";
    expect(normalizeDateRangeDashes(prose)).toBe(prose);
  });
});

const GEN = {
  resume: {
    header: { name: "Jane Doe", contact: "Denver, CO · +1 (303) 555-0142 · jane.doe@example.com" },
    executive_summary: "Product leader; cost–benefit minded.",
    experience: [
      { company: "Acme", title: "Principal PM", location: "Denver, CO", dates: "2022 – Present", bullets: ["**Gates:** Shipped the gate – on time."] },
      { company: "Globex", title: "PM", location: "Paris", dates: "2018—2022", bullets: ["**Evals:** Built the sets."] },
    ],
    education: [{ credential: "MBA", institution: "Westbrook", dates: "2019 – 2021" }],
    skills: ["Evals"],
  },
  provenance_audit: [],
} as unknown as GeneratedResume;

describe("renderers emit ASCII date ranges", () => {
  it("generatedResumeToMarkdown: role and education dates use ' - ', prose dashes stay", () => {
    const md = generatedResumeToMarkdown(GEN);
    expect(md).toContain("#### Principal PM | 2022 - Present");
    expect(md).toContain("#### PM | 2018 - 2022");
    expect(md).toContain("(2019 - 2021)");
    expect(md).toContain("cost–benefit");
    expect(md).toContain("the gate – on time");
  });

  it("markdownResumeToDocx: normalizes en-dash dates from an older source", async () => {
    const md = `# Jane Doe\nDenver · jane@example.com\n\n## Professional Experience\n\n### Acme | Denver\n#### Product Manager | 2020 – 2022\n\n- **Shipped:** The cost–benefit review.\n`;
    const xml = await (await JSZip.loadAsync(await markdownResumeToDocx(md))).file("word/document.xml")!.async("string");
    expect(xml).toContain("2020 - 2022");
    expect(xml).not.toContain("2020 – 2022");
    expect(xml).toContain("cost–benefit");
  });

  it("markdownResumeToHtml: normalizes the fallback PDF template too", () => {
    const html = markdownResumeToHtml("# Jane Doe\n\n#### PM | 2020 – 2022\n");
    expect(html).toContain("2020 - 2022");
  });
});

describe("atsExpectFromMarkdown", () => {
  const MD = `# Jane Doe
Denver, CO · +1 (303) 555-0142 · [jane.doe@example.com](mailto:jane.doe@example.com) · linkedin.com/in/janedoe

## Executive Summary

- **Leader:** Ten years at Acme and Globex.

## Professional Experience

### Acme | Denver, CO
#### Principal Product Manager | 2022 - Present

- **Gates:** Shipped.

<!--PAGEBREAK-->
#### Product Manager | 2020 - 2022

- **Data:** Built.

### Globex | Paris, France
#### Product Manager | 2018 - 2020

- **Evals:** Built.

## Education

- **MBA**, Westbrook

## Skills

Evals · Gates
`;

  it("reads name, email, phone, sections and employers from the source", () => {
    expect(atsExpectFromMarkdown(MD)).toEqual({
      name: "Jane Doe",
      email: "jane.doe@example.com",
      phone: "+1 (303) 555-0142",
      sectionOrder: ["Executive Summary", "Professional Experience", "Education", "Skills"],
      companies: ["Acme", "Globex"],
      companiesSection: "Professional Experience",
    });
  });

  it("returns only what the source holds", () => {
    expect(atsExpectFromMarkdown("# Jane Doe\n\n## Skills\n\nEvals\n")).toEqual({
      name: "Jane Doe",
      sectionOrder: ["Skills"],
    });
  });
});

// --- integration: the real extractor on a real PDF --------------------------

const PDFTOTEXT = ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "/usr/bin/pdftotext"].some(existsSync);

/** A minimal one-page PDF (Helvetica, WinAnsi) whose text layer holds `lines`. */
function tinyPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const content = `BT /F1 9 Tf 40 800 Td 12 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1"); // WinAnsi: "–" is byte 0x96, which latin1 cannot hold
}

const pdfLines = (dash: string) => [
  "Jane Doe",
  "Denver, CO · +1 (303) 555-0142 · jane.doe@example.com",
  "EXECUTIVE SUMMARY",
  ...Array.from({ length: 9 }, () => "Built the evaluation sets and release gates for the assistant across markets."),
  "PROFESSIONAL EXPERIENCE",
  "ACME",
  `Principal Product Manager   2022 ${dash} Present`,
  "GLOBEX",
  `Product Manager   2018 ${dash} 2022`,
  "EDUCATION",
  "SKILLS",
];

/** latin1 can't encode U+2013; patch the WinAnsi byte for the en dash in. */
function withWinAnsiEnDash(lines: string[]): Buffer {
  const buf = tinyPdf(lines.map((l) => l.replace(/–/g, "\u0001")));
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x01) buf[i] = 0x96;
  return buf;
}

describe.skipIf(!PDFTOTEXT)("integration: pdftotext text layer", () => {
  it("extracts an en-dash date range as U+2013 and the check flags it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kairos-ats-"));
    try {
      const pdf = join(dir, "dash.pdf");
      await writeFile(pdf, withWinAnsiEnDash(pdfLines("–")));
      const text = await extractPdfText(pdf);
      expect(text).toContain("2022 – Present");
      const ats = await checkPdfAts(pdf, EXPECT);
      expect(ats.available).toBe(true);
      if (ats.available) {
        expect(ats.issues.map((i) => i.rule)).toEqual(["unicode-date-dash"]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes the same PDF with ASCII-hyphen dates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kairos-ats-"));
    try {
      const pdf = join(dir, "ascii.pdf");
      await writeFile(pdf, tinyPdf(pdfLines("-")));
      const ats = await checkPdfAts(pdf, EXPECT);
      expect(ats).toEqual({ available: true, ok: true, issues: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Full LibreOffice round trip (docx → PDF → text layer). Slow and shares the
// probe's LibreOffice profile, so it runs only on request: KAIROS_LO_TESTS=1.
const LO = !!process.env.KAIROS_LO_TESTS && existsSync(process.env.SOFFICE_PATH ?? "/opt/homebrew/bin/soffice") && PDFTOTEXT;

describe.skipIf(!LO)("integration: rendered docx through the layout probe", () => {
  it("renders ASCII date ranges and reports a clean ATS layer", async () => {
    const { probeResumeLayout } = await import("@/lib/layout-probe");
    // The model's en/em-dash dates, with enough bullets to clear the 500-char floor.
    const bullet = "**Release Gates:** Built the evaluation sets and the go/no-go gate for each model release across markets.";
    const long = structuredClone(GEN);
    for (const exp of long.resume.experience) exp.bullets = [bullet, bullet, bullet, bullet];
    const md = generatedResumeToMarkdown(long);
    const dir = await mkdtemp(join(tmpdir(), "kairos-ats-lo-"));
    try {
      const docx = join(dir, "resume.docx");
      await writeFile(docx, await markdownResumeToDocx(md));
      const probe = await probeResumeLayout(docx, { atsExpect: atsExpectFromMarkdown(md) });
      expect(probe).not.toBeNull();
      expect(probe!.ats).toEqual({ available: true, ok: true, issues: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
