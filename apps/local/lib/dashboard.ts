import matter from "gray-matter";
import { renderSafeMarkdown } from "@/lib/safe-markdown";
import { getStore, kairosHome } from "@/store";
import { backlogBuckets, type BacklogEntry } from "@kairos/engine/sourcing/backlog";
import {
  loadIndexHealed,
  readMeta,
  readScoreReport,
  readScoreVersions,
  readSnapshot,
  readResumeSource,
  listApplicationFolders,
  type IndexEntry,
  type ApplicationMeta,
  type ScoreVersion,
} from "@kairos/engine/applications";
import { loadExperiences, loadVoiceProfile } from "@kairos/engine/kb/store";
import { readApplicationForm, type ApplicationForm } from "@kairos/engine/forms";
import { computeHealth, type HealthReport } from "@kairos/engine/health";
import type { GeneratedResume, RequirementCoverageRow, ScoreReport } from "@kairos/engine/types";
import { buildDaily, buildFunnel, type DailyApplications, type Funnel } from "@kairos/engine/funnel";
import { maxSourcedCards, readProfileSettings, storiesMapPath } from "@kairos/engine/settings";
import type { SearchProfile } from "@kairos/engine/sourcing/types";

/**
 * Server-side read layer for the local dashboard. Everything comes from the same
 * ~/Kairos/ files the MCP server writes — the dashboard never mutates, it renders.
 */

/** Index entry + which documents exist (drives the Draft-card generate buttons). */
export type BoardEntry = IndexEntry & { has_resume?: boolean };

export interface DashboardData {
  applications: BoardEntry[];
  experiences: { fileName: string; company: string; title: string; dates: string; domains: string[] }[];
  profile: { name?: string; headline?: string; contact_line?: string; target_roles?: string[] };
  insightsHtml: string | null;
  home: string;
}

export interface SourcedPosting {
  company: string;
  title: string;
  url: string;
  location: string;
  age_days: number | null;
  location_fit: "match" | "stretch";
  reasons: string[];
  guess_band?: "STRONG" | "COMPETITIVE" | "DEVELOPING" | "WEAK";
  one_liner?: string;
  /** Present only on `dropped`: why the role was cut before the board. */
  drop_reason?: "over_cap" | "triage_cut" | "same_company" | "below_cut";
  /** Set by Track/Dismiss actions on the last-run entry. */
  captured?: boolean;
  dismissed?: boolean;
}

/** Ledger headline row (new-since-last-run / vanished-shortlisted alerts). */
export interface SourcedAlert {
  url: string;
  company: string;
  title: string;
  location?: string;
  last_seen?: string;
  disposition?: string;
}

export interface SourcedRun {
  /** "daily" or "deep"; absent on files predating the deep-scan lane. */
  mode?: "daily" | "deep";
  ran_at: string;
  boards_swept: number;
  postings_fetched: number;
  /** Did the model triage run? false = deterministic UNRANKED fallback. */
  triaged?: boolean;
  /** Non-null when triage failed (e.g. expired CLI auth) — surface as a warning. */
  triage_error?: string | null;
  /** Board fetch accounting; warn when failures are material (REQ-6). */
  fetch_stats?: {
    boards_ok: number;
    boards_gone: number;
    boards_failed: number;
    rate_limited: number;
    failures_by_ats: Record<string, number>;
  };
  survivors: SourcedPosting[];
  stretch: SourcedPosting[];
  /** Priority shapes cut UNREVIEWED by the triage input cap — shown loud. */
  also_qualified?: SourcedPosting[];
  /** Prefilter survivors that did not reach the board (view-all page). */
  dropped?: SourcedPosting[];
  /** Roles the seen-ledger had never recorded before this run. */
  new_since_last_run?: SourcedAlert[];
  /** Previously shortlisted roles that left the board un-actioned this run. */
  vanished_shortlisted?: SourcedAlert[];
}

