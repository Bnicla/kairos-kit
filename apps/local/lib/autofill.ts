import type { NextRequest } from "next/server";
import { getStore } from "@/store";
import matter from "gray-matter";
import { loadEducation, loadExperiences } from "@kairos/engine/kb/store";
import { loadIndex } from "@kairos/engine/applications";
import { submissionFileName } from "@kairos/engine/file-names";

/**
 * Shared building blocks for the autofill extension endpoints
 * (/api/autofill-profile serves the profile; /api/autofill-map maps form fields
 * to it via Claude). Kept out of the route files because Next.js route modules
 * may only export request handlers.
 */

export interface AutofillJson {
  contact?: Record<string, string>;
  address?: Record<string, string>;
  links?: Record<string, string>;
  work_authorization?: Record<string, unknown>;
  eeo?: Record<string, string>;
  /** EEO/demographic data is served ONLY when this is explicitly true. */
  share_eeo?: boolean;
  common_answers?: Record<string, string>;
  defaults?: Record<string, unknown>;
  /** How each record role appears on application forms, keyed by experience id (see WorkHistoryOverride). */
  work_history_overrides?: Record<string, WorkHistoryOverride>;
}

/**
 * The user's own decisions about how one record role appears on application
 * forms, where a form needs something the record does not hold or the user
 * shows differently on forms (an HR title, exact months, a role left off).
 * Dates are "MM/YYYY" or "YYYY".
 */
export interface WorkHistoryOverride {
  title?: string;
  start?: string;
  end?: string;
  current?: boolean;
  /** Leave this role off application forms. */
  exclude?: boolean;
}

export interface WorkHistoryRow {
  id: string;
  company: string;
  title: string;
  location: string;
  start: string;
  end: string;
  current: boolean;
  /** Which fields came from work_history_overrides rather than the record. */
  overridden?: string[];
}

/**
 * Apply work_history_overrides to the record's roles: excluded roles drop out,
 * other fields replace the record's value and are listed in `overridden`. An
 * override for an id the record does not hold is ignored (it never adds a role).
 */
export function applyWorkHistoryOverrides(rows: WorkHistoryRow[], overrides: Record<string, WorkHistoryOverride> | undefined): WorkHistoryRow[] {
  if (!overrides) return rows;
  const out: WorkHistoryRow[] = [];
  for (const row of rows) {
    const o = overrides[row.id];
    if (!o) {
      out.push(row);
      continue;
    }
    if (o.exclude) continue;
    const next: WorkHistoryRow = { ...row };
    const changed: string[] = [];
    for (const k of ["title", "start", "end"] as const) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) {
        next[k] = v.trim();
        changed.push(k);
      }
    }
    if (typeof o.current === "boolean") {
      next.current = o.current;
      changed.push("current");
    }
    if (changed.length) next.overridden = changed;
    out.push(next);
  }
  return out;
}

/** Every autofill.json field; tsc fails when AutofillJson gains one without a line here (the /setup checklist test reads this). */
export const AUTOFILL_FIELDS: Record<keyof AutofillJson, true> = {
  contact: true,
  address: true,
  links: true,
  work_authorization: true,
  eeo: true,
  share_eeo: true,
  common_answers: true,
  defaults: true,
  work_history_overrides: true,
};

/**
 * Merge an update into autofill.json: object fields merge key by key (an
 * empty-string value removes that key), scalars replace. never_auto_submit
 * stays true unless the update sets it explicitly.
 */
export function mergeAutofill(existing: Record<string, unknown> | null, update: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(update)) {
    if (v === undefined) continue;
    const was = out[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const merged: Record<string, unknown> = { ...(was && typeof was === "object" && !Array.isArray(was) ? (was as Record<string, unknown>) : {}) };
      for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
        if (vv === "") delete merged[kk];
        else if (vv !== undefined) merged[kk] = vv;
      }
      out[k] = merged;
    } else out[k] = v;
  }
  const defaults = (out.defaults ?? {}) as Record<string, unknown>;
  if (defaults.never_auto_submit === undefined) out.defaults = { ...defaults, never_auto_submit: true };
  return out;
}

// Only reflect a chrome-extension:// origin back — never a web page's http(s)
// origin. That keeps this personal data readable by the extension alone.
export function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Kairos-Token",
      Vary: "Origin",
    };
  }
  return { Vary: "Origin" };
}

