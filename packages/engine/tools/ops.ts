import matter from "../front-matter";
import { worded } from "@kairos/engine/wording";
import { resumeLengthPolicy } from "@kairos/engine/length-policy";
import { allowedMetricStatuses, loadResumePaper, readProfileSettings } from "@kairos/engine/settings";
import type { Store } from "@kairos/engine/store/types";
import type { GeneratedResume, ScoreReport } from "@kairos/engine/types";
import { appendScoreVersion, readMeta, readSnapshot, saveResumeSource, updateMeta } from "@kairos/engine/applications";
import type { ApplicationStatus } from "@kairos/engine/applications";
import { loadEducation, loadEducationEntries, loadExperiences } from "@kairos/engine/kb/store";
import type { Experience } from "@kairos/engine/kb/types";
import { dateAsYears, yearsCovered } from "@kairos/engine/tools/years";
import { checkResumeStretch, claimsMoreThanTheFact, type StretchFinding } from "@kairos/engine/stretch";
import { checkLineOrigins, idOf, type LineOriginReport } from "@kairos/engine/line-origin";
import { generatedResumeToMarkdown } from "@kairos/engine/resume-render";
import { markdownResumeToDocx, type Paper, type TemplateSpec } from "@kairos/engine/docx-render";
import { GeneratedResumeSchema, ScoreReportSchema, formatIssues } from "@kairos/engine/tools/schemas";
import {
  keyOf,
  checkAtsCoverage,
  checkRequirementCoverage,
  ADVISORY_GROUNDING,
  checkResumeGrounding,
  checkResumePerson,
  checkStyle,
  educationRef,
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
  presentInEndedRoles,
  thirdPersonOpenings,
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
  /**
   * The origin of every line (the verified fact or facts it comes from), found in code, with the counts
   * and the findings of rule "origin": a line with no fact, a provenance_audit source that holds no fact for its line.
   */
  origins: LineOriginReport;
  /** Paper the .docx was rendered on (profile.md `paper`, else by the search: see settings.resumePaper). */
  paper: Paper;
  /** Lines whose named source held no fact for them and was replaced by the entry the facts were found in. */
  sourcesCorrected: number;
  /**
   * What differs from the knowledge base and does not stop the save (the guardrails of 15 November 2026). The résumé
   * is saved with them: how a person presents themselves is theirs to decide.
   */
  findings: ResumeFindings;
}

/** One thing on the résumé that differs from the knowledge base. */
export interface ResumeFinding {
  /** The same on every résumé for the same thing: what a remembered choice is kept under. */
  key: string;
  kind: string;
  /** The line it is in, when it is in one. */
  line?: string;
  /** What differs, and what the knowledge base holds: for the Writer, with what to do. */
  what: string;
  /** The same for the user, in plain words: what is on the résumé and what their knowledge base holds, with no judgement. */
  say?: string;
}

export interface ResumeFindings {
  /**
   * What the Writer is to put right from the knowledge base before the draft is shown: a title, a date, an issuer, a
   * count of years, a skill, a stronger verb, an "I", a statement of what the person did not do, a line no fact holds.
   * If the user asked for it themselves, it is not changed: it is told to them, and kept if they say so.
   */
  put_right: ResumeFinding[];
  /** What only the person can settle: told to them in plain words, with no judgement. */
  tell_user: ResumeFinding[];
  /** Findings not raised because the user chose, once, to keep them on every résumé (profile `resume_choices`). */
  kept_by_choice: ResumeFinding[];
}

/** A choice the user made once for every résumé, as the profile keeps it. */
export interface ResumeChoice {
  /** The finding's key, or a whole family of them ("skills|*": every item of the skills line). */
  key: string;
  /** The choice in the user's words: "My last role stays written to Present". */
  says?: string;
  since?: string;
}

/** The user's remembered choices (profile `resume_choices`). */
export function resumeChoices(profile: Record<string, unknown>): ResumeChoice[] {
  const raw = Array.isArray(profile.resume_choices) ? profile.resume_choices : [];
  return raw.flatMap((c) => (c && typeof c === "object" && typeof (c as ResumeChoice).key === "string" && (c as ResumeChoice).key.trim() ? [c as ResumeChoice] : []));
}

