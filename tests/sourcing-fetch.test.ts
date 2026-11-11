import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBoardDetailed, WORKDAY_MAX_DETAIL, WORKDAY_MAX_PAGES, WORKDAY_PAGE, workdayRemote } from "@kairos/engine/sourcing/adapters";
import type { RegistryEntry } from "@kairos/engine/sourcing/types";

const gh: RegistryEntry = { ats: "greenhouse", slug: "acme" };

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe("fetchBoardDetailed (REQ-6 — typed outcomes, retry, loud failures)", () => {
  it("returns postings on a healthy board", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ jobs: [{ title: "PM", absolute_url: "https://x/1", location: { name: "Denver" } }] }),
    ));
    const r = await fetchBoardDetailed(gh);
    expect(r.failure).toBeUndefined();
    expect(r.postings).toHaveLength(1);
    expect(r.postings[0].title).toBe("PM");
  });

  it("retries once on 429 and succeeds (honoring Retry-After)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "slow down" }, 429, { "retry-after": "0.001" }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [{ title: "PM", absolute_url: "https://x/1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchBoardDetailed(gh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.failure).toBeUndefined();
    expect(r.postings).toHaveLength(1);
  });

  it("reports rate_limited when the retry also 429s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 429, { "retry-after": "0.001" })));
    const r = await fetchBoardDetailed(gh);
    expect(r.postings).toEqual([]);
    expect(r.failure?.kind).toBe("rate_limited");
    expect(r.failure?.status).toBe(429);
  });

  it("classifies 404 as gone (registry decay, not infrastructure failure)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 404)));
    const r = await fetchBoardDetailed(gh);
    expect(r.failure?.kind).toBe("gone");
  });

  it("classifies persistent 5xx as http failure after one retry", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 503, { "retry-after": "0.001" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchBoardDetailed(gh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.failure?.kind).toBe("http");
    expect(r.failure?.status).toBe(503);
  });

  it("classifies invalid JSON as parse failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 200 })));
    const r = await fetchBoardDetailed(gh);
    expect(r.failure?.kind).toBe("parse");
  });

  it("classifies a redirect to an HTML page as gone (closed BambooHR account → www.bamboohr.com)", async () => {
    const html = new Response("<!DOCTYPE html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    Object.defineProperty(html, "redirected", { value: true });
    vi.stubGlobal("fetch", vi.fn(async () => html));
    const r = await fetchBoardDetailed({ ats: "bamboohr", slug: "closedco" });
    expect(r.failure?.kind).toBe("gone");
  });

  it("classifies Workday 422 (removed site) and 403 S22 (disabled site) as gone, other 403s as http", async () => {
    const wd: RegistryEntry = { ats: "workday", slug: "acme@wd1@careers" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errorCode: "HTTP_422" }, 422)));
    expect((await fetchBoardDetailed(wd)).failure?.kind).toBe("gone");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errorCode: "S22", message: "permission denied" }, 403)));
    expect((await fetchBoardDetailed(wd)).failure?.kind).toBe("gone");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errorCode: "OTHER" }, 403)));
    expect((await fetchBoardDetailed(wd)).failure).toEqual({ kind: "http", status: 403 });
  });

  it("greenhouse: dates a posting by first_published, not by its last edit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ jobs: [
        { title: "PM", absolute_url: "https://x/1", first_published: "2026-06-04T11:53:21-04:00", updated_at: "2026-10-30T17:10:22-04:00" },
        { title: "PM2", absolute_url: "https://x/2", updated_at: "2026-10-30T17:10:22-04:00" },
      ] }),
    ));
    const r = await fetchBoardDetailed(gh);
    expect(r.postings[0].posted_at).toBe("2026-06-04T15:53:21.000Z");
    expect(r.postings[1].posted_at).toBe("2026-10-30T21:10:22.000Z");
  });

  it("classifies thrown fetch errors as network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const r = await fetchBoardDetailed(gh);
    expect(r.failure?.kind).toBe("network");
  });
});

