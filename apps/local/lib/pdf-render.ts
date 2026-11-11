// NOTE: intentionally NOT "server-only" — imported by the MCP server (raw tsx)
// as well as the Next app; the server-only guard throws outside Next's bundler.
// Server-side by construction (spawns LibreOffice).
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, rename, rm, readdir, readFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import matter from "gray-matter";
import { checkAtsText, type AtsExpect, type AtsResult } from "@kairos/engine/ats-text";
import { submissionFileName, type SubmissionDoc } from "@kairos/engine/file-names";

/**
 * Render a .docx to a PDF sitting next to it (same directory, same stem).
 *
 * Every application keeps BOTH: the .docx is the editable master for quick
 * manual tuning, the .pdf is the faithful, submit-ready render of that exact
 * layout (LibreOffice, so Calibri / spacing / page breaks match the docx — not
 * the separate HTML template). Best-effort: returns false when LibreOffice is
 * absent so callers never fail a save just because the PDF couldn't be made.
 */

const execFileAsync = promisify(execFile);
/**
 * LibreOffice's command-line program: SOFFICE_PATH, then Homebrew's link, then
 * the app itself (where `brew install --cask libreoffice` and the download put it).
 */
export function sofficePath(): string {
  const candidates = [process.env.SOFFICE_PATH, "/opt/homebrew/bin/soffice", "/usr/local/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? process.env.SOFFICE_PATH ?? "/opt/homebrew/bin/soffice";
}
const SOFFICE = sofficePath();
// Isolated profile so conversion never pops a window or collides with the
// user's own LibreOffice session. Distinct from the layout probe's profile so
// the two can run concurrently without locking each other out.
const LO_PROFILE = "file:///tmp/lo-kairos-pdf";
// svp = LibreOffice's true headless display backend: it never touches the macOS
// window server, so no icon flashes into the Dock/app tray on each conversion
// (plain --headless still registers a GUI app on macOS and bounces the Dock).
const HEADLESS_ENV = { ...process.env, SAL_USE_VCLPLUGIN: "svp" };

async function sofficePresent(): Promise<boolean> {
  try {
    await execFileAsync("test", ["-x", SOFFICE]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert `docxPath` → sibling `.pdf`. Returns the pdf path on success, null if
 * LibreOffice is unavailable or the conversion failed.
 */
export async function renderDocxToPdf(docxPath: string): Promise<string | null> {
  if (!(await sofficePresent())) return null;
  const outDir = dirname(docxPath);
  const stem = basename(docxPath).replace(/\.docx$/i, "");
  const wantPdf = join(outDir, `${stem}.pdf`);
  try {
    await execFileAsync(
      SOFFICE,
      ["--headless", "--invisible", "--norestore", `-env:UserInstallation=${LO_PROFILE}`,
        "--convert-to", "pdf", "--outdir", outDir, docxPath],
      { timeout: 90_000, env: HEADLESS_ENV },
    );
    // soffice names the output after the input stem; confirm it landed.
    const produced = (await readdir(outDir)).find(
      (f) => f.toLowerCase() === `${stem.toLowerCase()}.pdf`,
    );
    if (!produced) return null;
    if (produced !== `${stem}.pdf`) {
      await rename(join(outDir, produced), wantPdf).catch(() => {});
    }
    await writeSubmissionCopies(outDir);
    return wantPdf;
  } catch {
    await rm(wantPdf, { force: true }).catch(() => {});
    return null;
  }
}

/**
 * Write the submit-ready copies of an application's documents next to the
 * masters: resume.pdf → Jane_Doe-<company>-resume.pdf, and the same for
 * resume.docx and the cover letter (rule: @kairos/engine/file-names). The
 * candidate attaches these by hand, so a recruiter never receives a bare
 * "resume.pdf". Runs after every PDF render; best-effort, never fails a save.
 * The folder must be an application folder (~/Kairos/applications/<id>/ with
 * application-meta.json); anything else is left alone.
 */
export async function writeSubmissionCopies(appDir: string): Promise<string[]> {
  const written: string[] = [];
  try {
    const meta = JSON.parse(await readFile(join(appDir, "application-meta.json"), "utf8")) as { company?: string };
    const profileRaw = await readFile(join(appDir, "..", "..", "profile.md"), "utf8").catch(() => "");
    const name = profileRaw ? (matter(profileRaw).data as { name?: string }).name : undefined;
    const present = new Set(await readdir(appDir));
    for (const doc of ["resume", "cover-letter"] as SubmissionDoc[]) {
      for (const ext of ["pdf", "docx"] as const) {
        if (!present.has(`${doc}.${ext}`)) continue;
        const target = submissionFileName(name, meta.company, doc, ext);
        await copyFile(join(appDir, `${doc}.${ext}`), join(appDir, target));
        written.push(target);
      }
    }
  } catch {
    // not an application folder, or unreadable: nothing to name
  }
  return written;
}

// --- ATS text layer ---------------------------------------------------------

// poppler's pdftotext: env override first, then the usual Homebrew/system spots.
const PDFTOTEXT_CANDIDATES = [
  process.env.PDFTOTEXT_PATH,
  "/opt/homebrew/bin/pdftotext",
  "/usr/local/bin/pdftotext",
  "/usr/bin/pdftotext",
].filter((p): p is string => !!p);

let pdftotextResolved: string | null | undefined;

/** Absolute path of an executable pdftotext, or null when poppler is absent. Cached. */
export async function pdftotextPath(): Promise<string | null> {
  if (pdftotextResolved !== undefined) return pdftotextResolved;
  for (const candidate of PDFTOTEXT_CANDIDATES) {
    try {
      await execFileAsync("test", ["-x", candidate]);
      return (pdftotextResolved = candidate);
    } catch {
      /* try the next one */
    }
  }
  return (pdftotextResolved = null);
}

/**
 * Extract a PDF's embedded text layer the way a parser sees it:
 * `pdftotext -layout -enc UTF-8`. Layout mode keeps the physical line order, so
 * a multi-column page interleaves its columns here exactly as it does for a
 * naive ATS parser. Null when pdftotext is unavailable or the extraction fails.
 */
export async function extractPdfText(pdfPath: string): Promise<string | null> {
  const bin = await pdftotextPath();
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(bin, ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout;
  } catch {
    return null;
  }
}

/** ATS block reported next to a layout verdict. Never changes that verdict. */
export type AtsCheck =
  | ({ available: true } & AtsResult)
  | { available: false; reason: string };

/**
 * Run the ATS text-layer rules (packages/engine/ats-text.ts) on a rendered PDF.
 * `expect` comes from the résumé source (atsExpectFromMarkdown); without it the
 * contact and reading-order rules are skipped and the rest still run.
 */
export async function checkPdfAts(pdfPath: string, expect: AtsExpect = {}): Promise<AtsCheck> {
  if (!(await pdftotextPath())) {
    return { available: false, reason: "pdftotext (poppler) not found; install poppler to check the ATS text layer." };
  }
  const text = await extractPdfText(pdfPath);
  if (text === null) return { available: false, reason: "pdftotext failed to extract the PDF's text layer." };
  return { available: true, ...checkAtsText(text, expect) };
}
