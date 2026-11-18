// NOTE: intentionally NOT "server-only" — this module is imported by the MCP
// server (raw tsx) as well as the Next app, and the server-only guard throws
// outside Next's bundler. It is server-side by construction (spawns processes).
import { execFile } from "node:child_process";
import { worded } from "@kairos/engine/wording";
import { promisify } from "node:util";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtsExpect } from "@kairos/engine/ats-text";
import { childEnv } from "./child-env";
import { checkPdfAts, libreOfficeOff, libreOfficeProfile, oneAtATime, pdftotextPath, popplerOff, runLibreOffice, sofficePath, type AtsCheck } from "./pdf-render";
import { existsSync } from "node:fs";
import { findProgram, isRunnable } from "./programs";

/**
 * Visual layout probe: render a .docx to PDF and MEASURE the real page count
 * and last-page fill, instead of estimating from word count. Template-agnostic
 * — it measures whatever the renderer actually produced. Needs LibreOffice;
 * returns null when it isn't present, so the engine's word-count gate remains
 * the portable safety net. The PDF is read with poppler when it is installed
 * and in JavaScript (unpdf) when it is not.
 *
 * The same PDF also gets an ATS text-layer check (`ats`): what a parser reads
 * from the embedded text, not the page. It is reported beside the layout
 * verdict and never changes it.
 */

const execFileAsync = promisify(execFile);
const SOFFICE = sofficePath();
// poppler's pdfinfo: PDFINFO_PATH, then Homebrew's spots, then the system's (Linux), then PATH (Windows: pdfinfo.exe).
const PDFINFO =
  [process.env.PDFINFO_PATH, "/opt/homebrew/bin/pdfinfo", "/usr/local/bin/pdfinfo", "/usr/bin/pdfinfo"].find((p): p is string => !!p && existsSync(p)) ??
  findProgram("pdfinfo") ??
  "/opt/homebrew/bin/pdfinfo";
// Its own LibreOffice profile folder, apart from the PDF render's (pdf-render.ts, libreOfficeProfile).
const LO_PROFILE = libreOfficeProfile("probe");

export interface LayoutProbe {
  pages: number;
  /** Chars on the last page as a fraction of chars on page 1 (0–1+). */
  lastPageFill: number;
  /** First non-empty text line of page 2 (null on 1-page renders). */
  page2Start: string | null;
  verdict: "good" | "short" | "overflow" | "bad-break";
  /** Human-readable, model-actionable guidance when not "good". */
  guidance: string | null;
  /**
   * ATS text-layer check of the same PDF (pdftotext -layout): contact details
   * present as text, ASCII date separators, no broken glyphs, reading order,
   * non-empty layer. Independent of `verdict`.
   */
  ats: AtsCheck;
}

/** A rendered PDF as the layout check reads it: how many pages, and the text of one page. */
interface PageReader {
  pages: number;
  pageText: (page: number) => Promise<string>;
}

/** poppler: pdfinfo for the page count, pdftotext for each page. */
async function popplerReader(pdfPath: string, pdftotext: string): Promise<PageReader> {
  const { stdout: info } = await execFileAsync(PDFINFO, [pdfPath], { timeout: 20_000, env: childEnv() });
  return {
    pages: parseInt(info.match(/Pages:\s+(\d+)/)?.[1] ?? "0", 10),
    pageText: async (page) => {
      const { stdout } = await execFileAsync(pdftotext, ["-f", String(page), "-l", String(page), pdfPath, "-"], { timeout: 20_000, env: childEnv() });
      return stdout;
    },
  };
}

/**
 * Without poppler (a Windows PC has no standard installer for it): the same PDF read in JavaScript
 * with unpdf, which the knowledge base's own PDF import already uses. Each page's text comes in the
 * order the file holds it, one line per line of the page.
 */
async function unpdfReader(pdfPath: string): Promise<PageReader> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(pdfPath)));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  return { pages: totalPages, pageText: async (page) => text[page - 1] ?? "" };
}

export type PdfReading = "poppler" | "unpdf";

/** Which reading this computer gives: poppler when both its programs are there, else unpdf. */
export async function pdfReading(): Promise<PdfReading> {
  return !popplerOff() && isRunnable(PDFINFO) && (await pdftotextPath()) ? "poppler" : "unpdf";
}

/** What the layout verdict is drawn from. */
export interface PdfMeasure {
  pages: number;
  /** Chars on the last page as a fraction of chars on page 1 (0–1+). */
  lastPageFill: number;
  /** First non-empty text line of page 2 (null on 1-page renders). */
  page2Start: string | null;
}

/** Measure a rendered PDF with one of the two readings. Null when the file has no page. */
export async function measurePdf(pdfPath: string, reading: PdfReading): Promise<PdfMeasure | null> {
  const pdftotext = reading === "poppler" ? await pdftotextPath() : null;
  if (reading === "poppler" && !pdftotext) return null;
  const reader = pdftotext ? await popplerReader(pdfPath, pdftotext) : await unpdfReader(pdfPath);
  const { pages } = reader;
  if (pages < 1) return null;
  const first = (await reader.pageText(1)).replace(/\s/g, "").length;
  const last = pages > 1 ? (await reader.pageText(pages)).replace(/\s/g, "").length : first;
  const lastPageFill = first > 0 ? last / first : 1;
  const page2Start =
    pages > 1
      ? ((await reader.pageText(2)).split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null)
      : null;
  return { pages, lastPageFill, page2Start };
}