describe("adapter payload parsing (REQ-18 — per-ATS fixtures incl. malformed)", () => {
  it("ashby: secondary locations are part of the location (multi-city postings)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ jobs: [{ title: "FDE Lead", jobUrl: "https://x/1", location: "New York City", secondaryLocations: [{ location: "San Francisco " }, { location: "Denver" }, { location: "new york city" }] }] }),
    ));
    const r = await fetchBoardDetailed({ ats: "ashby", slug: "acme" });
    expect(r.postings[0].location).toBe("New York City; San Francisco; Denver");
  });

  it("lever: allLocations are part of the location", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse([{ text: "PM", hostedUrl: "https://x/1", categories: { location: "Remote", allLocations: ["Remote", "Denver, CO"] } }]),
    ));
    const r = await fetchBoardDetailed({ ats: "lever", slug: "acme" });
    expect(r.postings[0].location).toBe("Remote; Denver, CO");
  });

  it("ashby: normal payload with publishedAt and isRemote", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ jobs: [{ title: "PM", jobUrl: "https://a/1", location: "NYC", isRemote: true, publishedAt: "2026-08-01T00:00:00Z" }] }),
    ));
    const r = await fetchBoardDetailed({ ats: "ashby", slug: "acme" });
    expect(r.postings[0]).toMatchObject({ ats: "ashby", title: "PM", remote: true });
    expect(r.postings[0].age_days).toBeGreaterThan(0);
  });

  it("lever: array payload with workplaceType remote", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse([{ text: "Head of AI", hostedUrl: "https://l/1", workplaceType: "remote", categories: { location: "US" } }]),
    ));
    const r = await fetchBoardDetailed({ ats: "lever", slug: "acme" });
    expect(r.postings[0]).toMatchObject({ ats: "lever", title: "Head of AI", remote: true, location: "US" });
  });

  it("smartrecruiters: normal payload — url built from slug+id, location joined, remote flag", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({
        totalFound: 2,
        content: [
          {
            id: "1000000000000001",
            name: "Design Lead",
            releasedDate: "2026-08-01T00:00:00Z",
            company: { identifier: "ExampleCo", name: "ExampleCo" },
            location: { city: "Seoul", country: "kr", remote: false },
          },
          { id: "1000000000000002", name: "Staff PM", location: { remote: true } },
        ],
      }),
    ));
    const r = await fetchBoardDetailed({ ats: "smartrecruiters", slug: "ExampleCo" });
    expect(r.failure).toBeUndefined();
    expect(r.postings).toHaveLength(2);
    expect(r.postings[0]).toMatchObject({
      ats: "smartrecruiters",
      company: "ExampleCo",
      title: "Design Lead",
      url: "https://jobs.smartrecruiters.com/ExampleCo/1000000000000001",
      location: "Seoul, kr",
      remote: false,
    });
    expect(r.postings[0].age_days).toBeGreaterThan(0);
    expect(r.postings[1]).toMatchObject({ remote: true, posted_at: null, age_days: null });
  });

  it("smartrecruiters: paginates until totalFound is covered, one request per page", async () => {
    const pageOf = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `id-${offset + i}`, name: `Role ${offset + i}` }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ totalFound: 150, content: pageOf(100, 0) }))
      .mockResolvedValueOnce(jsonResponse({ totalFound: 150, content: pageOf(50, 100) }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchBoardDetailed({ ats: "smartrecruiters", slug: "Visa" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("offset=100");
    expect(r.postings).toHaveLength(150);
  });

  it("smartrecruiters: malformed payloads resolve to zero postings, not a crash", async () => {
    for (const weird of [{ content: "not-an-array" }, { totalFound: 5 }, [], null, 42]) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(weird)));
      const r = await fetchBoardDetailed({ ats: "smartrecruiters", slug: "ExampleCo" });
      expect(r.failure).toBeUndefined();
      expect(r.postings).toEqual([]);
    }
  });

  it("smartrecruiters: entries missing id or name are dropped, valid siblings kept", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ totalFound: 3, content: [{ name: "No id" }, { id: "1" }, { id: "2", name: "Good" }] }),
    ));
    const r = await fetchBoardDetailed({ ats: "smartrecruiters", slug: "ExampleCo" });
    expect(r.postings).toHaveLength(1);
    expect(r.postings[0].title).toBe("Good");
  });

  it("malformed-but-200 payloads resolve to zero postings, not a crash", async () => {
    for (const weird of [{ jobs: "not-an-array" }, { unexpected: true }, [], "quoted-string", 42, null]) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(weird)));
      const r = await fetchBoardDetailed({ ats: "ashby", slug: "acme" });
      expect(r.postings).toEqual([]);
    }
  });

  it("entries missing required fields are dropped, valid siblings kept", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ jobs: [{ title: "No URL" }, { jobUrl: "https://a/2" }, { title: "Good", jobUrl: "https://a/3" }] }),
    ));
    const r = await fetchBoardDetailed({ ats: "ashby", slug: "acme" });
    expect(r.postings).toHaveLength(1);
    expect(r.postings[0].title).toBe("Good");
  });
});

