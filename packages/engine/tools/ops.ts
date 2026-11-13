import matter from "gray-matter";
import { resumeLengthPolicy } from "@kairos/engine/length-policy";
import { allowedMetricStatuses, loadResumePaper, readProfileSettings } from "@kairos/engine/settings";
import type { Store } from "@kairos/engine/store/types";
import type { GeneratedResume, ScoreReport } from "@kairos/engine/types";
import { appendScoreVersion, readMeta, readSnapshot, saveResumeSource, updateMeta } from "@kairos/engine/applications";
import type { ApplicationStatus } from "@kairos/engine/applications";
import { loadEducation, loadExperiences } from "@kairos/engine/kb/store";
import { checkResumeStretch, type StretchFinding } from "@kairos/engine/stretch";
import { generatedResumeToMarkdown } from "@kairos/engine/resume-render";
import { markdownResumeToDocx, type Paper, type TemplateSpec } from "@kairos/engine/docx-render";
import { GeneratedResumeSchema, ScoreReportSchema, formatIssues } from "@kairos/engine/tools/schemas";
import {
  checkAtsCoverage,
  checkRequirementCoverage,
  ADVISORY_GROUNDING,
  checkResumeGrounding,
  checkResumePerson,
  checkStyle,
  describeMetricStatusIssues,
  isHardStyleViolation,
  registerBlockedNumbers,
  resumeClaimText,
  ungroundedNumbers,
  type AtsCoverage,
  type MetricStatusIssue,
  type RequirementCoverageSummary,
  type StyleViolation,
  resolveStylePolicy,
  type StylePolicy,
} from "@kairos/engine/tools/checks";

/**
 * The guarded high-level API — the ONLY sanctioned way to persist model-authored
 * artifacts. Both the MCP server and any operator script must call these; the
 * raw writers in lib/applications.ts are plumbing, not an API. This is where the
 * product's guarantees actually live:
 *   - runtime schema validation (zod) with actionable errors
 *   - mechanical grounding against the [?]-stripped KB (anti-fabrication, N1)
 *   - metrics-register statuses: a number the register does not allow is refused
 *   - machine-checked house style (N5) and ATS-coverage reporting
 *   - requirements coverage: covered/partial rows must quote the résumé itself
 *   - resume.json / resume-source.md / resume.docx written together (no desync)
 *   - status + band bookkeeping in one place
 */

/**
 * Bookkeeping statuses only move a card forward through the draft column.
 * Re-scoring or re-tailoring a card that is already applied or interviewing
 * must not drag it back (a CMT card in interviews was reset to "drafted" by a
 * résumé regeneration, 2026-10-23).
 */
const DRAFT_ORDER: ApplicationStatus[] = ["captured", "scored", "drafted"];
async function advanceDraftStatus(store: Store, appId: string, to: ApplicationStatus): Promise<ApplicationStatus | undefined> {
  const current = (await readMeta(store, appId))?.status;
  if (!current) return to;
  const i = DRAFT_ORDER.indexOf(current);
  return i !== -1 && i < DRAFT_ORDER.indexOf(to) ? to : undefined;
}

export async function saveScoredReport(
  store: Store,
  appId: string,
  label: string,
  report: ScoreReport,
): Promise<{ versionLabel: string }> {
  const parsed = ScoreReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(`ScoreReport failed validation: ${formatIssues(parsed.error)}`);
  }
  await appendScoreVersion(store, appId, label, report);
  const status = await advanceDraftStatus(store, appId, "scored");
  await updateMeta(store, appId, {
    ...(status ? { status } : {}),
    score_band: report.match.overall_band,
    score_confidence: report.match.confidence,
    recommendation: report.recommendation,
  });
  return { versionLabel: label };
}

export interface SaveResumeResult {
  /** Advisory findings the caller should surface (not blocking). */
  warnings: string[];
  ats: AtsCoverage;
  style: StyleViolation[];
  provenanceEntries: number;
  /** Requirements coverage counts + gap list; null when the résumé carries no requirement_coverage. */
  coverage: RequirementCoverageSummary | null;
  /** Bullets and summary sentences claiming more than the KB states (agency, scope, a number's result, a total): ask keep / soften / drop. */
  stretch: StretchFinding[];
  /** Paper the .docx was rendered on (profile.md `paper`, else by the search: see settings.resumePaper). */
  paper: Paper;
}

