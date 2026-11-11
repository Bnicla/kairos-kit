/**
 * Job ad ingestion (§26). URL fetch is best-effort; paste is the always-available
 * fallback. Whatever we successfully ingest becomes the preserved snapshot.
 *
 * Every path runs the posting guard (posting-guard.ts): HTML is sanitized
 * (hidden elements removed) BEFORE it becomes text, invisible characters are
 * stripped, and instruction-shaped lines are quoted in `guard`. The snapshot
 * stores the guard's verdict and COUNTS only, never the removed hidden text.
 */
import { fetchPublic } from "./safe-fetch";
import {
  guardPosting,
  htmlToText,
  sanitizeField,
  sanitizeText,
  summarizeGuard,
  type PostingGuardResult,
  type PostingGuardSummary,
} from "./posting-guard";

export { htmlToText };

export interface IngestedAd {
  markdown: string; // the snapshot body written to job-ad-snapshot.md
  text: string; // plain text for scoring (guarded: hidden markup and invisible characters removed)
  meta: {
    company?: string;
    title?: string;
    source_url?: string;
    location?: string;
    req_id?: string;
  };
  /** Posting-guard verdict, counts and quoted visible instruction lines (never hidden text). */
  guard: PostingGuardSummary;
}

/** Plain single-line field from an ATS API (title, location, pay): invisible characters out, length capped. */
function field(value: string | null | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const v = sanitizeText(value).text.replace(/\s+/g, " ").trim();
  return v ? (v.length > max ? `${v.slice(0, max - 1)}…` : v) : undefined;
}

// -- ATS JSON adapters --------------------------------------------------------
// Ashby and Workday job pages are client-rendered, so the generic HTML fetch
// gets nothing; their unauthenticated posting APIs carry the full text. Tried
// by URL pattern BEFORE the HTML fetch. A null return falls through.

async function getJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetchPublic(url, {
      ...init,
      signal: AbortSignal.timeout(12_000),
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 (compatible; KairosBot/1.0; +https://kairos.app)",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function adFromParts(parts: {
  title: string;
  source_url: string;
  location?: string;
  remote?: boolean;
  compensation?: string;
  /** Plain-text description. */
  body?: string;
  /** HTML description: sanitized (hidden elements removed) before it becomes text. */
  bodyHtml?: string;
}): IngestedAd {
  // The header goes to the guard RAW (so smuggling in a title is detected and
  // counted); meta gets the cleaned, capped single-line values.
  const title = field(parts.title, 300) ?? "";
  const location = field(parts.location, 200);
  const header = [
    `# ${parts.title}`,
    parts.location ? `Location: ${parts.location}${parts.remote ? " (remote)" : ""}` : parts.remote ? "Location: Remote" : null,
    parts.compensation ? `Compensation: ${parts.compensation}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const g = parts.bodyHtml
    ? guardPosting({ text: header, html: parts.bodyHtml })
    : guardPosting({ text: `${header}\n\n${(parts.body ?? "").trim()}` });
  return finishAd(g, { source_url: parts.source_url, pageTitle: title }, {
    source_url: parts.source_url,
    title,
    location,
  });
}

function finishAd(
  g: PostingGuardResult,
  snap: { source_url?: string; pageTitle?: string },
  meta: IngestedAd["meta"],
): IngestedAd {
  const guard = summarizeGuard(g);
  return {
    text: g.cleanText,
    markdown: buildSnapshotMarkdown({ text: g.cleanText, source_url: snap.source_url, pageTitle: snap.pageTitle, guard }),
    meta,
    guard,
  };
}

/** https://jobs.ashbyhq.com/{org}/{jobId} → posting API (descriptionHtml, else descriptionPlain). */
async function fetchAshbyAd(url: string): Promise<IngestedAd | null> {
  const m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (!m) return null;
  const [, org, jobId] = m;
  const data = (await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${org}?includeCompensation=true`,
  )) as {
    jobs?: {
      id?: string;
      title?: string;
      location?: string;
      isRemote?: boolean;
      jobUrl?: string;
      applyUrl?: string;
      compensation?: { compensationTierSummary?: string };
      descriptionPlain?: string;
      descriptionHtml?: string;
    }[];
  } | null;
  // Match by ID (boards can carry near-identical titles), via the id field or
  // the job's own URLs.
  const job = data?.jobs?.find(
    (j) =>
      j.id?.toLowerCase() === jobId.toLowerCase() ||
      j.jobUrl?.includes(jobId) ||
      j.applyUrl?.includes(jobId),
  );
  if (!job?.title || !(job.descriptionHtml || job.descriptionPlain)) return null;
  // Prefer the HTML so hidden elements can be detected and dropped; the plain
  // rendering would already have flattened them into visible-looking text.
  return adFromParts({
    title: job.title,
    source_url: url,
    location: job.location,
    remote: job.isRemote,
    compensation: job.compensation?.compensationTierSummary,
    ...(job.descriptionHtml ? { bodyHtml: job.descriptionHtml } : { body: job.descriptionPlain }),
  });
}

