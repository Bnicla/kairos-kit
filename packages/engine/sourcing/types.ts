/** Sourcing module shared shapes (spec: kairos-sourcing-v1-spec.md). */

export type SourcingAts = "greenhouse" | "lever" | "ashby" | "rippling" | "workday" | "smartrecruiters" | "bamboohr";

export interface RegistryEntry {
  ats: SourcingAts;
  /** Board slug; for workday: "tenant@wdN@site" composite. */
  slug: string;
  company?: string;
}

export interface Posting {
  ats: SourcingAts;
  slug: string;
  company: string;
  title: string;
  url: string;
  location: string;
  remote: boolean;
  /** ISO date when known; null when the feed doesn't say. */
  posted_at: string | null;
  /** Age in days at fetch time; null when posted_at is null. */
  age_days: number | null;
}

export interface SearchProfile {
  /** Title must contain one of these (function gate — deliberately loose). */
  function_terms: string[];
  /** Title containing any of these is dropped (noise gate). */
  exclude_terms: string[];
  /**
   * Words sent as the search text to job sites that only answer a search
   * (Workday): one paged query per word, capped (see feedSearchTerms). Absent
   * or empty: the first few function_terms. Set it when the function terms are
   * many, or when one broad word finds everything ("engineer", "nurse").
   */
  search_terms?: string[];
  /**
   * Exact phrases that name the user's own role in a job title, whole words,
   * any case (e.g. "software engineer", "engineering manager"). Read only
   * together with soft_exclude_terms.
   */
  role_phrases?: string[];
  /**
   * The exclude_terms that name something the role may work for or with, as
   * opposed to a role or domain that is never a fit (e.g. "sales" for a
   * software engineer: "Software Engineer, Sales Platform" is a fit, "Sales
   * Engineer" is not). A term listed here still excludes, except on a title
   * that carries a role phrase in a different part of the title (parts are
   * split on punctuation). Absent or empty, or no role_phrases: every exclude
   * term blocks unconditionally.
   */
  soft_exclude_terms?: string[];
  /** Substrings marking a location as a direct match (lowercased compare). */
  locations: string[];
  /** Words that boost ranking when present in the title. */
  boost_terms: string[];
  /** Seniority words that boost ranking (rank, never gate). */
  seniority_terms: string[];
  /** Hard recency cap in days (strong default: 7). */
  max_age_days: number;
  /** Companies the user especially wants (lowercased substrings matched
   *  against company name/slug). Strong rank boost, never a gate. */
  watched_companies?: string[];
  /**
   * User-stated triage rules, injected verbatim into the triage prompt as
   * hard guidance (e.g. "crypto/web3 companies are out of scope entirely",
   * "Chief of Staff roles are a priority shape"). Exists because the triage
   * model repeatedly cut in-scope shapes and kept excluded ones when it only
   * had the generic prompt (observed 2026-09-07: cut a watched-company Chief
   * of Staff, kept a BD-titled role the user excludes).
   */
  triage_rules?: string[];
  /** Locations acceptable ONLY for strong fits (higher bar than `locations`):
   *  a posting here must carry both a seniority and a domain signal to
   *  survive. Also exempts these places from the non-domestic drop, so
   *  international entries (e.g. "lisbon") work. */
  secondary_locations?: string[];
  /** Hard location exclusions (lowercased substrings): an onsite/hybrid
   *  posting whose location names one of these, and none of the primary
   *  locations, is dropped. Remote postings are exempt. Checked in code, not
   *  only in the triage prompt, which let excluded places through when lenient. */
  excluded_locations?: string[];
  /** When true, postings clearly outside the home country stay in (ranked
   *  like any other location). When false or absent, they are dropped unless
   *  listed in `secondary_locations`. */
  international_ok?: boolean;
  /** Companies checked directly every day through their own career API,
   *  including ones the board sweep cannot see (read by dream-watch). Absent
   *  or empty: dream-watch has nothing to watch and says so. */
  dream_companies?: DreamCompany[];
  /** Board display settings. */
  board?: {
    /** Sourced cards shown in the board column (default 10); the rest stay on the All-sourced page. */
    max_sourced_cards?: number;
  };
  /** Companies the user will not work for (lowercased substrings, matched as
   *  whole words against the posting's company name and board slug). Hard
   *  gate: an excluded company's postings never reach triage. */
  excluded_companies?: string[];
  /** Minimum pay the user will consider. Most feeds carry no pay, so this is
   *  given to triage as a rule (see profileTriageRules) and to the person
   *  reading a score; it never drops a posting in code. */
  pay_floor?: PayFloor;
  /** The highest level the user will consider, in their words (e.g. "nothing
   *  above Senior PM", "no Director or VP"). Given to triage as a hard rule. */
  seniority_ceiling?: string;
  /** Whether the user would move for a role, and where. Recorded for triage;
   *  the places themselves belong in secondary_locations. */
  relocation?: { open: boolean; places?: string[]; note?: string };
  /** Optional module the daily search loads after triage, for extra logging
   *  such as a second model scoring the same postings. A path relative to the
   *  Kairos repo, or absolute. Its default export receives the run result and
   *  never changes it. Not set by /setup. */
  after_triage_hook?: string;
  /** The scheduled daily run (prune, sweep, dream watch). */
  daily_run?: {
    /** Default true. */
    enabled?: boolean;
    /** Local time, 24h "HH:MM" (default "08:15"). */
    time?: string;
  };
}