/** Where the metrics register lives in a data folder. */
const METRICS_REGISTER_PATH = ["knowledge-base", "metrics-register.md"];

export async function saveGeneratedResume(
  store: Store,
  appId: string,
  gen: GeneratedResume,
  opts: {
    headline?: string;
    /** Per-user design overrides (DEC-8: uploaded template, design only). */
    template?: Partial<TemplateSpec>;
    /** Escape hatch for a metric the KB genuinely holds in another wording — logs a warning instead of failing. */
    allowUngroundedMetrics?: boolean;
    /** Per-user style policy (REQ-14); defaults to the house rules. */
    stylePolicy?: StylePolicy;
  } = {},
): Promise<SaveResumeResult> {
  const parsed = GeneratedResumeSchema.safeParse(gen);
  if (!parsed.success) {
    throw new Error(`GeneratedResume failed validation: ${formatIssues(parsed.error)}`);
  }

  // Grounding (N1): employers, metrics, and provenance sources must trace to
  // verified KB evidence. Profile + education are legitimate curated sources.
  const experiences = await loadExperiences(store);
  const profileRaw = (await store.readFile(["profile.md"])) ?? "";
  const education = await loadEducation(store);
  const extraCorpus = [
    profileRaw,
    (await store.readFile(["base-resume.md"])) ?? "",
    ...education, // credentials and education entries are checked against these
  ].join("\n");
  const grounding = checkResumeGrounding(gen, experiences, extraCorpus, {
    educationRecorded: education.length > 0,
    targetCompany: (await readMeta(store, appId))?.company,
  });
  const warnings: string[] = [];
  const METRIC_KINDS = ["ungrounded_metric", "metric_source_mismatch", "ungrounded_count", "count_source_mismatch"];
  const hardGrounding = grounding.filter(
    (g) => !ADVISORY_GROUNDING.has(g.kind) && (!METRIC_KINDS.includes(g.kind) || !opts.allowUngroundedMetrics),
  );
  if (hardGrounding.length) {
    throw new Error(
      `Resume failed grounding against the knowledge base: ${hardGrounding.map((g) => `[${g.kind}] ${g.detail}`).join("; ")}`,
    );
  }
  for (const g of grounding) warnings.push(`[${g.kind}] ${g.detail}`);

  // Metrics register: a number on record can still be one the user has not
  // defended (OPEN, PARTIAL) or has withdrawn (RETIRED). With no register, or
  // for a number the register does not hold, nothing changes.
  const settings = readProfileSettings(profileRaw);
  const allowedStatuses = allowedMetricStatuses(settings);
  const blocked = registerBlockedNumbers(resumeClaimText(gen), await store.readFile(METRICS_REGISTER_PATH), allowedStatuses);
  if (blocked.length) {
    throw new Error(`Resume uses a number the metrics register does not allow: ${describeMetricStatusIssues(blocked, allowedStatuses)}`);
  }

  // Stretch (2026-11-03): ownership verbs and absolutes must be supported by a
  // verified fact of that employer. A phrasing the KB explicitly forbids blocks;
  // the rest is the candidate's call (keep / soften / drop). Since 2026-11-13
  // the same rules read the executive summary sentence by sentence, and the
  // findings include a number attached to another result, a client given as a
  // place of work and a total composed across roles.
  const stretchAll = checkResumeStretch(gen, experiences, extraCorpus, { candidateName: profileName(profileRaw) });
  const denied = stretchAll.filter((f) => f.kind === "denied");
  if (denied.length) {
    throw new Error(
      `Resume uses phrasing the knowledge base forbids: ${denied.map((f) => `[${f.company}] "${f.trigger}" in "${f.bullet}"`).join("; ")}. ` +
        `Rewrite with the knowledge base's own wording.`,
    );
  }
  const stretch = stretchAll.filter((f) => f.kind === "stretch");

  // Page-2 anchor (layout invariant): the profile can name the role that must
  // head page 2 (frontmatter `resume_page2_anchor`, matched against role
  // titles). The renderer turns the flag into a real page break, and the
  // visual layout probe verifies the break landed — so "page 2 starts with
  // the wrong section" can't recur silently. Personal data stays in ~/Kairos;
  // nothing here hard-codes a candidate's history.
  const anchor = readPage2Anchor(await store.readFile(["profile.md"]));
  if (anchor) {
    let found = false;
    for (const exp of gen.resume.experience) {
      const isAnchor = !found && `${exp.company} ${exp.title}`.toLowerCase().includes(anchor.toLowerCase());
      (exp as { page_break_before?: boolean }).page_break_before = isAnchor;
      if (isAnchor) found = true;
    }
    if (!found) warnings.push(`page2 anchor "${anchor}" matched no experience title — no page break set`);
  }

  // House style (N5): em dashes / banned words / "not just X but Y" block the save.
  const md = generatedResumeToMarkdown(gen);
  const style = [
    ...checkStyle(md, resolveStylePolicy(opts.stylePolicy)),
    ...checkResumePerson(md.split("\n").slice(1).join("\n")),
  ];
  const hardStyle = style.filter(isHardStyleViolation);
  if (hardStyle.length) {
    throw new Error(`Resume violates house style: ${hardStyle.map((v) => `${v.rule} (${v.detail})`).join("; ")}`);
  }
  for (const v of style) warnings.push(`style: ${v.rule} (${v.detail})`);

  // Page-fill safety net (portable). The AUTHORITATIVE check is the visual
  // layout probe (renders the docx, measures real page fill) where LibreOffice
  // is available; this word count is the coarse fallback for the cloud lane and
  // for catching grossly-short resumes. Calibrated on the tight layout: ~1230
  // words fills two pages; below ~1050 page 2 is visibly sparse regardless of
  // density. Leaner (CoS-style) resumes can render full at ~1080-1100 words, so
  // the hard floor sits at 1050 and the visual probe refines from there.
  const wordCount = md.split(/\s+/).filter((w) => /\w/.test(w)).length;
  // Only a two-page résumé has a word floor. The page target comes from
  // profile.md (target_pages) or, when unset, from the years in the record, so
  // a student's one-page résumé with four entries is never sent back as short.
  const pagePolicy = resumeLengthPolicy(experiences, { override: settings.target_pages });
  const fullCareerResume = pagePolicy.targetPages === 2 && gen.resume.experience.length >= 4; // skip gate for short/test fixtures
  if (fullCareerResume && wordCount < 1050) {
    throw new Error(
      `Resume too short for the two-page layout: ${wordCount} words (needs ~1200-1300). ` +
        `Do not pad with filler: restore more of the knowledge base's curated achievement bullets ` +
        `(second bullets for later roles are usually what got over-trimmed).`,
    );
  }
  if (fullCareerResume && wordCount < 1200)
    warnings.push(`length: ${wordCount} words — page 2 may run light (target 1200-1300)`);

  // Requirements coverage (optional field; older résumés lack it). Every
  // covered/partial row must quote text that is really on the rendered résumé
  // (exact excerpt, or a light paraphrase of one line: see
  // checkRequirementCoverage). Gap rows and a short table are advisory.
  let coverage: RequirementCoverageSummary | null = null;
  if (gen.requirement_coverage) {
    const cov = checkRequirementCoverage(gen.requirement_coverage, md);
    if (cov.errors.length) {
      throw new Error(
        `Requirement coverage failed: ${cov.errors.join("; ")}. ` +
          `Quote the résumé text verbatim as evidence, or mark the row partial/gap with an honest note. ` +
          `Never add a claim to the résumé to cover a requirement.`,
      );
    }
    warnings.push(...cov.warnings);
    coverage = cov.summary;
  }

  // ATS coverage vs the captured ad — advisory, surfaced to the caller. The
  // docx headline is part of what a parser sees, so it counts toward coverage.
  const snapshot = (await readSnapshot(store, appId)) ?? "";
  const ats = checkAtsCoverage(snapshot, `${md}\n${opts.headline ?? ""}`);
  if (ats.coverage < 0.6) {
    warnings.push(
      `ATS coverage ${(ats.coverage * 100).toFixed(0)}% — missing JD terms: ${ats.missing.slice(0, 8).join(", ")}`,
    );
  }

  // Persist the three artifacts together so they can never desync.
  await store.writeJson(["applications", appId, "resume.json"], gen);
  await saveResumeSource(store, appId, md);
  // Paper: an uploaded template's own size wins, else the user's setting.
  const paper = opts.template?.paper ?? (await loadResumePaper(store));
  const docx = await markdownResumeToDocx(md, {
    ...(opts.headline ? { headline: opts.headline } : {}),
    template: { ...opts.template, paper },
  });
  await store.writeBinary(
    ["applications", appId, "resume.docx"],
    docx,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  const status = await advanceDraftStatus(store, appId, "drafted");
  if (status) await updateMeta(store, appId, { status });

  return { warnings, ats, style, provenanceEntries: gen.provenance_audit.length, coverage, stretch, paper };
}

export interface LetterNumberCheck {
  /** Numbers found in no source the letter may use. */
  ungrounded: string[];
  /** Numbers the metrics register does not allow in a document. */
  blocked: MetricStatusIssue[];
  /** Why the letter cannot be saved, or null when its numbers are clean. */
  message: string | null;
}

/**
 * The number check every cover-letter save runs, whichever path wrote the
 * letter (the MCP tool or the dashboard's one-click letter): each number must
 * come from the verified record, the profile, education or the posting, and
 * must not be one the metrics register withholds.
 */
export async function checkLetterNumbers(store: Store, appId: string, markdown: string): Promise<LetterNumberCheck> {
  const [experiences, education, profileRaw, snapshot, registerRaw] = await Promise.all([
    loadExperiences(store),
    loadEducation(store).catch(() => [] as string[]),
    store.readFile(["profile.md"]),
    readSnapshot(store, appId),
    store.readFile(METRICS_REGISTER_PATH),
  ]);
  const posting = snapshotBody(snapshot);
  const sources = [profileRaw ?? "", JSON.stringify(education), posting].join("\n");
  const ungrounded = ungroundedNumbers(markdown, experiences, sources);
  const allowed = allowedMetricStatuses(readProfileSettings(profileRaw));
  const blocked = registerBlockedNumbers(markdown, registerRaw, allowed);
  const parts: string[] = [];
  if (ungrounded.length) {
    parts.push(
      `${ungrounded.length} number(s) in the letter are not in the user's verified record, profile, education or the posting: ${ungrounded.join(", ")}. ` +
        `Remove them, or ask the user and record the fact first (save_confirmed_fact / save_metric).`,
    );
  }
  if (blocked.length) {
    parts.push(`${blocked.length} number(s) in the letter are withheld by the metrics register: ${describeMetricStatusIssues(blocked, allowed)}`);
  }
  return { ungrounded, blocked, message: parts.length ? `Not saved: ${parts.join(" ")}` : null };
}

/** The posting text of a snapshot, without its frontmatter (the raw text when the frontmatter does not parse). */
function snapshotBody(snapshot: string | null): string {
  if (!snapshot) return "";
  try {
    return matter(snapshot).content.trim();
  } catch {
    return snapshot.trim();
  }
}

/** The profile's `name` (frontmatter), or undefined. */
function profileName(profileRaw: string): string | undefined {
  try {
    const n = (matter(profileRaw).data as Record<string, unknown>).name;
    return typeof n === "string" && n.trim() ? n.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the profile's `resume_page2_anchor` (title substring of the role that must head page 2). */
export function readPage2Anchor(profileRaw: string | null | undefined): string | null {
  if (!profileRaw) return null;
  try {
    const data = matter(profileRaw).data as Record<string, unknown>;
    const anchor = data.resume_page2_anchor;
    return typeof anchor === "string" && anchor.trim() ? anchor.trim() : null;
  } catch {
    return null;
  }
}
