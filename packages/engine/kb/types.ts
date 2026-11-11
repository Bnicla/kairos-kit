/** Knowledge-base types — mirror kb-schema-v1.md. */

export type Provenance = "R" | "C" | "F" | "?";

/** Only these may ever reach a generation/scoring call. `?` is holding-pen only. */
export const USABLE_PROVENANCE: readonly Provenance[] = ["R", "C", "F"] as const;

export type Proficiency = "exposure" | "working" | "strong" | "expert";

export type SeniorityLevel =
  | "IC"
  | "Lead"
  | "Manager"
  | "Director"
  | "VP"
  | "C-level";

export interface ScopeEntry {
  value: string;
  prov: Provenance;
}

export interface SkillEntry {
  name: string;
  proficiency: Proficiency;
  recency: string;
  prov: Provenance;
}

export interface ExperienceFrontmatter {
  id: string;
  company: string;
  company_context?: string;
  location?: string;
  title: string;
  title_normalized?: string;
  start: string;
  end: string;
  seniority_level?: SeniorityLevel;
  domains?: string[];
  scope?: Record<string, ScopeEntry>;
  skills?: SkillEntry[];
  keywords?: string[];
}

export interface Experience {
  /** Drive file name, e.g. "02-northwind-search-platform.md" */
  fileName: string;
  /** Drive file id, when known */
  fileId?: string;
  frontmatter: ExperienceFrontmatter;
  /** Markdown body (voice-preserving prose) */
  body: string;
}

export interface EducationEntry {
  fileName: string;
  fileId?: string;
  frontmatter: Record<string, unknown>;
  body: string;
}