describe("bamboohr adapter (seventh ATS, 2026-10-13)", () => {
  const list = {
    meta: { totalCount: 3 },
    result: [
      { id: "37", jobOpeningName: "Head of Product", location: { city: null, state: null }, atsLocation: { city: "Madrid", state: null, country: "Spain" }, locationType: "1" },
      { id: "34", jobOpeningName: "Finance Associate", location: { city: "Madrid", state: "Madrid" }, atsLocation: {}, locationType: "2" },
      { id: null, jobOpeningName: "Broken entry" },
    ],
  };

  it("lists a board from /careers/list and dates only the titles worth a detail call", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      return String(url).endsWith("/detail")
        ? jsonResponse({ result: { jobOpening: { datePosted: "2026-09-25" } } })
        : jsonResponse(list);
    }));
    const r = await fetchBoardDetailed({ ats: "bamboohr", slug: "acmelabs" });
    expect(r.failure).toBeUndefined();
    expect(r.postings).toHaveLength(2); // the id-less entry is dropped
    expect(r.postings[0]).toMatchObject({
      ats: "bamboohr",
      title: "Head of Product",
      url: "https://acmelabs.bamboohr.com/careers/37",
      location: "Madrid, Spain",
      remote: true,
    });
    expect(r.postings[0].posted_at).toContain("2026-09-25");
    expect(r.postings[1]).toMatchObject({ title: "Finance Associate", posted_at: null, age_days: null });
    expect(urls).toEqual(["https://acmelabs.bamboohr.com/careers/list", "https://acmelabs.bamboohr.com/careers/37/detail"]);
  });

  it("keeps the posting, undated, when its detail call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).endsWith("/detail") ? jsonResponse({}, 404) : jsonResponse(list),
    ));
    const r = await fetchBoardDetailed({ ats: "bamboohr", slug: "acmelabs" });
    expect(r.postings).toHaveLength(2);
    expect(r.postings[0].posted_at).toBeNull();
  });

  it("reports a missing board as gone, and a malformed payload as zero postings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 404)));
    expect((await fetchBoardDetailed({ ats: "bamboohr", slug: "nope" })).failure?.kind).toBe("gone");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ result: "nope" })));
    expect((await fetchBoardDetailed({ ats: "bamboohr", slug: "odd" })).postings).toEqual([]);
  });
});

