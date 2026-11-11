/**
 * Reading the documents a new user brings to `/setup`: résumés (PDF, DOCX,
 * text), a LinkedIn data export (the .zip, or the folder it unzips to), and
 * transcripts. Each document becomes plain text with its source name, so the
 * extraction prompt can run on it and every saved fact can name where it came
 * from.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { extractResumeText } from "@kairos/engine/extract-text";

export type SourceKind = "resume" | "linkedin" | "transcript" | "other";

export interface SourceDocument {
  path: string;
  name: string;
  kind: SourceKind;
  bytes: number;
}

const READABLE = new Set([".pdf", ".docx", ".txt", ".md"]);
/** LinkedIn export files Kairos reads, in the order they are rendered. */
export const LINKEDIN_FILES = ["Profile.csv", "Positions.csv", "Education.csv", "Skills.csv", "Languages.csv", "Certifications.csv", "Projects.csv", "Honors.csv"];

export function guessKind(name: string): SourceKind {
  const n = name.toLowerCase();
  if (/linkedin|basic_linkedindata|positions\.csv/.test(n)) return "linkedin";
  if (/transcript|grades|releve|record of study/.test(n)) return "transcript";
  if (/resume|résumé|cv\b|curriculum/.test(n)) return "resume";
  return "other";
}

async function isLinkedInFolder(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, "Positions.csv"));
    return true;
  } catch {
    return false;
  }
}

/** The documents in a folder (two levels deep), with a guess at what each is. */
export async function listSourceDocuments(folder: string): Promise<SourceDocument[]> {
  const out: SourceDocument[] = [];
  async function walk(dir: string, depth: number) {
    if (await isLinkedInFolder(dir)) {
      out.push({ path: dir, name: path.basename(dir), kind: "linkedin", bytes: 0 });
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 2) await walk(p, depth + 1);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      const stat = await fs.stat(p);
      if (ext === ".zip") {
        const zip = await JSZip.loadAsync(await fs.readFile(p)).catch(() => null);
        if (zip && Object.keys(zip.files).some((f) => f.endsWith("Positions.csv"))) {
          out.push({ path: p, name: e.name, kind: "linkedin", bytes: stat.size });
        }
        continue;
      }
      if (!READABLE.has(ext)) continue;
      out.push({ path: p, name: e.name, kind: guessKind(e.name), bytes: stat.size });
    }
  }
  await walk(folder, 0);
  return out;
}

/** RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((x) => x.trim()));
  // LinkedIn puts a "Notes:" preamble above the header in some files.
  const headerAt = nonEmpty.findIndex((r) => r.length > 1);
  if (headerAt === -1) return [];
  const [header, ...body] = nonEmpty.slice(headerAt);
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/** A LinkedIn export as résumé-like text, one section per CSV. */
export function linkedInToText(files: Record<string, string>): string {
  const parts: string[] = ["LINKEDIN DATA EXPORT"];
  const rows = (name: string) => (files[name] ? parseCsv(files[name]) : []);
  const join = (...xs: (string | undefined)[]) => xs.filter((x) => x && x.trim()).join(" · ");

  const profile = rows("Profile.csv")[0];
  if (profile) {
    parts.push(
      "",
      "PROFILE",
      join(`${profile["First Name"] ?? ""} ${profile["Last Name"] ?? ""}`.trim(), profile["Geo Location"]),
      profile["Headline"] ? `Headline: ${profile["Headline"]}` : "",
      profile["Summary"] ? `Summary: ${profile["Summary"]}` : "",
    );
  }
  const positions = rows("Positions.csv");
  if (positions.length) {
    parts.push("", "EXPERIENCE");
    for (const p of positions) {
      parts.push(
        "",
        join(p["Title"], p["Company Name"], p["Location"]),
        `${p["Started On"] || "?"} – ${p["Finished On"] || "present"}`,
        p["Description"] ?? "",
      );
    }
  }
  const education = rows("Education.csv");
  if (education.length) {
    parts.push("", "EDUCATION");
    for (const e of education) {
      parts.push(join(e["School Name"], e["Degree Name"], `${e["Start Date"] || ""}–${e["End Date"] || ""}`, e["Notes"], e["Activities"]));
    }
  }
  const list = (file: string, title: string, col: string, extra?: string) => {
    const r = rows(file);
    if (!r.length) return;
    parts.push("", title, r.map((x) => join(x[col], extra ? x[extra] : undefined)).join("; "));
  };
  list("Skills.csv", "SKILLS", "Name");
  list("Languages.csv", "LANGUAGES", "Name", "Proficiency");
  list("Certifications.csv", "CERTIFICATIONS", "Name", "Authority");
  const projects = rows("Projects.csv");
  if (projects.length) {
    parts.push("", "PROJECTS");
    for (const p of projects) parts.push(join(p["Title"], `${p["Started On"] || ""}–${p["Finished On"] || ""}`, p["Description"]));
  }
  list("Honors.csv", "HONORS", "Title", "Issued On");
  return parts.filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n").trim();
}

