/**
 * User settings that used to be constants in code. Two homes, both user data:
 *
 *   - profile.md frontmatter: résumé and writing settings (standing_base_app,
 *     resume_leadin_aliases, target_pages, resume_page2_anchor, paper,
 *     metrics_allowed_statuses, voice, stories_map).
 *   - sourcing/search-profile.json: sourcing settings (dream_companies,
 *     board.max_sourced_cards, daily_run). Types in sourcing/types.ts.
 *
 * Every reader here returns a safe default when the file or the field is
 * absent, so a new user with an empty data folder gets working behaviour.
 */
import matter from "gray-matter";
import type { SearchProfile } from "./sourcing/types";
import type { Paper } from "./docx-render";
import { DEFAULT_ALLOWED_METRIC_STATUSES, METRIC_STATUSES, type MetricStatus } from "./metrics-register";
import type { Store } from "./store/types";

export interface VoiceSettings {
  /**
   * Phrases the user never wants in letters and answers. Plain entries match
   * case-insensitively as whole words; an entry written as /pattern/flags is a
   * regular expression.
   */
  banned_patterns?: string[];
  /** When true, banned_patterns REPLACES the built-in phrase list instead of extending it. */
  replace_default_patterns?: boolean;
}

export interface ProfileSettings {
  /** appId of the standing generic résumé that tailor-resume clones when a spec names no base. */
  standing_base_app?: string;
  /** Old lead-in name -> current lead-in name, so older tailoring specs keep matching the base. */
  resume_leadin_aliases?: Record<string, string>;
  target_pages?: 1 | 2;
  resume_page2_anchor?: string;
  /**
   * Paper size of the résumé and the cover letter: "letter" (US Letter) or
   * "a4". Unset: US Letter for a United States search, A4 for a search that
   * includes other countries (see `resumePaper`).
   */
  paper?: Paper;
  /**
   * Metrics-register statuses whose numbers may appear in a résumé or letter.
   * Unset: DEFENDED and SCOPE. Listing all five statuses turns the register
   * check off.
   */
  metrics_allowed_statuses?: MetricStatus[];
  voice?: VoiceSettings;
  /** Path, inside the data folder, of the stories map read by the deep-dives page. */
  stories_map?: string;
}

/** Where the deep-dives page reads the stories map when profile.md sets no `stories_map`. */
export const DEFAULT_STORIES_MAP = "knowledge-base/stories-map.json";

/**
 * The stories map path as data-folder path parts. A path that is absolute or
 * climbs out of the data folder ("..") falls back to the default.
 */
export function storiesMapPath(settings: Pick<ProfileSettings, "stories_map">): string[] {
  const parts = (settings.stories_map ?? "").split("/").filter(Boolean);
  if (!parts.length || settings.stories_map!.startsWith("/") || parts.includes("..")) return DEFAULT_STORIES_MAP.split("/");
  return parts;
}