/**
 * Shared-token auth for the autofill endpoints (defense against DNS rebinding
 * and other local processes: CORS only constrains browsers, and the profile
 * endpoint serves contact/address/work-authorization data). The token lives at
 * ~/Kairos/.secrets/autofill-token, generated on first use; the extension sends
 * it as X-Kairos-Token after a one-time paste in its popup settings.
 */
export async function getOrCreateAutofillToken(store: Store): Promise<string> {
  const path = [".secrets", "autofill-token"];
  const existing = (await store.readFile(path).catch(() => null))?.trim();
  if (existing) return existing;
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("hex");
  const abs = await store.writeFile(path, token);
  // Readable by this user only.
  const { chmod } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await chmod(dirname(abs), 0o700).catch(() => {});
  await chmod(abs, 0o600).catch(() => {});
  return token;
}

const PORT = process.env.KAIROS_PORT ?? process.env.PORT ?? "3000";
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, "localhost", "127.0.0.1"]);

/** Null when the request is authorized; otherwise an error message + status. */
export async function rejectUnauthorized(
  req: NextRequest,
  store: Store,
): Promise<{ status: number; message: string } | null> {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return { status: 403, message: "Bad Host header." };
  }
  const token = await getOrCreateAutofillToken(store);
  const sent = req.headers.get("x-kairos-token") ?? "";
  const { timingSafeEqual } = await import("node:crypto");
  if (sent.length !== token.length || !timingSafeEqual(Buffer.from(sent), Buffer.from(token))) {
    return {
      status: 401,
      message:
        "Missing or invalid X-Kairos-Token. Paste the token from ~/Kairos/.secrets/autofill-token into the extension's settings.",
    };
  }
  return null;
}

type Store = ReturnType<typeof getStore>;

/**
 * Assemble the normalized autofill profile from ~/Kairos. Shared so the profile
 * endpoint and the field-map endpoint see exactly the same facts.
 */
export async function buildAutofillProfile(store: Store) {
  const [autofill, experiences, index, education, profileRaw] = await Promise.all([
    store.readJson<AutofillJson>(["autofill.json"]).catch(() => null),
    loadExperiences(store).catch(() => []),
    loadIndex(store).catch(() => ({ applications: [] as { id: string; company: string; role: string; status: string; updated_at?: string }[] })),
    loadEducation(store).catch(() => [] as string[]),
    store.readFile(["profile.md"]).catch(() => null),
  ]);

  const profileName = frontmatterOf(profileRaw).name;
  const candidateName = autofill?.contact?.full_name || (typeof profileName === "string" ? profileName : undefined);

  const recordRows: WorkHistoryRow[] = experiences
    .map((e) => {
      const fm = e.frontmatter as unknown as Record<string, unknown>;
      return {
        id: String(fm.id ?? ""),
        company: String(fm.company ?? ""),
        title: String(fm.title ?? ""),
        location: String(fm.location ?? ""),
        start: String(fm.start ?? ""),
        end: String(fm.end ?? ""),
        current: String(fm.end ?? "").toLowerCase() === "present",
      };
    })
    .filter((w) => w.company && w.title);
  const work_history = applyWorkHistoryOverrides(recordRows, autofill?.work_history_overrides);

  const identity = autofillIdentity({
    candidateName,
    commonAnswers: autofill?.common_answers,
    workHistory: work_history,
    educationRaws: education,
  });

  const resumes = (index.applications ?? [])
    .filter((a) => ["drafted", "applied", "interviewing", "offer"].includes(a.status))
    .slice(0, 40)
    .map((a) => ({
      appId: a.id,
      company: a.company,
      role: a.role,
      // Prefer the PDF; the background worker falls back to .docx if a PDF
      // hasn't been rendered for this app yet.
      resume_url: `/api/file/${encodeURIComponent(a.id)}/resume.pdf`,
      // The name the attached file carries on the form (engine/file-names).
      resume_file_name: submissionFileName(candidateName, a.company, "resume", "pdf"),
      cover_letter_url: `/api/file/${encodeURIComponent(a.id)}/cover-letter.pdf`,
    }));

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    contact: autofill?.contact ?? {},
    address: autofill?.address ?? {},
    links: autofill?.links ?? {},
    work_authorization: autofill?.work_authorization ?? {},
    // EEO/demographics are the most sensitive category here: served only on
    // explicit opt-in ("share_eeo": true in autofill.json).
    eeo: autofill?.share_eeo === true ? (autofill?.eeo ?? {}) : {},
    common_answers: autofill?.common_answers ?? {},
    defaults: autofill?.defaults ?? { never_auto_submit: true },
    // What the extension's offline matchers fill for name / employer /
    // school questions and how it names an attached file (no literals there).
    identity,
    work_history,
    resumes,
  };
}