/**
 * The verdict for a measure. Target: exactly 2 pages with the second at least ~80% full, and — when
 * an anchor is configured — page 2 headed by the anchored role. 1 page is fine (short careers).
 * 3+ pages, a sparse final page, or a stray break all need fixing.
 */
export function layoutVerdict(m: PdfMeasure, page2Anchor?: string | null): Pick<LayoutProbe, "verdict" | "guidance"> {
  const { pages, lastPageFill, page2Start } = m;
  const anchor = page2Anchor?.trim();
  if (pages > 2) {
    return {
      verdict: "overflow",
      guidance: `Rendered to ${pages} pages. Trim the lowest-value bullets from the later roles until it fits exactly 2 pages (remove ~${(pages - 2) * 4}-${(pages - 2) * 6} bullets).`,
    };
  }
  if (anchor && pages === 2 && page2Start && !page2Start.toLowerCase().includes(anchor.toLowerCase())) {
    return {
      verdict: "bad-break",
      guidance: `Page 2 starts with "${page2Start.slice(0, 60)}" instead of the anchored role ("${anchor}"). Tighten or trim bullets in the roles BEFORE the anchor until page 1 holds them exactly; if page 2 then runs short, restore curated bullets to the roles AFTER the anchor.`,
    };
  }
  if (pages === 2 && lastPageFill < 0.78) {
    const deficit = Math.round((0.85 - lastPageFill) * 12);
    return {
      verdict: "short",
      guidance: worded`Page 2 is only ${Math.round(lastPageFill * 100)}% full. Restore ~${deficit} more curated achievement bullets from the knowledge base (second bullets on later roles), never filler, to fill it.`,
    };
  }
  return { verdict: "good", guidance: null };
}

/**
 * Measure a rendered resume .docx. Null if LibreOffice is unavailable. The PDF is read with poppler
 * when it is there and with unpdf when it is not (pdfReading), so a computer with LibreOffice alone
 * still gets a measured verdict; the ATS text check needs poppler and says so when it is absent.
 * When `page2Anchor` is given (the profile's `resume_page2_anchor`), the probe
 * also verifies that page 2 actually starts with the anchored role and returns
 * verdict "bad-break" otherwise — the layout invariant that page breaks land
 * on the intended section, not mid-role.
 */
export async function probeResumeLayout(
  docxPath: string,
  opts: {
    page2Anchor?: string | null;
    /** What the text layer must hold (atsExpectFromMarkdown of the résumé source). */
    atsExpect?: AtsExpect;
  } = {},
): Promise<LayoutProbe | null> {
  if (libreOfficeOff() || !isRunnable(SOFFICE)) return null;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "kairos-layout-"));
    // One LibreOffice run at a time, renders included: the probe's profile folder
    // is shared, and under the hosted connector several users can ask at once.
    const outDir = dir;
    await oneAtATime(() =>
      runLibreOffice(["--headless", "--invisible", "--norestore", `-env:UserInstallation=${LO_PROFILE}`,
        "--convert-to", "pdf", "--outdir", outDir, docxPath]),
    );
    const pdf = (await readdir(dir)).find((f) => f.endsWith(".pdf"));
    if (!pdf) return null;
    const pdfPath = join(dir, pdf);

    const measure = await measurePdf(pdfPath, await pdfReading());
    if (!measure) return null;
    // ATS text layer of the same PDF. Reported, never folded into `verdict`.
    let ats: AtsCheck;
    try {
      ats = await checkPdfAts(pdfPath, opts.atsExpect ?? {});
    } catch (e) {
      ats = { available: false, reason: `ATS check failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ...measure, ...layoutVerdict(measure, opts.page2Anchor), ats };
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * One-line verdict for humans and the model: the layout verdict first, then the
 * ATS text-layer result. ATS issues do not change the layout verdict, but they
 * are named here so they cannot be missed.
 */
export function layoutVerdictText(p: LayoutProbe): string {
  const layout =
    p.verdict === "good"
      ? // The fill compares the last page with the first. On one page that is the page with itself:
        // "100% full" would be said of a page that is half empty, so no figure is given.
        p.pages === 1
        ? "Layout good (1 page; how full it is was not measured)."
        : `Layout good (${p.pages} pages, last page ${Math.round(p.lastPageFill * 100)}% full).`
      : `Layout ${p.verdict}: ${p.guidance ?? "see guidance"}`;
  if (!p.ats.available) return `${layout} ATS text layer not checked: ${p.ats.reason}`;
  if (p.ats.ok) return `${layout} ATS text layer clean.`;
  const rules = [...new Set(p.ats.issues.map((i) => i.rule))].join(", ");
  return (
    `${layout} ATS TEXT LAYER: ${p.ats.issues.length} issue(s) (${rules}); fix before submitting ` +
    `(the layout verdict is unaffected). ${p.ats.issues.map((i) => `[${i.rule}] ${i.detail}`).join(" ")}`
  );
}
