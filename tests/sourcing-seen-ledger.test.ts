import { describe, expect, it } from "vitest";
import { updateSeenLedger, type SeenLedger } from "@kairos/engine/sourcing/seen-ledger";
import type { RankedPosting } from "@kairos/engine/sourcing/types";

/**
 * Seen-ledger semantics — the post-mortem-2026-09-27 audit trail. The sweep
 * must remember every posting it ever surfaced (with disposition and age at
 * first sight), report genuinely NEW roles, and alert when a previously
 * shortlisted role leaves the board un-actioned instead of vanishing silently.
 */

const posting = (url: string, over: Partial<RankedPosting> = {}): RankedPosting =>
  ({
    url,
    title: "Head of Product",
    company: "Northwind",
    location: "Remote, US",
    age_days: 3,
    rank_score: 10,
    location_fit: "match",
    reasons: [],
    ...over,
  }) as RankedPosting;

const RUN1 = "2026-09-25T12:00:00.000Z";
const RUN2 = "2026-09-26T12:00:00.000Z";

describe("updateSeenLedger", () => {
  it("records first sightings with disposition and age at first sight, reports them as new", () => {
    const { ledger, newlySurfaced } = updateSeenLedger({
      previous: {},
      survivors: [posting("https://x.co/a?utm=1", { age_days: 2 })],
      stretch: [posting("https://x.co/b", { title: "Director PM" })],
      alsoQualified: [posting("https://x.co/c", { title: "Principal PM", age_days: 5 })],
      dropped: [posting("https://x.co/d", { drop_reason: "triage_cut" })],
      ranAt: RUN1,
      lane: "daily",
      actionedUrls: new Set(),
    });
    expect(ledger["https://x.co/a"]).toMatchObject({
      disposition: "shortlisted",
      first_seen: RUN1,
      age_at_first_sight: 2,
      ever_shortlisted: true,
    });
    expect(ledger["https://x.co/b"].disposition).toBe("stretch");
    expect(ledger["https://x.co/c"].disposition).toBe("also_qualified");
    expect(ledger["https://x.co/d"]).toMatchObject({ disposition: "dropped", drop_reason: "triage_cut" });
    // Dropped roles are recorded but not celebrated as "new".
    expect(newlySurfaced.map((e) => e.url)).toEqual(["https://x.co/a?utm=1", "https://x.co/b", "https://x.co/c"]);
  });

  it("keeps first_seen and age_at_first_sight on later sightings; only new roles are reported", () => {
    const first = updateSeenLedger({
      previous: {},
      survivors: [posting("https://x.co/a", { age_days: 2 })],
      stretch: [],
      ranAt: RUN1,
      lane: "daily",
      actionedUrls: new Set(),
    });
    const second = updateSeenLedger({
      previous: first.ledger,
      survivors: [posting("https://x.co/a", { age_days: 3 }), posting("https://x.co/new")],
      stretch: [],
      ranAt: RUN2,
      lane: "daily",
      actionedUrls: new Set(),
    });
    expect(second.ledger["https://x.co/a"]).toMatchObject({
      first_seen: RUN1,
      last_seen: RUN2,
      age_at_first_sight: 2,
    });
    expect(second.newlySurfaced.map((e) => e.url)).toEqual(["https://x.co/new"]);
  });

  it("alerts once when a shortlisted role leaves the run AND the board un-actioned", () => {
    const first = updateSeenLedger({
      previous: {},
      survivors: [posting("https://x.co/gone")],
      stretch: [],
      ranAt: RUN1,
      lane: "daily",
      actionedUrls: new Set(),
    });
    const second = updateSeenLedger({
      previous: first.ledger,
      survivors: [],
      stretch: [],
      ranAt: RUN2,
      lane: "daily",
      actionedUrls: new Set(),
      boardUrls: new Set(),
    });
    expect(second.vanishedShortlisted.map((e) => e.url)).toEqual(["https://x.co/gone"]);
    expect(second.ledger["https://x.co/gone"].vanished_at).toBe(RUN2);
    // Already alerted: the next run stays quiet.
    const third = updateSeenLedger({
      previous: second.ledger,
      survivors: [],
      stretch: [],
      ranAt: "2026-09-27T12:00:00.000Z",
      lane: "daily",
      actionedUrls: new Set(),
    });
    expect(third.vanishedShortlisted).toHaveLength(0);
  });

  it("does not alert while the role still lives on the board (backlog) or was actioned", () => {
    const first = updateSeenLedger({
      previous: {},
      survivors: [posting("https://x.co/carried"), posting("https://x.co/tracked")],
      stretch: [],
      ranAt: RUN1,
      lane: "daily",
      actionedUrls: new Set(),
    });
    const second = updateSeenLedger({
      previous: first.ledger,
      survivors: [],
      stretch: [],
      ranAt: RUN2,
      lane: "daily",
      actionedUrls: new Set(["https://x.co/tracked"]),
      boardUrls: new Set(["https://x.co/carried"]),
    });
    expect(second.vanishedShortlisted).toHaveLength(0);
  });

  it("does not alert when the role is still listed by its ATS but aged out of the window or was filtered", () => {
    const first = updateSeenLedger({
      previous: {},
      survivors: [posting("https://x.co/aged"), posting("https://x.co/closed")],
      stretch: [],
      ranAt: RUN1,
      lane: "daily",
      actionedUrls: new Set(),
    });
    const second = updateSeenLedger({
      previous: first.ledger,
      survivors: [],
      stretch: [],
      ranAt: RUN2,
      lane: "daily",
      actionedUrls: new Set(),
      liveUrls: new Set(["https://x.co/aged"]),
    });
    expect(second.vanishedShortlisted.map((e) => e.url)).toEqual(["https://x.co/closed"]);
  });

  it("a re-sighting clears the vanished flag (posting reopened or refetched)", () => {
    const previous: SeenLedger = {
      "https://x.co/back": {
        company: "X",
        title: "Head of Product",
        location: "Remote",
        url: "https://x.co/back",
        first_seen: RUN1,
        last_seen: RUN1,
        age_at_first_sight: 1,
        disposition: "shortlisted",
        ever_shortlisted: true,
        vanished_at: RUN1,
      },
    };
    const { ledger } = updateSeenLedger({
      previous,
      survivors: [posting("https://x.co/back")],
      stretch: [],
      ranAt: RUN2,
      lane: "daily",
      actionedUrls: new Set(),
    });
    expect(ledger["https://x.co/back"].vanished_at).toBeUndefined();
    expect(ledger["https://x.co/back"].ever_shortlisted).toBe(true);
  });

  it("deep lane records sightings but never raises vanish alerts (different universe)", () => {
    const first = updateSeenLedger({
      previous: {},
      survivors: [posting("https://x.co/daily")],
      stretch: [],
      ranAt: RUN1,
      lane: "daily",
      actionedUrls: new Set(),
    });
    const deep = updateSeenLedger({
      previous: first.ledger,
      survivors: [posting("https://x.co/old-role", { age_days: 46 })],
      stretch: [],
      ranAt: RUN2,
      lane: "deep",
      actionedUrls: new Set(),
      boardUrls: new Set(),
    });
    expect(deep.vanishedShortlisted).toHaveLength(0);
    expect(deep.ledger["https://x.co/old-role"]).toMatchObject({ last_lane: "deep", age_at_first_sight: 46 });
    // The daily role is untouched, not marked vanished by the deep pass.
    expect(deep.ledger["https://x.co/daily"].vanished_at).toBeUndefined();
  });

  it("a deep-lane shortlisted role does not 'vanish' on the next daily run (outside its window)", () => {
    const deep = updateSeenLedger({
      previous: {},
      survivors: [posting("https://x.co/old-role", { age_days: 46 })],
      stretch: [],
      ranAt: RUN1,
      lane: "deep",
      actionedUrls: new Set(),
    });
    const daily = updateSeenLedger({
      previous: deep.ledger,
      survivors: [],
      stretch: [],
      ranAt: RUN2,
      lane: "daily",
      actionedUrls: new Set(),
      boardUrls: new Set(),
    });
    expect(daily.vanishedShortlisted).toHaveLength(0);
    expect(daily.ledger["https://x.co/old-role"].vanished_at).toBeUndefined();
  });
});

