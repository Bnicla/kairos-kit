/**
 * Per-user sourcing preferences. The search profile that drives the sweep is
 * USER DATA (sourcing/search-profile.json), never constants in code. First run
 * derives sensible defaults from the candidate's profile.md; after that the
 * stored file wins, and the preferences conversation edits it.
 */

import type { Store } from "@kairos/engine/store/types";
import type { SearchProfile } from "./types";
import { WORKDAY_MAX_SEARCH_TERMS } from "./adapters";
import { dailyRun, maxSourcedCards } from "../settings";

export const SEARCH_PROFILE_PATH = ["sourcing", "search-profile.json"];

export interface StoredSearchProfile extends SearchProfile {
  /** Free-text notes from the preferences conversation (context for triage). */
  notes?: string;
  updated_at: string;
  /** "derived" until the user has confirmed it in a conversation. */
  source: "derived" | "confirmed";
}

/** Frontmatter shape of profile.md that the derivation reads. */
export interface CandidateProfileFrontmatter {
  target_roles?: string[];
  target_seniority?: string;
  domains?: string[];
  preferences?: { location?: string } & Record<string, unknown>;
  role_shape_preference?: string;
}

const SENIORITY_VOCAB = [
  "principal", "staff", "senior", "lead", "director", "head of", "vp",
  "vice president", "group", "chief", "manager",
];

/** Single words that state a level, not a discipline. */
const LEVEL_WORDS = new Set([...SENIORITY_VOCAB, "junior", "associate", "intern", "internship", "entry", "level", "graduate", "trainee"]);

const DISCIPLINE_VOCAB = [
  "product", "engineering", "engineer", "design", "designer", "data",
  "marketing", "sales", "research", "operations", "finance", "security",
  "analytics", "science", "scientist",
];

/**
 * Early-career title words. Excluded by default only for a profile that
 * states a senior level and no early-career one: a student or a new graduate
 * is looking for exactly these. Refined per user in conversation.
 */
const EARLY_CAREER_EXCLUDES = ["intern", "internship", "junior", "apprentice"];
/** Stated levels that make the early-career words noise. */
const SENIOR_LEVEL = /\b(?:senior|principal|lead|director|head of|vp|vice president|chief)\b/;
/** Stated levels (or target roles) that make them the target. */
const EARLY_LEVEL = /\b(?:intern(?:ship)?s?|junior|entry|graduate|grad|apprentice(?:ship)?|trainee|student|associate|early career)\b/;

/** Default exclude terms for the level the candidate states; none when no level is stated. */
function defaultExcludes(levelText: string): string[] {
  return SENIOR_LEVEL.test(levelText) && !EARLY_LEVEL.test(levelText) ? [...EARLY_CAREER_EXCLUDES] : [];
}

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Derive a starting search profile from the candidate's own profile.md.
 * Heuristic by design: the preferences conversation is where it gets exact.
 */
export function deriveSearchProfile(
  fm: CandidateProfileFrontmatter,
  now: () => string = () => new Date().toISOString(),
): StoredSearchProfile {
  const roleText = (fm.target_roles ?? []).map(norm).join(" ");
  const seniorityText = `${roleText} ${norm(fm.target_seniority ?? "")}`;

  const function_terms = DISCIPLINE_VOCAB.filter((d) => roleText.includes(d));
  if (function_terms.length === 0 && fm.target_roles?.length) {
    // Unknown discipline: fall back to the meaningful words of the first
    // target role. Level words are left out when anything else remains: with
    // "senior" or "manager" as a function term, every senior or manager title
    // of any profession would pass the gate.
    const words = norm(fm.target_roles[0]).split(/[^a-z]+/).filter((w) => w.length > 3);
    const roleWords = words.filter((w) => !LEVEL_WORDS.has(w));
    function_terms.push(...(roleWords.length ? roleWords : words));
  }

  const seniority_terms = SENIORITY_VOCAB.filter((s) => seniorityText.includes(s));

  // Locations from the stated preference, split on common separators. The
  // sweep treats these as "counts as local" markers; remote postings match
  // through the remote flag, not this list.
  const locations = (fm.preferences?.location ?? "")
    .split(/[\/,;·]| or | and /i)
    .map(norm)
    .filter((l) => l.length > 1);

  const boost_terms = (fm.domains ?? []).map(norm);

  return {
    // No target roles: no function terms. Nothing is assumed; the sweep says
    // that it has nothing to look for until the user names a role.
    function_terms: [...new Set(function_terms)],
    exclude_terms: defaultExcludes(seniorityText),
    locations,
    boost_terms,
    seniority_terms,
    max_age_days: 7,
    ...(fm.role_shape_preference ? { notes: fm.role_shape_preference } : {}),
    international_ok: false,
    secondary_locations: [],
    updated_at: now(),
    source: "derived",
  };
}