/** A pay floor: one amount, optionally different by place. */
export interface PayFloor {
  /** Base pay, a plain number in `currency` per `period`. */
  amount: number;
  /** ISO code, default "USD". */
  currency?: string;
  /** Default "year". */
  period?: "year" | "month" | "hour";
  /** A different floor for named places, e.g. [{ place: "new york", amount: 95000 }]. */
  by_location?: { place: string; amount: number }[];
  note?: string;
}

/**
 * One dream company. `ats` picks the fetcher:
 *   - greenhouse | ashby | lever: `slug` is the board id (boards-api / posting-api / api.lever.co).
 *   - google: Google Careers search page; `queries` (default: the profile's
 *     function terms quoted) and `location` (default "United States").
 *   - eightfold: Eightfold career sites; `host`, `domain`, `queries`, `location`.
 *   - browser: no server-side feed (the site blocks direct calls). dream-watch
 *     prints a reminder to check `url` in a browser, running `script` there
 *     when one is given.
 */
export interface DreamCompany {
  name: string;
  ats: "greenhouse" | "ashby" | "lever" | "google" | "eightfold" | "browser";
  slug?: string;
  queries?: string[];
  location?: string;
  host?: string;
  domain?: string;
  url?: string;
  script?: string;
  /** Why it is watched, when added; for the user, never read by code. */
  note?: string;
}

export interface RankedPosting extends Posting {
  rank_score: number;
  location_fit: "match" | "stretch";
  reasons: string[];
  /** Set by triage: rough fit guess (pre-screen, never a real score). */
  guess_band?: "STRONG" | "COMPETITIVE" | "DEVELOPING" | "WEAK";
  one_liner?: string;
  /**
   * Why a role that cleared the mechanical prefilter did NOT reach the final
   * board. Only set on the `dropped` list (the "view all sourced" surface):
   *   - "over_cap"     — beyond the triage input cap, never reviewed
   *   - "triage_cut"   — triage did not shortlist it
   *   - "same_company" — shortlisted, but another role held the company's slot
   *   - "below_cut"    — shortlisted, but ranked below the final cap
   */
  drop_reason?: "over_cap" | "triage_cut" | "same_company" | "below_cut";
}

export interface SweepResult {
  boards_swept: number;
  boards_failed: number;
  postings_fetched: number;
  survivors: RankedPosting[];
  stretch: RankedPosting[];
}
