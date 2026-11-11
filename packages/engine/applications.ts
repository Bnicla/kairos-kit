import type { Store } from "@kairos/engine/store/types";

/**
 * Per-job application zone. Each application is a self-contained folder under
 * `Kairos/applications/YYYY-MM-DD_company_role-slug/`. The root `_index.json` is
 * the lightweight cross-application index the dashboard reads (never re-scanning
 * every folder).
 */

export type ApplicationStatus =
  | "captured" // ad snapshotted at share time (§26)
  | "scored" // three-axis scorecard produced
  | "drafted" // resume generated
  | "applied"
  | "interviewing"
  | "offer"
  | "rejected"
  | "withdrawn"
  | "expired"
  | "on_hold"; // role paused by the company (reorg, freeze) — not a rejection; keep-warm

/**
 * SINGLE source of truth for how each status is presented and grouped.
 * The pipeline board's stages, badge labels, and badge tones all derive from
 * this map — adding a status here is the only step; nothing else to update.
 */
export const STATUS_META: Record<
  ApplicationStatus,
  { label: string; tone: "neutral" | "info" | "warn" | "success" | "danger"; stage: "draft" | "applied" | "ongoing" | "closed" }
> = {
  captured: { label: "Captured", tone: "neutral", stage: "draft" },
  scored: { label: "Scored", tone: "neutral", stage: "draft" },
  drafted: { label: "Drafted", tone: "neutral", stage: "draft" },
  applied: { label: "Applied", tone: "info", stage: "applied" },
  interviewing: { label: "Interviewing", tone: "warn", stage: "ongoing" },
  offer: { label: "Offer", tone: "success", stage: "ongoing" },
  rejected: { label: "Rejected", tone: "danger", stage: "closed" },
  withdrawn: { label: "Withdrawn", tone: "neutral", stage: "closed" },
  expired: { label: "Listing closed", tone: "neutral", stage: "closed" },
  on_hold: { label: "On hold", tone: "warn", stage: "closed" },
};

export const ALL_STATUSES = Object.keys(STATUS_META) as ApplicationStatus[];

export interface ApplicationMeta {
  id: string; // folder name
  company: string;
  role: string;
  status: ApplicationStatus;
  source_url?: string;
  req_id?: string;
  location?: string;
  detected_ats?: string;
  captured_at: string;
  updated_at: string;
  applied_at?: string;
  /** Every status change, timestamped — the application's timeline. */
  status_history?: { status: ApplicationStatus; at: string; note?: string }[];
  /** Filename (in the app folder) of the resume actually sent off-platform. */
  submitted_file?: string;
  docs_sent?: string[];
  score_band?: string; // e.g. "COMPETITIVE"
  score_confidence?: string;
  recommendation?: string;
  notes?: string;
  /** Hidden from the default board view (closed apps the user filed away). */
  archived?: boolean;
  /** Highest interview round reached (1 recruiter screen, 2 hiring manager, 3 on-site). Feeds the funnel chart;
   *  status history cannot say how many rounds an "interviewing" spell covered. */
  interview_round?: number;
  /** Track (direction) this application belongs to, `tracks/<id>.json`. Absent means the main track. */
  track?: string;
}

export interface IndexEntry {
  id: string;
  company: string;
  role: string;
  status: ApplicationStatus;
  captured_at: string;
  updated_at: string;
  applied_at?: string;
  score_band?: string;
  recommendation?: string;
  archived?: boolean;
  track?: string;
}

export interface AppIndex {
  version: 1;
  applications: IndexEntry[];
}

const APPLICATIONS = "applications";
const INDEX_PATH = ["_index.json"];

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function applicationFolderName(
  company: string,
  role: string,
  date = new Date().toISOString().slice(0, 10),
): string {
  return `${date}_${slugify(company)}_${slugify(role)}`;
}

// Index --------------------------------------------------------------------

export async function loadIndex(store: Store): Promise<AppIndex> {
  return (await store.readJson<AppIndex>(INDEX_PATH)) ?? { version: 1 as const, applications: [] };
}

