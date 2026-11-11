/**
 * Application-form harvesting (spec: application packet v1).
 *
 * The same public Greenhouse endpoint used for sourcing also serves the
 * application form's question schema (`?questions=true`). Fetching it at
 * capture time means every question the form will ask is known BEFORE any
 * tailoring work: answers can be drafted up front (qa-bank first) and the
 * detail page becomes an apply checklist instead of the form ambushing the
 * candidate mid-application.
 *
 * Greenhouse only for v1. Lever/Ashby have similar schema endpoints — same
 * normalized shape when they land.
 */

import type { Store } from "@kairos/engine/store/types";

export type FormQuestionKind =
  | "text"
  | "essay"
  | "select"
  | "multi_select"
  | "file"
  | "unknown";

export interface FormQuestion {
  label: string;
  required: boolean;
  kind: FormQuestionKind;
  /** True for company-authored questions (vs standard contact/resume fields). */
  custom: boolean;
  options?: string[];
}

export interface ApplicationForm {
  source: "greenhouse";
  board: string;
  job_id: string;
  fetched_at: string;
  questions: FormQuestion[];
  /** EEOC / demographic / compliance sections present (never drafted for). */
  has_demographic_section: boolean;
  has_compliance_section: boolean;
}

export interface FormSummary {
  custom_questions: number;
  writing_questions: number;
  needs_cover_letter: boolean;
}

// -- URL parsing --------------------------------------------------------------

const GH_PATTERNS: RegExp[] = [
  // https://job-boards.greenhouse.io/{board}/jobs/{id}, https://boards.greenhouse.io/...
  /(?:job-boards|boards)(\.eu)?\.greenhouse\.io\/([A-Za-z0-9_-]+)\/jobs\/(\d+)/,
  // https://boards.greenhouse.io/embed/job_app?for={board}&token={id}
  /(\.eu)?greenhouse\.io\/embed\/job_app\?[^#]*for=([A-Za-z0-9_-]+)[^#]*token=(\d+)/,
];

export function parseGreenhouseUrl(
  url: string | null | undefined,
): { board: string; jobId: string; eu: boolean } | null {
  if (!url) return null;
  for (const re of GH_PATTERNS) {
    const m = url.match(re);
    if (m) return { eu: !!m[1], board: m[2].toLowerCase(), jobId: m[3] };
  }
  return null;
}

// -- Fetch + normalize --------------------------------------------------------

interface GhField {
  name?: string;
  type?: string;
  values?: { label?: string }[];
}
interface GhQuestion {
  label?: string;
  required?: boolean;
  fields?: GhField[];
}
interface GhJobWithQuestions {
  questions?: GhQuestion[];
  location_questions?: GhQuestion[];
  demographic_questions?: unknown;
  compliance?: unknown[];
}

const KIND_BY_TYPE: Record<string, FormQuestionKind> = {
  input_text: "text",
  textarea: "essay",
  input_file: "file",
  multi_value_single_select: "select",
  multi_value_multi_select: "multi_select",
};

/** Standard Greenhouse field names — everything else is a company question. */
const STANDARD_FIELDS = new Set([
  "first_name", "last_name", "email", "phone", "location", "resume",
  "resume_text", "cover_letter", "cover_letter_text",
]);

export function normalizeGreenhouseForm(
  raw: unknown,
  ref: { board: string; jobId: string },
  now: () => string = () => new Date().toISOString(),
): ApplicationForm | null {
  const job = raw as GhJobWithQuestions | null;
  if (!job || !Array.isArray(job.questions)) return null;
  const questions: FormQuestion[] = [];
  for (const q of [...job.questions, ...(job.location_questions ?? [])]) {
    const field = q.fields?.[0];
    if (!q.label || !field || field.type === "input_hidden") continue;
    const kind = KIND_BY_TYPE[field.type ?? ""] ?? "unknown";
    const options = field.values?.map((v) => v.label ?? "").filter(Boolean);
    questions.push({
      label: q.label.trim(),
      required: q.required !== false,
      kind,
      custom: !STANDARD_FIELDS.has(field.name ?? ""),
      ...(options && options.length > 0 && options.length <= 30 ? { options } : {}),
    });
  }
  return {
    source: "greenhouse",
    board: ref.board,
    job_id: ref.jobId,
    fetched_at: now(),
    questions,
    has_demographic_section: !!job.demographic_questions,
    has_compliance_section: Array.isArray(job.compliance) && job.compliance.length > 0,
  };
}

export async function fetchGreenhouseForm(url: string): Promise<ApplicationForm | null> {
  const ref = parseGreenhouseUrl(url);
  if (!ref) return null;
  const api = ref.eu ? "boards-api.eu.greenhouse.io" : "boards-api.greenhouse.io";
  try {
    const res = await fetch(
      `https://${api}/v1/boards/${ref.board}/jobs/${ref.jobId}?questions=true`,
      {
        signal: AbortSignal.timeout(12_000),
        headers: { accept: "application/json", "user-agent": "kairos-forms/1.0" },
      },
    );
    if (!res.ok) return null;
    return normalizeGreenhouseForm(await res.json(), ref);
  } catch {
    return null;
  }
}

/**
 * Custom fields that are contact/identity housekeeping, not writing prompts:
 * the user fills these in seconds and no draft should be offered for them.
 */
const HOUSEKEEPING_RE =
  /linkedin|github|twitter|portfolio|website|other links|current company|current or last|most recent\)? company|preferred name|legal name|pronunciation|pronouns|salary|compensation|how did you|learned about|referr|start date|notice period|address|\bcity\b|zip|postal|country|street|suite|apt\b|residence|reside|current title|job title|relative|certification|license|conflicts? of interest|restriction|support is needed|visa|sponsorship|authoriz/i;

/** True when a form question needs actual writing (drafted via qa-bank/Workflow F). */
export function isWritingQuestion(q: FormQuestion): boolean {
  if (!q.custom || (q.kind !== "essay" && q.kind !== "text")) return false;
  return !HOUSEKEEPING_RE.test(q.label);
}

export function formSummary(form: ApplicationForm): FormSummary {
  const custom = form.questions.filter((q) => q.custom);
  return {
    custom_questions: custom.length,
    writing_questions: custom.filter(isWritingQuestion).length,
    needs_cover_letter: form.questions.some(
      (q) => q.required && /cover.letter/i.test(q.label),
    ),
  };
}

// -- Storage convention -------------------------------------------------------

const APPLICATIONS = "applications";

export const saveApplicationForm = (s: Store, appId: string, form: ApplicationForm) =>
  s.writeJson([APPLICATIONS, appId, "application-form.json"], form);

export const readApplicationForm = (s: Store, appId: string) =>
  s.readJson<ApplicationForm>([APPLICATIONS, appId, "application-form.json"]);
