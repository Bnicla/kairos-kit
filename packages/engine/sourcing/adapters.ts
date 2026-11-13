import type { Posting, RegistryEntry, SourcingAts } from "./types";

/**
 * Public ATS feed adapters. Every function talks DIRECTLY to the ATS's own
 * unauthenticated job-board endpoint (no intermediaries — spec §3/§4) and
 * returns a normalized Posting[]. A missing/renamed board resolves to [] —
 * sweep-time validation is how the registry self-cleans.
 */

const TIMEOUT_MS = 12_000;

/**
 * Typed fetch outcomes (REQ-6). A rate-limit event must be distinguishable from
 * "board has no jobs": swallowing errors made a throttled sweep look like a
 * quiet market. "gone" (404/410) is registry decay, not infrastructure failure —
 * accounted separately so the failure banner doesn't cry wolf on stale slugs.
 */
export type FetchFailureKind = "http" | "gone" | "rate_limited" | "timeout" | "network" | "parse";

export class BoardFetchError extends Error {
  constructor(
    public kind: FetchFailureKind,
    public status?: number,
    /** Start of the error body, for hosts that explain a refusal there (Workday "S22"). */
    public detail?: string,
  ) {
    super(`board fetch failed: ${kind}${status ? ` (${status})` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json", "user-agent": "kairos-sourcing/1.0", ...(init?.headers ?? {}) },
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new BoardFetchError(timedOut ? "timeout" : "network");
    }
    // A closed account is redirected to the vendor's marketing site (BambooHR
    // sends dead subdomains to www.bamboohr.com): an HTML page after a
    // redirect means the board is gone, not that the feed broke.
    if (res.ok && res.redirected && /text\/html/i.test(res.headers.get("content-type") ?? "")) {
      throw new BoardFetchError("gone", res.status);
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new BoardFetchError("parse", res.status);
      }
    }
    // One retry with backoff + jitter on throttle/transient statuses, honoring
    // Retry-After when the host names a wait (capped so a sweep can't stall).
    if ((res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503) && attempt === 0) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5_000)
        : 500 + Math.random() * 700;
      await sleep(wait);
      continue;
    }
    if (res.status === 404 || res.status === 410) throw new BoardFetchError("gone", res.status);
    if (res.status === 429) throw new BoardFetchError("rate_limited", res.status);
    throw new BoardFetchError("http", res.status, (await res.text().catch(() => "")).slice(0, 200));
  }
}

const iso = (d: Date | number | string | null | undefined): string | null => {
  if (d === null || d === undefined) return null;
  const date = new Date(d);
  return isNaN(date.getTime()) ? null : date.toISOString();
};

/** Primary location first, then any other listed cities, deduplicated, "; "-joined. */
const joinLocations = (primary: string | undefined, others: (string | undefined)[]): string => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [primary, ...others]) {
    const loc = raw?.trim();
    if (!loc || seen.has(loc.toLowerCase())) continue;
    seen.add(loc.toLowerCase());
    out.push(loc);
  }
  return out.join("; ");
};

const ageDays = (posted: string | null, now: number): number | null =>
  posted === null ? null : Math.max(0, Math.floor((now - new Date(posted).getTime()) / 86_400_000));

function mk(
  base: Omit<Posting, "age_days" | "remote"> & { remote?: boolean },
  now: number,
): Posting {
  const remote = base.remote ?? /remote|anywhere|distributed/i.test(base.location);
  return { ...base, remote, age_days: ageDays(base.posted_at, now) };
}

const titleize = (slug: string) =>
  slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

// -- Greenhouse ---------------------------------------------------------------

async function fetchGreenhouse(slug: string, now: number): Promise<Posting[]> {
  const data = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`)) as {
    jobs?: { absolute_url?: string; title?: string; first_published?: string; updated_at?: string; location?: { name?: string } }[];
  } | null;
  if (!data?.jobs) return [];
  return data.jobs
    .filter((j) => j.title && j.absolute_url)
    .map((j) =>
      mk(
        {
          ats: "greenhouse",
          slug,
          company: titleize(slug),
          title: j.title!,
          url: j.absolute_url!,
          location: j.location?.name ?? "",
          // first_published is the real posting date. updated_at moves on any
          // edit, so a months-old req looked fresh (one board, June → "2 days",
          // 2026-11-02); it stays only as the fallback for boards without it.
          posted_at: iso(j.first_published ?? j.updated_at ?? null),
        },
        now,
      ),
    );
}