/** The board column's sourced-card cap from search-profile.json (default 10). */
export async function getMaxSourcedCards(): Promise<number> {
  const profile = await getStore().readJson<Pick<SearchProfile, "board">>(["sourcing", "search-profile.json"]);
  return maxSourcedCards(profile);
}

/** Latest sourcing run for the Sourced column; null before the first run. */
export async function getSourcedRun(): Promise<SourcedRun | null> {
  const store = getStore();
  const run = await store.readJson<SourcedRun>(["sourcing", "last-run.json"]);
  if (!run) return null;
  // The Sourced column shows the persistent backlog (this run's cards plus
  // un-actioned cards carried from earlier runs), not just the latest run —
  // otherwise triage churn silently deletes roles the user never saw.
  const backlog = await store.readJson<BacklogEntry[]>(["sourcing", "backlog.json"]);
  if (!backlog?.length) return run;
  const seen = (await store.readJson<Record<string, string>>(["sourcing", "seen.json"])) ?? {};
  const live = backlog.filter((b) => !seen[b.url.split("?")[0]]);
  const { matches, stretch } = backlogBuckets(live);
  return { ...run, survivors: matches, stretch };
}

/**
 * Latest weekly deep scan (no recency cap; age ranked, not gated), for the
 * All-sourced page. Cards the user already tracked/dismissed are hidden the
 * same way the daily lane hides them (dismissals land in seen.json).
 */
export async function getDeepScan(): Promise<SourcedRun | null> {
  const store = getStore();
  const run = await store.readJson<SourcedRun>(["sourcing", "deep-scan.json"]);
  if (!run) return null;
  const seen = (await store.readJson<Record<string, string>>(["sourcing", "seen.json"])) ?? {};
  const live = (list?: SourcedPosting[]) => (list ?? []).filter((s) => !seen[s.url.split("?")[0]]);
  return {
    ...run,
    survivors: live(run.survivors),
    stretch: live(run.stretch),
    also_qualified: live(run.also_qualified),
    dropped: live(run.dropped),
  };
}

export async function getDashboard(): Promise<DashboardData> {
  const store = getStore();
  const [index, experiences, profileRaw, insightsMd] = await Promise.all([
    loadIndexHealed(store),
    loadExperiences(store),
    store.readFile(["profile.md"]),
    store.readFile(["insights.md"]),
  ]);
  const profile = profileRaw ? (matter(profileRaw).data as DashboardData["profile"]) : {};
  // Board cards show generate buttons for missing documents; one listFiles per
  // open app (local fs, cheap). Closed/archived apps don't need the flags.
  const applications: BoardEntry[] = await Promise.all(
    index.applications.map(async (a) => {
      if (["rejected", "withdrawn", "expired"].includes(a.status) || a.archived) return a;
      const files = await store.listFiles(["applications", a.id]).catch(() => []);
      const names = new Set(files.map((f) => f.name));
      return { ...a, has_resume: names.has("resume.docx") };
    }),
  );
  return {
    applications,
    experiences: experiences.map((e) => ({
      fileName: e.fileName,
      company: e.frontmatter.company,
      title: e.frontmatter.title,
      dates: `${e.frontmatter.start} – ${e.frontmatter.end}`,
      domains: e.frontmatter.domains ?? [],
    })),
    profile,
    insightsHtml: insightsMd ? (renderSafeMarkdown(insightsMd)) : null,
    home: kairosHome(),
  };
}

export interface ApplicationQuestion {
  question: string;
  answer: string;
}

