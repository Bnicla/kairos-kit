import { describe, expect, it, vi } from "vitest";
import type { FetchOptions } from "@kairos/engine/sourcing/adapters";
import type { FilterStats } from "@kairos/engine/sourcing/sweep";
import type { Posting, SearchProfile } from "@kairos/engine/sourcing/types";

/**
 * Per-gate loss telemetry (miss audit, 2026-11-05): every fetched posting is
 * accounted for at exactly one gate or on the board, with priority shapes
 * counted, and the run flags location data that has gone unknown.
 */

let n = 0;
const mk = (over: Partial<Posting>): Posting => ({
  ats: "greenhouse",
  slug: "acme",
  company: "Acme",
  title: "Product Manager",
  url: `https://boards.greenhouse.io/acme/jobs/${++n}`,
  location: "Denver, CO",
  remote: false,
  posted_at: new Date().toISOString(),
  age_days: 1,
  ...over,
});

const postings: Posting[] = [
  mk({ url: "https://x.co/1" }),
  mk({ url: "https://x.co/1?utm=dup" }), // duplicate_url
  mk({ url: "https://x.co/2", location: "Portland, OR" }), // duplicate_role (stretch copy of /1)
  mk({ title: "Product Manager, Seen", url: "https://x.co/seen" }), // seen
  mk({ title: "Product Manager, Applied", company: "Hooli" }), // known_application
  mk({ title: "Account Executive" }), // no_function_term
  mk({ title: "Principal Product Designer" }), // exclude_term (priority)
  mk({ title: "Product Lead", company: "Globex" }), // excluded_company
  mk({ title: "Product Manager, Payments", location: "Phoenix, AZ" }), // excluded_location
  mk({ title: "Director of Product", location: "Berlin, Germany" }), // non_us (priority)
  mk({ title: "Principal Product Manager, Old", age_days: 20 }), // too_old (priority)
  mk({ title: "Product Manager, Mobile", location: "Seattle, WA" }), // secondary_bar
  mk({ title: "Product Specialist", location: "Portland, OR" }), // weak_stretch
  ...["A", "B", "C", "D"].map((x) => mk({ title: `Product Manager ${x}`, company: "Initech" })), // 1 company_cap
  mk({ title: "Principal Product Manager, AI", company: "Umbrella", location: "Portland, OR" }), // stretch (priority)
  mk({ title: "Product Lead, Workflows", company: "Vandelay", location: "3 Locations" }), // unknown → match
  mk({ title: "Product Manager, Data", company: "Pied Piper", location: "" }), // empty → match; triage SKIPs it
  mk({ title: "Product Manager, Tracked", company: "Wayne", url: "https://wayne.example/careers?gh_jid=1234567" }), // already_tracked
];

let seenOpts: FetchOptions | undefined;
vi.mock("@kairos/engine/sourcing/adapters", async (orig) => ({
  ...(await orig<typeof import("@kairos/engine/sourcing/adapters")>()),
  fetchBoardDetailed: async (_entry: unknown, _now: unknown, opts?: FetchOptions) => {
    seenOpts = opts;
    return { postings };
  },
}));

const profile: SearchProfile = {
  function_terms: ["product"],
  exclude_terms: ["designer"],
  locations: ["denver", "united states"],
  secondary_locations: ["seattle"],
  excluded_locations: ["phoenix"],
  excluded_companies: ["globex"],
  boost_terms: ["ai"],
  seniority_terms: ["principal", "director"],
  max_age_days: 7,
};