/** Whether a finding is one the user chose to keep: its own key, or a family ("skills|*") that holds it. */
export const keptByChoice = (key: string, choices: ResumeChoice[]): boolean =>
  choices.some((c) => {
    const k = c.key.trim().toLowerCase();
    return k === key || (k.endsWith("|*") && key.startsWith(k.slice(0, -1))) || (k.endsWith("*") && !k.includes("|") && key.startsWith(k.slice(0, -1)));
  });

/** What the faults that stopped a save until 15 November 2026 are keyed by, for a choice the user keeps. */
const STOP_KEYS: Record<string, string> = {
  unknown_employer: "employer",
  unknown_organisation: "organisation",
  ungrounded_metric: "number",
  metric_source_mismatch: "number",
  ungrounded_count: "number",
  count_source_mismatch: "number",
  ungrounded_credential: "credential",
  unknown_source: "source",
};

const short = (line: string | undefined) => (line ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 160);

/**
 * A finding as the user reads it: what is on the résumé and what their knowledge base holds. Plain words, no
 * judgement, no "must": how they present themselves is theirs to decide.
 */
export function sayOf(kind: string, thing: string, line: string | undefined): string {
  const l = short(line);
  switch (kind) {
    case "unknown_employer":
      return `"${thing}" is on this résumé as an employer. Your knowledge base has no entry for it.`;
    case "unknown_organisation":
      return `A line says you were "${thing}". Your knowledge base does not mention that organisation.`;
    case "ungrounded_metric":
    case "ungrounded_count":
      return `The number "${thing}" is on this résumé. It is not in your knowledge base.`;
    case "metric_source_mismatch":
    case "count_source_mismatch":
      return `The number "${thing}" is under one employer on this résumé. Your knowledge base has it under another.`;
    case "ungrounded_credential":
      return `"${thing}" is on this résumé as a credential. Your knowledge base does not hold it.`;
    case "unknown_source":
      return "";
    case "unknown_title":
      return `The title "${thing}" is on this résumé. Your knowledge base has another title for that entry.`;
    case "dates_differ":
      return `The dates "${thing}" are on this résumé. Your knowledge base has other dates for that entry.`;
    case "education_differs":
      return `"${thing}" is under education on this résumé. Your knowledge base holds it differently, or not at all.`;
    case "years_exceed_dates":
      return `A line says "${thing}". The dates of that role in your knowledge base give fewer.`;
    case "years_not_the_persons":
      return `The summary says "${thing}". The figure you give of yourself is another.`;
    case "years_from_dates":
      return `The summary says "${thing}". You have not stated that figure yourself: it was worked out from your dates. Is it right for what the sentence says?`;
    case "share_of_another_whole":
      return `A line says "${thing}". Your knowledge base gives that share of something else.`;
    case "year_left_out":
      return `The figure "${thing}" is on this résumé without its year. Your knowledge base gives it for one year.`;
    case "composed_total":
      return `The summary gives "${thing}". No line of your knowledge base states that count.`;
    case "skill_not_held":
    case "ungrounded_skill":
      return `"${l}" is in the skills section. It is not on your list of skills, and no fact of yours says it in these words.`;
    case "listed_skill_left_out":
      return `"${thing}" is on your list of skills and the job ad names it. It is not in the skills section.`;
    case "says_more_than_the_fact":
      return `This line says more than your knowledge base does ("${thing}"): "${l}".`;
    case "line_with_no_origin":
      return `This line rests on nothing in your knowledge base: "${l}".`;
    case "negative_statement":
      return `A line says what you did not do: "${l}".`;
    case "unknown_audience":
      return `A line names an audience ("${thing}") that your knowledge base does not.`;
    case "first-person":
      return 'A line says "I", "my" or "me".';
    case "verb-form":
      return `A line opens in the third person ("${thing}").`;
    default:
      return "";
  }
}

/** Findings only the person can settle; every other finding is the Writer's to put right first. */
const FOR_THE_PERSON = new Set(["years_from_dates"]);