export interface ApplicationDetail {
  meta: ApplicationMeta;
  report: ScoreReport | null;
  jobText: string | null;
  resumeHtml: string | null;
  coverLetterHtml: string | null;
  questions: ApplicationQuestion[];
  form: ApplicationForm | null;
  /** Last one-click generation failure, shown until the next successful run. */
  generationError: string | null;
  scoreVersions: ScoreVersion<ScoreReport>[];
  downloads: { resumeDocx: boolean; resumePdf: boolean; coverLetterDocx: boolean; submitted: string | null };
  /** Prep notes in the application folder: markdown briefs and .html glance cards, file names. */
  prepNotes: string[];
  /** The résumé's requirements coverage table (resume.json); null when absent (older résumés). */
  requirementCoverage: RequirementCoverageRow[] | null;
}

// Markdown files in an application folder that already have their own view.
const NOT_PREP_NOTES = new Set(["resume-source.md", "cover-letter.md", "job-ad-snapshot.md"]);
const NOTE_NAME = /^[\w.-]+\.md$/;
const GLANCE_NAME = /^[\w.-]+\.html$/;

async function listPrepNotes(store: ReturnType<typeof getStore>, id: string): Promise<string[]> {
  const files = await store.listFiles(["applications", id]);
  return files
    .map((f) => f.name)
    .filter((n) => (NOTE_NAME.test(n) && !NOT_PREP_NOTES.has(n)) || GLANCE_NAME.test(n))
    .sort();
}

/** One prep note rendered to HTML, with the provenance tags ([C], [?], [K], [rev]) made visible. */
export async function getPrepNote(id: string, file: string): Promise<{ meta: ApplicationMeta; html: string } | null> {
  if (!NOTE_NAME.test(file) || NOT_PREP_NOTES.has(file)) return null;
  const store = getStore();
  const meta = await readMeta(store, id);
  if (!meta) return null;
  const raw = await store.readFile(["applications", id, file]);
  if (raw === null) return null;
  const html = renderSafeMarkdown(raw).replace(
    /\[(C|\?|K|rev)\]/g,
    (_, tag: string) => `<span class="prov prov-${tag === "?" ? "q" : tag.toLowerCase()}">${tag}</span>`,
  );
  return { meta, html };
}

export async function getApplication(id: string): Promise<ApplicationDetail | null> {
  const store = getStore();
  const meta = await readMeta(store, id);
  if (!meta) return null;
  const base = ["applications", id];
  const [report, versions, snapshot, resumeMd, coverMd, questionsJson, form, genError, resumeDocx, resumePdf, coverDocx, prepNotes, resumeJson] =
    await Promise.all([
      readScoreReport<ScoreReport>(store, id),
      readScoreVersions<ScoreReport>(store, id),
      readSnapshot(store, id),
      readResumeSource(store, id),
      store.readFile([...base, "cover-letter.md"]),
      store.readJson<ApplicationQuestion[]>([...base, "questions.json"]),
      readApplicationForm(store, id),
      store.readFile([...base, "generation-error.txt"]),
      store.readBinary([...base, "resume.docx"]),
      store.readBinary([...base, "resume.pdf"]),
      store.readBinary([...base, "cover-letter.docx"]),
      listPrepNotes(store, id),
      // Advisory section only: a corrupt resume.json must not take the page down.
      store.readJson<GeneratedResume>([...base, "resume.json"]).catch(() => null),
    ]);
  return {
    meta,
    report: versions.length ? versions[versions.length - 1].report : report,
    scoreVersions: versions,
    jobText: snapshot ? matter(snapshot).content.trim() : null,
    resumeHtml: resumeMd ? resumeMarkdownToHtml(resumeMd) : null,
    // breaks:true so the letterhead (name / contact) keeps its line breaks on screen.
    coverLetterHtml: coverMd ? (renderSafeMarkdown(coverMd, { breaks: true })) : null,
    questions: questionsJson ?? [],
    form,
    generationError: genError?.trim() ? genError.trim() : null,
    downloads: {
      resumeDocx: resumeDocx !== null,
      resumePdf: resumePdf !== null,
      coverLetterDocx: coverDocx !== null,
      submitted: meta.submitted_file ?? null,
    },
    prepNotes,
    requirementCoverage: readRequirementCoverage(resumeJson),
  };
}