describe("workday: multi-city postings listed as 'N Locations' (miss audit, 2026-11-05)", () => {
  const wd: RegistryEntry = { ats: "workday", slug: "acme@wd1@careers" };
  const LIST = "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/careers/jobs";
  const DETAIL = "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/careers/job/";
  const row = (i: number, over: Record<string, string> = {}) => ({
    title: `Group Product Manager ${i}`,
    externalPath: `/job/Denver/Group-Product-Manager_R${i}`,
    locationsText: "3 Locations",
    postedOn: `Posted ${i} Days Ago`,
    ...over,
  });

  it("names the cities from the detail endpoint: primary + additional, deduplicated", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url) === LIST) {
        return jsonResponse({ jobPostings: [row(1), row(2, { locationsText: "Denver, Colorado" })] });
      }
      return jsonResponse({
        jobPostingInfo: { location: "Denver, Colorado", additionalLocations: ["Remote – United States", "denver, colorado", "Portland, Oregon"] },
      });
    }));
    const r = await fetchBoardDetailed(wd);
    expect(r.failure).toBeUndefined();
    expect(r.postings[0]).toMatchObject({
      title: "Group Product Manager 1",
      location: "Denver, Colorado; Remote – United States; Portland, Oregon",
      remote: true,
      url: "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Denver/Group-Product-Manager_R1",
    });
    expect(r.postings[1].location).toBe("Denver, Colorado");
    // One detail call, for the placeholder posting only, at the cxs job path.
    expect(urls).toEqual([LIST, `${DETAIL}Denver/Group-Product-Manager_R1`]);
  });

  it("keeps the placeholder when the detail call fails or names no city", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url) === LIST) return jsonResponse({ jobPostings: [row(1), row(2), row(3)] });
      if (String(url).endsWith("_R1")) return jsonResponse({}, 404);
      if (String(url).endsWith("_R2")) throw new TypeError("fetch failed");
      return jsonResponse({ jobPostingInfo: { additionalLocations: "not-an-array" } });
    }));
    const r = await fetchBoardDetailed(wd);
    expect(r.failure).toBeUndefined();
    expect(r.postings.map((p) => p.location)).toEqual(["3 Locations", "3 Locations", "3 Locations"]);
  });

  it("caps detail calls per board, freshest first, and asks the sweep which postings deserve one", async () => {
    const detailCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url) === LIST) {
        // Four more placeholders than the cap, oldest first in the list, plus
        // the freshest posting of all with a title the sweep does not want.
        const n = WORKDAY_MAX_DETAIL + 4;
        return jsonResponse({ total: n + 1, jobPostings: Array.from({ length: n }, (_, i) => row(n - i)).concat(row(0, { title: "Warehouse Associate" })) });
      }
      detailCalls.push(String(url));
      return jsonResponse({ jobPostingInfo: { location: "Denver, Colorado" } });
    }));
    const r = await fetchBoardDetailed(wd, Date.now(), { resolveLocationFor: (p) => p.title.startsWith("Group Product") });
    expect(detailCalls).toHaveLength(WORKDAY_MAX_DETAIL);
    // The freshest ones: R1 … R(cap).
    expect(detailCalls.map((u) => +u.match(/_R(\d+)$/)![1]).sort((a, b) => a - b)).toEqual(Array.from({ length: WORKDAY_MAX_DETAIL }, (_, i) => i + 1));
    const resolved = r.postings.filter((p) => p.location === "Denver, Colorado").map((p) => p.title);
    expect(resolved).toHaveLength(WORKDAY_MAX_DETAIL);
    expect(r.postings.find((p) => p.title === "Warehouse Associate")?.location).toBe("3 Locations");
    expect(r.postings.find((p) => p.title === `Group Product Manager ${WORKDAY_MAX_DETAIL + 4}`)?.location).toBe("3 Locations");
  });

  it("dates a resolved posting by the detail's startDate, and keeps the list date when it is absent or in the future", async () => {
    const NOW = Date.parse("2026-11-05T12:00:00Z");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url) === LIST) return jsonResponse({ jobPostings: [row(1, { postedOn: "Posted 30+ Days Ago" }), row(2), row(3)] });
      if (String(url).endsWith("_R1")) return jsonResponse({ jobPostingInfo: { location: "Denver, Colorado", startDate: "2026-09-20" } });
      if (String(url).endsWith("_R2")) return jsonResponse({ jobPostingInfo: { location: "Denver, Colorado" } });
      return jsonResponse({ jobPostingInfo: { location: "Denver, Colorado", startDate: "2027-01-01" } });
    }));
    const r = await fetchBoardDetailed(wd, NOW);
    expect(r.postings.map((p) => p.age_days)).toEqual([46, 2, 3]);
  });
});

