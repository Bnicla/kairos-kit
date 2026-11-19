import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { layoutVerdict, measurePdf, pdfReading, probeResumeLayout } from "../apps/local/lib/layout-probe";
import { checkPdfAts, pdftotextPath, sofficePath } from "../apps/local/lib/pdf-render";
import { markdownResumeToDocx } from "@kairos/engine/docx-render";

/**
 * The layout check reads the rendered PDF in one of two ways: with poppler
 * (pdfinfo, pdftotext) where it is installed, and in JavaScript (unpdf) where
 * it is not, which is the usual case on a Windows PC. Both must give the page
 * count, the fill of the last page and the first line of page 2.
 */

/** A small PDF written by hand: one page per list of lines, in Helvetica. No program needed. */
function pdfOf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, i) => {
    const text = lines.map((line, n) => `BT /F1 11 Tf 72 ${720 - n * 16} Td (${line.replace(/[\\()]/g, "\\$&")}) Tj ET`).join("\n");
    objects[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const dir = mkdtempSync(join(tmpdir(), "kairos-readings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, pages: string[][]) => {
  const p = join(dir, name);
  writeFileSync(p, pdfOf(pages));
  return p;
};
const line = (n: number) => `Line ${n} of the page with the words that fill it`;
const page = (count: number, first?: string) => [...(first ? [first] : []), ...Array.from({ length: count - (first ? 1 : 0) }, (_, i) => line(i + 1))];

const before = process.env.KAIROS_NO_POPPLER;
afterEach(() => {
  if (before === undefined) delete process.env.KAIROS_NO_POPPLER;
  else process.env.KAIROS_NO_POPPLER = before;
});

describe("reading the rendered PDF without poppler (unpdf)", () => {
  it("counts the pages, compares the last page with the first, and gives the first line of page 2", async () => {
    const twoPages = file("two.pdf", [page(20), page(10, "Product Manager, Clinics | 2020 - 2022")]);
    const m = await measurePdf(twoPages, "unpdf");
    expect(m).not.toBeNull();
    expect(m!.pages).toBe(2);
    expect(m!.page2Start).toBe("Product Manager, Clinics | 2020 - 2022");
    expect(m!.lastPageFill).toBeGreaterThan(0.4);
    expect(m!.lastPageFill).toBeLessThan(0.6);
  });

  it("one page: no first line of page 2, and the page compared with itself", async () => {
    const m = await measurePdf(file("one.pdf", [page(12)]), "unpdf");
    expect(m).toEqual({ pages: 1, lastPageFill: 1, page2Start: null });
  });

  it("three pages are counted as three", async () => {
    const m = await measurePdf(file("three.pdf", [page(20), page(20), page(3)]), "unpdf");
    expect(m!.pages).toBe(3);
    expect(layoutVerdict(m!).verdict).toBe("overflow");
  });
});

describe("the two readings agree", () => {
  // Only where both of poppler's programs are installed (the owner's Mac, the hosted connector's image).
  // The Kit's Linux CI has neither; a Windows PC with Git for Windows has pdftotext and no pdfinfo
  // (seen in the Kit's Windows CI on 19 November 2026), and the layout check reads with unpdf there.
  it("on the page count, the first line of page 2 and the fill", async () => {
    if ((await pdfReading()) !== "poppler") return;
    const pdf = file("agree.pdf", [page(22), page(17, "Research Lead | 2018 - 2020")]);
    const withPoppler = await measurePdf(pdf, "poppler");
    const without = await measurePdf(pdf, "unpdf");
    expect(withPoppler).not.toBeNull();
    expect(without!.pages).toBe(withPoppler!.pages);
    expect(without!.page2Start).toBe(withPoppler!.page2Start);
    expect(Math.abs(without!.lastPageFill - withPoppler!.lastPageFill)).toBeLessThan(0.01);
    expect(layoutVerdict(without!, "Research Lead")).toEqual(layoutVerdict(withPoppler!, "Research Lead"));
  });
});

describe("the verdict for a measure", () => {
  it("is good on one page, and on two pages with a full second page", () => {
    expect(layoutVerdict({ pages: 1, lastPageFill: 1, page2Start: null })).toEqual({ verdict: "good", guidance: null });
    expect(layoutVerdict({ pages: 2, lastPageFill: 0.9, page2Start: "Research Lead | 2018 - 2020" }, "Research Lead").verdict).toBe("good");
  });
  it("is short when page 2 is under 78% full, overflow past two pages, bad-break when page 2 opens on another line", () => {
    const short = layoutVerdict({ pages: 2, lastPageFill: 0.5, page2Start: "Research Lead" });
    expect(short.verdict).toBe("short");
    expect(short.guidance).toContain("50% full");
    expect(layoutVerdict({ pages: 3, lastPageFill: 0.2, page2Start: "x" }).verdict).toBe("overflow");
    const broken = layoutVerdict({ pages: 2, lastPageFill: 0.9, page2Start: "the end of a bullet from page 1" }, "Research Lead");
    expect(broken.verdict).toBe("bad-break");
    expect(broken.guidance).toContain("Research Lead");
  });
});

describe("with poppler treated as absent (KAIROS_NO_POPPLER=1)", () => {
  it("the PDF is read with unpdf, and the ATS text check says it is not available", async () => {
    process.env.KAIROS_NO_POPPLER = "1";
    expect(await pdfReading()).toBe("unpdf");
    expect(await pdftotextPath()).toBeNull();
    const ats = await checkPdfAts(file("ats.pdf", [page(5)]));
    expect(ats.available).toBe(false);
  });

  // The whole way through LibreOffice, only on request (KAIROS_LO_TESTS=1): a computer with LibreOffice and no poppler.
  const LO = process.env.KAIROS_LO_TESTS === "1" && existsSync(sofficePath());
  it.skipIf(!LO)("a Word résumé is still measured with LibreOffice alone", async () => {
    process.env.KAIROS_NO_POPPLER = "1";
    const md = `# Jane Doe\nDenver · jane@example.com\n\n## Professional Experience\n\n### Acme | Denver\n#### Product Manager | 2020 – 2022\n\n- **Delivery:** Shipped the scheduling tool to 40 clinics on the planned date.\n`;
    const docx = join(dir, "resume.docx");
    writeFileSync(docx, await markdownResumeToDocx(md));
    const probe = await probeResumeLayout(docx);
    expect(probe).not.toBeNull();
    expect(probe!.pages).toBe(1);
    expect(probe!.verdict).toBe("good");
    expect(probe!.ats.available).toBe(false);
  }, 120_000);
});