describe("runSourcingSweep filter_stats", () => {
  it("accounts for every fetched posting, gate by gate", async () => {
    const { runSourcingSweep, FILTER_GATES } = await import("@kairos/engine/sourcing/sweep");
    const result = await runSourcingSweep({
      registry: [{ ats: "greenhouse", slug: "acme" }],
      profile,
      seenUrls: new Set(["https://x.co/seen", "https://boards.greenhouse.io/wayne/jobs/1234567"]),
      knownApplications: [{ company: "Hooli", role: "Product Manager, Applied" }],
      profileSummary: "Product leader.",
      triage: async (prompt) => {
        const urls = [...prompt.matchAll(/^- url: (\S+)$/gm)].map((m) => m[1]);
        return JSON.stringify(
          urls.map((url) => ({ url, verdict: url === postings[19].url ? "SKIP" : "SHORTLIST", guess_band: "STRONG" })),
        );
      },
    });
    const f = result.filter_stats!;
    expect(f.input).toBe(postings.length);
    expect(Object.keys(f.gates)).toEqual([...FILTER_GATES]);
    const g = f.gates;
    const removed = (k: keyof typeof g) => g[k].removed;
    expect(removed("duplicate_url")).toBe(1);
    expect(removed("duplicate_role")).toBe(1);
    expect(removed("seen")).toBe(1);
    expect(removed("known_application")).toBe(1);
    expect(removed("no_function_term")).toBe(1);
    expect(g.exclude_term).toEqual({ removed: 1, priority: 1 });
    expect(removed("excluded_company")).toBe(1);
    expect(removed("excluded_location")).toBe(1);
    expect(g.non_us).toEqual({ removed: 1, priority: 1 });
    expect(g.too_old).toEqual({ removed: 1, priority: 1 });
    expect(removed("secondary_bar")).toBe(1);
    expect(removed("weak_stretch")).toBe(1);
    expect(removed("company_cap")).toBe(1);
    expect(removed("already_tracked")).toBe(1);
    expect(removed("triage_cut")).toBe(1); // Pied Piper, SKIPped
    expect(removed("same_company")).toBe(2); // Initech: three shortlisted, one card
    expect(removed("over_cap")).toBe(0);
    expect(removed("below_cut")).toBe(0);
    expect(f.routed_to_stretch).toEqual({ count: 1, priority: 1 });
    expect(f.on_board).toEqual({ count: 4, priority: 1 }); // Acme, Initech, Vandelay + Umbrella (stretch)

    // Nothing disappears unaccounted.
    const total = Object.values(g).reduce((s, c) => s + c.removed, 0);
    expect(total + f.on_board.count).toBe(f.input);

    // Location health: one "N Locations", one empty, among the rankable postings.
    expect(f.location_health).toMatchObject({ unresolved_multi: 1, empty: 1, threshold: 0.05 });
    expect(f.location_health.share).toBeCloseTo(2 / f.location_health.checked, 3);
    expect(f.location_health.alarm).toBe(2 / f.location_health.checked > 0.05);
  }, 30_000); // cold import of the sweep module is slow under a parallel run

  it("asks the adapters to resolve locations only for postings that can reach the board", async () => {
    const { runSourcingSweep } = await import("@kairos/engine/sourcing/sweep");
    await runSourcingSweep({
      registry: [{ ats: "greenhouse", slug: "acme" }],
      profile,
      seenUrls: new Set(),
      knownApplications: [],
      profileSummary: "",
    });
    expect(seenOpts).toMatchObject({ maxAgeDays: 7 });
    const want = seenOpts!.resolveLocationFor!;
    expect(want(mk({ title: "Group Product Manager", location: "3 Locations" }))).toBe(true);
    expect(want(mk({ title: "Group Product Manager", age_days: 30 }))).toBe(false); // outside the window
    expect(want(mk({ title: "Account Executive" }))).toBe(false); // fails the function gate
  });

  it("raises the location alarm when unknown locations pass the threshold", async () => {
    const { runSourcingSweep } = await import("@kairos/engine/sourcing/sweep");
    postings.splice(0, postings.length, ...Array.from({ length: 20 }, (_, i) => mk({ title: `Product Manager ${i}`, location: i < 2 ? "2 Locations" : "Denver, CO" })));
    const result = await runSourcingSweep({
      registry: [{ ats: "greenhouse", slug: "acme" }],
      profile,
      seenUrls: new Set(),
      knownApplications: [],
      profileSummary: "",
    });
    expect(result.filter_stats!.location_health).toMatchObject({ checked: 20, unresolved_multi: 2, empty: 0, share: 0.1, alarm: true });
    postings.splice(0, 1, mk({ title: "Product Manager 0", location: "Denver, CO" }));
    const healthy = await runSourcingSweep({
      registry: [{ ats: "greenhouse", slug: "acme" }],
      profile,
      seenUrls: new Set(),
      knownApplications: [],
      profileSummary: "",
    });
    expect(healthy.filter_stats!.location_health).toMatchObject({ checked: 20, unresolved_multi: 1, share: 0.05, alarm: false });
  });
});