function frontmatterOf(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return matter(raw).data as Record<string, unknown>;
  } catch {
    return {};
  }
}

const DEGREE = /\b(?:mba|master|bachelor|b\.?s\b|b\.?a\b|m\.?s\b|ph\.?d|doctor|degree|diplom|licen|engineer)/i;

/**
 * Name, current employer and school for form fields that ask for them.
 *   - full_name: autofill.json contact.full_name, else profile.md `name`.
 *   - current_employer: autofill.json common_answers.current_employer (an
 *     explicit answer wins), else the knowledge-base role ending "present",
 *     else the most recent role listed.
 *   - school: common_answers.school, else the first education file whose
 *     credential reads as a degree, else the first with an institution.
 */
export function autofillIdentity(input: {
  candidateName?: string;
  commonAnswers?: Record<string, string>;
  workHistory: { company: string; current: boolean; start?: string }[];
  educationRaws: string[];
}): { full_name?: string; current_employer?: string; school?: string } {
  const ca = input.commonAnswers ?? {};
  const byStart = [...input.workHistory].sort((a, b) => String(b.start ?? "").localeCompare(String(a.start ?? "")));
  const employer = ca.current_employer || input.workHistory.find((w) => w.current)?.company || byStart[0]?.company;
  const edu = input.educationRaws.map((r) => frontmatterOf(r)).filter((fm) => typeof fm.institution === "string" && fm.institution);
  const degree = edu.find((fm) => DEGREE.test(String(fm.credential ?? "")));
  const school = ca.school || String((degree ?? edu[0])?.institution ?? "") || undefined;
  return {
    ...(input.candidateName ? { full_name: input.candidateName } : {}),
    ...(employer ? { current_employer: employer } : {}),
    ...(school ? { school } : {}),
  };
}

/**
 * The files to attach on a form, from an application folder's file names:
 * the submit-ready copies save_resume / save_cover_letter write
 * (<Name>-<company>-resume.pdf), PDF before Word; the bare resume.pdf /
 * resume.docx masters only when no submit-ready copy exists.
 */
export function formAttachments(fileNames: string[]): { resume: string | null; cover_letter: string | null } {
  const pick = (kind: "resume" | "cover-letter") => {
    const ready = (ext: string) => fileNames.find((f) => f.endsWith(`-${kind}.${ext}`));
    return ready("pdf") ?? ready("docx") ?? fileNames.find((f) => f === `${kind}.pdf`) ?? fileNames.find((f) => f === `${kind}.docx`) ?? null;
  };
  return { resume: pick("resume"), cover_letter: pick("cover-letter") };
}

// --- Field-mapping helpers (extracted from the map route for testability, REQ-18) ---

export interface MapField {
  id: string;
  label: string;
  type: "text" | "select" | "combobox" | "radio" | "toggle";
  options?: string[];
}

/** A page's fields, bounded: at most 120 fields, 200 options each, 500 characters a string. */
export function capFields(raw: unknown[]): MapField[] {
  const str = (v: unknown) => String(v ?? "").slice(0, 500);
  return raw.slice(0, 120).flatMap((f) => {
    if (!f || typeof f !== "object") return [];
    const o = f as Record<string, unknown>;
    const type = ["text", "select", "combobox", "radio", "toggle"].includes(String(o.type)) ? (o.type as MapField["type"]) : "text";
    return [{ id: str(o.id), label: str(o.label), type, ...(Array.isArray(o.options) ? { options: o.options.slice(0, 200).map(str) } : {}) }];
  });
}

export interface FieldMapping {
  id: string;
  value: string;
}

/** Pull the first JSON array out of model output (fenced, prose-wrapped, or bare). */
export function extractMappingArray(text: string): FieldMapping[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m) => m && typeof m.id === "string" && m.value != null)
      .map((m) => ({ id: String(m.id), value: String(m.value) }));
  } catch {
    return [];
  }
}

/**
 * Mechanical guard on model mappings: only ids that were actually sent, and for
 * choice fields only values copied VERBATIM from that field's options — a
 * hallucinated option must never be clicked into a form.
 */
export function filterSafeMappings(fields: MapField[], mappings: FieldMapping[]): FieldMapping[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return mappings.filter((m) => {
    const f = byId.get(m.id);
    if (!f) return false;
    if (f.options && f.options.length) return f.options.some((o) => o === m.value);
    return true;
  });
}