/**
 * A save that was refused by a check, before anything was written: the résumé, the letter or the score is as it was.
 * The tool server tells this apart from an error part of the way through a write (which may have saved something).
 */
export class SaveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveRefused";
  }
}

/**
 * The executive summary as a list, one line per bold opener ("- **Scope:** …"). The prompt asks for this; in the
 * run on other professions two summaries came as one paragraph and one as bare lines, and each rendered differently.
 * A summary that is a list already, or that has no such openers, is left as it is.
 */
export function summaryAsBullets(text: string): string {
  const opener = /\*\*[^*\n]{2,60}:\*\*/g;
  if ((text.match(opener) ?? []).length < 2) return text;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.every((l) => /^[-*•]\s+/.test(l))) return text;
  const parts = text
    .replace(/\s*\n\s*/g, " ")
    .split(/(?=\*\*[^*\n]{2,60}:\*\*)/)
    .map((p) => p.replace(/^[-*•]\s+/, "").replace(/\s*[-*•]\s*$/, "").trim())
    .filter(Boolean);
  if (parts.some((p) => !p.startsWith("**"))) return text;
  return parts.map((p) => `- ${p}`).join("\n");
}

const DEGREE = /\b(?:b\.?\s?[as]\.?c?|m\.?\s?[as]\.?c?|mba|ph\.?\s?d|bachelor|master|doctor|associate|degree|diploma|licence|maîtrise)\b/i;
const NOT_A_DEGREE = /certif|licens|course|bootcamp|training/i;

/**
 * Whether education stands before experience: the person's degree is their latest entry and they have under three
 * years of work behind them (a student, a recent graduate). Anyone with a working history keeps experience first.
 */
export function educationStandsFirst(gen: GeneratedResume, experiences: Experience[], now: Date = new Date()): boolean {
  const jobs = experiences.filter((e) => e.frontmatter.kind !== "project");
  if ((yearsCovered(jobs, now) ?? 0) >= 3) return false;
  if (jobs.some((e) => /^(present|current|now|today|ongoing)$/i.test(String(e.frontmatter.end ?? "").trim()))) return false;
  const lastJob = Math.max(-Infinity, ...jobs.map((e) => dateAsYears(e.frontmatter.end, true, now) ?? -Infinity));
  const degrees = (gen.resume.education ?? []).filter((ed) => DEGREE.test(ed.credential) && !NOT_A_DEGREE.test(ed.credential));
  const lastDegree = Math.max(
    -Infinity,
    ...degrees.map((ed) => {
      const all = [...(ed.dates ?? "").matchAll(/(?:([A-Za-z]{3})[a-z]*\.?\s+)?((?:19|20)\d{2})/g)];
      const last = all[all.length - 1];
      if (!last) return -Infinity;
      // "expected 2027": the word before the year is a month only when it is one.
      return dateAsYears(`${last[1] ?? ""} ${last[2]}`.trim(), true, now) ?? dateAsYears(last[2], true, now) ?? -Infinity;
    }),
  );
  return lastDegree > -Infinity && lastDegree >= lastJob;
}

/** Bullets that say a role's introduction again (most of its content words), as warnings. */
export function repeatedIntros(gen: GeneratedResume): string[] {
  const content = (t: string) => new Set(t.toLowerCase().replace(/\*\*[^*]*\*\*/g, " ").split(/[^a-z0-9]+/).filter((w) => w.length > 3).map((w) => w.replace(/(?:ing|ed|es|s)$/, "")));
  const out: string[] = [];
  for (const exp of gen.resume.experience) {
    const intro = content(exp.summary ?? "");
    if (intro.size < 5) continue;
    for (const b of exp.bullets) {
      const words = content(b);
      const shared = [...intro].filter((w) => words.has(w)).length;
      if (shared / intro.size >= 0.7) out.push(`repeat: under "${exp.company}", a bullet says the role's introduction again ("${b.slice(0, 70)}…"): keep one of the two`);
    }
  }
  return out;
}

/**
 * What every refusal of a résumé ends on: the two honest ways out. A check is never to be reworded around.
 */