describe("triage batches (dry run 2026-11-05: 203 priority shapes cut unreviewed as over_cap)", () => {
  const fill = (list: Posting[]) => postings.splice(0, postings.length, ...list);
  // 200 fresh plain titles outrank 50 six-day-old priority titles, so the
  // first batch (120 matches) holds only plain ones.
  const plain = () => Array.from({ length: 200 }, (_, i) => mk({ title: `Product Manager ${i}`, company: `Plain ${i}`, age_days: 0 }));
  const senior = () => Array.from({ length: 50 }, (_, i) => mk({ title: `Principal Product Manager ${i}`, company: `Senior ${i}`, age_days: 6 }));
  const urlsIn = (prompt: string) => [...prompt.matchAll(/^- url: (\S+)$/gm)].map((m) => m[1]);
  const titlesIn = (prompt: string) => [...prompt.matchAll(/^ {2}title: (.+)$/gm)].map((m) => m[1]);
  const base = { registry: [{ ats: "greenhouse" as const, slug: "acme" }], profile, seenUrls: new Set<string>(), knownApplications: [], profileSummary: "" };
  // Nothing disappears unaccounted.
  const invariant = (f: FilterStats) => Object.values(f.gates).reduce((s, c) => s + c.removed, 0) + f.on_board.count === f.input;

  it("sends every priority shape past the first batch to a follow-up batch; plain ones stay over_cap", async () => {
    const { runSourcingSweep } = await import("@kairos/engine/sourcing/sweep");
    fill([...plain(), ...senior()]);
    const prompts: string[] = [];
    const result = await runSourcingSweep({
      ...base,
      triage: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify(urlsIn(prompt).map((url) => ({ url, verdict: prompt.includes("Principal") ? "SHORTLIST" : "SKIP", guess_band: "STRONG" })));
      },
    });
    expect(prompts).toHaveLength(2);
    expect(titlesIn(prompts[0])).toHaveLength(120);
    expect(titlesIn(prompts[0]).every((t) => t.startsWith("Product Manager"))).toBe(true);
    expect(titlesIn(prompts[1])).toHaveLength(50);
    expect(titlesIn(prompts[1]).every((t) => t.startsWith("Principal"))).toBe(true);
    expect(result.triage_batches).toEqual({ batches: 2, failed: 0, postings: 170 });
    const f = result.filter_stats!;
    expect(f.gates.over_cap).toEqual({ removed: 80, priority: 0 });
    expect(f.gates.triage_cut).toEqual({ removed: 120, priority: 0 });
    expect(f.on_board).toEqual({ count: 25, priority: 25 });
    expect(f.gates.below_cut).toEqual({ removed: 25, priority: 25 });
    expect(result.also_qualified).toEqual([]);
    expect(invariant(f)).toBe(true);
  });

  it("stops at the run's total cap; the rest stay loud as also_qualified", async () => {
    const { runSourcingSweep } = await import("@kairos/engine/sourcing/sweep");
    fill([...plain(), ...senior()]);
    const sizes: number[] = [];
    const result = await runSourcingSweep({
      ...base,
      triageTotalCap: 160,
      triage: async (prompt) => {
        sizes.push(urlsIn(prompt).length);
        return JSON.stringify(urlsIn(prompt).map((url) => ({ url, verdict: "SHORTLIST", guess_band: "STRONG" })));
      },
    });
    expect(sizes).toEqual([120, 40]);
    expect(result.filter_stats!.gates.over_cap).toEqual({ removed: 90, priority: 10 });
    expect(result.also_qualified).toHaveLength(10);
    expect(invariant(result.filter_stats!)).toBe(true);
  });

  it("a failed follow-up batch leaves the run triaged; its postings count as over_cap and are listed", async () => {
    const { runSourcingSweep } = await import("@kairos/engine/sourcing/sweep");
    fill([...plain(), ...senior()]);
    const logs: string[] = [];
    let calls = 0;
    const result = await runSourcingSweep({
      ...base,
      onLog: (m) => logs.push(m),
      triage: async (prompt) => {
        if (++calls > 1) throw new Error("CLI timed out");
        return JSON.stringify(urlsIn(prompt).map((url) => ({ url, verdict: "SHORTLIST", guess_band: "STRONG" })));
      },
    });
    expect(result.triaged).toBe(true);
    expect(result.triage_error).toBeNull();
    expect(result.triage_batches).toEqual({ batches: 2, failed: 1, postings: 170 });
    expect(result.filter_stats!.gates.over_cap).toEqual({ removed: 130, priority: 50 });
    expect(result.also_qualified).toHaveLength(50);
    expect(logs.some((m) => m.includes("triage batch 2/2 failed"))).toBe(true);
    expect(invariant(result.filter_stats!)).toBe(true);
  });

  it("a failed first batch ships the untriaged fallback and makes no follow-up call", async () => {
    const { runSourcingSweep } = await import("@kairos/engine/sourcing/sweep");
    fill([...plain(), ...senior()]);
    let calls = 0;
    const result = await runSourcingSweep({ ...base, triage: async () => { calls++; return "no json here"; } });
    expect(calls).toBe(1);
    expect(result.triaged).toBe(false);
    expect(result.triage_error).toMatch(/no parseable verdicts/);
    expect(result.filter_stats!.gates.over_cap.priority).toBe(50);
    expect(invariant(result.filter_stats!)).toBe(true);
  });
});