const COVERAGE_STATUSES = new Set(["covered", "partial", "gap"]);

/** The coverage rows from resume.json, tolerating older or hand-edited files: malformed rows are skipped. */
function readRequirementCoverage(gen: GeneratedResume | null): RequirementCoverageRow[] | null {
  const rows = gen?.requirement_coverage;
  if (!Array.isArray(rows)) return null;
  const valid = rows.filter(
    (r): r is RequirementCoverageRow =>
      !!r && typeof r.requirement === "string" && COVERAGE_STATUSES.has(r.status as string),
  );
  return valid.length ? valid : null;
}

// --- Knowledge base viewer -------------------------------------------------

export type KBDepth = "résumé-only" | "developing" | "rich";

export interface KBExperience {
  fileName: string;
  company: string;
  title: string;
  dates: string;
  location?: string;
  seniority?: string;
  domains: string[];
  scope: { key: string; value: string; prov: string }[];
  skills: { name: string; proficiency: string; recency: string; prov: string }[];
  bodyHtml: string;
  confirmedCount: number;
  depth: KBDepth;
}
export interface KBEducation {
  fileName: string;
  institution: string;
  credential: string;
  dates?: string;
  bodyHtml: string;
}
export interface KnowledgeBase {
  experiences: KBExperience[];
  education: KBEducation[];
  voiceProfileHtml: string | null;
}

/** How far beyond the résumé a role has been enriched — counts confirmed [C] facts. */
function depthOf(body: string): { confirmedCount: number; depth: KBDepth } {
  const confirmedCount = (body.match(/\[C\]/g) ?? []).length;
  const depth: KBDepth = confirmedCount === 0 ? "résumé-only" : confirmedCount < 4 ? "developing" : "rich";
  return { confirmedCount, depth };
}

/** Render KB markdown, turning [R]/[C]/[F] provenance tags into colored markers. */
function renderKbBody(md: string): string {
  const html = renderSafeMarkdown(md);
  return html.replace(/\[(R|C|F)\]/g, (_m, p) => `<sup class="prov prov-${p}">[${p}]</sup>`);
}

export interface StarStoryMetrics {
  /** Signals that surfaced or prioritized the problem. */
  identify?: string[];
  /** How success was measured, with the number where one is on record. */
  success?: string[];
  /** anchored: both sides on record; partial: one side or a caveated number; gap: neither. */
  status?: "anchored" | "partial" | "gap";
  /** Metrics-register entries the numbers come from. */
  register?: string[];
  /** The question to answer to close a partial or gap. */
  gap?: string;
}
/** One-glance version of a story for live calls. Strings allow **bold** and a ≈ marker
 *  (reconstructed detail: say "roughly", never quote as exact). */
export interface StarStoryGlance {
  /** The concrete instance: test question, bad answer, what the trace showed. */
  example?: string[];
  /** 3–5 boxes: problem, what was tried, the decision, the result. One is final. */
  steps: { h: string; text: string; final?: boolean }[];
  /** One plain sentence to say aloud. */
  say?: string;
  /** Caveats, boundaries, "if asked" answers. */
  notes?: string[];
}
export interface StarStory {
  story: string;
  source: string;
  s: string;
  t: string;
  a: string;
  r: string;
  metrics?: StarStoryMetrics;
  glance?: StarStoryGlance;
}
export interface StarTheme {
  theme: string;
  stories: StarStory[];
}
export interface StarStories {
  updated_at?: string;
  themes: StarTheme[];
}

/** STAR story repository: curated behavioral-interview stories grounded in the KB. */
export async function getStarStories(): Promise<StarStories | null> {
  const store = getStore();
  const data = await store.readJson<StarStories>(["knowledge-base", "star-stories.json"]);
  if (!data || !Array.isArray(data.themes)) return null;
  return data;
}