export const loadSearchProfile = (s: Store) =>
  s.readJson<StoredSearchProfile>(SEARCH_PROFILE_PATH);

export const saveSearchProfile = (s: Store, p: StoredSearchProfile) =>
  s.writeJson(SEARCH_PROFILE_PATH, p);

/** A preferences update from a conversation tool: any subset of the fields. */
export type SearchProfileUpdate = Partial<Omit<StoredSearchProfile, "updated_at">>;

/**
 * Merge an update into the stored profile: fields present in the update win,
 * fields it omits are kept. Tool schemas have lagged the stored shape before
 * (watched_companies, triage_rules and excluded_locations were silently wiped
 * by a full overwrite), so a conversation save must never drop what it did not
 * mention. To clear a list, the update passes an empty array.
 */
export function mergeSearchProfile(
  existing: StoredSearchProfile | null,
  update: SearchProfileUpdate,
  now: () => string = () => new Date().toISOString(),
): StoredSearchProfile {
  const defined = Object.fromEntries(
    Object.entries(update).filter(([, v]) => v !== undefined),
  ) as SearchProfileUpdate;
  const base = existing ?? deriveSearchProfile({}, now);
  return { ...base, ...defined, updated_at: now() };
}

/** Load, merge an update, save. Returns the profile as written. */
export async function updateSearchProfile(
  s: Store,
  update: SearchProfileUpdate,
  now?: () => string,
): Promise<StoredSearchProfile> {
  const next = mergeSearchProfile(await loadSearchProfile(s), update, now);
  await saveSearchProfile(s, next);
  return next;
}

/**
 * The words sent to job sites that only answer a search (Workday), and the
 * ones the cap left out. The profile's search_terms when it has any, else its
 * function_terms; a function term that contains another one as whole words is
 * skipped (a search for "engineer" already returns what "software engineer"
 * would). At most WORKDAY_MAX_SEARCH_TERMS words, in the profile's order: each
 * one is a paged query against every such board. Empty when the profile names
 * no role at all.
 */