// -- Lever --------------------------------------------------------------------

async function fetchLever(slug: string, now: number): Promise<Posting[]> {
  const data = (await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`)) as
    | { hostedUrl?: string; text?: string; createdAt?: number; categories?: { location?: string; allLocations?: string[] }; workplaceType?: string }[]
    | null;
  if (!Array.isArray(data)) return [];
  return data
    .filter((j) => j.text && j.hostedUrl)
    .map((j) =>
      mk(
        {
          ats: "lever",
          slug,
          company: titleize(slug),
          title: j.text!,
          url: j.hostedUrl!,
          location: joinLocations(j.categories?.location, j.categories?.allLocations ?? []),
          remote: j.workplaceType === "remote" || undefined,
          posted_at: iso(j.createdAt ?? null),
        },
        now,
      ),
    );
}

// -- Ashby --------------------------------------------------------------------

async function fetchAshby(slug: string, now: number): Promise<Posting[]> {
  const data = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`)) as {
    jobs?: {
      title?: string;
      location?: string;
      secondaryLocations?: { location?: string }[];
      isRemote?: boolean;
      publishedAt?: string;
      publishedDate?: string;
      jobUrl?: string;
      applyUrl?: string;
    }[];
  } | null;
  if (!data?.jobs) return [];
  return data.jobs
    .filter((j) => j.title && (j.jobUrl || j.applyUrl))
    .map((j) =>
      mk(
        {
          ats: "ashby",
          slug,
          company: titleize(slug),
          title: j.title!,
          url: (j.jobUrl ?? j.applyUrl)!,
          // Multi-city postings list one primary city; the rest sit in
          // secondaryLocations. Ignoring them hid a role open in three cities
          // behind the first one (2026-11-05).
          location: joinLocations(j.location, (j.secondaryLocations ?? []).map((l) => l.location)),
          remote: j.isRemote || undefined,
          posted_at: iso(j.publishedAt ?? j.publishedDate ?? null),
        },
        now,
      ),
    );
}

// -- Rippling -----------------------------------------------------------------

async function fetchRippling(slug: string, now: number): Promise<Posting[]> {
  const data = (await getJson(`https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`)) as
    | { name?: string; title?: string; url?: string; workLocation?: { label?: string }; locations?: { label?: string }[] }[]
    | null;
  if (!Array.isArray(data)) return [];
  return data
    .filter((j) => (j.name || j.title) && j.url)
    .map((j) =>
      mk(
        {
          ats: "rippling",
          slug,
          company: titleize(slug),
          title: (j.name ?? j.title)!,
          url: j.url!,
          location: j.workLocation?.label ?? j.locations?.map((l) => l.label).join(" / ") ?? "",
          posted_at: null, // Rippling's public board feed carries no post date.
        },
        now,
      ),
    );
}

// -- Workday ------------------------------------------------------------------

/** "Posted Today" → 0, "Posted Yesterday" → 1, "Posted 6 Days Ago" → 6, "30+ Days Ago" → 31. */
export function parseWorkdayPostedOn(postedOn: string | undefined, now: number): string | null {
  if (!postedOn) return null;
  const p = postedOn.toLowerCase();
  let days: number | null = null;
  if (p.includes("today")) days = 0;
  else if (p.includes("yesterday")) days = 1;
  else if (p.includes("30+")) days = 31;
  else {
    const m = p.match(/(\d+)\+?\s+days?\s+ago/);
    if (m) days = parseInt(m[1], 10);
  }
  return days === null ? null : new Date(now - days * 86_400_000).toISOString();
}

/**
 * A location that only counts cities ("2 Locations", "13 Locations"). The
 * Workday list API says this for every multi-city posting; the cities
 * themselves sit on the posting's detail page.
 */
export const isLocationCountPlaceholder = (location: string): boolean => /^\s*\d+\s+locations?\s*$/i.test(location);

/**
 * Detail calls per Workday board to resolve "N Locations" postings. Only
 * postings the sweep could rank get one (function gate, recency window), so
 * the count follows how many relevant roles a board has. Was 8 with one list
 * page; with ten pages one large tenant had 34 such postings (2026-11-05).
 */
