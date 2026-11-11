// NOTE: intentionally NOT "server-only" — this module is imported by the MCP
// server (raw tsx) as well as the Next app, and the server-only guard throws
// outside Next's bundler. It is server-side by construction (spawns processes).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtsExpect } from "@kairos/engine/ats-text";
import { checkPdfAts, pdftotextPath, sofficePath, type AtsCheck } from "./pdf-render";
import { existsSync } from "node:fs";

/**
 * Visual layout probe: render a .docx to PDF and MEASURE the real page count
 * and last-page fill, instead of estimating from word count. Template-agnostic
 * — it measures whatever the renderer actually produced. Local-only (needs
 * LibreOffice + poppler); returns null when the tooling isn't present, so the
 * engine's word-count gate remains the portable safety net.
 *
 * The same PDF also gets an ATS text-layer check (`ats`): what a parser reads
 * from the embedded text, not the page. It is reported beside the layout
 * verdict and never changes it.
 */

const execFileAsync = promisify(execFile);
const SOFFICE = sofficePath();
const PDFINFO = ["/opt/homebrew/bin/pdfinfo", "/usr/local/bin/pdfinfo"].find((p) => existsSync(p)) ?? "/opt/homebrew/bin/pdfinfo";
// Isolated LibreOffice profile so the probe never pops a visible window and
// never collides with the user's own LibreOffice session.
const LO_PROFILE = "file:///tmp/lo-kairos-probe";
// svp = true headless backend; skips the macOS window server so no Dock/tray
// icon flashes on each render (plain --headless still registers a GUI app).
const HEADLESS_ENV = { ...process.env, SAL_USE_VCLPLUGIN: "svp" };

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

async function toolsPresent(): Promise<boolean> {
  try {
    await execFileAsync("test", ["-x", SOFFICE]);
    await execFileAsync("test", ["-x", PDFINFO]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Measure a rendered resume .docx. Null if the render tools are unavailable.
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
  if (!(await toolsPresent())) return null;
  const pdftotext = await pdftotextPath();
  if (!pdftotext) return null;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "kairos-layout-"));
    await execFileAsync(
      SOFFICE,
      ["--headless", "--invisible", "--norestore", `-env:UserInstallation=${LO_PROFILE}`,
        "--convert-to", "pdf", "--outdir", dir, docxPath],
      { timeout: 90_000, env: HEADLESS_ENV },
    );
    const pdf = (await readdir(dir)).find((f) => f.endsWith(".pdf"));
    if (!pdf) return null;
    const pdfPath = join(dir, pdf);

    const { stdout: info } = await execFileAsync(PDFINFO, [pdfPath], { timeout: 20_000 });
    const pages = parseInt(info.match(/Pages:\s+(\d+)/)?.[1] ?? "0", 10);
    if (pages < 1) return null;

    const pageText = async (page: number) => {
      const { stdout } = await execFileAsync(
        pdftotext, ["-f", String(page), "-l", String(page), pdfPath, "-"],
        { timeout: 20_000 },
      );
      return stdout;
    };
    const firstText = await pageText(1);
    const first = firstText.replace(/\s/g, "").length;
    const last = pages > 1 ? (await pageText(pages)).replace(/\s/g, "").length : first;
    const lastPageFill = first > 0 ? last / first : 1;
    const page2Start =
      pages > 1
        ? ((await pageText(2)).split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null)
        : null;

    // Target: exactly 2 pages with the second at least ~80% full, and — when an
    // anchor is configured — page 2 headed by the anchored role. 1 page is
    // fine (short careers). 3+ pages, a sparse final page, or a stray break
    // all need fixing.
    let verdict: LayoutProbe["verdict"] = "good";
    let guidance: string | null = null;
    const anchor = opts.page2Anchor?.trim();
    if (pages > 2) {
      verdict = "overflow";
      guidance = `Rendered to ${pages} pages. Trim the lowest-value bullets from the later roles until it fits exactly 2 pages (remove ~${(pages - 2) * 4}-${(pages - 2) * 6} bullets).`;
    } else if (anchor && pages === 2 && page2Start && !page2Start.toLowerCase().includes(anchor.toLowerCase())) {
      verdict = "bad-break";
      guidance = `Page 2 starts with "${page2Start.slice(0, 60)}" instead of the anchored role ("${anchor}"). Tighten or trim bullets in the roles BEFORE the anchor until page 1 holds them exactly; if page 2 then runs short, restore curated bullets to the roles AFTER the anchor.`;
    } else if (pages === 2 && lastPageFill < 0.78) {
      verdict = "short";
      const deficit = Math.round((0.85 - lastPageFill) * 12);
      guidance = `Page 2 is only ${Math.round(lastPageFill * 100)}% full. Restore ~${deficit} more curated achievement bullets from the knowledge base (second bullets on later roles), never filler, to fill it.`;
    }
    // ATS text layer of the same PDF. Reported, never folded into `verdict`.
    let ats: AtsCheck;
    try {
      ats = await checkPdfAts(pdfPath, opts.atsExpect ?? {});
    } catch (e) {
      ats = { available: false, reason: `ATS check failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { pages, lastPageFill, page2Start, verdict, guidance, ats };
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
      ? `Layout good (${p.pages} page${p.pages === 1 ? "" : "s"}, last page ${Math.round(p.lastPageFill * 100)}% full).`
      : `Layout ${p.verdict}: ${p.guidance ?? "see guidance"}`;
  if (!p.ats.available) return `${layout} ATS text layer not checked: ${p.ats.reason}`;
  if (p.ats.ok) return `${layout} ATS text layer clean.`;
  const rules = [...new Set(p.ats.issues.map((i) => i.rule))].join(", ");
  return (
    `${layout} ATS TEXT LAYER: ${p.ats.issues.length} issue(s) (${rules}); fix before submitting ` +
    `(the layout verdict is unaffected). ${p.ats.issues.map((i) => `[${i.rule}] ${i.detail}`).join(" ")}`
  );
}