/** https://{tenant}.wd{N}.myworkdayjobs.com/{locale?}/{site}/job/{location}/{slug} → cxs job API. */
async function fetchWorkdayAd(url: string): Promise<IngestedAd | null> {
  const m = url.match(
    /^https?:\/\/([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\/job\/([^/?#]+)\/([^/?#]+)/,
  );
  if (!m) return null;
  const [, tenant, wd, site, jobLocation, slug] = m;
  const data = (await getJson(
    `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${jobLocation}/${slug}`,
  )) as {
    jobPostingInfo?: { title?: string; location?: string; jobDescription?: string };
  } | null;
  const job = data?.jobPostingInfo;
  if (!job?.title || !job.jobDescription) return null;
  return adFromParts({
    title: job.title,
    source_url: url,
    location: job.location,
    bodyHtml: job.jobDescription,
  });
}

/**
 * https://{company}.bamboohr.com/careers/{id} → the page's own /detail JSON.
 * The careers page is a JS shell (the HTML holds only the word "BambooHR"), so
 * every BambooHR posting used to need a pasted PDF (2026-10-08).
 */
async function fetchBambooHrAd(url: string): Promise<IngestedAd | null> {
  const m = url.match(/^https?:\/\/([\w-]+)\.bamboohr\.com\/careers\/(\d+)/i);
  if (!m) return null;
  const [, company, id] = m;
  const data = (await getJson(`https://${company}.bamboohr.com/careers/${id}/detail`, {
    headers: { Accept: "application/json" },
  })) as {
    result?: {
      jobOpening?: {
        jobOpeningName?: string;
        description?: string;
        compensation?: string | null;
        departmentLabel?: string | null;
        locationType?: string | number | null;
        location?: { city?: string | null; state?: string | null; addressCountry?: string | null };
        atsLocation?: { city?: string | null; state?: string | null; country?: string | null };
      };
    };
  } | null;
  const job = data?.result?.jobOpening;
  if (!job?.jobOpeningName || !job.description) return null;
  const loc = [
    job.location?.city ?? job.atsLocation?.city,
    job.location?.state ?? job.atsLocation?.state,
    job.location?.addressCountry ?? job.atsLocation?.country,
  ].filter(Boolean);
  return adFromParts({
    title: job.jobOpeningName,
    source_url: url,
    location: loc.length ? loc.join(", ") : undefined,
    // BambooHR locationType: "0" on-site, "1" remote, "2" hybrid.
    remote: String(job.locationType) === "1" ? true : undefined,
    compensation: job.compensation ?? undefined,
    bodyHtml: job.description,
  });
}

/** Greenhouse board URL → boards-api JSON. Fallback only — the HTML page usually works. */
async function fetchGreenhouseAd(url: string): Promise<IngestedAd | null> {
  let org: string | undefined;
  let id: string | undefined;
  const embed = url.match(/greenhouse\.io\/embed\/job_app\?([^#]+)/i);
  if (embed) {
    const q = new URLSearchParams(embed[1]);
    org = q.get("for") ?? undefined;
    id = q.get("token") ?? undefined;
  } else {
    const board = url.match(/greenhouse\.io\/([\w-]+)\/jobs\/(\d+)/i);
    if (board) [, org, id] = board;
  }
  if (!org || !id) return null;
  const data = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${org}/jobs/${id}`)) as {
    title?: string;
    location?: { name?: string };
    content?: string;
  } | null;
  if (!data?.title || !data.content) return null;
  // Greenhouse ships content as entity-escaped HTML — unescape, then strip.
  const html = data.content
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  return adFromParts({
    title: data.title,
    source_url: url,
    location: data.location?.name,
    bodyHtml: html,
  });
}

export async function fetchJobAd(url: string): Promise<IngestedAd> {
  // ATS APIs first: exact structured text where the HTML page is JS-rendered.
  const viaApi = (await fetchAshbyAd(url)) ?? (await fetchWorkdayAd(url)) ?? (await fetchBambooHrAd(url));
  if (viaApi) return viaApi;

  let htmlError: Error | null = null;
  try {
    const res = await fetchPublic(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; KairosBot/1.0; +https://kairos.app)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
    const html = await res.text();
    const g = guardPosting({ html });
    if (g.cleanText.length < 200) {
      // Over-hiding (e.g. a page that hides its body until JS runs) must not
      // fall back to the unsanitized text: hidden text is exactly what the
      // guard keeps away from the model. Paste is the safe path.
      const hiddenHeavy = htmlToText(html).length >= 200;
      throw new Error(
        hiddenHeavy
          ? "Fetched page shows almost no visible text (most of it is hidden by markup or CSS until JavaScript runs). Paste the text instead."
          : "Fetched page had almost no readable text (likely JS-rendered or login-gated). Paste the text instead.",
      );
    }
    const rawTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? "";
    const title = sanitizeField(htmlToText(rawTitle), 200).value;
    return finishAd(g, { source_url: url, pageTitle: title }, { source_url: url });
  } catch (e) {
    htmlError = e instanceof Error ? e : new Error(String(e));
  }

  // HTML failed — Greenhouse's boards API can still rescue a board URL.
  const viaGreenhouse = await fetchGreenhouseAd(url);
  if (viaGreenhouse) return viaGreenhouse;
  throw htmlError;
}

export function ingestPastedText(
  text: string,
  hint?: { company?: string; title?: string; source_url?: string },
): IngestedAd {
  const g = guardPosting({ text });
  return finishAd(g, { source_url: hint?.source_url }, { ...hint });
}

/** YAML for the snapshot's posting_guard block: verdict + counts (+ visible quoted lines). */
function guardFrontmatter(guard: PostingGuardSummary): string[] {
  const c = guard.counts;
  const lines = [
    "posting_guard:",
    `  verdict: ${guard.verdict}`,
    `  hidden_elements: ${c.hidden_elements}`,
    `  invisible_chars: ${c.invisible_chars}`,
    `  smuggled_chars: ${c.smuggled_chars}`,
    `  hidden_urls: ${c.hidden_urls}`,
    `  hidden_instruction_hits: ${c.hidden_instruction_hits}`,
    `  mixed_script_words: ${c.mixed_script_words}`,
  ];
  if (guard.instruction_lines.length) {
    lines.push("  instruction_lines:", ...guard.instruction_lines.map((l) => `    - ${JSON.stringify(l)}`));
  }
  return lines;
}

function buildSnapshotMarkdown(input: {
  text: string;
  source_url?: string;
  pageTitle?: string;
  guard: PostingGuardSummary;
}): string {
  const captured_at = new Date().toISOString().slice(0, 10);
  const frontmatter = [
    "---",
    `captured_at: "${captured_at}"`,
    input.source_url ? `source_url: ${input.source_url}` : "source: pasted",
    input.pageTitle ? `page_title: ${JSON.stringify(input.pageTitle)}` : null,
    'capture_note: "Full text snapshot preserved so the candidate can review pre-interview even if the posting is removed."',
    ...guardFrontmatter(input.guard),
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  return `${frontmatter}\n\n${input.text}\n`;
}