/**
 * Read the index, self-healing dropped entries. The index is a derived cache
 * over the application folders, and cross-process write races (serverless!)
 * can drop entries. The folders are the source of truth; when they OUTNUMBER
 * the index entries, rebuild from the folder metas. Never shrinks the index —
 * folder listings can lag behind a just-created application (cloud caches
 * them briefly), so a shorter listing must not delete fresh entries.
 * Use on read/display paths only; the write path stays on plain loadIndex.
 */
export async function loadIndexHealed(store: Store): Promise<AppIndex> {
  const idx = await loadIndex(store);
  const folders = await listApplicationFolders(store);
  if (folders.length > idx.applications.length) {
    return rebuildApplicationsIndex(store, folders);
  }
  return idx;
}

/** Rebuild applications/_index.json from the folder metas (source of truth). */
export async function rebuildApplicationsIndex(
  store: Store,
  folderNames?: string[],
): Promise<AppIndex> {
  const folders = folderNames ?? (await listApplicationFolders(store));
  const metas = await Promise.all(folders.map((id) => readMeta(store, id).catch(() => null)));
  const applications = metas
    .filter((m): m is ApplicationMeta => m !== null)
    .map(toIndexEntry)
    .sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  const idx: AppIndex = { version: 1, applications };
  await store.writeJson(INDEX_PATH, idx);
  return idx;
}

// The index is read-modify-write; two concurrent writers (MCP server tool call
// + a dashboard server action) would clobber each other's entry. Serialize all
// index mutations through one in-process promise chain. (Cross-PROCESS races
// remain possible but are rare; `rebuild` from folders is the recovery path.)
let indexLock: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexLock.then(fn, fn);
  indexLock = run.catch(() => {});
  return run;
}

export function upsertIndexEntry(
  store: Store,
  entry: IndexEntry,
): Promise<void> {
  return withIndexLock(async () => {
    const idx = await loadIndex(store);
    const i = idx.applications.findIndex((a) => a.id === entry.id);
    if (i === -1) idx.applications.unshift(entry);
    else idx.applications[i] = { ...idx.applications[i], ...entry };
    idx.applications.sort((a, b) => b.captured_at.localeCompare(a.captured_at));
    await store.writeJson(INDEX_PATH, idx);
  });
}

/** Drop an application from the index (after its folder is purged). */
export function removeIndexEntry(store: Store, id: string): Promise<void> {
  return withIndexLock(async () => {
    const idx = await loadIndex(store);
    idx.applications = idx.applications.filter((a) => a.id !== id);
    await store.writeJson(INDEX_PATH, idx);
  });
}

// Application CRUD ---------------------------------------------------------

export async function createApplication(
  store: Store,
  input: {
    company: string;
    role: string;
    snapshotMarkdown: string;
    source_url?: string;
    /**
     * Every card must link back to its posting (the board renders it, and a
     * card with no link has repeatedly meant a driver forgot to pass the URL
     * on a paste-capture). Creating without a source_url therefore throws
     * unless the caller explicitly declares the ad has no public URL
     * (an emailed JD, a fixture).
     */
    source_url_unavailable?: boolean;
    req_id?: string;
    location?: string;
    detected_ats?: string;
  },
): Promise<ApplicationMeta> {
  if (!input.source_url?.trim() && !input.source_url_unavailable) {
    throw new Error(
      `Refusing to create application for ${input.company} without a source_url. ` +
        "Pass the posting URL (also alongside pasted text), or set source_url_unavailable: true for an ad with no public URL.",
    );
  }
  const now = new Date().toISOString();
  const id = applicationFolderName(input.company, input.role);
  const folder = [APPLICATIONS, id];

  // §26: capture the snapshot FIRST, before anything else can fail.
  await store.writeFile([...folder, "job-ad-snapshot.md"], input.snapshotMarkdown);

  const meta: ApplicationMeta = {
    id,
    company: input.company,
    role: input.role,
    status: "captured",
    source_url: input.source_url?.trim() || undefined,
    req_id: input.req_id,
    location: input.location,
    detected_ats: input.detected_ats,
    captured_at: now,
    updated_at: now,
    status_history: [{ status: "captured", at: now }],
  };
  await store.writeJson([...folder, "application-meta.json"], meta);
  await upsertIndexEntry(store, toIndexEntry(meta));
  return meta;
}

