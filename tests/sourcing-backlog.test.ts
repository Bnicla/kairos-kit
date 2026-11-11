import { describe, expect, it } from "vitest";
import { mergeBacklog, mergeBacklogForProfile, backlogBuckets, type BacklogEntry } from "@kairos/engine/sourcing/backlog";
import type { RankedPosting } from "@kairos/engine/sourcing/types";

/**
 * Persistence semantics for the sourced backlog — the regression guard for
 * run-scoped amnesia (a card surfaced by one run vanished when the next run's
 * triage made a different cut, before the user ever saw it).
 */

const posting = (url: string, over: Partial<RankedPosting> = {}): RankedPosting =>
  ({
    url,
    title: "Principal PM",
    company: url.replace(/https?:\/\//, "").split(".")[0],
    location: "Remote, US",
    age_days: 1,
    rank_score: 10,
    location_fit: "match",
    ...over,
  }) as RankedPosting;

const entry = (url: string, over: Partial<BacklogEntry> = {}): BacklogEntry => ({
  ...posting(url),
  first_seen: "2026-09-01T00:00:00.000Z",
  last_seen: "2026-09-03T00:00:00.000Z",
  bucket: "match",
  ...over,
});

const RAN_AT = "2026-09-07T12:00:00.000Z";

describe("mergeBacklog", () => {
  it("keeps a previously surfaced card the new run no longer lists, marked carried", () => {
    const out = mergeBacklog({
      previous: [entry("https://tr.example/director")],
      runSurvivors: [posting("https://new.example/pm")],
      runStretch: [],
      ranAt: RAN_AT,
      actionedUrls: new Set(),
    });
    const urls = out.map((e) => e.url);
    expect(urls).toContain("https://tr.example/director");
    expect(out.find((e) => e.url === "https://tr.example/director")?.carried).toBe(true);
    expect(out.find((e) => e.url === "https://new.example/pm")?.carried).toBe(false);
  });

  it("orders fresh cards before carried ones (recency rule)", () => {
    const out = mergeBacklog({
      previous: [entry("https://old.example/a")],
      runSurvivors: [posting("https://fresh.example/b")],
      runStretch: [],
      ranAt: RAN_AT,
      actionedUrls: new Set(),
    });
    expect(out[0].url).toBe("https://fresh.example/b");
  });

  it("resurfaced cards keep first_seen but refresh last_seen and triage read", () => {
    const out = mergeBacklog({
      previous: [entry("https://co.example/pm", { guess_band: "COMPETITIVE" })],
      runSurvivors: [posting("https://co.example/pm", { guess_band: "STRONG" } as never)],
      runStretch: [],
      ranAt: RAN_AT,
      actionedUrls: new Set(),
    });
    const e = out.find((x) => x.url === "https://co.example/pm")!;
    expect(e.first_seen).toBe("2026-09-01T00:00:00.000Z");
    expect(e.last_seen).toBe(RAN_AT);
    expect(e.guess_band).toBe("STRONG");
    expect(e.carried).toBe(false);
  });

  it("drops actioned cards (tracked or dismissed), matching on canonical URL", () => {
    const out = mergeBacklog({
      previous: [entry("https://a.example/x?utm=1")],
      runSurvivors: [posting("https://b.example/y?src=2")],
      runStretch: [],
      ranAt: RAN_AT,
      actionedUrls: new Set(["https://a.example/x", "https://b.example/y"]),
    });
    expect(out).toHaveLength(0);
  });

  it("retires entries not re-surfaced within staleAfterDays", () => {
    const out = mergeBacklog({
      previous: [
        entry("https://stale.example/a", { last_seen: "2026-08-20T00:00:00.000Z" }),
        entry("https://live.example/b", { last_seen: "2026-09-05T00:00:00.000Z" }),
      ],
      runSurvivors: [],
      runStretch: [],
      ranAt: RAN_AT,
      actionedUrls: new Set(),
      staleAfterDays: 14,
    });
    expect(out.map((e) => e.url)).toEqual(["https://live.example/b"]);
  });

  it("re-applies today's rules to carried cards (2026-10-08: pre-rule ad-tech cards lingered)", () => {
    const out = mergeBacklog({
      previous: [
        entry("https://pinecrest.example/ads", { title: "Staff PM, Ads Formats" }),
        entry("https://ok.example/pm"),
      ],
      runSurvivors: [],
      runStretch: [],
      ranAt: RAN_AT,
      actionedUrls: new Set(),
      stillEligible: (e) => !/\bads\b/i.test(e.title),
    });
    expect(out.map((e) => e.url)).toEqual(["https://ok.example/pm"]);
  });

  it("retires carried cards first seen beyond maxCarryDays, even if re-stamped recently", () => {
    const out = mergeBacklog({
      previous: [
        entry("https://old.example/a", { first_seen: "2026-08-25T00:00:00.000Z", last_seen: "2026-09-06T00:00:00.000Z" }),
        entry("https://new.example/b", { first_seen: "2026-09-04T00:00:00.000Z", last_seen: "2026-09-06T00:00:00.000Z" }),
      ],
      runSurvivors: [posting("https://old2.example/c")],
      runStretch: [],
      ranAt: RAN_AT,
      actionedUrls: new Set(),
      maxCarryDays: 7,
    });
    expect(out.map((e) => e.url).sort()).toEqual(["https://new.example/b", "https://old2.example/c"]);
  });

  it("a card the fresh run re-surfaces is never retired by the carry window", () => {
    const out = mergeBacklog({
      previous: [entry("https://co.example/pm", { first_seen: "2026-08-01T00:00:00.000Z", last_seen: "2026-09-06T00:00:00.000Z" })],
      runSurvivors: [posting("https://co.example/pm")],
      runStretch: [],
      ranAt: RAN_AT,
      actionedUrls: new Set(),
      maxCarryDays: 7,
    });
    expect(out).toHaveLength(1);
    expect(out[0].carried).toBe(false);
  });

  it("recomputes a carried card's age from posted_at instead of freezing it", () => {
    const out = mergeBacklog({
      previous: [entry("https://co.example/pm", { posted_at: "2026-09-02T00:00:00.000Z", age_days: 0 })],
      runSurvivors: [],
      runStretch: [],
      ranAt: RAN_AT,
      actionedUrls: new Set(),
    });
    expect(out[0].age_days).toBe(5);
  });

  it("collapses the same role posted under two URLs, keeping the fresh card", () => {
    const out = mergeBacklog({
      previous: [entry("https://abbvie.example/1", { company: "AbbVie", title: "Head of AI Strategic Programs" })],
      runSurvivors: [posting("https://abbvie.example/2", { company: "AbbVie", title: "Head of AI  Strategic Programs " })],
      runStretch: [],
      ranAt: RAN_AT,
      actionedUrls: new Set(),
    });
    expect(out.map((e) => e.url)).toEqual(["https://abbvie.example/2"]);
  });

  it("keeps dropped triage bands off the board, fresh or carried; untriaged cards stay", () => {
    const out = mergeBacklog({
      previous: [entry("https://old.example/dev", { guess_band: "DEVELOPING" } as never)],
      runSurvivors: [
        posting("https://new.example/dev", { title: "Dev role", guess_band: "DEVELOPING" } as never),
        posting("https://new.example/strong", { title: "Strong role", guess_band: "STRONG" } as never),
        posting("https://new.example/untriaged", { title: "Untriaged role" }),
      ],
      runStretch: [],
      ranAt: RAN_AT,
      actionedUrls: new Set(),
      dropBands: ["DEVELOPING"],
    });
    expect(out.map((e) => e.url).sort()).toEqual(["https://new.example/strong", "https://new.example/untriaged"]);
  });

  it("backlogBuckets splits by last bucket, preserving order", () => {
    const out = mergeBacklog({
      previous: [],
      runSurvivors: [posting("https://m.example/1")],
      runStretch: [posting("https://s.example/2")],
      ranAt: RAN_AT,
      actionedUrls: new Set(),
    });
    const { matches, stretch } = backlogBuckets(out);
    expect(matches.map((e) => e.url)).toEqual(["https://m.example/1"]);
    expect(stretch.map((e) => e.url)).toEqual(["https://s.example/2"]);
  });
});

describe("mergeBacklogForProfile (cloud results merged on the Mac)", () => {
  const profile = {
    function_terms: ["product"],
    exclude_terms: ["ads"],
    locations: ["denver", "remote"],
    boost_terms: [],
    seniority_terms: [],
    max_age_days: 7,
    excluded_locations: ["austin"],
  };
  it("filters the incoming run by today's rules and known applications, and drops weak bands", () => {
    const out = mergeBacklogForProfile({
      previous: [],
      runSurvivors: [
        posting("https://a.example/1", { company: "Acme", title: "Principal Product Manager, AI Platform" }),
        posting("https://b.example/2", { company: "Pinecrest", title: "Staff Product Manager, Ads Formats" }),
        posting("https://c.example/3", { company: "Lonestar Labs", title: "Head of Product", location: "Austin, TX", remote: false }),
        posting("https://d.example/4", { company: "Halo Rings", title: "Staff Product Manager", guess_band: "DEVELOPING" } as never),
        posting("https://e.example/5", { company: "Wavecraft", title: "Staff Product Manager, AI Applications", guess_band: "COMPETITIVE" } as never),
      ],
      runStretch: [],
      ranAt: RAN_AT,
      actionedUrls: new Set(),
      profile,
      knownApplications: [{ company: "Acme", role: "Principal Product Manager, AI Platform" }],
    });
    expect(out.map((e) => e.company)).toEqual(["Wavecraft"]);
  });
});

describe("topSourced (column cap, 2026-10-25)", () => {
  it("keeps the best few: matches before stretch, stronger band, then freshest", async () => {
    const { topSourced } = await import("@kairos/engine/sourcing/backlog");
    const cards = [
      { id: "stretch-strong", location_fit: "stretch", guess_band: "STRONG", age_days: 0 },
      { id: "comp-old", location_fit: "match", guess_band: "COMPETITIVE", age_days: 6 },
      { id: "strong-old", location_fit: "match", guess_band: "STRONG", age_days: 5 },
      { id: "strong-new", location_fit: "match", guess_band: "STRONG", age_days: 1 },
    ];
    expect(topSourced(cards, 3).map((c) => c.id)).toEqual(["strong-new", "strong-old", "comp-old"]);
  });
});
