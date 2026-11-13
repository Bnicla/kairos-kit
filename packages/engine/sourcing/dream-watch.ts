/**
 * Dream-company watch: direct career-API checks for the companies listed in
 * the search profile's `dream_companies`, including ones the board sweep
 * cannot see (proprietary career sites). The list is user data; this module
 * only knows how to read each kind of career site.
 */
import type { DreamCompany, SearchProfile } from "./types";

export interface DreamJob {
  company: string;
  title: string;
  location: string;
  url: string;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };

export interface DreamWatchPlan {
  /** Companies with a server-side feed, fetched by dream-watch. */
  fetchable: DreamCompany[];
  /** Companies that must be checked in a browser (reminder only). */
  browser: DreamCompany[];
  /** Entries that cannot be fetched as written, with the reason. */
  invalid: string[];
}

/** Split the profile's dream_companies by how they are checked. Absent list -> all empty. */
export function planDreamWatch(profile: Pick<SearchProfile, "dream_companies"> | null | undefined): DreamWatchPlan {
  const plan: DreamWatchPlan = { fetchable: [], browser: [], invalid: [] };
  for (const c of profile?.dream_companies ?? []) {
    if (!c?.name) {
      plan.invalid.push(`entry without a name: ${JSON.stringify(c)}`);
      continue;
    }
    switch (c.ats) {
      case "greenhouse":
      case "ashby":
      case "lever":
        if (!c.slug) plan.invalid.push(`${c.name}: ${c.ats} needs a slug (the board id)`);
        else plan.fetchable.push(c);
        break;
      case "google":
        plan.fetchable.push(c);
        break;
      case "eightfold":
        if (!c.host || !c.domain) plan.invalid.push(`${c.name}: eightfold needs host and domain`);
        else plan.fetchable.push(c);
        break;
      case "browser":
        plan.browser.push(c);
        break;
      default:
        plan.invalid.push(`${c.name}: unknown ats "${(c as { ats?: string }).ats}"`);
    }
  }
  return plan;
}

/**
 * Search queries for google/eightfold entries: the entry's own, else the
 * profile's function terms quoted. Neither: no query (fetchDreamCompany then
 * fails that company with the reason; no role is ever assumed).
 */
export function dreamQueries(c: DreamCompany, profile: Pick<SearchProfile, "function_terms">): string[] {
  if (c.queries?.length) return c.queries;
  return (profile.function_terms ?? []).filter((t) => typeof t === "string" && t.trim()).map((t) => `"${t.trim()}"`);
}

/** The queries for a search-only career site, or the error that says what is missing. */
function requireQueries(c: DreamCompany, profile: Pick<SearchProfile, "function_terms">): string[] {
  const queries = dreamQueries(c, profile);
  if (!queries.length) {
    throw new Error(`${c.name}: nothing to search for. Add "queries" to this dream company, or target roles (function_terms) to the search profile`);
  }
  return queries;
}

async function getJson(f: FetchLike, url: string): Promise<unknown> {
  const res = await f(url, { headers: { ...UA, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Fetch one dream company's postings (all titles; the caller applies the function gate). */
export async function fetchDreamCompany(
  c: DreamCompany,
  profile: Pick<SearchProfile, "function_terms">,
  f: FetchLike = fetch as unknown as FetchLike,
): Promise<DreamJob[]> {
  const company = c.name;
  const location = c.location ?? "United States";
  switch (c.ats) {
    case "greenhouse": {
      const d = (await getJson(f, `https://boards-api.greenhouse.io/v1/boards/${c.slug}/jobs`)) as {
        jobs?: { title: string; absolute_url: string; location?: { name?: string } }[];
      };
      return (d.jobs ?? []).map((j) => ({ company, title: j.title, location: j.location?.name ?? "", url: j.absolute_url }));
    }
    case "ashby": {
      const d = (await getJson(f, `https://api.ashbyhq.com/posting-api/job-board/${c.slug}`)) as {
        jobs?: { title: string; location?: string; jobUrl?: string; isRemote?: boolean }[];
      };
      return (d.jobs ?? []).map((j) => ({
        company,
        title: j.title,
        location: `${j.location ?? ""}${j.isRemote ? " (Remote)" : ""}`,
        url: j.jobUrl ?? `https://jobs.ashbyhq.com/${c.slug}`,
      }));
    }
    case "lever": {
      const d = (await getJson(f, `https://api.lever.co/v0/postings/${c.slug}?mode=json`)) as
        { text: string; hostedUrl: string; categories?: { location?: string } }[];
      return (d ?? []).map((j) => ({ company, title: j.text, location: j.categories?.location ?? "", url: j.hostedUrl }));
    }
    case "google": {
      // The old v3 JSON API is gone (404). The search RESULTS page still embeds
      // every job as jobs/results/<id>-<title-slug> in the initial HTML; titles
      // are rebuilt from the slug (enough for gating; the posting has the real one).
      const out = new Map<string, DreamJob>();
      for (const q of requireQueries(c, profile)) {
        const res = await f(
          `https://www.google.com/about/careers/applications/jobs/results?q=${encodeURIComponent(q)}&location=${encodeURIComponent(location)}`,
          { headers: UA },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        for (const m of html.matchAll(/jobs\/results\/(\d{10,})-([a-z0-9-]+)/g)) {
          const [, id, slug] = m;
          if (out.has(id)) continue;
          const title = slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          out.set(id, {
            company,
            title,
            location: `${location} (see posting)`,
            url: `https://www.google.com/about/careers/applications/jobs/results/${id}-${slug}`,
          });
        }
      }
      return [...out.values()];
    }
    case "eightfold": {
      // Eightfold career sites: /api/apply/v2/jobs returns JSON per query.
      // Queries are fuzzy; the function gate does the real filtering.
      const out = new Map<string, DreamJob>();
      for (const q of requireQueries(c, profile)) {
        const d = (await getJson(
          f,
          `https://${c.host}/api/apply/v2/jobs?domain=${c.domain}&query=${encodeURIComponent(q)}&location=${encodeURIComponent(location)}&num=100&sort_by=new`,
        )) as { positions?: { name?: string; location?: string; canonicalPositionUrl?: string }[] };
        for (const p of d.positions ?? []) {
          const url = p.canonicalPositionUrl ?? "";
          if (!url || out.has(url)) continue;
          out.set(url, { company, title: p.name ?? "", location: p.location ?? "", url });
        }
      }
      return [...out.values()];
    }
    default:
      throw new Error(`${company}: no server-side feed for ats "${c.ats}"`);
  }
}