export async function readMeta(
  store: Store,
  appId: string,
): Promise<ApplicationMeta | null> {
  return store.readJson<ApplicationMeta>([
    APPLICATIONS,
    appId,
    "application-meta.json",
  ]);
}

export async function updateMeta(
  store: Store,
  appId: string,
  patch: Partial<ApplicationMeta>,
  opts?: { statusNote?: string },
): Promise<ApplicationMeta> {
  const current = await readMeta(store, appId);
  if (!current) throw new Error(`Application not found: ${appId}`);
  const now = new Date().toISOString();
  const next: ApplicationMeta = {
    ...current,
    ...patch,
    updated_at: now,
  };
  // Append to the timeline whenever the status actually changes.
  const history = current.status_history ?? [{ status: current.status, at: current.captured_at }];
  if (patch.status && patch.status !== current.status) {
    next.status_history = [
      ...history,
      { status: patch.status, at: now, ...(opts?.statusNote ? { note: opts.statusNote } : {}) },
    ];
  } else if (opts?.statusNote) {
    // A note with no status change is still an event (an interview booked while
    // already "interviewing"). It used to be dropped silently (2026-10-11: the
    // interview time never reached the card).
    next.status_history = [...history, { status: current.status, at: now, note: opts.statusNote }];
  } else {
    next.status_history = history;
  }
  await store.writeJson([APPLICATIONS, appId, "application-meta.json"], next);
  await upsertIndexEntry(store, toIndexEntry(next));
  return next;
}

export const readSnapshot = (s: Store, appId: string) =>
  s.readFile([APPLICATIONS, appId, "job-ad-snapshot.md"]);

export const saveScoreReport = (s: Store, appId: string, report: unknown) =>
  s.writeJson([APPLICATIONS, appId, "score-report.json"], report);

export const readScoreReport = <T>(s: Store, appId: string) =>
  s.readJson<T>([APPLICATIONS, appId, "score-report.json"]);

// Versioned scores — e.g. "Default résumé" (untailored) vs "Optimized résumé"
// (tailored), so the dashboard can show the before/after delta.
export interface ScoreVersion<T = unknown> {
  label: string;
  at: string;
  report: T;
}

export async function appendScoreVersion(
  s: Store,
  appId: string,
  label: string,
  report: unknown,
): Promise<void> {
  const hist =
    (await s.readJson<{ versions: ScoreVersion[] }>([APPLICATIONS, appId, "score.json"])) ?? { versions: [] };
  hist.versions.push({ label, at: new Date().toISOString(), report });
  await s.writeJson([APPLICATIONS, appId, "score.json"], hist);
  await s.writeJson([APPLICATIONS, appId, "score-report.json"], report); // latest, for compat
}

export async function readScoreVersions<T>(s: Store, appId: string): Promise<ScoreVersion<T>[]> {
  const hist = await s.readJson<{ versions: ScoreVersion<T>[] }>([APPLICATIONS, appId, "score.json"]);
  return hist?.versions ?? [];
}

export const saveResumeSource = (s: Store, appId: string, md: string) =>
  s.writeFile([APPLICATIONS, appId, "resume-source.md"], md);

export const readResumeSource = (s: Store, appId: string) =>
  s.readFile([APPLICATIONS, appId, "resume-source.md"]);

export const saveConversation = (s: Store, appId: string, convo: unknown) =>
  s.writeJson([APPLICATIONS, appId, "conversation.json"], convo);

export const readConversation = <T>(s: Store, appId: string) =>
  s.readJson<T>([APPLICATIONS, appId, "conversation.json"]);

/** List applications from the folder zone (fallback if index is missing). */
export async function listApplicationFolders(store: Store): Promise<string[]> {
  const folders = await store.listFolders([APPLICATIONS]);
  return folders.map((f) => f.name);
}

function toIndexEntry(meta: ApplicationMeta): IndexEntry {
  return {
    id: meta.id,
    company: meta.company,
    role: meta.role,
    status: meta.status,
    captured_at: meta.captured_at,
    updated_at: meta.updated_at,
    applied_at: meta.applied_at,
    score_band: meta.score_band,
    recommendation: meta.recommendation,
    archived: meta.archived,
    ...(meta.track ? { track: meta.track } : {}),
  };
}