export function feedSearchTerms(p: Pick<SearchProfile, "function_terms" | "search_terms">): { terms: string[]; left_out: string[] } {
  const clean = (list: string[] | undefined) => [
    ...new Set((list ?? []).map((t) => (typeof t === "string" ? norm(t) : "")).filter(Boolean)),
  ];
  let words = clean(p.search_terms);
  if (!words.length) {
    const all = clean(p.function_terms);
    const within = (long: string, short: string) =>
      long !== short && new RegExp(`\\b${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(long);
    words = all.filter((t) => !all.some((u) => within(t, u)));
  }
  return { terms: words.slice(0, WORKDAY_MAX_SEARCH_TERMS), left_out: words.slice(WORKDAY_MAX_SEARCH_TERMS) };
}

const money = (n: number, currency = "USD") =>
  `${currency === "USD" ? "$" : ""}${n.toLocaleString("en-US")}${currency === "USD" ? "" : ` ${currency}`}`;

/** The pay floor in one plain line, e.g. "$80,000 a year (new york: $95,000)". */
export function describePayFloor(p: Pick<SearchProfile, "pay_floor">): string | null {
  const f = p.pay_floor;
  if (!f || typeof f.amount !== "number") return null;
  const per = f.period === "hour" ? "an hour" : f.period === "month" ? "a month" : "a year";
  const places = (f.by_location ?? []).map((l) => `${l.place}: ${money(l.amount, f.currency)}`);
  return `${money(f.amount, f.currency)} ${per}${places.length ? ` (${places.join("; ")})` : ""}${f.note ? `. ${f.note}` : ""}`;
}

/**
 * Rules the structured settings imply, in plain words for triage. Pay floor,
 * seniority ceiling, relocation and excluded companies are settings (so a
 * setup interview can fill and check them), and triage reads them through
 * these lines next to the user's own triage_rules.
 */
export function profileTriageRules(p: SearchProfile): string[] {
  const out: string[] = [];
  if (p.seniority_ceiling?.trim()) out.push(`Seniority ceiling: ${p.seniority_ceiling.trim()}. SKIP roles above it.`);
  const pay = describePayFloor(p);
  if (pay) out.push(`Pay floor: ${pay}. SKIP a posting whose stated pay range tops out below it; when pay is not stated, judge on fit.`);
  if (p.excluded_companies?.length) out.push(`Never shortlist these companies or their subsidiaries: ${p.excluded_companies.join(", ")}.`);
  if (p.relocation) {
    out.push(
      p.relocation.open
        ? `Open to relocating${p.relocation.places?.length ? ` to ${p.relocation.places.join(", ")}` : ""}${p.relocation.note ? ` (${p.relocation.note})` : ""}.`
        : "Not open to relocating: onsite or hybrid roles outside the listed locations are out unless remote.",
    );
  }
  return out;
}

/** The user's own triage rules followed by the rules the structured settings imply. */
export function allTriageRules(p: SearchProfile): string[] {
  return [...(p.triage_rules ?? []), ...profileTriageRules(p)];
}

/** Human-readable summary for the settings page and the conversation opener. */
export function describeSearchProfile(p: StoredSearchProfile): string {
  const lines = [
    `Discipline terms: ${p.function_terms.join(", ") || "(none)"}`,
    `Seniority terms: ${p.seniority_terms.join(", ") || "(any)"}`,
    `Locations counted as local: ${p.locations.join(", ") || "(none — remote only)"}`,
    `Higher-bar locations (strong fits only): ${(p.secondary_locations ?? []).join(", ") || "(none)"}`,
    `Interest boosts: ${p.boost_terms.join(", ") || "(none)"}`,
    `Excluded words: ${p.exclude_terms.join(", ") || "(none)"}`,
    `Freshness window: postings from the last ${p.max_age_days} days`,
    `International postings: ${p.international_ok ? "included" : "excluded"}`,
  ];
  if (p.excluded_companies?.length) lines.push(`Excluded companies: ${p.excluded_companies.join(", ")}`);
  if (p.excluded_locations?.length) lines.push(`Excluded places (onsite/hybrid): ${p.excluded_locations.join(", ")}`);
  if (p.seniority_ceiling) lines.push(`Seniority ceiling: ${p.seniority_ceiling}`);
  const pay = describePayFloor(p);
  if (pay) lines.push(`Pay floor: ${pay}`);
  if (p.relocation) lines.push(`Relocation: ${p.relocation.open ? `open${p.relocation.places?.length ? ` (${p.relocation.places.join(", ")})` : ""}` : "no"}`);
  const dream = p.dream_companies ?? [];
  lines.push(`Dream companies checked directly: ${dream.map((c) => c.name).join(", ") || "(none)"}`);
  lines.push(`Board column: ${maxSourcedCards(p)} sourced cards`);
  const run = dailyRun(p);
  lines.push(`Daily run: ${run.enabled ? `at ${run.time}` : "off"}`);
  if (p.notes) lines.push(`Notes: ${p.notes}`);
  lines.push(p.source === "derived" ? "(Derived automatically from your profile — not yet confirmed.)" : "(Confirmed by you.)");
  return lines.join("\n");
}