describe("workday: list paging (2026-11-05: one 20-posting page left out 55% of live boards' hits)", () => {
  const wd: RegistryEntry = { ats: "workday", slug: "acme@wd1@careers" };
  const NOW = Date.parse("2026-11-05T12:00:00Z");
  const ago = (d: number) => (d === 0 ? "Posted Today" : d === 1 ? "Posted Yesterday" : d > 30 ? "Posted 30+ Days Ago" : `Posted ${d} Days Ago`);
  /** A tenant whose search returns `ages.length` postings in this order. */
  const tenant = (ages: number[], opts: { failAt?: number; wrap?: boolean } = {}) => {
    const offsets: number[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { offset: number; limit: number };
      offsets.push(body.offset);
      if (opts.failAt === body.offset) return jsonResponse({}, 404);
      // Workday quirks: only the first page carries the total; an offset past the end returns page one.
      const start = body.offset >= ages.length && opts.wrap ? 0 : body.offset;
      const jobPostings = ages.slice(start, start + body.limit).map((age, k) => ({
        title: `Product Manager ${start + k}`,
        externalPath: `/job/Denver/PM_R${start + k}`,
        locationsText: "Denver, Colorado",
        postedOn: ago(age),
      }));
      return jsonResponse({ total: body.offset === 0 ? ages.length : 0, jobPostings });
    });
    vi.stubGlobal("fetch", fetchMock);
    return offsets;
  };

  it("pages 20 at a time through the first page's total, with no duplicate postings", async () => {
    const offsets = tenant(Array.from({ length: 50 }, () => 40), { wrap: true });
    const r = await fetchBoardDetailed(wd, NOW);
    expect(offsets).toEqual([0, 20, 40]);
    expect(r.postings).toHaveLength(50);
    expect(new Set(r.postings.map((p) => p.url)).size).toBe(50);
    expect(r.partial).toBeUndefined();
  });

  it("stops when a page brings nothing new (an offset past the end returns page one)", async () => {
    // 40 postings but the first page claims no total: the wrap ends it.
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const { offset } = JSON.parse(String(init?.body));
      const start = offset >= 40 ? 0 : offset;
      return jsonResponse({ jobPostings: Array.from({ length: 20 }, (_, k) => ({ title: `PM ${start + k}`, externalPath: `/job/x/PM_${start + k}`, postedOn: "Posted Today" })) });
    }));
    const r = await fetchBoardDetailed(wd, NOW);
    expect(r.postings).toHaveLength(40);
  });

  it("stops a newest-first list once a whole page is past the recency window (plus two days' slack)", async () => {
    // Pages: 0-3 days, 4-8 days (still inside 7 + 2), 10-14 days (stop), then more.
    const ages = [...Array(20).fill(1), ...Array(10).fill(5), ...Array(10).fill(8), ...Array(20).fill(12), ...Array(20).fill(20)];
    const offsets = tenant(ages);
    const r = await fetchBoardDetailed(wd, NOW, { maxAgeDays: 7 });
    expect(offsets).toEqual([0, 20, 40]);
    expect(r.postings).toHaveLength(60);
  });

  it("tolerates a day of disorder in a newest-first list", async () => {
    const ages = [...Array(19).fill(0), 1, 0, ...Array(19).fill(1), ...Array(20).fill(31), ...Array(20).fill(31)];
    const offsets = tenant(ages);
    await fetchBoardDetailed(wd, NOW, { maxAgeDays: 7 });
    expect(offsets).toEqual([0, 20, 40]);
  });

  it("keeps paging a relevance-ordered list (fresh postings anywhere), up to the page cap", async () => {
    // Old and fresh mixed on every page: no recency stop applies.
    const ages = Array.from({ length: 400 }, (_, i) => (i % 7 === 0 ? 2 : 31));
    const offsets = tenant(ages);
    const r = await fetchBoardDetailed(wd, NOW, { maxAgeDays: 7 });
    expect(offsets).toHaveLength(WORKDAY_MAX_PAGES);
    expect(r.postings).toHaveLength(WORKDAY_MAX_PAGES * WORKDAY_PAGE);
  });

  it("without a recency window (deep scan) pages to the cap it is given", async () => {
    const offsets = tenant(Array.from({ length: 600 }, () => 31));
    const r = await fetchBoardDetailed(wd, NOW, { workdayMaxPages: 25 });
    expect(offsets).toHaveLength(25);
    expect(r.postings).toHaveLength(500);
  });

  it("a later page that fails keeps the earlier pages and marks the board partial; a failed first page fails the board", async () => {
    tenant(Array.from({ length: 60 }, () => 1), { failAt: 40 });
    const r = await fetchBoardDetailed(wd, NOW);
    expect(r.failure).toBeUndefined();
    expect(r.postings).toHaveLength(40);
    expect(r.partial).toEqual({ kind: "gone", status: 404 });

    tenant(Array.from({ length: 60 }, () => 1), { failAt: 0 });
    const first = await fetchBoardDetailed(wd, NOW);
    expect(first.failure?.kind).toBe("gone");
    expect(first.postings).toEqual([]);
  });

  it("a short board takes one request, as before", async () => {
    const offsets = tenant([0, 1, 2]);
    const r = await fetchBoardDetailed(wd, NOW, { maxAgeDays: 7 });
    expect(offsets).toEqual([0]);
    expect(r.postings).toHaveLength(3);
  });
});