async function readLinkedIn(p: string): Promise<string> {
  const files: Record<string, string> = {};
  const stat = await fs.stat(p);
  if (stat.isDirectory()) {
    for (const f of LINKEDIN_FILES) {
      const text = await fs.readFile(path.join(p, f), "utf8").catch(() => null);
      if (text) files[f] = text;
    }
  } else {
    const zip = await JSZip.loadAsync(await fs.readFile(p));
    for (const [name, entry] of Object.entries(zip.files)) {
      const base = path.basename(name);
      if (LINKEDIN_FILES.includes(base)) files[base] = await entry.async("string");
    }
  }
  if (!files["Positions.csv"] && !files["Profile.csv"]) throw new Error("No Profile.csv or Positions.csv found: this is not a LinkedIn data export.");
  return linkedInToText(files);
}

/** Plain text of one source document. */
/** The largest document read (a long résumé PDF is well under 5 MB). */
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * Only documents: a résumé or transcript (PDF, DOCX, TXT, MD), or a LinkedIn
 * export (.zip or its folder). The tool takes a path from the model, so a
 * posting that talks it into "reading" ~/.ssh or a key file is refused: no
 * hidden file or folder anywhere in the real path (after symlinks), no other
 * file type, nothing over the size limit.
 */
export async function checkSourcePath(p: string): Promise<{ real: string; stat: import("node:fs").Stats }> {
  if (!path.isAbsolute(p)) throw new Error("Pass the document's absolute path.");
  const real = await fs.realpath(p);
  if (real.split(path.sep).some((seg) => seg.startsWith("."))) throw new Error("Kairos does not read hidden files or folders. Move the document to a regular folder and try again.");
  const stat = await fs.stat(real);
  const ext = path.extname(real).toLowerCase();
  if (stat.isDirectory()) {
    if (!(await isLinkedInFolder(real))) throw new Error("That folder is not a LinkedIn data export. Pass a document, or use list_source_documents on the folder.");
  } else if (!READABLE.has(ext) && ext !== ".zip") {
    throw new Error(`Kairos reads résumés and transcripts (PDF, DOCX, TXT, MD) and LinkedIn exports (.zip). ${path.basename(real)} is not one of these.`);
  } else if (stat.size > MAX_DOCUMENT_BYTES) {
    throw new Error(`${path.basename(real)} is over 25 MB.`);
  }
  return { real, stat };
}

export async function readSourceDocument(input: string): Promise<{ name: string; kind: SourceKind; text: string }> {
  const { real: p, stat } = await checkSourcePath(input);
  const name = path.basename(p);
  if (stat.isDirectory() || p.toLowerCase().endsWith(".zip")) {
    return { name, kind: "linkedin", text: await readLinkedIn(p) };
  }
  const buffer = await fs.readFile(p);
  const file = new File([new Uint8Array(buffer)], name);
  const text = await extractResumeText(file);
  return { name, kind: guessKind(name), text };
}
