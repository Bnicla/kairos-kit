/**
 * Pure writers for the curated knowledge-base files that used to be edited by
 * hand: writing samples (_writing-samples.md), STAR stories (star-stories.json)
 * and the metrics register (metrics-register.md). Each output is shaped
 * exactly the way its reader parses it (generate.ts reads the samples as raw
 * markdown; dashboard.ts reads the stories JSON; metrics-register.ts parses
 * the register), so a file written here reads back the same way.
 */
import type { StarStories, StarStory } from "./dashboard";
import type { MetricStatus } from "./metrics-register";

// --- Writing samples ---------------------------------------------------------

export interface WritingSample {
  /** e.g. "cover letter I wrote myself (Acme, Product Manager)". */
  title: string;
  /** The user's own text, verbatim. */
  text: string;
  /** What to imitate in it (register, sentence shapes). */
  imitate?: string[];
  /** Parts that are template or generic: never imitate these. */
  avoid?: string[];
}

const WRITING_HEADER = `# Own writing (style few-shot for generated prose)

Used by the cover-letter engine as \`own_writing_samples\`: match the register and sentence
shapes, never the content, and never copy the parts listed under "Do not imitate".
`;

function sampleBlock(n: number, s: WritingSample): string {
  const lines = [`## Sample ${n}: ${s.title.trim()}`, ""];
  if (s.imitate?.length) lines.push("Imitate (the user's voice):", ...s.imitate.map((x) => `- ${x}`), "");
  if (s.avoid?.length) lines.push("Do not imitate (template or generic parts):", ...s.avoid.map((x) => `- ${x}`), "");
  lines.push("Text:", "", ...s.text.trim().split("\n").map((l) => (l ? `> ${l}` : ">")), "");
  return lines.join("\n");
}

/** Append (default) or replace the samples. Numbering continues after existing samples. */
export function writeWritingSamples(existing: string | null, samples: WritingSample[], mode: "append" | "replace" = "append"): string {
  const base = mode === "replace" || !existing?.trim() ? WRITING_HEADER : existing.trimEnd() + "\n";
  const already = mode === "replace" ? 0 : (base.match(/^## Sample \d+/gm) ?? []).length;
  return [base, ...samples.map((s, i) => sampleBlock(already + i + 1, s))].join("\n").trimEnd() + "\n";
}

// --- STAR stories ------------------------------------------------------------

/** Insert or replace one story (matched by title within its theme); the theme is created if new. */
export function upsertStarStory(existing: StarStories | null, theme: string, story: StarStory, now = new Date().toISOString()): { data: StarStories; replaced: boolean } {
  const data: StarStories = existing ? structuredClone(existing) : { themes: [] };
  data.themes ??= [];
  let t = data.themes.find((x) => x.theme === theme);
  if (!t) {
    t = { theme, stories: [] };
    data.themes.push(t);
  }
  const i = t.stories.findIndex((s) => s.story === story.story);
  if (i >= 0) t.stories[i] = story;
  else t.stories.push(story);
  data.updated_at = now;
  return { data, replaced: i >= 0 };
}

// --- Metrics register ------------------------------------------------------

export interface MetricInput {
  /** Section heading, usually the role, e.g. "Acme Search (02-acme-search.md, 2021–2024)". */
  section: string;
  /** Short name of the number, e.g. "Query latency down 30%". */
  name: string;
  status: MetricStatus;
  /** Anything after the status on the header line: provenance tag, date, caveat. */
  status_note?: string;
  /** Detail bullets: baseline, how measured, who can confirm, what not to say. */
  details?: string[];
}

const REGISTER_HEADER = `# Metrics register

Every number used on a résumé, letter or in an interview, with its status.
DEFENDED: both sides on record and defensible. SCOPE: a scale fact, not an outcome.
PARTIAL: one side or a caveat missing. OPEN: not yet checked. RETIRED: never use.
`;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Insert or replace one entry. An entry is its `**name** — STATUS note` line
 * plus the `- ` bullets under it; it is replaced in place when the name exists
 * in the section, else appended to the section (created before "Operating
 * rules" when new).
 */
export function upsertMetricEntry(existing: string | null, m: MetricInput): { markdown: string; replaced: boolean } {
  const block = [
    `**${m.name.trim()}** — ${m.status}${m.status_note?.trim() ? ` ${m.status_note.trim()}` : ""}`,
    ...(m.details ?? []).map((d) => `- ${d.trim()}`),
  ];
  const lines = (existing?.trim() ? existing : REGISTER_HEADER).replace(/\s+$/, "").split("\n");
  const sectionIdx = lines.findIndex((l) => l.trim() === `## ${m.section.trim()}`);
  if (sectionIdx < 0) {
    const rulesIdx = lines.findIndex((l) => /^## Operating rules/i.test(l));
    const insert = ["", `## ${m.section.trim()}`, "", ...block, ""];
    if (rulesIdx >= 0) lines.splice(rulesIdx, 0, ...insert.slice(1));
    else lines.push(...insert);
    return { markdown: lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", replaced: false };
  }
  let end = lines.findIndex((l, i) => i > sectionIdx && /^## /.test(l));
  if (end < 0) end = lines.length;
  const header = new RegExp(`^\\*\\*${esc(m.name.trim())}\\*\\*\\s*[—–:-]`);
  const at = lines.findIndex((l, i) => i > sectionIdx && i < end && header.test(l));
  if (at >= 0) {
    let stop = at + 1;
    while (stop < end && /^- /.test(lines[stop])) stop++;
    lines.splice(at, stop - at, ...block);
    return { markdown: lines.join("\n").trimEnd() + "\n", replaced: true };
  }
  // Append at the end of the section, before its trailing blank lines.
  let tail = end;
  while (tail > sectionIdx + 1 && lines[tail - 1].trim() === "") tail--;
  lines.splice(tail, 0, "", ...block);
  return { markdown: lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", replaced: false };
}
