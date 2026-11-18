// NOTE: intentionally NOT "server-only" — imported by the MCP server (raw tsx)
// as well as the Next app; the server-only guard throws outside Next's bundler.
// Server-side by construction (spawns LibreOffice).
import { existsSync, readdirSync, rmSync } from "node:fs";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, rename, rm, readdir, readFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import matter from "@kairos/engine/front-matter";
import { checkAtsText, type AtsExpect, type AtsResult } from "@kairos/engine/ats-text";
import { submissionFileName, type SubmissionDoc } from "@kairos/engine/file-names";
import { childEnv } from "./child-env";
import { findProgram, isRunnable, windowsProgramFolders } from "./programs";

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
 * the app itself (where `brew install --cask libreoffice` and the download put it),
 * then on Windows the folders its installer uses, then `soffice` on PATH.
 */
export function sofficePath(): string {
  const candidates = [
    process.env.SOFFICE_PATH,
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ...windowsProgramFolders().map((dir) => join(dir, "LibreOffice", "program", "soffice.exe")),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? process.env.SOFFICE_PATH ?? findProgram("soffice") ?? "/opt/homebrew/bin/soffice";
}
const SOFFICE = sofficePath();
/**
 * Set to "1", LibreOffice is treated as absent: nothing is rendered and the layout is not measured.
 * The tests set it (tests/setup.ts) unless KAIROS_LO_TESTS=1 asks for the real program, because on
 * macOS every conversion brings LibreOffice up as a foreground app and a test run does dozens.
 */
export const libreOfficeOff = (): boolean => process.env.KAIROS_NO_LIBREOFFICE === "1";

/**
 * LibreOffice's profile folder for this process and this use ("pdf", "probe"): its own, so a
 * conversion never opens a window, never meets the user's own LibreOffice, and never meets another
 * Kairos process (the dashboard, the tool server, a test worker). Two programs on one profile hand
 * their work to whichever started first, and that one is then left running when its starter ends.
 */
const profileDirs = new Set<string>();
/** Where the profile folders go: /tmp on macOS and Linux, the user's temporary folder on Windows (it has no /tmp). */
const PROFILE_ROOT = process.platform === "win32" ? tmpdir() : "/tmp";
export function libreOfficeProfile(use: string): string {
  const dir = join(PROFILE_ROOT, `lo-kairos-${use}-${process.pid}`);
  if (!profileDirs.size) removeProfilesOfEndedProcesses();
  profileDirs.add(dir);
  // LibreOffice takes the folder as an address: file:///tmp/… here, file:///C:/Users/… on Windows.
  return pathToFileURL(dir).href;
}
/** A process that was killed could not remove its folders (the exit hook below did not run): the next one does. */
function removeProfilesOfEndedProcesses(): void {
  try {
    for (const name of readdirSync(PROFILE_ROOT)) {
      const pid = Number(name.match(/^lo-kairos-[a-z]+-(\d+)$/)?.[1]);
      if (!pid || pid === process.pid) continue;
      try {
        process.kill(pid, 0); // still running: its folder is in use
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") rmSync(join(PROFILE_ROOT, name), { recursive: true, force: true });
      }
    }
  } catch {
    // Best effort: a folder left in /tmp does no harm.
  }
}

/**
 * The option that once kept LibreOffice off the macOS window server (29 August 2026). Measured on
 * 15 November 2026 with LibreOffice 26.2.4 on macOS 26.6.2: it changes nothing, the program is a
 * foreground app during a conversion with or without it. Kept because it is harmless and right on Linux.
 * A short environment of its own (child-env.ts): LibreOffice gets none of the server's settings.
 */
export const HEADLESS_ENV = childEnv({ SAL_USE_VCLPLUGIN: "svp" });

/** The conversions in progress, so that none outlives this process. */
const running = new Set<ChildProcess>();
let exitHook = false;
function stopWithThisProcess(): void {
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => {
    // SIGKILL, not SIGTERM: LibreOffice answers SIGTERM by aborting, which macOS records as a crash.
    for (const child of running) child.kill("SIGKILL");
    for (const dir of profileDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // The folder is in /tmp; the system clears it later.
      }
    }
  });
}

/** Run LibreOffice once with these arguments. Rejects when it fails or takes more than 90 seconds. */
export function runLibreOffice(args: string[]): Promise<void> {
  stopWithThisProcess();
  return new Promise((resolve, reject) => {
    const child = execFile(SOFFICE, args, { timeout: 90_000, killSignal: "SIGKILL", env: HEADLESS_ENV }, (err) => {
      running.delete(child);
      if (err) reject(err);
      else resolve();
    });
    running.add(child);
  });
}

const LO_PROFILE = libreOfficeProfile("pdf");

/**
 * One conversion at a time: every conversion uses the same LibreOffice profile
 * folder, and two at once lock each other out. On the Mac there is one user;
 * under the hosted connector several users can ask at the same moment.
 */
let conversions: Promise<unknown> = Promise.resolve();
export function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = conversions.then(work, work);
  conversions = run.catch(() => undefined);
  return run;
}

async function sofficePresent(): Promise<boolean> {
  if (libreOfficeOff()) return false;
  return isRunnable(SOFFICE);
}

/**
 * Convert `docxPath` → sibling `.pdf`. Returns the pdf path on success, null if
 * LibreOffice is unavailable or the conversion failed.
 */
export function renderDocxToPdf(docxPath: string): Promise<string | null> {
  return oneAtATime(() => convertDocxToPdf(docxPath));
}

async function convertDocxToPdf(docxPath: string): Promise<string | null> {
  if (!(await sofficePresent())) return null;
  const outDir = dirname(docxPath);
  const stem = basename(docxPath).replace(/\.docx$/i, "");
  const wantPdf = join(outDir, `${stem}.pdf`);
  try {
    await runLibreOffice(["--headless", "--invisible", "--norestore", `-env:UserInstallation=${LO_PROFILE}`,
      "--convert-to", "pdf", "--outdir", outDir, docxPath]);
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

// poppler's pdftotext: env override first, then the usual Homebrew/system spots, then PATH
// (where a Windows install of poppler is found, as pdftotext.exe).
const PDFTOTEXT_CANDIDATES = [
  process.env.PDFTOTEXT_PATH,
  "/opt/homebrew/bin/pdftotext",
  "/usr/local/bin/pdftotext",
  "/usr/bin/pdftotext",
  findProgram("pdftotext"),
].filter((p): p is string => !!p);

let pdftotextResolved: string | null | undefined;

/**
 * Set to "1", poppler (pdfinfo, pdftotext) is treated as absent, as on a Windows PC, where it has no
 * standard installer: the layout check then reads the PDF in JavaScript (layout-probe.ts) and the ATS
 * text check answers "not available". The tests and the comparison of the two readings use it.
 */
export const popplerOff = (): boolean => process.env.KAIROS_NO_POPPLER === "1";

/** Absolute path of an executable pdftotext, or null when poppler is absent. Cached. */
export async function pdftotextPath(): Promise<string | null> {
  if (popplerOff()) return null;
  if (pdftotextResolved !== undefined) return pdftotextResolved;
  for (const candidate of PDFTOTEXT_CANDIDATES) {
    if (isRunnable(candidate)) return (pdftotextResolved = candidate);
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
      env: childEnv(),
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