function frontmatter(profileRaw: string | null | undefined): Record<string, unknown> {
  if (!profileRaw) return {};
  try {
    return (matter(profileRaw).data ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Parse the settings out of profile.md's raw text (null/absent file -> {}). */
export function readProfileSettings(profileRaw: string | null | undefined): ProfileSettings {
  const fm = frontmatter(profileRaw);
  const out: ProfileSettings = {};
  const base = str(fm.standing_base_app);
  if (base) out.standing_base_app = base;
  const aliases = fm.resume_leadin_aliases;
  if (aliases && typeof aliases === "object" && !Array.isArray(aliases)) {
    out.resume_leadin_aliases = Object.fromEntries(
      Object.entries(aliases as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [string, string][],
    );
  }
  if (fm.target_pages === 1 || fm.target_pages === 2) out.target_pages = fm.target_pages;
  const anchor = str(fm.resume_page2_anchor);
  if (anchor) out.resume_page2_anchor = anchor;
  const paper = str(fm.paper)?.toLowerCase();
  if (paper === "letter" || paper === "a4") out.paper = paper;
  if (Array.isArray(fm.metrics_allowed_statuses)) {
    const wanted = new Set(fm.metrics_allowed_statuses.filter((x): x is string => typeof x === "string").map((x) => x.trim().toUpperCase()));
    // A list with no valid status is ignored: a typo must not open the gate or close it entirely.
    const statuses = METRIC_STATUSES.filter((st) => wanted.has(st));
    if (statuses.length) out.metrics_allowed_statuses = statuses;
  }
  const voice = fm.voice as Record<string, unknown> | undefined;
  if (voice && typeof voice === "object") {
    const v: VoiceSettings = {};
    if (Array.isArray(voice.banned_patterns)) v.banned_patterns = voice.banned_patterns.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    if (voice.replace_default_patterns === true) v.replace_default_patterns = true;
    out.voice = v;
  }
  const map = str(fm.stories_map);
  if (map) out.stories_map = map;
  return out;
}

/**
 * The paper for a résumé or letter. The profile's `paper` wins. With none set,
 * the search decides: the default search is limited to the United States
 * (`international_ok` false or absent, or no search profile yet), where
 * résumés are printed on US Letter; a search that takes postings from other
 * countries gets A4.
 */
export function resumePaper(
  settings: Pick<ProfileSettings, "paper">,
  search: Pick<SearchProfile, "international_ok"> | null | undefined,
): Paper {
  return settings.paper ?? (search?.international_ok === true ? "a4" : "letter");
}

/** `resumePaper` read from a data folder (profile.md and sourcing/search-profile.json). */
export async function loadResumePaper(store: Pick<Store, "readFile" | "readJson">): Promise<Paper> {
  const [profileRaw, search] = await Promise.all([
    store.readFile(["profile.md"]),
    store.readJson<Pick<SearchProfile, "international_ok">>(["sourcing", "search-profile.json"]),
  ]);
  return resumePaper(readProfileSettings(profileRaw), search);
}

/** The register statuses whose numbers may appear in a document (default DEFENDED and SCOPE). */
export function allowedMetricStatuses(settings: Pick<ProfileSettings, "metrics_allowed_statuses">): readonly MetricStatus[] {
  return settings.metrics_allowed_statuses ?? DEFAULT_ALLOWED_METRIC_STATUSES;
}

/**
 * Turn the user's banned_patterns into regexes. "/x/i" is a regex; anything
 * else is a literal phrase, escaped, matched as whole words, case-insensitive.
 * An invalid regex is skipped rather than breaking every letter check.
 */
export function compileBannedPatterns(patterns: string[] | undefined): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns ?? []) {
    const m = p.match(/^\/(.+)\/([a-z]*)$/);
    try {
      if (m) out.push(new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i"));
      else {
        const esc = p.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
        out.push(new RegExp(`(?<![\\w])${esc}(?![\\w])`, "i"));
      }
    } catch {
      /* invalid user regex: ignored */
    }
  }
  return out;
}

// --- Sourcing settings (search-profile.json) --------------------------------

/** Sourced cards shown in the board column when the profile sets none. */
export const DEFAULT_MAX_SOURCED_CARDS = 10;
/** Daily run time when the profile sets none (24h "HH:MM", local time). */
export const DEFAULT_DAILY_RUN_TIME = "08:15";

export function maxSourcedCards(profile: Pick<SearchProfile, "board"> | null | undefined): number {
  const n = profile?.board?.max_sourced_cards;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_SOURCED_CARDS;
}

export function dailyRun(profile: Pick<SearchProfile, "daily_run"> | null | undefined): { enabled: boolean; time: string; hour: number; minute: number } {
  const t = profile?.daily_run?.time;
  const m = typeof t === "string" ? t.match(/^([01]?\d|2[0-3]):([0-5]\d)$/) : null;
  const time = m ? `${m[1].padStart(2, "0")}:${m[2]}` : DEFAULT_DAILY_RUN_TIME;
  const [hour, minute] = time.split(":").map(Number);
  return { enabled: profile?.daily_run?.enabled !== false, time, hour, minute };
}