export async function getHealth(): Promise<HealthReport> {
  const store = getStore();
  const [experiences, profileRaw] = await Promise.all([loadExperiences(store), store.readFile(["profile.md"])]);
  const profile = profileRaw ? (matter(profileRaw).data as Record<string, unknown>) : {};
  return computeHealth(experiences, {
    contactLine: typeof profile.contact_line === "string" ? profile.contact_line : undefined,
    headline: typeof profile.headline === "string" ? profile.headline : undefined,
  });
}

export async function getKnowledgeBase(): Promise<KnowledgeBase> {
  const store = getStore();
  const [experiences, voice, eduFiles] = await Promise.all([
    loadExperiences(store),
    loadVoiceProfile(store),
    store.listFiles(["knowledge-base", "education"]),
  ]);

  const education: KBEducation[] = [];
  for (const f of eduFiles.filter((x) => x.name.endsWith(".md"))) {
    const raw = await store.readFile(["knowledge-base", "education", f.name]);
    if (!raw) continue;
    const p = matter(raw);
    education.push({
      fileName: f.name,
      institution: String(p.data.institution ?? f.name),
      credential: String(p.data.credential ?? ""),
      dates: p.data.dates ? String(p.data.dates) : undefined,
      bodyHtml: renderKbBody(p.content.trim()),
    });
  }

  return {
    experiences: experiences.map((e) => ({
      fileName: e.fileName,
      company: e.frontmatter.company,
      title: e.frontmatter.title,
      dates: `${e.frontmatter.start} – ${e.frontmatter.end}`,
      location: e.frontmatter.location,
      seniority: e.frontmatter.seniority_level,
      domains: e.frontmatter.domains ?? [],
      scope: Object.entries(e.frontmatter.scope ?? {}).map(([key, v]) => ({ key, value: v.value, prov: v.prov })),
      skills: (e.frontmatter.skills ?? []).map((s) => ({ name: s.name, proficiency: s.proficiency, recency: s.recency, prov: s.prov })),
      bodyHtml: renderKbBody(e.body),
      ...depthOf(e.body),
    })),
    education,
    voiceProfileHtml: voice ? (renderSafeMarkdown(voice)) : null,
  };
}

/** Render resume-source.md into the on-screen "paper" HTML, matching the docx:
 *  "### Company | Location" and "#### Role | Dates" become right-aligned rows. */
function resumeMarkdownToHtml(md: string): string {
  let html = renderSafeMarkdown(md);
  html = html
    .replace(/<h1>([^<]*)<\/h1>/, (_m, n) => `<h1 class="r-name">${n}</h1>`)
    .replace(/<h3>([^|<]*?)\s*\|\s*([^<]*?)<\/h3>/g, '<div class="r-co"><span>$1</span><span>$2</span></div>')
    .replace(/<h3>([^<]*?)<\/h3>/g, '<div class="r-co"><span>$1</span></div>')
    .replace(/<h4>([^|<]*?)\s*\|\s*([^<]*?)<\/h4>/g, '<div class="r-role"><span>$1</span><span>$2</span></div>')
    .replace(/<h4>([^<]*?)<\/h4>/g, '<div class="r-role"><span>$1</span></div>');
  return html;
}

// ---------------------------------------------------------------------------
// Knowledge-base space: metrics register + deep dives

import { parseMetricsRegister, type MetricsRegisterData, type MetricStatus, type MetricEntry, type MetricSection } from "./metrics-register";
export type { MetricsRegisterData as MetricsRegister, MetricStatus, MetricEntry, MetricSection };

export interface MetricTile {
  number: string;
  label: string;
  fromTo?: string;
  how?: string;
  caveat?: string;
  status: MetricStatus;
}
export interface MetricsGlance {
  updated_at?: string;
  groups: { name: string; tiles: MetricTile[] }[];
  dontSay: string[];
}