export const WORKDAY_MAX_DETAIL = 40;
/** Detail calls in flight at once against one Workday tenant. */
const WORKDAY_DETAIL_PARALLEL = 4;

/** Postings per Workday list call: the cxs API answers 400 to anything above 20. */
export const WORKDAY_PAGE = 20;
/**
 * List pages per Workday board and search word, daily lane: 200 postings. The
 * search is full-text, so a broad word matches most of a tenant's postings;
 * one page of 20 left out 55% of live boards' hits (2026-11-05). Half of the
 * tenants list newest first and stop well before the cap (see
 * WORKDAY_ORDER_SLACK_DAYS); the other half rank by relevance and page until
 * the cap or their total.
 */
export const WORKDAY_MAX_PAGES = 10;
/**
 * Search words per Workday board. Each word is its own paged query, so the
 * list calls per board are at most this many times the page cap.
 */
export const WORKDAY_MAX_SEARCH_TERMS = 3;

/**
 * The search texts one Workday board is queried with: the given words,
 * trimmed, lowercased, without repeats, at most WORKDAY_MAX_SEARCH_TERMS.
 * No words: one query with an empty search text, which lists the whole board
 * (newest pages up to the page cap). No word is ever assumed.
 */
export function workdaySearchWords(terms: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of terms ?? []) {
    const t = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (t && !out.includes(t)) out.push(t);
  }
  return out.length ? out.slice(0, WORKDAY_MAX_SEARCH_TERMS) : [""];
}
/** List pages per Workday board, deep lane (no recency stop): 500 postings. */
export const WORKDAY_MAX_PAGES_DEEP = 25;
/**
 * A newest-first list may run a day or two out of order. The list counts as
 * newest-first while no posting is more than this many days fresher than one
 * listed before it; paging stops at the first page whose freshest posting is
 * older than the recency window plus this slack.
 */
const WORKDAY_ORDER_SLACK_DAYS = 2;

/**
 * The list's remoteType is a tenant-named label ("Remote", "Fully Remote",
 * "100% Remote", "Hybrid", "On-Site", "In Person", "#LI-Onsite", "Office
 * Worker (NOT Remote)", "Virtual Worker"). It wins over the location text,
 * which can read "US-CA-Remote" on a hybrid role. A label that names neither
 * (e.g. "80-100%"), or "Home Office" (working from home at some employers,
 * the head office at others), leaves the location text to decide.
 */
