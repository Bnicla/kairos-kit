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
import matter from "./front-matter";
import type { SearchProfile } from "./sourcing/types";
import type { Paper } from "./docx-render";
import { DEFAULT_ALLOWED_METRIC_STATUSES, METRIC_STATUSES, type MetricStatus } from "./metrics-register";
import type { Store } from "./store/types";
import type { MatchBand } from "./types";

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

export type ScoreConfidence = "high" | "medium" | "low";

/** When Kairos shows, by itself, the people the user knows at a company (contacts.ts). */
export interface ReferralSettings {
  /** false: never shown unasked. The user can still ask for the contacts at a company. */
  enabled?: boolean;
  /** Lowest score band that counts as a good match. Unset: COMPETITIVE. */
  min_band?: MatchBand;
  /** Lowest score confidence. Unset: high. */
  min_confidence?: ScoreConfidence;
  /**
   * true: contacts stay shown after the application is sent (applied,
   * interviewing, offer, on hold). Unset or false: they are shown only while
   * the application is not sent yet (captured, scored, drafted).
   */
  after_applying?: boolean;
}

/** `ReferralSettings` with every default applied. */
export type ReferralRule = Required<ReferralSettings>;

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
  /** Which applications show the user's contacts at the company as possible referrals. */
  referrals?: ReferralSettings;
  /** The section headings the user renamed (profile `resume_headings`); the others keep their default. */
  resume_headings?: Partial<ResumeHeadings>;
}

/**
 * The section headings of a résumé. The defaults are the owner's decision of 15 November 2026: "Keep them, but users
 * can change them through conversation". A user renames one by asking; the choice is theirs, kept in their profile
 * (`resume_headings`), and every later résumé of theirs is written with it.
 */
export interface ResumeHeadings {
  summary: string;
  experience: string;
  projects: string;
  education: string;
  skills: string;
}
export const DEFAULT_RESUME_HEADINGS: ResumeHeadings = { summary: "Executive Summary", experience: "Professional Experience", projects: "Projects", education: "Education", skills: "Skills" };
export const RESUME_HEADING_KEYS = Object.keys(DEFAULT_RESUME_HEADINGS) as (keyof ResumeHeadings)[];

/** A heading as it can be written: one short line of plain text. Anything else is not a heading and is ignored. */
export function cleanHeading(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/[#|*_`<>\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length >= 2 && t.length <= 40 && /\p{L}/u.test(t) ? t : undefined;
}

/** The headings a user renamed, out of a profile's `resume_headings`: only those that differ from the default. */
export function renamedHeadings(value: unknown): Partial<ResumeHeadings> {
  const out: Partial<ResumeHeadings> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const k of RESUME_HEADING_KEYS) {
    const h = cleanHeading((value as Record<string, unknown>)[k]);
    if (h && h.toLowerCase() !== DEFAULT_RESUME_HEADINGS[k].toLowerCase()) out[k] = h;
  }
  return out;
}

/** The five headings of a résumé: the user's where they renamed one, the default otherwise. */
export const headingsFor = (renamed?: Partial<ResumeHeadings> | null): ResumeHeadings => ({ ...DEFAULT_RESUME_HEADINGS, ...renamedHeadings(renamed) });

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
  const headings = renamedHeadings(fm.resume_headings);
  if (Object.keys(headings).length) out.resume_headings = headings;
  const map = str(fm.stories_map);
  if (map) out.stories_map = map;
  const ref = fm.referrals as Record<string, unknown> | undefined;
  if (ref && typeof ref === "object" && !Array.isArray(ref)) {
    const r: ReferralSettings = {};
    if (typeof ref.enabled === "boolean") r.enabled = ref.enabled;
    if (typeof ref.after_applying === "boolean") r.after_applying = ref.after_applying;
    // A value that is not a band or a confidence is ignored: a typo must not widen or close the rule.
    const band = str(ref.min_band)?.toUpperCase();
    if (band && (MATCH_BANDS as readonly string[]).includes(band)) r.min_band = band as MatchBand;
    const confidence = str(ref.min_confidence)?.toLowerCase();
    if (confidence && (SCORE_CONFIDENCES as readonly string[]).includes(confidence)) r.min_confidence = confidence as ScoreConfidence;
    out.referrals = r;
  }
  return out;
}

const MATCH_BANDS = ["STRONG", "COMPETITIVE", "DEVELOPING", "WEAK"] as const satisfies readonly MatchBand[];
const SCORE_CONFIDENCES = ["high", "medium", "low"] as const satisfies readonly ScoreConfidence[];

/**
 * The default rule for showing contacts unasked: the score says the user meets
 * the core bar of the role (COMPETITIVE or STRONG) and says so with high
 * confidence. Asking someone for a referral costs that person time, so the
 * default waits for the applications the score is sure about. It also stops
 * once the application is sent (the owner's decision of 13 November 2026): a
 * referral is asked for before applying. `after_applying: true` keeps the
 * contacts shown on sent applications.
 */
export const DEFAULT_REFERRAL_RULE: ReferralRule = { enabled: true, min_band: "COMPETITIVE", min_confidence: "high", after_applying: false };

/** The referral rule of a profile, defaults applied. */
export function referralRule(settings: Pick<ProfileSettings, "referrals">): ReferralRule {
  return { ...DEFAULT_REFERRAL_RULE, ...(settings.referrals ?? {}) };
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
 * Whether a pattern the user wrote as a regular expression ("/x/i") is run.
 * On the user's own machine it is. Where one process serves several users
 * (the hosted connector) it is not: a pattern such as /(a+)+$/ against a long
 * run of "a" never finishes, and every user's requests would wait behind it.
 * There, only plain phrases are checked.
 */
let userRegexAllowed = true;
export function allowUserRegex(allowed: boolean): void {
  userRegexAllowed = allowed;
}

const USER_REGEX = /^\/(.+)\/([a-z]*)$/;
/** The user's patterns that are written as regular expressions and are not run here. */
export function skippedBannedPatterns(patterns: string[] | undefined): string[] {
  return userRegexAllowed ? [] : (patterns ?? []).filter((p) => USER_REGEX.test(p));
}

/**
 * Turn the user's banned_patterns into regexes. "/x/i" is a regex; anything
 * else is a literal phrase, escaped, matched as whole words, case-insensitive.
 * An invalid regex is skipped rather than breaking every letter check.
 */
export function compileBannedPatterns(patterns: string[] | undefined): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns ?? []) {
    const m = p.match(USER_REGEX);
    if (m && !userRegexAllowed) continue;
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