export const WAYS_OUT =
  "Two honest ways out for each: write it in the person's own words, as the knowledge base has them; or ask the person, save what they confirm as a fact of theirs (save_confirmed_fact), and save the résumé again. Do not reword a line to get it past a check.";
const quoted = (line: string | undefined) => (line ? ` In the line: "${line.replace(/\s+/g, " ").trim().slice(0, 160)}".` : "");

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
    /**
     * What happens when the résumé holds something the knowledge base does not (an employer, a number, a number the
     * register withholds, a phrasing the user forbade, a house-style or coverage fault).
     *  - "warn": the résumé is saved and each is a finding. For a save made in a conversation, where the Writer puts
     *    right what it added and the rest is told to the user, who may keep it (the owner's decision of 15 November
     *    2026: "it is the user responsibility how they want to represent themselves").
     *  - "refuse" (the default): each stops the save, as before. For a save with nobody to tell: the one-click résumé
     *    of the board, a script. There a résumé with an employer nobody gave must not be written unseen.
     * In both, what the user chose to keep on every résumé (profile `resume_choices`) is neither raised nor refused.
     */
    whenItDiffers?: "warn" | "refuse";
  } = {},
): Promise<SaveResumeResult> {
  const parsed = GeneratedResumeSchema.safeParse(gen);
  if (!parsed.success) {
    // The usual cause: the résumé's inner object was given where the whole one is expected.
    const inner = gen && typeof gen === "object" && "header" in (gen as object) && !("resume" in (gen as object));
    throw new SaveRefused(
      `GeneratedResume failed validation: ${formatIssues(parsed.error)}` +
        (inner ? `. The whole object is expected: { "resume": { "header", "executive_summary", "experience", "education", "skills" }, "provenance_audit": [ ... ], "requirement_coverage": [ ... ] }, not the inner "resume" alone.` : ""),
    );
  }

  // Grounding (N1): employers, metrics, and provenance sources must trace to
  // verified KB evidence. Profile + education are legitimate curated sources.
  const experiences = await loadExperiences(store);
  const profileRaw = (await store.readFile(["profile.md"])) ?? "";
  const education = await loadEducation(store);
  const educationEntries = (await loadEducationEntries(store)).map((e) => {
    try {
      const parsedEntry = matter(e.raw);
      return educationRef(e.fileName, parsedEntry.data as Record<string, unknown>, parsedEntry.content);
    } catch {
      return educationRef(e.fileName, {}, e.raw);
    }
  });
  const profileData = profileFields(profileRaw);

  // What the save decides, not the model. Which rows are the person's own projects (the knowledge base says so): they
  // stand under "Projects". Whether education stands first. And the summary's form: one line per bold opener.
  const kindOf = (company: string) => {
    const own = experiences.filter((e) => e.frontmatter.company.toLowerCase().trim() === company.toLowerCase().trim());
    return own.length > 0 && own.every((e) => e.frontmatter.kind === "project") ? ("project" as const) : undefined;
  };
  for (const exp of gen.resume.experience) {
    const kind = kindOf(exp.company);
    if (kind) exp.kind = kind;
    else delete exp.kind;
    if (!kind && !exp.title.trim()) throw new SaveRefused(worded`Resume failed grounding against the knowledge base: the role under "${exp.company}" has no title`);
  }
  if (educationStandsFirst(gen, experiences)) gen.resume.education_first = true;
  else delete gen.resume.education_first;
  // The section headings are the user's own where they renamed one (profile `resume_headings`); nothing the model sends counts.
  const renamed = readProfileSettings(profileRaw).resume_headings;
  if (renamed) gen.resume.headings = renamed;
  else delete gen.resume.headings;
  gen.resume.executive_summary = summaryAsBullets(gen.resume.executive_summary);
  const extraCorpus = [
    profileRaw,
    (await store.readFile(["base-resume.md"])) ?? "",
    ...education, // credentials and education entries are checked against these
  ].join("\n");
  const grounding = checkResumeGrounding(gen, experiences, extraCorpus, {
    educationRecorded: education.length > 0,
    targetCompany: (await readMeta(store, appId))?.company,
    educationEntries,
    statedSkills: Array.isArray(profileData.skills) ? profileData.skills.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [],
    jobText: snapshotBody(await readSnapshot(store, appId)),
    // The person's own résumé and summary blocks: a title or a count of years written there is theirs.
    ownWriting: [(await store.readFile(["knowledge-base", "reference-resume.md"])) ?? "", (await store.readFile(["knowledge-base", "_summary-blocks.md"])) ?? ""].join("\n"),
  });
  const warnings: string[] = [];
  const choices = resumeChoices(profileData);
  const refuse = (opts.whenItDiffers ?? "refuse") === "refuse";
  /** Of the faults of one check, those the user did not choose to keep: what a save with nobody to tell stops on. */
  const open = <T extends { key: string }>(items: T[]) => items.filter((i) => !keptByChoice(i.key, choices));
  const thing = (detail: string) => /^"([^"]+)"/.exec(detail)?.[1] ?? "";
  const METRIC_KINDS = ["ungrounded_metric", "metric_source_mismatch", "ungrounded_count", "count_source_mismatch"];
  const keyed = grounding.map((g) => ({ ...g, key: g.key ?? keyOf(STOP_KEYS[g.kind] ?? g.kind, thing(g.detail) || g.detail) }));
  const hardGrounding = keyed.filter((g) => !ADVISORY_GROUNDING.has(g.kind) && (!METRIC_KINDS.includes(g.kind) || !opts.allowUngroundedMetrics));
  if (refuse && open(hardGrounding).length) {
    throw new SaveRefused(
      worded`Resume failed grounding against the knowledge base: ${open(hardGrounding).map((g) => `[${g.kind}] ${g.detail}${g.detail.endsWith(".") ? "" : "."}${quoted(g.line)}`).join(" ")} ${WAYS_OUT}`,
    );
  }
  for (const g of grounding) warnings.push(`[${g.kind}] ${g.detail}`);
  const found: ResumeFinding[] = keyed
    .filter((g) => ADVISORY_GROUNDING.has(g.kind) || hardGrounding.includes(g))
    .map((g) => ({ key: g.key, kind: g.kind, ...(g.line ? { line: g.line } : {}), what: g.detail, say: sayOf(g.kind, thing(g.detail), g.line) }));

  // Metrics register: a number on record can still be one the user has not
  // defended (OPEN, PARTIAL) or has withdrawn (RETIRED). With no register, or
  // for a number the register does not hold, nothing changes.
  const settings = readProfileSettings(profileRaw);
  const allowedStatuses = allowedMetricStatuses(settings);
  const blocked = registerBlockedNumbers(resumeClaimText(gen), await store.readFile(METRICS_REGISTER_PATH), allowedStatuses).map((b) => ({ ...b, key: keyOf("register", b.number) }));
  if (refuse && open(blocked).length) {
    throw new SaveRefused(`Resume uses a number the metrics register does not allow: ${describeMetricStatusIssues(open(blocked), allowedStatuses)}`);
  }
  for (const b of blocked) {
    found.push({
      key: b.key,
      kind: "register_withholds",
      what: `"${b.number}" matches the metrics-register entry "${b.entry}" (${b.status}, under "${b.section}"). Only ${allowedStatuses.join(" and ")} numbers go into a document: take the number out, or have the user settle its status in the register`,
      say: `The number "${b.number}" is on this résumé. Your numbers register has it as ${b.status} ("${b.entry}"), which is not a status you put on a document.`,
    });
  }

  // Stretch (2026-11-03): ownership verbs and absolutes must be supported by a
  // verified fact of that employer. A phrasing the KB explicitly forbids blocks;
  // the rest is the candidate's call (keep / soften / drop). Since 2026-11-13
  // the same rules read the executive summary sentence by sentence, and the
  // findings include a number attached to another result, a client given as a
  // place of work and a total composed across roles.
  const stretchAll = checkResumeStretch(gen, experiences, extraCorpus, { candidateName: profileName(profileRaw) });
  const denied = stretchAll.filter((f) => f.kind === "denied").map((f) => ({ ...f, key: keyOf("forbidden", f.trigger) }));
  if (refuse && open(denied).length) {
    throw new SaveRefused(
      worded`Resume uses phrasing the knowledge base forbids: ${open(denied).map((f) => `[${f.company}] "${f.trigger}" in "${f.bullet}"`).join("; ")}. ` +
        worded`Rewrite with the knowledge base's own wording.`,
    );
  }
  for (const f of denied) {
    found.push({ key: f.key, kind: "forbidden_phrasing", line: f.bullet, what: worded`"${f.trigger}" (${f.company}): the knowledge base says never to claim this. Write the line in the knowledge base's own wording`, say: `A line says "${f.trigger}". Your knowledge base has a note of yours never to claim that.` });
  }
  // The knowledge base says less than the line does, in kind (took part, and the line leads; a result of the site's,
  // and the line makes it the person's doing). A finding for the Writer to put right in the fact's own words; if the
  // person says the stronger statement is true, it is saved as a fact of theirs and stands.
  for (const f of stretchAll.filter(claimsMoreThanTheFact)) {
    found.push({ key: keyOf("verb", f.company, f.trigger, f.bullet), kind: "says_more_than_the_fact", line: f.bullet, say: sayOf("says_more_than_the_fact", f.trigger, f.bullet), what: `"${f.trigger}" (${f.company}): ${f.detail}. Say what the person did in the knowledge base's own words; another verb for the same claim changes nothing` });
  }
  const stretch = stretchAll.filter((f) => f.kind === "stretch" && !claimsMoreThanTheFact(f));

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
    ...thirdPersonOpenings(gen).map((w) => ({ rule: "verb-form" as const, detail: `a line opens on "${w}": résumé lines are in the implied first person ("${w.replace(/(?:ies)$/, "y").replace(/s$/, "")}" for what is still done, the past form for what is finished)` })),
  ];
  const hardStyle = style.filter(isHardStyleViolation).map((v) => ({ ...v, key: keyOf("style", v.rule, v.detail) }));
  if (refuse && open(hardStyle).length) {
    throw new SaveRefused(`Resume violates house style: ${open(hardStyle).map((v) => `${v.rule} (${v.detail})`).join("; ")}. Change the wording only: the facts stay as they are.`);
  }
  for (const v of style) warnings.push(`style: ${v.rule} (${v.detail})`);
  for (const v of hardStyle) {
    found.push({ key: v.key, kind: `style_${v.rule.replace(/-/g, "_")}`, what: `${v.rule} (${v.detail}). Change the wording only: the facts stay as they are`, say: `The wording goes against a writing rule of this résumé (${v.rule}): ${v.detail}.` });
  }
  for (const v of style.filter((x) => x.rule === "first-person" || x.rule === "verb-form")) {
    found.push({ key: v.rule, kind: v.rule, what: v.rule === "first-person" ? `${v.detail}. Take the pronoun out; the fact stays as it is` : `${v.detail}`, say: sayOf(v.rule, /"([^"]+)"/.exec(v.detail)?.[1] ?? "", undefined) });
  }

  // The present tense under a role that has ended.
  for (const t of presentInEndedRoles(gen, experiences)) {
    found.push({ key: keyOf("tense", t.company, t.word), kind: "present_in_an_ended_role", line: t.line, what: `"${t.word}" (${t.company}): this role has ended in the knowledge base, and the line opens in the present. Write it in the past`, say: `A line under ${t.company} opens in the present ("${t.word}"). Your knowledge base has that role as ended.` });
  }

  // Page-fill safety net (portable). The AUTHORITATIVE check is the visual
  // layout probe (renders the docx, measures real page fill) where LibreOffice
  // is available; this word count is the coarse fallback for the cloud lane and
  // for catching grossly-short resumes. Calibrated on the tight layout: ~1230
  // words fills two pages; below ~1050 page 2 is visibly sparse regardless of
  // density. Leaner (CoS-style) resumes can render full at ~1080-1100 words, so
  // the hard floor sits at 1050 and the visual probe refines from there.
  const wordCount = md.split(/\s+/).filter((w) => /\w/.test(w)).length;
  // Only a two-page résumé has a word floor. The page target comes from
  // profile.md (target_pages) or, when unset, from the years in the knowledge base, so
  // a student's one-page résumé with four entries is never sent back as short.
  const pagePolicy = resumeLengthPolicy(experiences, { override: settings.target_pages });
  const fullCareerResume = pagePolicy.targetPages === 2 && gen.resume.experience.length >= 4; // skip gate for short/test fixtures
  if (fullCareerResume && wordCount < 1050) {
    const short =
      `Resume too short for the two-page layout: ${wordCount} words (needs ~1200-1300). ` +
      worded`Do not pad with filler: restore more of the knowledge base's curated achievement bullets ` +
      `(second bullets for later roles are usually what got over-trimmed).`;
    if (refuse && !keptByChoice("length", choices)) throw new SaveRefused(short);
    found.push({ key: "length", kind: "short_for_two_pages", what: short, say: `This résumé is set for two pages and holds ${wordCount} words; two full pages take about 1,200.` });
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
    const rows = cov.errors.map((e) => ({ error: e, key: keyOf("coverage", e) }));
    if (refuse && open(rows).length) {
      throw new SaveRefused(
        `Requirement coverage failed: ${open(rows).map((r) => r.error).join("; ")}. ` +
          `Quote the résumé text verbatim as evidence, or mark the row partial/gap with an honest note. ` +
          `Never add a claim to the résumé to cover a requirement.`,
      );
    }
    for (const r of rows) {
      found.push({ key: r.key, kind: "coverage_evidence", what: `${r.error}. Quote the résumé's own text as evidence, or mark the row partial or gap with an honest note; never add a claim to the résumé to cover a requirement`, say: "The table that says which of the ad's requirements this résumé covers marks one as covered with a line that is not on the résumé." });
    }
    warnings.push(...cov.warnings);
    coverage = cov.summary;
  }

  // ATS coverage vs the captured ad — advisory, surfaced to the caller. The
  // docx headline is part of what a parser sees, so it counts toward coverage.
  const snapshot = (await readSnapshot(store, appId)) ?? "";
  const ats = checkAtsCoverage(snapshotBody(snapshot), `${md}\n${opts.headline ?? ""}`);
  if (ats.coverage < 0.6) {
    warnings.push(
      `ATS coverage ${(ats.coverage * 100).toFixed(0)}% — missing JD terms: ${ats.missing.slice(0, 8).join(", ")}`,
    );
  }

  // Line origins (2026-11-13): the verified fact or facts each bullet, role
  // intro and summary sentence comes from, found in code and saved with the
  // résumé. The model's provenance_audit is compared with them, not trusted.
  // A line with no origin is listed for the user and never blocks: what is
  // clearly unsupported was blocked above.
  // What the person says of themselves in their profile (their own summary, their headline) is a source for a summary
  // sentence, as an education entry is.
  const ownWords = [profileData.summary, profileData.headline].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  const origins = checkLineOrigins(gen, experiences, {
    candidateName: profileName(profileRaw),
    education: [...education, ...(ownWords.length ? [matter.stringify(`\n${ownWords.map((w) => `${w} [R]`).join("\n")}\n`, { institution: "the person's own summary" })] : [])],
  });
  // A line with no origin: no verified fact holds its words or its numbers. A finding for the Writer to put right
  // (drop it, or write it from a fact); a line matched in part is listed for the person, as before.
  for (const f of origins.findings.filter((x) => x.kind === "none")) {
    found.push({ key: keyOf("line", f.line), kind: "line_with_no_origin", line: f.line, say: sayOf("line_with_no_origin", "", f.line), what: `(${f.company}) no verified fact of the knowledge base holds this line. Leave it out, or write it from a fact; if the person told you this, save it as a fact of theirs first (save_confirmed_fact)` });
  }
  // A line whose named source holds no fact for it, while the facts were found in another entry: the source is put
  // right here, in the audit that is saved, and is not handed back to be reported to the user.
  let sourcesCorrected = 0;
  origins.findings = origins.findings.filter((f) => {
    if (f.kind !== "audit" || f.audit_index === undefined || !f.found?.length) return true;
    const first = f.found[0]!;
    const entry = experiences.find((e) => idOf(e) === first);
    const source = entry ? entry.fileName : first.startsWith("education:") ? "education" : null;
    if (!source || !gen.provenance_audit[f.audit_index]) return true;
    gen.provenance_audit[f.audit_index]!.source_experience = source;
    sourcesCorrected++;
    return false;
  });
  warnings.push(...repeatedIntros(gen));

  // What the user chose once to keep on every résumé is not raised again; the rest is the Writer's to put right, or
  // the person's to settle.
  const findings: ResumeFindings = {
    put_right: found.filter((f) => !keptByChoice(f.key, choices) && !FOR_THE_PERSON.has(f.kind)),
    tell_user: found.filter((f) => !keptByChoice(f.key, choices) && FOR_THE_PERSON.has(f.kind)),
    kept_by_choice: found.filter((f) => keptByChoice(f.key, choices)),
  };

  // Persist the three artifacts together so they can never desync.
  // docx_headline: the headline the Word file is written with, so that the same file can be written again from the text.
  await store.writeJson(["applications", appId, "resume.json"], { ...gen, line_origins: origins.lines, ...(opts.headline ? { docx_headline: opts.headline } : {}) });
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

  return { warnings, ats, style, provenanceEntries: gen.provenance_audit.length, coverage, stretch, origins, paper, sourcesCorrected, findings };
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
 * come from the verified knowledge base, the profile, education or the posting, and
 * must not be one the metrics register withholds.
 */
export async function checkLetterNumbers(
  store: Store,
  appId: string,
  markdown: string,
  /** `what`: the document's name in the message ("letter" by default). `extraSources`: other text a number may come from. */
  opts: { what?: string; extraSources?: string } = {},
): Promise<LetterNumberCheck> {
  const what = opts.what ?? "letter";
  const [experiences, education, profileRaw, snapshot, registerRaw] = await Promise.all([
    loadExperiences(store),
    loadEducation(store).catch(() => [] as string[]),
    store.readFile(["profile.md"]),
    readSnapshot(store, appId),
    store.readFile(METRICS_REGISTER_PATH),
  ]);
  const posting = snapshotBody(snapshot);
  const sources = [profileRaw ?? "", JSON.stringify(education), posting, opts.extraSources ?? ""].join("\n");
  const ungrounded = ungroundedNumbers(markdown, experiences, sources);
  const allowed = allowedMetricStatuses(readProfileSettings(profileRaw));
  const blocked = registerBlockedNumbers(markdown, registerRaw, allowed);
  const parts: string[] = [];
  if (ungrounded.length) {
    parts.push(
      `${ungrounded.length} number(s) in the ${what} are not in the user's verified knowledge base, profile, education or the posting: ${ungrounded.join(", ")}. ` +
        `Remove them, or ask the user and record the fact first (save_confirmed_fact / save_metric).`,
    );
  }
  if (blocked.length) {
    parts.push(`${blocked.length} number(s) in the ${what} are withheld by the metrics register: ${describeMetricStatusIssues(blocked, allowed)}`);
  }
  return { ungrounded, blocked, message: parts.length ? `Not saved: ${parts.join(" ")}` : null };
}

/**
 * The posting text of a snapshot, without its frontmatter (the raw text when the frontmatter does not parse).
 * The frontmatter is Kairos's own (capture note, posting-guard counts): read as posting text, its words
 * ("posting", "hidden", "chars") were counted as terms the résumé is missing.
 */
export function snapshotBody(snapshot: string | null): string {
  if (!snapshot) return "";
  try {
    return matter(snapshot).content.trim();
  } catch {
    return snapshot.trim();
  }
}

/** The profile's fields (frontmatter); empty when it does not parse. */
export function profileFields(profileRaw: string): Record<string, unknown> {
  try {
    return (matter(profileRaw).data ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The profile's `name` (frontmatter), or undefined. */
export function profileName(profileRaw: string): string | undefined {
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