describe("sweep boards and fetch options", () => {
  it("sweeps a Workday site listed in two spellings once", async () => {
    const { runSourcingSweep } = await import("@kairos/engine/sourcing/sweep");
    postings.splice(0, postings.length, mk({}));
    const result = await runSourcingSweep({
      registry: [
        { ats: "workday", slug: "acme@wd1@External" },
        { ats: "workday", slug: "acme@wd1@external" },
        { ats: "greenhouse", slug: "acme" },
      ],
      profile,
      seenUrls: new Set(),
      knownApplications: [],
      profileSummary: "",
    });
    expect(result.boards_swept).toBe(2);
  });

  it("daily lane pages Workday to the recency window; deep lane has no window and a larger cap", async () => {
    const { sweepFetchOptions } = await import("@kairos/engine/sourcing/sweep");
    const { WORKDAY_MAX_PAGES, WORKDAY_MAX_PAGES_DEEP } = await import("@kairos/engine/sourcing/adapters");
    expect(sweepFetchOptions(profile)).toMatchObject({ maxAgeDays: 7, workdayMaxPages: WORKDAY_MAX_PAGES });
    const deep = sweepFetchOptions(profile, true);
    expect(deep.maxAgeDays).toBeUndefined();
    expect(deep.workdayMaxPages).toBe(WORKDAY_MAX_PAGES_DEEP);
    expect(WORKDAY_MAX_PAGES_DEEP).toBeGreaterThan(WORKDAY_MAX_PAGES);
  });
});