/** One-glance tiles for live calls, curated from the register (knowledge-base/metrics-glance.json). */
export async function getMetricsGlance(): Promise<MetricsGlance | null> {
  const raw = await getStore().readFile(["knowledge-base", "metrics-glance.json"]);
  if (!raw) return null;
  return JSON.parse(raw) as MetricsGlance;
}

export async function getMetricsRegister(): Promise<MetricsRegisterData | null> {
  const store = getStore();
  const raw = await store.readFile(["knowledge-base", "metrics-register.md"]);
  if (!raw) return null;
  return parseMetricsRegister(raw);
}


export interface DeepDiveDepth {
  title: string; // KB story title the depth attaches to
  layers: string[];
}
export interface DeepDives {
  warTheme: StarTheme | null;
  depths: DeepDiveDepth[];
}

/** Deep dives: the war-story theme from the STAR repository plus the approved
 *  depth layers in the stories map (keyed to KB story titles). The map's path
 *  is profile.md `stories_map`, default knowledge-base/stories-map.json. */
export async function getDeepDives(): Promise<DeepDives> {
  const store = getStore();
  const mapPath = storiesMapPath(readProfileSettings(await store.readFile(["profile.md"])));
  const [stars, map] = await Promise.all([
    getStarStories(),
    store.readJson<{ stories?: { kb_story?: string; title?: string; depth?: string[] }[] }>(mapPath),
  ]);
  const warTheme = stars?.themes.find((t) => t.theme.startsWith("War Stories")) ?? null;
  const depths: DeepDiveDepth[] = (map?.stories ?? [])
    .filter((s) => Array.isArray(s.depth) && s.depth.length > 0)
    .map((s) => ({ title: s.kb_story || s.title || "", layers: s.depth as string[] }));
  return { warTheme, depths };
}

/** Application funnel for /funnel: recomputed from every application's meta on each load. */
export async function getFunnel(): Promise<Funnel> {
  const store = getStore();
  const ids = await listApplicationFolders(store);
  const metas = (await Promise.all(ids.map((id) => readMeta(store, id)))).filter((m): m is ApplicationMeta => !!m);
  return buildFunnel(metas);
}

export async function getDailyApplications(): Promise<DailyApplications[]> {
  const store = getStore();
  const ids = await listApplicationFolders(store);
  const metas = (await Promise.all(ids.map((id) => readMeta(store, id)))).filter((m): m is ApplicationMeta => !!m);
  return buildDaily(metas);
}

// ---------------------------------------------------------------------------
// Cross-application gap report (/gaps and the get_gap_report MCP tool)

import { buildGapReport, DEFAULT_WINDOW_DAYS, type GapInput, type GapReport } from "@kairos/engine/gaps";
export type { GapReport };

/**
 * Gaps from every scored application's latest report (the same one the
 * application page shows: last score version, else score-report.json),
 * aggregated by the engine. Archived applications are excluded there.
 */
export async function getGapReport(days: number = DEFAULT_WINDOW_DAYS): Promise<GapReport> {
  const store = getStore();
  const ids = await listApplicationFolders(store);
  const inputs = await Promise.all(
    ids.map(async (id): Promise<GapInput | null> => {
      const meta = await readMeta(store, id).catch(() => null);
      if (!meta) return null;
      const versions = await readScoreVersions<ScoreReport>(store, id).catch(() => []);
      const latest = versions.length ? versions[versions.length - 1] : null;
      const report = latest?.report ?? (await readScoreReport<ScoreReport>(store, id).catch(() => null));
      if (!report || !Array.isArray(report.gaps)) return null;
      return {
        appId: id,
        company: meta.company,
        role: meta.role,
        status: meta.status,
        archived: !!meta.archived,
        band: report.match?.overall_band ?? meta.score_band ?? null,
        scored_at: latest?.at ?? meta.captured_at,
        gaps: report.gaps,
      };
    }),
  );
  return buildGapReport(
    inputs.filter((x): x is GapInput => x !== null),
    { days },
  );
}