export function workdayRemote(remoteType: string | undefined): boolean | undefined {
  // Labels seen on 249 tenants (2026-11-05), 146 of them; "Remote Type - Hybrid" names the field first.
  const label = (remoteType ?? "").replace(/^remote type\s*[-:]\s*/i, "").trim();
  if (!label) return undefined;
  if (/remote/i.test(label)) {
    if (/\b(?:not|non|no)\b/i.test(label)) return false; // "Office Worker (NOT Remote)"
    if (/partial|near primary/i.test(label)) return false;
    // "Hybrid Remote" and "Hybrid: Remote and Office" are hybrid; "Remote or Hybrid" may be remote.
    if (/hybrid/i.test(label) && !/\bor\b|\//i.test(label)) return false;
    return true;
  }
  if (/hybrid|on[- ]?site|in[- ]?person/i.test(label)) return false;
  if (/home office/i.test(label)) return undefined;
  if (/virtual|telecommut|anywhere|work from home|home[- ]?based|homeworking|\bwfh\b/i.test(label)) return true;
  if (/office|field/i.test(label)) return false;
  return undefined;
}

/** A detail call's startDate ("2026-10-19"), when it is a real date not in the future. */
const workdayStartDate = (startDate: unknown, now: number): string | null => {
  if (typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(startDate)) return null;
  const at = iso(startDate);
  return at && Date.parse(at) <= now + 86_400_000 ? at : null;
};

async function mapPool<T>(items: T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

type WorkdayListRow = { title?: string; externalPath?: string; locationsText?: string; postedOn?: string; remoteType?: string };

async function fetchWorkday(composite: string, now: number, opts?: FetchOptions): Promise<AdapterResult> {
  // slug format: tenant@wdN@site
  const [tenant, wd, site] = composite.split("@");
  if (!tenant || !wd || !site) return [];
  const base = `https://${tenant}.${wd}.myworkdayjobs.com`;
  const listPage = (searchText: string, offset: number) =>
    getJson(`${base}/wday/cxs/${tenant}/${site}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE, offset, searchText }),
    }) as Promise<{ total?: number; jobPostings?: WorkdayListRow[] } | null>;

  // One paged search per search word (the sweep passes the profile's; none
  // means one unfiltered listing), 20 postings at a time; a posting found by
  // two words is kept once. Observed 2026-11-05: only the first page carries
  // the real `total` (later pages say 0), and an offset past the end returns
  // page one again, so the first total bounds the paging and a page with
  // nothing new for its word ends it.
  const maxPages = Math.max(1, opts?.workdayMaxPages ?? WORKDAY_MAX_PAGES);
  const jobs: WorkdayListRow[] = [];
  const seenPaths = new Set<string>();
  let partial: AdapterPartial | undefined;
  words: for (const [w, word] of workdaySearchWords(opts?.searchTerms).entries()) {
    const wordPaths = new Set<string>();
    let total = Infinity;
    let newestFirst = true;
    let oldestSoFar = -Infinity;
    for (let page = 0; page < maxPages && page * WORKDAY_PAGE < total; page++) {
      let data: Awaited<ReturnType<typeof listPage>>;
      try {
        data = await listPage(word, page * WORKDAY_PAGE);
      } catch (err) {
        if (w === 0 && page === 0) {
          // Workday answers a removed career site with 422 and a disabled one
          // with 403 "S22" (the site page itself redirects to a maintenance
          // page). Both are registry decay, not a broken feed.
          if (err instanceof BoardFetchError && err.kind === "http" && (err.status === 422 || (err.status === 403 && err.detail?.includes('"S22"')))) {
            throw new BoardFetchError("gone", err.status);
          }
          throw err;
        }
        // A later page or word failed: keep what was read before it, say so,
        // and send this tenant nothing more.
        partial = err instanceof BoardFetchError ? { kind: err.kind, status: err.status } : { kind: "network" };
        break words;
      }
      if (page === 0 && typeof data?.total === "number") total = data.total;
      const pageRows = Array.isArray(data?.jobPostings) ? data.jobPostings : [];
      let added = 0;
      let freshest = Infinity;
      for (const j of pageRows) {
        if (!j?.title || !j.externalPath || wordPaths.has(j.externalPath)) continue;
        wordPaths.add(j.externalPath);
        added++;
        if (!seenPaths.has(j.externalPath)) {
          seenPaths.add(j.externalPath);
          jobs.push(j);
        }
        const posted = parseWorkdayPostedOn(j.postedOn, now);
        const age = posted === null ? null : ageDays(posted, now)!;
        if (age === null) continue;
        if (age < oldestSoFar - WORKDAY_ORDER_SLACK_DAYS) newestFirst = false;
        oldestSoFar = Math.max(oldestSoFar, age);
        freshest = Math.min(freshest, age);
      }
      if (added === 0 || pageRows.length < WORKDAY_PAGE) break;
      // Newest-first list, and even this page's freshest posting is past the
      // window: nothing further down can reach the board.
      if (opts?.maxAgeDays !== undefined && newestFirst && freshest !== Infinity && freshest > opts.maxAgeDays + WORKDAY_ORDER_SLACK_DAYS) break;
    }
  }

  const rows = jobs.map((j) => {
    const remote = workdayRemote(j.remoteType);
    return {
      path: j.externalPath!,
      remote,
      posting: mk(
        {
          ats: "workday",
          slug: composite,
          company: titleize(tenant),
          title: j.title!,
          url: `${base}/en-US/${site}${j.externalPath}`,
          location: j.locationsText ?? "",
          remote,
          posted_at: parseWorkdayPostedOn(j.postedOn, now),
        },
        now,
      ),
    };
  });

  // Multi-city postings list as "N Locations", which no location gate can
  // place: a role open in a primary city went to the stretch bucket (miss
  // audit, 2026-11-05: 117 recent postings with a target title). The detail
  // endpoint names the cities, and its startDate is the posting date to the
  // day ("30+ Days Ago" is all the list says past a month). Freshest postings
  // first, capped per board; a failed call keeps the placeholder.
  const toResolve = rows
    .filter((r) => isLocationCountPlaceholder(r.posting.location) && (opts?.resolveLocationFor?.(r.posting) ?? true))
    .sort((a, b) => (a.posting.age_days ?? Infinity) - (b.posting.age_days ?? Infinity))
    .slice(0, WORKDAY_MAX_DETAIL);
  await mapPool(toResolve, WORKDAY_DETAIL_PARALLEL, async (r) => {
    try {
      const d = (await getJson(`${base}/wday/cxs/${tenant}/${site}${r.path}`)) as {
        jobPostingInfo?: { location?: string; additionalLocations?: string[]; startDate?: string; remoteType?: string };
      } | null;
      const info = d?.jobPostingInfo;
      const location = joinLocations(info?.location, Array.isArray(info?.additionalLocations) ? info.additionalLocations : []);
      const posted = workdayStartDate(info?.startDate, now) ?? r.posting.posted_at;
      r.posting = mk(
        {
          ...r.posting,
          location: location || r.posting.location,
          // Re-derived from the named cities unless a remoteType label said.
          remote: r.remote ?? workdayRemote(info?.remoteType),
          posted_at: posted,
        },
        now,
      );
    } catch {
      // keep "N Locations"
    }
  });
  const postings = rows.map((r) => r.posting);
  return partial ? { postings, partial } : postings;
}

// -- SmartRecruiters ----------------------------------------------------------

const SR_PAGE = 100; // API max per request
const SR_MAX_PAGES = 5; // 500 postings caps runaway enterprise boards mid-sweep

async function fetchSmartRecruiters(slug: string, now: number): Promise<Posting[]> {
  const out: Posting[] = [];
  for (let page = 0; page < SR_MAX_PAGES; page++) {
    const data = (await getJson(
      `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SR_PAGE}&offset=${page * SR_PAGE}`,
    )) as {
      totalFound?: number;
      content?: {
        id?: string;
        name?: string;
        releasedDate?: string;
        location?: { city?: string; region?: string; country?: string; remote?: boolean };
        company?: { name?: string };
      }[];
    } | null;
    if (!data || !Array.isArray(data.content)) break;
    for (const j of data.content) {
      if (!j.id || !j.name) continue;
      out.push(
        mk(
          {
            ats: "smartrecruiters",
            slug,
            company: j.company?.name ?? titleize(slug),
            title: j.name,
            url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
            location: [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(", "),
            remote: j.location?.remote === true || undefined,
            posted_at: iso(j.releasedDate ?? null),
          },
          now,
        ),
      );
    }
    const total = typeof data.totalFound === "number" ? data.totalFound : 0;
    if (data.content.length < SR_PAGE || (total > 0 && (page + 1) * SR_PAGE >= total)) break;
  }
  return out;
}

// -- BambooHR -----------------------------------------------------------------
// https://{slug}.bamboohr.com/careers/list is the careers page's own JSON. The
// list carries no posting date; only /careers/{id}/detail does. Boards are
// small (typically a few dozen openings at most), but one detail call per
// posting across the registry would multiply sweep requests, so the date is
// fetched only for the titles the caller says are worth dating (the sweep
// passes its function gate), a few per board. Everything else ships undated
// (survives the recency gate, ranks below dated postings). Without that test
// the first few postings of the board are dated, whatever their titles.

/** Posting-date detail calls per BambooHR board. */
export const BAMBOO_MAX_DETAIL = 6;

async function fetchBambooHr(slug: string, now: number, opts?: FetchOptions): Promise<Posting[]> {
  const base = `https://${slug}.bamboohr.com/careers`;
  const data = (await getJson(`${base}/list`)) as {
    result?: {
      id?: string | number;
      jobOpeningName?: string;
      location?: { city?: string | null; state?: string | null };
      atsLocation?: { city?: string | null; state?: string | null; country?: string | null };
      isRemote?: boolean | null;
      locationType?: string | number | null;
    }[];
  } | null;
  if (!data || !Array.isArray(data.result)) return [];
  const jobs = data.result.filter((j) => j.id != null && j.jobOpeningName);

  // Posting dates for the few titles worth dating; a failed detail call just
  // leaves that posting undated.
  const dates = new Map<string, string | null>();
  await Promise.all(
    jobs
      .filter((j) => opts?.dateWorthy?.(j.jobOpeningName!) ?? true)
      .slice(0, BAMBOO_MAX_DETAIL)
      .map(async (j) => {
        try {
          const d = (await getJson(`${base}/${j.id}/detail`)) as { result?: { jobOpening?: { datePosted?: string } } } | null;
          dates.set(String(j.id), iso(d?.result?.jobOpening?.datePosted ?? null));
        } catch {
          dates.set(String(j.id), null);
        }
      }),
  );

  return jobs.map((j) =>
    mk(
      {
        ats: "bamboohr",
        slug,
        company: titleize(slug),
        title: j.jobOpeningName!,
        url: `${base}/${j.id}`,
        location: [
          j.location?.city ?? j.atsLocation?.city,
          j.location?.state ?? j.atsLocation?.state,
          j.atsLocation?.country,
        ].filter(Boolean).join(", "),
        // locationType: "0" on-site, "1" remote, "2" hybrid.
        remote: j.isRemote === true || String(j.locationType) === "1" || undefined,
        posted_at: dates.get(String(j.id)) ?? null,
      },
      now,
    ),
  );
}

// -- dispatch -----------------------------------------------------------------

/** Per-sweep options an adapter may use. The adapters stay profile-free. */
export interface FetchOptions {
  /**
   * Which postings deserve an extra detail call to name the cities behind an
   * "N Locations" placeholder (Workday). Absent: every such posting, up to
   * WORKDAY_MAX_DETAIL per board. The sweep passes its function gate and
   * recency window so the calls go to postings that can reach the board.
   */
  resolveLocationFor?: (p: Posting) => boolean;
  /**
   * The recency window in days: postings older than this cannot reach the
   * board, so a newest-first Workday list stops paging past it. Absent: no
   * recency stop (deep scan), paging runs to the page cap or the list's end.
   */
  maxAgeDays?: number;
  /** Workday list pages per board and search word (default WORKDAY_MAX_PAGES). */
  workdayMaxPages?: number;
  /**
   * Search words for job sites that only answer a search (Workday): one paged
   * query per word, at most WORKDAY_MAX_SEARCH_TERMS, postings found twice
   * kept once. The sweep passes the profile's (feedSearchTerms). Absent or
   * empty: one unfiltered listing of the board.
   */
  searchTerms?: string[];
  /**
   * Which titles deserve the extra detail call that reads a posting date
   * (BambooHR, whose list carries none), at most BAMBOO_MAX_DETAIL per board.
   * The sweep passes its function gate. Absent: the first postings listed.
   */
  dateWorthy?: (title: string) => boolean;
}

/** A board read whose later pages failed: the postings are the pages read before. */
type AdapterPartial = { kind: FetchFailureKind; status?: number };
type AdapterResult = Posting[] | { postings: Posting[]; partial: AdapterPartial };

const ADAPTERS: Record<SourcingAts, (slug: string, now: number, opts?: FetchOptions) => Promise<AdapterResult>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  rippling: fetchRippling,
  workday: fetchWorkday,
  smartrecruiters: fetchSmartRecruiters,
  bamboohr: fetchBambooHr,
};

export interface BoardFetchResult {
  postings: Posting[];
  /** Present when the board could not be read; postings is then []. */
  failure?: { kind: FetchFailureKind; status?: number };
  /** Present when the first page was read but a later one failed (Workday paging). */
  partial?: { kind: FetchFailureKind; status?: number };
}

/** Fetch one board with a typed outcome — failures are reported, never swallowed. */
export async function fetchBoardDetailed(entry: RegistryEntry, now = Date.now(), opts?: FetchOptions): Promise<BoardFetchResult> {
  try {
    const got = await ADAPTERS[entry.ats](entry.slug, now, opts);
    return Array.isArray(got) ? { postings: got } : { postings: got.postings, partial: got.partial };
  } catch (err) {
    if (err instanceof BoardFetchError) {
      return { postings: [], failure: { kind: err.kind, status: err.status } };
    }
    return { postings: [], failure: { kind: "network" } };
  }
}

/** Back-compat form: failures resolve to []. Prefer fetchBoardDetailed. */
export async function fetchBoard(entry: RegistryEntry, now = Date.now()): Promise<Posting[]> {
  return (await fetchBoardDetailed(entry, now)).postings;
}