describe("workday: remoteType", () => {
  it("reads the tenant's label: remote, not remote, or no say", () => {
    for (const label of ["Remote", "Fully Remote", "100% Remote", "Hybrid or 100% Remote", "Remote First", "Virtual Worker", "Remote or Hybrid", "Remote/Hybrid", "Home Based", "Work From Home"]) {
      expect([label, workdayRemote(label)]).toEqual([label, true]);
    }
    for (const label of [
      "Hybrid", "On-Site", "OnSite", "In Person", "#LI-Onsite", "Partially Remote", "Fully Remote Near Primary Location", "Field",
      "Office (In Office 4 days/week)", "Hybrid (Home and Office)", "Office Worker (NOT Remote)", "Non Remote", "On Site",
      "Hybrid Remote", "Hybrid: Remote and Office", "Remote Type - Hybrid",
    ]) {
      expect(workdayRemote(label)).toBe(false);
    }
    for (const label of [undefined, "", "80-100%", "Home Office", "Remote Type - Full-time", "Flexible Work Arrangement"]) expect(workdayRemote(label)).toBeUndefined();
  });

  it("the label wins over the location text; without a label the text decides", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({
        total: 3,
        jobPostings: [
          { title: "PM 1", externalPath: "/job/a/1", locationsText: "US-CA-Remote", remoteType: "Hybrid", postedOn: "Posted Today" },
          { title: "PM 2", externalPath: "/job/a/2", locationsText: "Denver, Colorado", remoteType: "Fully Remote", postedOn: "Posted Today" },
          { title: "PM 3", externalPath: "/job/a/3", locationsText: "Remote - United States", postedOn: "Posted Today" },
        ],
      }),
    ));
    const r = await fetchBoardDetailed({ ats: "workday", slug: "acme@wd1@careers" });
    expect(r.postings.map((p) => p.remote)).toEqual([false, true, true]);
  });
});