describe("posting identity across Workday site-name spellings (2026-11-06)", () => {
  const UPPER = "https://acme.wd5.myworkdayjobs.com/en-US/Acme_Careers_External/job/Remote-USA/Principal-PM_R000001-1";
  const LOWER = "https://acme.wd5.myworkdayjobs.com/en-US/acme_careers_external/job/Remote-USA/Principal-PM_R000001-1";

  it("postingKey folds case for Workday and SmartRecruiters only", async () => {
    const { postingKey } = await import("@kairos/engine/sourcing/url-key");
    expect(postingKey(UPPER)).toBe(postingKey(LOWER));
    expect(postingKey("https://jobs.smartrecruiters.com/Canva/123?x=1")).toBe(postingKey("https://jobs.smartrecruiters.com/canva/123"));
    // Greenhouse/Ashby ids are case-sensitive: left exact.
    expect(postingKey("https://jobs.ashbyhq.com/Acme/AbC?src=1")).toBe("https://jobs.ashbyhq.com/Acme/AbC");
  });

  it("a shortlisted Workday role seen again under the other spelling is neither new nor vanished", () => {
    const first = updateSeenLedger({
      previous: {},
      survivors: [posting(UPPER, { age_days: 1 })],
      stretch: [],
      ranAt: RUN1,
      lane: "daily",
      actionedUrls: new Set(),
    });
    const second = updateSeenLedger({
      previous: first.ledger,
      survivors: [posting(LOWER, { age_days: 2 })],
      stretch: [],
      ranAt: RUN2,
      lane: "daily",
      actionedUrls: new Set(),
    });
    expect(second.newlySurfaced).toEqual([]);
    expect(second.vanishedShortlisted).toEqual([]);
    expect(Object.keys(second.ledger)).toHaveLength(1);
    expect(Object.values(second.ledger)[0]).toMatchObject({ first_seen: RUN1, last_seen: RUN2, age_at_first_sight: 1 });
  });

  it("merges a stored ledger holding both spellings, clearing a vanished mark the other copy disproves", () => {
    const previous: SeenLedger = {
      [UPPER]: {
        company: "Acme", title: "Principal PM", location: "Remote-USA", url: UPPER,
        first_seen: RUN1, last_seen: RUN1, age_at_first_sight: 1, disposition: "shortlisted",
        ever_shortlisted: true, vanished_at: RUN2, last_lane: "daily",
      },
      [LOWER]: {
        company: "Acme", title: "Principal PM", location: "Remote-USA", url: LOWER,
        first_seen: RUN2, last_seen: RUN2, age_at_first_sight: 2, disposition: "shortlisted",
        last_lane: "daily",
      },
    };
    const { ledger, vanishedShortlisted } = updateSeenLedger({
      previous,
      survivors: [],
      stretch: [],
      ranAt: "2026-09-27T12:00:00.000Z",
      lane: "daily",
      actionedUrls: new Set(),
      liveUrls: new Set([LOWER.toLowerCase()]),
    });
    expect(Object.keys(ledger)).toHaveLength(1);
    expect(Object.values(ledger)[0]).toMatchObject({ first_seen: RUN1, age_at_first_sight: 1, ever_shortlisted: true });
    expect(Object.values(ledger)[0].vanished_at).toBeUndefined();
    expect(vanishedShortlisted).toEqual([]);
  });
});
