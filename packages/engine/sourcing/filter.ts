import { isLocationCountPlaceholder } from "./adapters";
import type { Posting, RankedPosting, SearchProfile } from "./types";
import { postingKey } from "./url-key";

/**
 * Deterministic prefilter + ranking (spec §6, with the 2026-07-28 amendments):
 *  - function gate only (loose); seniority RANKS, never gates (lesson from a missed role)
 *  - location mismatch on an otherwise-strong posting → labeled "stretch"
 *    bucket, never silently dropped (lesson from two missed roles)
 *  - STRONG recency bias: hard cap at max_age_days (default 7); ranking is
 *    newest-first inside the window. Unknown-date postings survive the gate
 *    (some feeds carry no date) but rank below any dated posting.
 */

const norm = (s: string) => s.toLowerCase();

const termPattern = (term: string, flags = "i") =>
  new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, flags);

// Compiled once per term: the gate runs on every fetched posting (~300K a sweep).
const wordPatterns = new Map<string, RegExp>();

/** Word-boundary match: "product" must not match "production". */
const hasWord = (text: string, term: string) => {
  let re = wordPatterns.get(term);
  if (!re) wordPatterns.set(term, (re = termPattern(term)));
  return re.test(text);
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Compiled once per term, like wordPatterns.
const signalPatterns = new Map<string, RegExp[]>();

/**
 * Title signal match for the seniority and domain (boost) terms. A substring
 * test let "ai" match inside "Retail", which cleared the secondary-city bar
 * for a retail role (dry run, 2026-11-05). The term must be a whole word,
 * plain or with a plural or "-er" ending ("Agents", "LLMs", "Leader"), so
 * "Staffing" and "Head Office" stay out. A term of three letters or fewer
 * ("ai", "ml", "vp") also counts written in capitals and glued to a word
 * ("GenAI", "OpenAI", "MLOps", "SVP"), which the substring test used to
 * catch; an all-caps word that only contains it ("RETAIL", "AIRBUS", "HTML")
 * does not count: at most one capital before it, none right after it unless
 * a new word starts there ("AIOps").
 */
export function hasSignal(title: string, term: string): boolean {
  let res = signalPatterns.get(term);
  if (!res) {
    const t = norm(term).trim();
    res = t ? [new RegExp(`\\b${escapeRe(t)}(?:s|es|ers?)?\\b`, "i")] : [];
    if (t.length > 0 && t.length <= 3 && /^[a-z]+$/.test(t)) {
      res.push(new RegExp(`(?<![A-Z]{2})${t.toUpperCase()}(?![a-z])(?![A-Z](?![a-z]))`));
    }
    signalPatterns.set(term, res);
  }
  return res.some((re) => re.test(title));
}

/**
 * Location marker match. Markers of three letters or fewer ("ma", "ny", "nyc",
 * "sf") must be whole words, or "il" would match "Philadelphia" and "ma" would
 * match "Omaha". Longer markers keep the substring match ("denver" matches
 * "Greater Denver").
 */
const placeHas = (loc: string, marker: string) => {
  const m = norm(marker).trim();
  if (!m) return false;
  return m.length <= 3 ? hasWord(loc, m) : loc.includes(m);
};

/**
 * Exclude terms that name a function a product manager may work FOR ("AI
 * Sales Platform", "Unified Support", "ex-product engineer"), as opposed to
 * a domain the user rules out (ads, crypto) or a role/level that is never a
 * fit (intern, designer, product marketing, counsel). On a title with an
 * explicit product-management phrase these do not exclude: the miss audit of
 * 2026-11-05 found "Senior Product Manager, AI Sales Platform" blocked by
 * "sales" and "Sr Principal, Product Manager - Unified Support & AI
 * Experience" blocked by "support". Hard-coded on purpose: the profile's
 * exclude_terms stay one flat list, and every term not named here keeps
 * blocking unconditionally.
 */
const FUNCTION_OVERRIDE_TERMS = new Set([
  "sales", "support", "engineer", "account", "analyst", "scientist", "researcher", "writer", "coordinator",
]);
const EXPLICIT_PM_PHRASE =
  /\bproduct manag\w*|\bhead of product\b|\bdirector,? (?:of )?product\b|\bgroup product\b|\bprincipal product\b|\bproduct lead\b|\bvp,? (?:of )?product\b/gi;
/** Titles that never get the override, whatever else they say. */
const NEVER_OVERRIDDEN = /\bproduct marketing\b|\bmarketing manager\b|\bproduct owner\b|\bassociate product\b|\bdesigner\b/i;
/**
 * Title parts: the override needs the excluded word in a different part from
 * the PM phrase, so "Product Manager, AI Sales Platform" passes while "Head of
 * Product Support" and "Principal Product Engineer" (one part: the role IS
 * support or engineering) stay excluded.
 */
const TITLE_PART_BREAK = /[,|:;/()[\]–—-]/g;

/** Index of the title part (split on punctuation) that holds character `at`. */
const partAt = (title: string, at: number): number => (title.slice(0, at).match(TITLE_PART_BREAK) ?? []).length;

function excludeOverridden(title: string, term: string): boolean {
  if (!FUNCTION_OVERRIDE_TERMS.has(norm(term).trim())) return false;
  if (NEVER_OVERRIDDEN.test(title)) return false;
  const pmParts = new Set([...title.matchAll(EXPLICIT_PM_PHRASE)].map((m) => partAt(title, m.index! + m[0].length - 1)));
  if (pmParts.size === 0) return false;
  return [...title.matchAll(termPattern(term, "gi"))].every((m) => !pmParts.has(partAt(title, m.index!)));
}

export type FunctionGateVerdict = "pass" | "no_function_term" | "exclude_term";

/**
 * The function gate, with its reason. A title needs a function term; a title
 * that has one is then blocked by any exclude term, except the function-type
 * terms above on an explicit product-management title. "exclude_term" means
 * an exclude term cut a title the function terms would have kept.
 */
export function functionGateVerdict(title: string, profile: SearchProfile): FunctionGateVerdict {
  if (!profile.function_terms.some((f) => hasWord(title, f))) return "no_function_term";
  const blocked = profile.exclude_terms.some((x) => hasWord(title, x) && !excludeOverridden(title, x));
  return blocked ? "exclude_term" : "pass";
}

export function passesFunctionGate(title: string, profile: SearchProfile): boolean {
  return functionGateVerdict(title, profile) === "pass";
}

// Postings clearly outside the US are dropped unless the profile allows
// international roles: a remote flag on a "Remote (Germany)" posting does not
// make it applicable from a US home base.
//
// Every marker matches as a whole word or phrase. The old substring test with
// " uk" missed "Remote (UK)" and "London-UK" (a UK role reached the board,
// 2026-11-05) while matching "Ukiah, CA"; "india" matched "Indianapolis" and
// "Indiana", "porto" matched "Portola Valley", "rome" matched "Jerome", and
// the US marker "us -" matched "Vilnius - Lithuania".
const NON_US_MARKERS = [
  "germany", "france", "spain", "poland", "sweden", "austria", "portugal", "ireland",
  "netherlands", "belgium", "italy", "switzerland", "denmark", "norway", "finland",
  "united kingdom", "uk", "england", "scotland", "london", "dublin", "berlin", "paris", "amsterdam", "prague",
  "india", "bangalore", "singapore", "japan", "tokyo", "china", "korea", "seoul",
  "hong kong", "taiwan", "taipei", "vietnam", "thailand", "indonesia", "malaysia",
  "philippines", "australia", "sydney", "canada", "toronto", "vancouver", "brazil",
  "mexico", "israel", "emea", "apac", "latam",
  // City-only strings that dodge the country markers (observed leaks + the
  // common offenders). Ambiguous names with real US collisions (london,
  // dublin, athens) stay off the list on purpose.
  "vienna", "zurich", "geneva", "buenos aires", "hyderabad", "mumbai", "pune",
  "chennai", "gurgaon", "noida", "bengaluru", "warsaw", "krakow", "wroclaw",
  "bratislava", "budapest", "bucharest", "sofia", "lisbon", "porto", "madrid",
  "barcelona", "milan", "rome", "stockholm", "gothenburg", "oslo", "copenhagen",
  "helsinki", "tallinn", "riga", "vilnius", "brussels", "antwerp", "munich",
  "hamburg", "frankfurt", "cologne", "stuttgart", "zagreb", "ljubljana",
  "athens, gr", "slovakia", "slovenia", "croatia", "serbia", "romania",
  "bulgaria", "greece", "hungary", "czech", "estonia", "latvia", "lithuania",
  "ukraine", "turkey", "istanbul", "tel aviv", "jerusalem", "cairo", "nairobi",
  "cape town", "johannesburg", "argentina", "colombia", "chile", "peru",
  "uruguay", "bogota", "santiago", "lima", "montevideo", "mexico city",
  "guadalajara", "monterrey", "sao paulo", "rio de janeiro", "waterford",
  "cork", "galway", "limerick", "new zealand", "auckland", "wellington",
  "melbourne", "brisbane", "montreal", "ottawa", "calgary", "edmonton",
  // Places the substring test only caught inside a longer word ("Milano" via
  // "milan", "Antwerpen" via "antwerp", "Limassol" via "lima", "Londonderry"
  // via "london"); found by running both tests over one full sweep, 2026-11-05.
  "milano", "czechia", "antwerpen", "cyprus", "limassol", "belfast", "londonderry", "northern ireland",
  "jakarta", "kalimantan", "australian", "czechowice",
  // Observed leaks, dry run 2026-11-05.
  "uae", "united arab emirates", "dubai", "abu dhabi", "kyiv", "morocco", "kuala lumpur", "bangkok",
  "ho chi minh", "hcmc",
];
// "new mexico": the US state must not read as the country ("mexico");
// "new england" ("New England Baptist Hospital") must not read as England.
const US_MARKERS = ["united states", "usa", "u.s", "us", "north america", "new mexico", "new england"];

/** One whole-word alternation per marker list ("uk" matches "Remote (UK)", not "Ukiah"). */
const markerPattern = (markers: string[]) =>
  new RegExp(`\\b(?:${[...markers].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})\\b`, "i");
const NON_US_RE = markerPattern(NON_US_MARKERS);
const US_RE = markerPattern(US_MARKERS);

/**
 * SmartRecruiters ends a location with the lowercase ISO country code
 * ("Telok Panglima Garang, my", "Hitachinaka, jp"). A lowercase code after
 * the last comma counts as foreign, except "us", SmartRecruiters' unknowns
 * ("xx", "un"), and the codes that are also US state or territory
 * abbreviations ("in", "ca", "de", "ma", ...), which a hand-typed
 * "Cambridge, ma" could mean. Checked over one full sweep (2026-11-05):
 * 24,566 SmartRecruiters postings caught; the only other hits were bare
 * "sf" and "na" (no comma, so not read as codes).
 */
const NOT_FOREIGN_CODES = new Set(
  ("us xx un al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or " +
    "pa ri sc sd tn tx ut vt va wa wv wi wy dc pr gu vi as mp").split(" "),
);
const trailingForeignCode = (location: string): boolean => {
  const code = location.match(/,\s*([a-z]{2})\s*$/)?.[1];
  return !!code && !NOT_FOREIGN_CODES.has(code);
};

export function isNonUs(location: string): boolean {
  // Underscores join words in some Workday names ("IN - Hyderabad_HQ").
  const loc = location.replace(/_/g, " ");
  // Accents folded for the marker tests: "São Paulo", "Montréal", "Bogotá",
  // "Zürich", "İstanbul" never matched their plain-letter markers (2026-11-05).
  // The trailing-code test keeps the original case.
  const plain = loc.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (US_RE.test(plain)) return false;
  return NON_US_RE.test(plain) || trailingForeignCode(loc);
}

/**
 * The non-domestic drop, as the prefilter applies it. Secondary locations
 * (which may be international) are exempt, and so is everything when the
 * profile allows international roles. A multi-city list that names one of the
 * primary places stays ("Denver, Colorado; Toronto, Ontario", the shape
 * Workday detail calls now produce), like inExcludedLocation's rule; a list
 * of only foreign or unknown cities keeps the old whole-string test.
 */
export function droppedAsNonUs(p: Posting, profile: SearchProfile): boolean {
  if (profile.international_ok || inSecondaryLocation(p, profile) || !isNonUs(p.location)) return false;
  const parts = p.location.split(";");
  const namesHome = parts.length > 1 && parts.some((part) => !isNonUs(part) && profile.locations.some((l) => placeHas(norm(part), l)));
  return !namesHome;
}

export function locationFit(p: Posting, profile: SearchProfile): "match" | "stretch" {
  if (p.remote) return "match";
  const loc = norm(p.location);
  // Unknown location is NOT a mismatch: some boards omit the field entirely
  // (observed: a fresh posting carried no location and was buried in
  // the stretch bucket). Treat unknown as a match and let triage judge it;
  // clearly-non-US postings were already dropped upstream by isNonUs.
  if (loc.trim() === "" || loc.trim() === "n/a") return "match";
  // "3 Locations" (Workday) is unknown too: the adapter names the cities when
  // it can, and a posting it could not resolve must not lose its place for it.
  if (isLocationCountPlaceholder(loc)) return "match";
  return profile.locations.some((l) => placeHas(loc, l)) ? "match" : "stretch";
}

/**
 * Hard location exclusion: onsite/hybrid in an excluded place, with no primary
 * location listed alongside it (a multi-city posting that includes your city stays).
 */
export function inExcludedLocation(p: Posting, profile: SearchProfile): boolean {
  if (p.remote) return false;
  const loc = norm(p.location);
  if (!(profile.excluded_locations ?? []).some((l) => hasWord(loc, l))) return false;
  return !locationMatches(p, profile);
}

/**
 * Hard company exclusion: the user will not work there. Matched as whole words
 * against the company name and the board slug, so "acme" excludes "Acme Corp"
 * and the board "acme", but not "Acmeville".
 */
export function inExcludedCompany(p: Pick<Posting, "company" | "slug">, profile: SearchProfile): boolean {
  const names = `${p.company} ${p.slug}`;
  return (profile.excluded_companies ?? []).some((c) => c.trim() && hasWord(names, c.trim()));
}

/** True when the posting's location contains one of the primary location markers. */
export function locationMatches(p: Posting, profile: SearchProfile): boolean {
  const loc = norm(p.location);
  return profile.locations.some((l) => placeHas(loc, l));
}

/** True when the posting sits in one of the user's higher-bar secondary locations. */
export function inSecondaryLocation(p: Posting, profile: SearchProfile): boolean {
  const loc = norm(p.location);
  return (profile.secondary_locations ?? []).some((l) => placeHas(loc, l));
}

/** Strong-fit test for secondary locations: both a seniority and a domain signal. */
export function meetsSecondaryBar(p: Posting, profile: SearchProfile): boolean {
  return (
    profile.seniority_terms.some((s) => hasSignal(p.title, s)) &&
    profile.boost_terms.some((b) => hasSignal(p.title, b))
  );
}

/**
 * Priority shape: a seniority-titled role (head of, director, principal,
 * chief of staff, …) on a posting that already cleared the function gate.
 * These are the shapes the user must never lose silently: a post-mortem found
 * one buried in an over_cap drop of several hundred postings.
 */
export function isPriorityShape(title: string, profile: SearchProfile): boolean {
  return profile.seniority_terms.some((s) => hasSignal(title, s));
}

export interface RankOptions {
  /**
   * Deep-scan lane: posting age is a ranking PENALTY, never a gate. Exists
   * because the hard recency cap made any posting older than max_age_days
   * permanently invisible — an excellent role open for six weeks could never
   * surface (a well-matched role over six weeks old was missed this way).
   */
  deepScan?: boolean;
}

export function rankScore(p: Posting, profile: SearchProfile, reasons: string[], opts?: RankOptions): number {
  let score = 0;
  // Recency dominates: fresher = higher, unknown date sinks below all dated.
  if (p.age_days !== null) {
    if (opts?.deepScan) {
      // Gentle penalty (~0.5/day, capped): an aged strong fit competes on
      // fit instead of dropping off the bottom, but fresh peers still win.
      score -= Math.min(p.age_days, 60) * 0.5;
      if (p.age_days > profile.max_age_days) reasons.push(`open ${p.age_days}d (outside the daily window)`);
    } else {
      score += (profile.max_age_days - p.age_days) * 10;
      if (p.age_days <= 2) reasons.push("posted in the last 2 days");
    }
  } else {
    score -= 15;
    reasons.push("no post date in feed");
  }
  // Watched companies outrank everything but recency: the user asked to see
  // these whenever a matching role opens.
  const co = norm(`${p.company} ${p.slug}`);
  for (const w of profile.watched_companies ?? []) {
    if (co.includes(norm(w))) {
      score += 20;
      reasons.push(`watched company: ${w}`);
      break;
    }
  }
  for (const s of profile.seniority_terms) {
    if (hasSignal(p.title, s)) {
      score += 8;
      reasons.push(`seniority: ${s}`);
      break;
    }
  }
  for (const b of profile.boost_terms) {
    if (hasSignal(p.title, b)) {
      score += 6;
      reasons.push(`domain: ${b}`);
    }
  }
  return score;
}

/** Removed at one gate; `priority` = how many of those were priority-shape titles. */
export interface GateCount {
  removed: number;
  priority: number;
}

/** Postings in one place (the stretch list, the board); `priority` as above. */
export interface ShapeCount {
  count: number;
  priority: number;
}

/**
 * The prefilter's gates in pipeline order. A posting is counted at the first
 * gate that removes it.
 *   duplicate_url      same URL listed twice (same posting)
 *   duplicate_role     same company + title at another URL (multi-location copies; one kept)
 *   seen               URL already seen, dismissed or tracked
 *   known_application  company + title already an application
 *   no_function_term   no function term in the title
 *   exclude_term       a function term matched, an exclude term cut it
 *   excluded_company / excluded_location / non_us   hard profile rules
 *   too_old            older than max_age_days (daily lane)
 *   not_priority_shape not a priority shape (deep lane)
 *   secondary_bar      secondary location without seniority + domain signal
 *   weak_stretch       location mismatch with no seniority or domain signal
 *   company_cap        beyond the per-company cap (3 matches, 2 stretch)
 */
export const PREFILTER_GATES = [
  "duplicate_url",
  "duplicate_role",
  "seen",
  "known_application",
  "no_function_term",
  "exclude_term",
  "excluded_company",
  "excluded_location",
  "non_us",
  "too_old",
  "not_priority_shape",
  "secondary_bar",
  "weak_stretch",
  "company_cap",
] as const;
export type PrefilterGate = (typeof PREFILTER_GATES)[number];

export interface PrefilterStats {
  input: number;
  gates: Record<PrefilterGate, GateCount>;
  /** Not removed: a location mismatch sent these to the stretch list, which
   *  gets fewer triage and board slots than the matches. */
  routed_to_stretch: ShapeCount;
}

export interface PrefilterOutput {
  survivors: RankedPosting[];
  stretch: RankedPosting[];
  stats: PrefilterStats;
}

export function prefilterAndRank(
  postings: Posting[],
  profile: SearchProfile,
  seenUrls: Set<string>,
  knownApplications: { company: string; role: string }[],
  opts?: RankOptions,
): PrefilterOutput {
  const stats: PrefilterStats = {
    input: postings.length,
    gates: Object.fromEntries(PREFILTER_GATES.map((g) => [g, { removed: 0, priority: 0 }])) as Record<PrefilterGate, GateCount>,
    routed_to_stretch: { count: 0, priority: 0 },
  };
  const priority = (p: Posting) => (isPriorityShape(p.title, profile) ? 1 : 0);
  const drop = (gate: PrefilterGate, p: Posting) => {
    stats.gates[gate].removed++;
    stats.gates[gate].priority += priority(p);
  };

  const knownPairs = new Set(knownApplications.map((a) => `${norm(a.company).trim()}|${norm(a.role).trim()}`));
  const byUrl = new Map<string, Posting>();
  for (const p of postings) {
    const key = postingKey(p.url);
    if (!byUrl.has(key)) byUrl.set(key, p);
    else drop("duplicate_url", p);
  }

  // Collapse multi-location duplicates of the same role (company+title),
  // preferring a location-matching copy over a stretch copy.
  const byRole = new Map<string, Posting>();
  for (const p of byUrl.values()) {
    const key = `${norm(p.company)}|${norm(p.title)}`;
    const existing = byRole.get(key);
    if (!existing) byRole.set(key, p);
    else if (locationFit(existing, profile) === "stretch" && locationFit(p, profile) === "match") {
      byRole.set(key, p);
      drop("duplicate_role", existing);
    } else drop("duplicate_role", p);
  }

  const survivors: RankedPosting[] = [];
  const stretch: RankedPosting[] = [];
  for (const p of byRole.values()) {
    if (seenUrls.has(postingKey(p.url))) { drop("seen", p); continue; }
    if (knownPairs.has(`${norm(p.company).trim()}|${norm(p.title).trim()}`)) { drop("known_application", p); continue; }
    const gate = functionGateVerdict(p.title, profile);
    if (gate !== "pass") { drop(gate, p); continue; }
    if (inExcludedCompany(p, profile)) { drop("excluded_company", p); continue; }
    if (inExcludedLocation(p, profile)) { drop("excluded_location", p); continue; }
    const secondary = inSecondaryLocation(p, profile);
    if (droppedAsNonUs(p, profile)) { drop("non_us", p); continue; }
    if (opts?.deepScan) {
      // Deep scan drops the recency cap entirely, so the sanity valve is a
      // TIGHTER shape gate: only priority titles (which already sit on a
      // function-gate-matched posting) enter, keeping triage volume sane.
      if (!isPriorityShape(p.title, profile)) { drop("not_priority_shape", p); continue; }
    } else {
      // HARD recency gate: nothing older than the window; unknown dates pass.
      if (p.age_days !== null && p.age_days > profile.max_age_days) { drop("too_old", p); continue; }
    }
    // Secondary locations carry a HIGHER bar: only strong fits (seniority AND
    // domain signal) surface at all; the rest are dropped, not stretched.
    if (secondary && !locationMatches(p, profile) && !p.remote && !meetsSecondaryBar(p, profile)) { drop("secondary_bar", p); continue; }

    const reasons: string[] = [];
    const fit = locationFit(p, profile);
    if (secondary && fit === "stretch") reasons.push("secondary location: strong fit");
    const ranked: RankedPosting = { ...p, location_fit: fit, reasons, rank_score: rankScore(p, profile, reasons, opts) };
    (fit === "match" || (secondary && meetsSecondaryBar(p, profile)) ? survivors : stretch).push(ranked);
  }

  const newestFirst = (a: RankedPosting, b: RankedPosting) => b.rank_score - a.rank_score;
  // One company must not flood a run: cap postings per company (best-ranked win).
  const capPerCompany = (list: RankedPosting[], cap: number) => {
    const counts = new Map<string, number>();
    return list.filter((p) => {
      const c = counts.get(p.company) ?? 0;
      if (c >= cap) {
        drop("company_cap", p);
        return false;
      }
      counts.set(p.company, c + 1);
      return true;
    });
  };
  survivors.sort(newestFirst);
  // Stretch only keeps otherwise-strong postings: seniority or domain signal.
  const isStrong = (p: RankedPosting) => p.reasons.some((r) => r.startsWith("seniority") || r.startsWith("domain"));
  for (const p of stretch) if (!isStrong(p)) drop("weak_stretch", p);
  const strongStretch = stretch.filter(isStrong);
  strongStretch.sort(newestFirst);
  const cappedSurvivors = capPerCompany(survivors, 3);
  const cappedStretch = capPerCompany(strongStretch, 2);
  for (const p of cappedStretch) {
    stats.routed_to_stretch.count++;
    stats.routed_to_stretch.priority += priority(p);
  }
  return { survivors: cappedSurvivors, stretch: cappedStretch, stats };
}
