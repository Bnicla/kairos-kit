/**
 * The "Line origins" view of a tailored résumé: each line beside the fact of
 * the knowledge base it comes from. This file holds what the view shows, apart from
 * how it is drawn, so that the local dashboard (a React component) and the
 * connector's application page (plain DOM) show the same thing: the data, the
 * grouping by role, the counts, the labels and the explanation.
 */
import matter from "./front-matter";
import { loadEducation, loadExperiences } from "./kb/store";
import { readLineOrigins } from "./line-origin";
import { cleanHeading } from "./settings";
import type { Store } from "./store/types";
import type { GeneratedResume, LineOrigin, OriginStrength } from "./types";

export interface LineOriginView {
  /** False for a résumé saved before origins were recorded: they are computed on read, from the knowledge base as it is now. */
  saved: boolean;
  lines: LineOrigin[];
  /** "Company · Title" of each role, by its index in the résumé. */
  roles: string[];
  /** The summary's heading on this résumé, when the user renamed it. */
  summaryHeading?: string;
}

/**
 * The line origins of the saved résumé. An older resume.json has none: they
 * are computed here from the knowledge base. Advisory section only: any failure (a
 * hand-edited file, an unreadable record) shows nothing rather than an error.
 */
export async function loadLineOriginView(store: Store, gen: GeneratedResume | null | undefined): Promise<LineOriginView | null> {
  if (!gen?.resume || !Array.isArray(gen.resume.experience)) return null;
  try {
    const saved = Array.isArray(gen.line_origins);
    let candidateName: string | undefined;
    if (!saved) {
      const profileRaw = await store.readFile(["profile.md"]);
      const name = profileRaw ? (matter(profileRaw).data as { name?: unknown }).name : undefined;
      if (typeof name === "string") candidateName = name;
    }
    const [experiences, education] = saved ? [[], []] : await Promise.all([loadExperiences(store), loadEducation(store).catch(() => [] as string[])]);
    const { lines } = readLineOrigins(gen, experiences, { candidateName, education });
    const summaryHeading = cleanHeading(gen.resume.headings?.summary);
    return lines.length ? { saved, lines, roles: gen.resume.experience.map((e) => `${e.company} · ${e.title}`), ...(summaryHeading ? { summaryHeading } : {}) } : null;
  } catch {
    return null;
  }
}

/** The chip of each strength: its label and its colour family. */
export const ORIGIN_CHIP: Record<OriginStrength, { tone: "success" | "info" | "warn"; label: string }> = {
  strong: { tone: "success", label: "Strong" },
  partial: { tone: "info", label: "Partial" },
  none: { tone: "warn", label: "None" },
};

/** The explanation under the section's title. */
export const ORIGIN_NOTE =
  "Each line of the résumé beside the fact of your knowledge base it comes from, found by matching words and numbers. Strong: the facts hold most of the line, in their wording, and all its numbers. Partial: the line was rewritten further, says more than the facts found, or (a summary sentence) is composed from several of them. None: no fact was found; confirm the fact, reword the line or drop it. An origin shows where a line comes from. It does not show that the line is true: a line can keep a fact's words and still say more than the fact does, and the stretch check lists the lines where it finds that.";
/** Added for a résumé saved before origins were recorded. */
export const ORIGIN_NOTE_COMPUTED = " This résumé was saved before origins were recorded: they are computed now, from your knowledge base as it is today.";

/** Longest fact shown in full; a longer one is cut, its provenance tag kept. */
export const FACT_MAX = 420;

/** A résumé line without its bold marks. */
export const plainLine = (s: string) => s.replace(/\*\*/g, "").trim();

/** A fact as the view shows it: whole, or cut at FACT_MAX with its closing tag ([R], [C] or [F]) kept. */
export function cutFact(text: string): string {
  if (text.length <= FACT_MAX) return text;
  return `${text.slice(0, FACT_MAX - 1).replace(/\s*\[[RCF]\]\s*/g, " ").trimEnd()}… ${text.match(/\[[RCF]\]\s*$/)?.[0] ?? ""}`;
}

/** A fact split at its provenance tags, so that a view can colour them: text, tag, text... */
export function factParts(text: string): { text: string; tag?: "R" | "C" | "F" }[] {
  return text
    .split(/(\[[RCF]\])/)
    .filter((part) => part !== "")
    .map((part) => (/^\[[RCF]\]$/.test(part) ? { text: part, tag: part[1] as "R" | "C" | "F" } : { text: part }));
}

/** What a view writes before a fact that comes from an education entry, to name the entry. */
export const educationLabel = (fact: { education?: string }) => (fact.education ? `Education · ${fact.education}: ` : "");

export function originCounts(lines: LineOrigin[]): Record<OriginStrength, number> {
  const count = (s: OriginStrength) => lines.filter((l) => l.strength === s).length;
  return { strong: count("strong"), partial: count("partial"), none: count("none") };
}

/** The lines in the view's order: the executive summary, then each role of the résumé; a group with no line is left out. */
export function originGroups(view: LineOriginView): { label: string; lines: LineOrigin[] }[] {
  return [
    { label: view.summaryHeading ?? "Executive summary", lines: view.lines.filter((l) => l.kind === "summary") },
    ...view.roles.map((label, role) => ({ label, lines: view.lines.filter((l) => l.kind !== "summary" && l.role === role) })),
  ].filter((g) => g.lines.length);
}
