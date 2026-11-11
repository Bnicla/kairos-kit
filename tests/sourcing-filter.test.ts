import { describe, it, expect } from "vitest";
import {
  functionGateVerdict,
  hasSignal,
  inExcludedLocation,
  isNonUs,
  isPriorityShape,
  meetsSecondaryBar,
  rankScore,
  locationFit,
  passesFunctionGate,
  prefilterAndRank,
} from "@kairos/engine/sourcing/filter";
import { parseWorkdayPostedOn } from "@kairos/engine/sourcing/adapters";
import type { Posting, SearchProfile } from "@kairos/engine/sourcing/types";

const NOW = new Date("2026-07-28T12:00:00Z").getTime();

const profile: SearchProfile = {
  function_terms: ["product"],
  exclude_terms: ["intern", "engineer"],
  locations: ["denver", "united states"],
  boost_terms: ["ai"],
  seniority_terms: ["principal", "staff"],
  max_age_days: 7,
};

const posting = (over: Partial<Posting>): Posting => ({
  ats: "greenhouse",
  slug: "acme",
  company: "Acme",
  title: "Product Manager",
  url: `https://boards.greenhouse.io/acme/jobs/${Math.abs(JSON.stringify(over).length)}${over.title ?? ""}`,
  location: "Remote",
  remote: true,
  posted_at: new Date(NOW - 2 * 86_400_000).toISOString(),
  age_days: 2,
  ...over,
});

describe("sourcing prefilter + rank", () => {
  it("enforces the hard 7-day recency gate but keeps unknown dates (ranked last)", () => {
    const { survivors } = prefilterAndRank(
      [
        posting({ title: "Product Lead Fresh", age_days: 1 }),
        posting({ title: "Product Lead Stale", age_days: 9 }),
        posting({ title: "Product Lead Undated", posted_at: null, age_days: null }),
      ],
      profile,
      new Set(),
      [],
    );
    expect(survivors.map((s) => s.title)).toEqual(["Product Lead Fresh", "Product Lead Undated"]);
  });

  it("ranks newer first, seniority and domain boost within the window", () => {
    const { survivors } = prefilterAndRank(
      [
        posting({ title: "Product Manager Old", age_days: 6 }),
        posting({ title: "Principal Product Manager, AI Today", age_days: 0 }),
        posting({ title: "Product Manager Today", age_days: 0 }),
      ],
      profile,
      new Set(),
      [],
    );
    expect(survivors[0].title).toBe("Principal Product Manager, AI Today");
    expect(survivors[1].title).toBe("Product Manager Today");
    expect(survivors[2].title).toBe("Product Manager Old");
  });

  it("gates on function only — plain 'Product Manager' passes (lesson from a missed role)", () => {
    const { survivors } = prefilterAndRank([posting({ title: "Product Manager, ML Research" })], profile, new Set(), []);
    expect(survivors).toHaveLength(1);
  });

  it("routes strong non-local postings to stretch instead of dropping (lesson from a missed role)", () => {
    const { survivors, stretch } = prefilterAndRank(
      [posting({ title: "Staff Product Manager", location: "San Francisco", remote: false })],
      profile,
      new Set(),
      [],
    );
    expect(survivors).toHaveLength(0);
    expect(stretch.map((s) => s.title)).toEqual(["Staff Product Manager"]);
  });

  it("dedupes against existing applications and seen urls, excludes noise titles", () => {
    const { survivors } = prefilterAndRank(
      [
        posting({ title: "Product Lead, AI", company: "Initech" }),
        posting({ title: "Product Engineer" }),
        posting({ title: "Product Person Seen", url: "https://x.co/seen?utm=1" }),
      ],
      profile,
      new Set(["https://x.co/seen"]),
      [{ company: "Initech", role: "Product Lead, AI" }],
    );
    expect(survivors).toHaveLength(0);
  });
});

describe("workday postedOn parsing", () => {
  it("parses the phrase formats", () => {
    expect(parseWorkdayPostedOn("Posted Today", NOW)).toBe(new Date(NOW).toISOString());
    expect(parseWorkdayPostedOn("Posted Yesterday", NOW)).toBe(new Date(NOW - 86_400_000).toISOString());
    expect(parseWorkdayPostedOn("Posted 6 Days Ago", NOW)).toBe(new Date(NOW - 6 * 86_400_000).toISOString());
    expect(parseWorkdayPostedOn("Posted 30+ Days Ago", NOW)).toBe(new Date(NOW - 31 * 86_400_000).toISOString());
    expect(parseWorkdayPostedOn(undefined, NOW)).toBeNull();
  });
});

describe("2026-07-28 first-run fixes", () => {
  it("word-boundary gate: 'Production Technician' does not match 'product'", () => {
    const { survivors, stretch } = prefilterAndRank(
      [posting({ title: "Lead Production Technician, Intelligence Systems" })],
      profile,
      new Set(),
      [],
    );
    expect(survivors).toHaveLength(0);
    expect(stretch).toHaveLength(0);
  });

  it("drops clearly non-US postings even when flagged remote", () => {
    const { survivors } = prefilterAndRank(
      [
        posting({ title: "Product Lead A", location: "Germany", remote: true, url: "https://x.co/de" }),
        posting({ title: "Product Lead B", location: "Remote - United States", remote: true, url: "https://x.co/us" }),
      ],
      profile,
      new Set(),
      [],
    );
    expect(survivors.map((s) => s.title)).toEqual(["Product Lead B"]);
  });

  it("collapses multi-location duplicates and caps per-company flooding", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      posting({
        title: i < 6 ? "Product Lead - AI App" : `Product Lead Unique ${i}`,
        company: "Flood",
        url: `https://x.co/flood/${i}`,
        location: "Remote - United States",
      }),
    );
    const { survivors } = prefilterAndRank(many, profile, new Set(), []);
    expect(survivors.filter((s) => s.company === "Flood")).toHaveLength(3);
    expect(survivors.filter((s) => s.title === "Product Lead - AI App")).toHaveLength(1);
  });
});

describe("triage", () => {
  it("parses verdicts, ignores unknown urls, applies band ordering and cap", async () => {
    const { parseTriageResponse, applyTriage } = await import("@kairos/engine/sourcing/triage");
    const a = { ...posting({ title: "Product A", url: "https://x.co/a" }), rank_score: 50, location_fit: "match" as const, reasons: [] };
    const b = { ...posting({ title: "Product B", url: "https://x.co/b" }), rank_score: 90, location_fit: "match" as const, reasons: [] };
    const c = { ...posting({ title: "Product C", url: "https://x.co/c" }), rank_score: 70, location_fit: "match" as const, reasons: [] };
    const text = `Here you go:\n[
      {"url":"https://x.co/a","verdict":"SHORTLIST","guess_band":"STRONG","one_liner":"fits"},
      {"url":"https://x.co/b","verdict":"SHORTLIST","guess_band":"COMPETITIVE","one_liner":"ok"},
      {"url":"https://x.co/c","verdict":"SKIP"},
      {"url":"https://x.co/unknown","verdict":"SHORTLIST"}
    ]`;
    const verdicts = parseTriageResponse(text, new Set(["https://x.co/a", "https://x.co/b", "https://x.co/c"]));
    expect(verdicts.size).toBe(3);
    const { list, triaged } = applyTriage([a, b, c], verdicts, 10);
    expect(triaged).toBe(true);
    // a and b share a company; only the better-banded one represents it.
    expect(list.map((p) => p.title)).toEqual(["Product A"]);
    expect(list[0].guess_band).toBe("STRONG");
  });

  it("falls back to deterministic top-N when triage is unavailable", async () => {
    const { applyTriage } = await import("@kairos/engine/sourcing/triage");
    const a = { ...posting({ title: "Product A", url: "https://x.co/a" }), rank_score: 50, location_fit: "match" as const, reasons: [] };
    const b = { ...posting({ title: "Product B", url: "https://x.co/b" }), rank_score: 90, location_fit: "match" as const, reasons: [] };
    const { list, triaged } = applyTriage([b, a], new Map(), 1);
    expect(triaged).toBe(false);
    expect(list.map((p) => p.title)).toEqual(["Product B"]);
  });
});

describe("one job per company in the final shortlist", () => {
  it("keeps only the best-ranked shortlisted posting per company", async () => {
    const { parseTriageResponse, applyTriage } = await import("@kairos/engine/sourcing/triage");
    const a = { ...posting({ title: "Product A", company: "Livekit", url: "https://x.co/a" }), rank_score: 90, location_fit: "match" as const, reasons: [] };
    const b = { ...posting({ title: "Product B", company: "Livekit", url: "https://x.co/b" }), rank_score: 50, location_fit: "match" as const, reasons: [] };
    const c = { ...posting({ title: "Product C", company: "Other", url: "https://x.co/c" }), rank_score: 10, location_fit: "match" as const, reasons: [] };
    const verdicts = parseTriageResponse(
      `[{"url":"https://x.co/a","verdict":"SHORTLIST","guess_band":"STRONG"},
        {"url":"https://x.co/b","verdict":"SHORTLIST","guess_band":"STRONG"},
        {"url":"https://x.co/c","verdict":"SHORTLIST","guess_band":"COMPETITIVE"}]`,
      new Set(["https://x.co/a", "https://x.co/b", "https://x.co/c"]),
    );
    const { list } = applyTriage([a, b, c], verdicts, 10);
    expect(list.map((p) => p.title)).toEqual(["Product A", "Product C"]);
  });
});

describe("secondary locations (higher bar)", () => {
  const secondaryProfile: SearchProfile = {
    ...profile,
    secondary_locations: ["san francisco", "lisbon"],
  };
  const mk = (over: Partial<Posting>): Posting => ({
    ats: "greenhouse", slug: "x", company: "X", title: "Principal Product Manager, AI",
    url: `https://job-boards.greenhouse.io/x/jobs/${Math.floor(Math.random() * 1e9)}`,
    location: "San Francisco, CA", remote: false, posted_at: new Date(NOW - 86400000).toISOString(),
    age_days: 1, ...over,
  });

  it("surfaces strong fits in secondary locations as survivors", () => {
    const out = prefilterAndRank([mk({})], secondaryProfile, new Set(), []);
    expect(out.survivors).toHaveLength(1);
    expect(out.survivors[0].reasons).toContain("secondary location: strong fit");
  });

  it("drops weak fits in secondary locations entirely (not stretch)", () => {
    const weak = mk({ title: "Product Manager, Payments", url: "https://job-boards.greenhouse.io/x/jobs/2" });
    const out = prefilterAndRank([weak], secondaryProfile, new Set(), []);
    expect(out.survivors).toHaveLength(0);
    expect(out.stretch).toHaveLength(0);
  });

  it("exempts listed international cities from the non-US drop, still applying the bar", () => {
    const lisbon = mk({ location: "Lisbon, Portugal", url: "https://job-boards.greenhouse.io/x/jobs/3" });
    const lisbonWeak = mk({ title: "Product Manager", location: "Lisbon, Portugal", url: "https://job-boards.greenhouse.io/x/jobs/4" });
    const out = prefilterAndRank([lisbon, lisbonWeak], secondaryProfile, new Set(), []);
    expect(out.survivors.map((p) => p.url)).toEqual(["https://job-boards.greenhouse.io/x/jobs/3"]);
  });

  it("keeps unlisted non-US locations dropped", () => {
    const berlin = mk({ location: "Berlin, Germany", url: "https://job-boards.greenhouse.io/x/jobs/5" });
    const out = prefilterAndRank([berlin], secondaryProfile, new Set(), []);
    expect(out.survivors.length + out.stretch.length).toBe(0);
  });

  it("keeps non-US postings when the profile allows international roles", () => {
    const berlin = mk({ location: "Berlin, Germany", url: "https://job-boards.greenhouse.io/x/jobs/6" });
    const remoteDe = mk({ company: "Y", location: "Remote (Germany)", remote: true, url: "https://job-boards.greenhouse.io/x/jobs/7" });
    const open = { ...secondaryProfile, international_ok: true };
    const out = prefilterAndRank([berlin, remoteDe], open, new Set(), []);
    const kept = [...out.survivors, ...out.stretch].map((p) => p.url).sort();
    expect(kept).toEqual(["https://job-boards.greenhouse.io/x/jobs/6", "https://job-boards.greenhouse.io/x/jobs/7"]);
    // Not a listed location, so the onsite Berlin role is a stretch, not a match.
    expect(out.stretch.map((p) => p.url)).toContain("https://job-boards.greenhouse.io/x/jobs/6");
  });

  it("drops non-US postings when international_ok is false", () => {
    const berlin = mk({ location: "Berlin, Germany", url: "https://job-boards.greenhouse.io/x/jobs/8" });
    const out = prefilterAndRank([berlin], { ...secondaryProfile, international_ok: false }, new Set(), []);
    expect(out.survivors.length + out.stretch.length).toBe(0);
  });
});

describe("locationFit — unknown location is not a mismatch", () => {
  it("treats an empty or n/a location as a match, not stretch", async () => {
    const { locationFit } = await import("@kairos/engine/sourcing/filter");
    // Observed 2026-09-07: a fresh posting with no location field was
    // buried in the stretch bucket and cut by the triage stretch cap.
    expect(locationFit(posting({ location: "", remote: false }), profile)).toBe("match");
    expect(locationFit(posting({ location: "  ", remote: false }), profile)).toBe("match");
    expect(locationFit(posting({ location: "N/A", remote: false }), profile)).toBe("match");
    expect(locationFit(posting({ location: "Madrid, Spain", remote: false }), profile)).toBe("stretch");
  });
});

describe("buildTriagePrompt — user rules injection", () => {
  it("injects triage_rules as hard constraints and omits the block when absent", async () => {
    const { buildTriagePrompt } = await import("@kairos/engine/sourcing/triage");
    const rows = [{ url: "https://x/1", title: "PM", company: "Acme", location: "Denver", rank_score: 1, age_days: 1, location_fit: "match" }] as never;
    const withRules = buildTriagePrompt(rows, "summary", ["Crypto companies are out of scope."]);
    expect(withRules).toContain("CANDIDATE RULES (hard constraints");
    expect(withRules).toContain("Crypto companies are out of scope.");
    const without = buildTriagePrompt(rows, "summary");
    expect(without).not.toContain("CANDIDATE RULES");
  });
});

describe("deep-scan lane (post-mortem 2026-09-27: a missed 46-day-old Head of Product role)", () => {
  const deep = { deepScan: true };

  it("ignores the recency cap: a 46-day-old priority posting survives", () => {
    const { survivors } = prefilterAndRank(
      [posting({ title: "Principal Product Manager", age_days: 46, url: "https://x.co/old" })],
      profile,
      new Set(),
      [],
      deep,
    );
    expect(survivors.map((s) => s.title)).toEqual(["Principal Product Manager"]);
  });

  it("restricts to priority shapes: non-seniority titles are gated out", () => {
    const out = prefilterAndRank(
      [posting({ title: "Product Manager", age_days: 3, url: "https://x.co/plain" })],
      profile,
      new Set(),
      [],
      deep,
    );
    expect(out.survivors.length + out.stretch.length).toBe(0);
  });

  it("ranks age as a penalty, not a cliff: fresh beats old at equal fit, old still competes", () => {
    const { survivors } = prefilterAndRank(
      [
        posting({ title: "Principal Product Manager A", age_days: 40, url: "https://x.co/a" }),
        posting({ title: "Principal Product Manager B", age_days: 2, url: "https://x.co/b" }),
      ],
      profile,
      new Set(),
      [],
      deep,
    );
    expect(survivors.map((s) => s.title)).toEqual(["Principal Product Manager B", "Principal Product Manager A"]);
    // The old posting is penalized, not annihilated: fit signals still matter.
    expect(survivors[1].rank_score).toBeGreaterThan(-20);
  });

  it("daily mode is unchanged: the same 46-day posting stays invisible without deepScan", () => {
    const { survivors } = prefilterAndRank(
      [posting({ title: "Principal Product Manager", age_days: 46, url: "https://x.co/old" })],
      profile,
      new Set(),
      [],
    );
    expect(survivors).toHaveLength(0);
  });
});

describe("isPriorityShape", () => {
  it("matches seniority-titled roles and rejects plain ones", async () => {
    const { isPriorityShape } = await import("@kairos/engine/sourcing/filter");
    expect(isPriorityShape("Principal Product Manager", profile)).toBe(true);
    expect(isPriorityShape("Staff Product Manager, AI", profile)).toBe(true);
    expect(isPriorityShape("Product Manager", profile)).toBe(false);
  });
});

describe("inExcludedLocation (2026-10-02 excluded-places rule, enforced in code 2026-10-08)", () => {
  const prof = { locations: ["denver", "new york"], excluded_locations: ["texas", "austin", "atlanta", "georgia"] } as never;
  const p = (location: string, remote = false) => ({ location, remote }) as never;
  it("drops onsite/hybrid roles in an excluded place", () => {
    expect(inExcludedLocation(p("Austin, TX"), prof)).toBe(true);
    expect(inExcludedLocation(p("Atlanta, Georgia"), prof)).toBe(true);
  });
  it("keeps remote roles and multi-city postings that also offer a primary location", () => {
    expect(inExcludedLocation(p("Austin, TX", true), prof)).toBe(false);
    expect(inExcludedLocation(p("Dallas, Texas; New York, NY"), prof)).toBe(false);
  });
  it("keeps places that only contain an excluded word as a substring", () => {
    expect(inExcludedLocation(p("Austintown, OH"), prof)).toBe(false);
  });
});

describe("location markers: short ones match whole words only", () => {
  it("'co', 'il' and 'ny' do not match inside other place names", async () => {
    const { locationFit, inSecondaryLocation } = await import("@kairos/engine/sourcing/filter");
    const p = { ...profile, locations: ["denver", "co"], secondary_locations: ["ny", "il"] };
    expect(locationFit(posting({ location: "Tacoma, WA", remote: false }), p)).toBe("stretch");
    expect(locationFit(posting({ location: "Boulder, CO", remote: false }), p)).toBe("match");
    expect(locationFit(posting({ location: "Greater Denver Area", remote: false }), p)).toBe("match");
    expect(inSecondaryLocation(posting({ location: "Philadelphia, PA", remote: false }), p)).toBe(false);
    expect(inSecondaryLocation(posting({ location: "Albany, NY", remote: false }), p)).toBe(true);
  });
});

describe("exclude-term override on explicit product-management titles (miss audit, 2026-11-05)", () => {
  const p: SearchProfile = {
    ...profile,
    function_terms: ["product", "pm", "chief of staff"],
    exclude_terms: [
      "sales", "support", "engineer", "account", "analyst", "scientist", "researcher", "writer", "coordinator",
      "ads", "ad tech", "adtech", "crypto", "web3", "intern", "junior", "associate product", "designer",
      "product marketing", "marketing manager", "product owner", "counsel",
    ],
  };
  const gate = (title: string) => functionGateVerdict(title, p);

  it("keeps PM titles whose excluded word names the domain they serve", () => {
    for (const title of [
      "Senior Product Manager, AI Sales Platform",
      "Sr Principal, Product Manager - Unified Support & AI Experience",
      "Product Manager - Growth (technical or ex-product engineer)",
      "Group Product Manager, Customer Account Experience",
      "Head of Product, Sales Tools",
      "Director of Product (Research Writer Tools)",
    ]) {
      expect([title, gate(title)]).toEqual([title, "pass"]);
      expect(passesFunctionGate(title, p)).toBe(true);
    }
  });

  it("keeps blocking domain, level and role excludes on PM titles", () => {
    for (const title of [
      "Principal Product Manager, Ads Quality",
      "Senior Product Manager, Ad Tech",
      "Associate Product Manager",
      "Product Marketing Manager",
      "Product Designer",
      "Technical Product Manager & Designer",
      "Product Management Intern",
      "Product Owner, Sales Systems",
      "Director, Product Counsel",
    ]) {
      expect([title, gate(title)]).toEqual([title, "exclude_term"]);
    }
  });

  it("does not override when the excluded word is the role itself (same title part)", () => {
    for (const title of [
      "Head of Product Support",
      "Director, Product Support",
      "Principal Product Engineer",
      "Principal Product Analyst",
      "Product Lead Engineer",
      "Product Engineer",
    ]) {
      expect([title, gate(title)]).toEqual([title, "exclude_term"]);
    }
  });

  it("needs an explicit PM phrase: a function term alone does not lift the exclude", () => {
    expect(gate("Product Support Specialist")).toBe("exclude_term");
    expect(gate("Chief of Staff, Sales")).toBe("exclude_term");
    expect(gate("Sales Engineer")).toBe("no_function_term");
  });

  it("never overrides on product marketing / product owner / associate / designer titles, even when the profile lacks that term", () => {
    const loose: SearchProfile = { ...p, exclude_terms: ["sales"] };
    expect(functionGateVerdict("Product Manager / Designer, Sales Tools", loose)).toBe("exclude_term");
    expect(functionGateVerdict("Product Manager, Sales Tools", loose)).toBe("pass");
  });

  it("the prefilter applies it: the three audit titles reach the survivors", () => {
    const { survivors } = prefilterAndRank(
      [
        "Senior Product Manager, AI Sales Platform",
        "Sr Principal, Product Manager - Unified Support & AI Experience",
        "Product Manager - Growth (technical or ex-product engineer)",
        "Principal Product Manager, Ads Quality",
      ].map((title, i) => posting({ title, company: `Co${i}` })),
      p,
      new Set(),
      [],
    );
    expect(survivors.map((s) => s.title).sort()).toEqual([
      "Product Manager - Growth (technical or ex-product engineer)",
      "Senior Product Manager, AI Sales Platform",
      "Sr Principal, Product Manager - Unified Support & AI Experience",
    ]);
  });
});

describe("multi-city locations (miss audit, 2026-11-05)", () => {
  it("a city list that names a primary place is not dropped as non-US; foreign-only lists still are", () => {
    const run = (location: string) =>
      prefilterAndRank([posting({ title: "Group Product Manager", location, remote: false })], profile, new Set(), []);
    expect(run("Denver, Colorado; Toronto, Ontario").survivors.map((s) => s.location_fit)).toEqual(["match"]);
    for (const location of ["Toronto, Ontario; Berlin, Germany", "Munich; Cologne; Dusseldorf", "Remote; Berlin", "Portland, OR; Toronto, ON", "Toronto"]) {
      const out = run(location);
      expect([location, out.survivors.length + out.stretch.length, out.stats.gates.non_us.removed]).toEqual([location, 0, 1]);
    }
  });

  it("the whole-string non-US test is unchanged", () => {
    expect(isNonUs("Denver, Colorado; Toronto, Ontario")).toBe(true);
    expect(isNonUs("Remote - US; Berlin")).toBe(false);
    expect(isNonUs("Remote")).toBe(false);
  });

  it("an unresolved 'N Locations' placeholder is an unknown location, not a mismatch", () => {
    expect(locationFit(posting({ location: "3 Locations", remote: false }), profile)).toBe("match");
    expect(locationFit(posting({ location: "1 Location", remote: false }), profile)).toBe("match");
    expect(locationFit(posting({ location: "Portland, Oregon", remote: false }), profile)).toBe("stretch");
  });
});

describe("prefilter gate counts", () => {
  it("counts each removed posting once, at the first gate that removed it, with priority shapes", () => {
    const p: SearchProfile = {
      ...profile,
      exclude_terms: ["designer"],
      excluded_companies: ["globex"],
      excluded_locations: ["phoenix"],
      secondary_locations: ["seattle"],
    };
    const input = [
      posting({ title: "Product Manager", url: "https://x.co/1", location: "Denver, CO", remote: false }),
      posting({ title: "Product Manager", url: "https://x.co/1?src=feed", location: "Denver, CO", remote: false }),
      posting({ title: "Product Manager", url: "https://x.co/2", location: "Portland, OR", remote: false }),
      posting({ title: "Account Executive", url: "https://x.co/3" }),
      posting({ title: "Principal Product Designer", url: "https://x.co/4" }),
      posting({ title: "Principal Product Manager, Old", url: "https://x.co/5", age_days: 20 }),
      posting({ title: "Product Lead", url: "https://x.co/6", company: "Globex" }),
      posting({ title: "Product Manager, Payments", url: "https://x.co/7", location: "Phoenix, AZ", remote: false }),
      posting({ title: "Staff Product Manager, AI", url: "https://x.co/8", location: "Portland, OR", remote: false }),
      posting({ title: "Product Specialist", url: "https://x.co/9", location: "Portland, OR", remote: false }),
    ];
    const out = prefilterAndRank(input, p, new Set(), []);
    const g = out.stats.gates;
    expect(out.stats.input).toBe(10);
    expect(g.duplicate_url).toEqual({ removed: 1, priority: 0 });
    expect(g.duplicate_role).toEqual({ removed: 1, priority: 0 });
    expect(g.no_function_term).toEqual({ removed: 1, priority: 0 });
    expect(g.exclude_term).toEqual({ removed: 1, priority: 1 });
    expect(g.too_old).toEqual({ removed: 1, priority: 1 });
    expect(g.excluded_company.removed).toBe(1);
    expect(g.excluded_location.removed).toBe(1);
    expect(g.weak_stretch).toEqual({ removed: 1, priority: 0 });
    expect(out.stats.routed_to_stretch).toEqual({ count: 1, priority: 1 });
    const removed = Object.values(g).reduce((n, c) => n + c.removed, 0);
    expect(removed + out.survivors.length + out.stretch.length).toBe(input.length);
  });
});

describe("seniority and domain terms match whole words (dry run, 2026-11-05)", () => {
  const p: SearchProfile = {
    ...profile,
    boost_terms: ["ai", "ml", "agent", "platform", "llm"],
    seniority_terms: ["director", "lead", "staff", "head of", "vp"],
    secondary_locations: ["seattle"],
  };

  it("'ai' inside 'Retail' is no domain signal: the retail role does not clear the secondary-city bar", () => {
    const retail = posting({ title: "Director, Retail Product Strategy", location: "Seattle, WA", remote: false });
    expect(hasSignal(retail.title, "ai")).toBe(false);
    expect(meetsSecondaryBar(retail, p)).toBe(false);
    const out = prefilterAndRank([retail], p, new Set(), []);
    expect(out.survivors.length + out.stretch.length).toBe(0);
    expect(out.stats.gates.secondary_bar.removed).toBe(1);
    // The real thing still clears it.
    expect(meetsSecondaryBar(posting({ title: "Director, AI Product", location: "Seattle, WA" }), p)).toBe(true);
  });

  it("keeps the forms the substring test caught on purpose: plurals, 'Leader', glued acronyms", () => {
    for (const [title, term] of [
      ["AI Agents Product Lead", "agent"],
      ["Product Manager, LLMs", "llm"],
      ["Product Leader, Platforms", "lead"],
      ["Product Leader, Platforms", "platform"],
      ["GenAI Product Manager", "ai"],
      ["OpenAI Partnerships Product Lead", "ai"],
      ["AIOps Product Manager", "ai"],
      ["MLOps Product Manager", "ml"],
      ["SVP, Product", "vp"],
      ["Head of Product", "head of"],
    ]) expect([title, term, hasSignal(title, term)]).toEqual([title, term, true]);
  });

  it("no longer matches inside other words", () => {
    for (const [title, term] of [
      ["Retail Product Manager", "ai"],
      ["RETAIL PRODUCT MANAGER", "ai"],
      ["Product Manager, Email", "ai"],
      ["AIRBUS Product Manager", "ai"],
      ["Product Manager, HTML Tools", "ml"],
      ["Staffing Product Manager", "staff"],
      ["Head Office Product Manager", "head of"],
      ["Product Manager, Mislead Detection", "lead"],
    ]) expect([title, term, hasSignal(title, term)]).toEqual([title, term, false]);
  });

  it("priority shape and ranking use the same matching", () => {
    expect(isPriorityShape("Staffing Product Manager", p)).toBe(false);
    expect(isPriorityShape("Product Leader", p)).toBe(true);
    const reasons: string[] = [];
    rankScore(posting({ title: "Product Manager, Retail Platform" }), p, reasons);
    expect(reasons.filter((r) => r.startsWith("domain"))).toEqual(["domain: platform"]);
  });
});

describe("non-US markers match whole words (a 'Remote (UK)' role reached the board, 2026-11-05)", () => {
  it("catches the UK in every punctuation", () => {
    for (const location of ["Remote (UK)", "UK - Remote", "Remote - UK", "UK, Remote", "London-UK", "Remote, UK", "UK"]) {
      expect([location, isNonUs(location)]).toEqual([location, true]);
    }
  });

  it("no longer matches inside US place names", () => {
    for (const location of ["Ukiah, CA", "Indianapolis, IN", "Indiana", "Portola Valley, CA", "Jerome, ID", "Albuquerque, New Mexico"]) {
      expect([location, isNonUs(location)]).toEqual([location, false]);
    }
  });

  it("the US markers are whole words too: '-us' endings of foreign cities are not 'US'", () => {
    expect(isNonUs("Vilnius - Lithuania")).toBe(true);
    expect(isNonUs("Remote - US")).toBe(false);
    expect(isNonUs("US-CO-Denver")).toBe(false);
    expect(isNonUs("Remote (US)")).toBe(false);
    expect(isNonUs("Remote, OR, us")).toBe(false);
    expect(isNonUs("U.S. Remote")).toBe(false);
  });

  it("keeps the forms a longer marker used to catch, and the observed leaks", () => {
    for (const location of ["Milano, Lombardia", "Praha, Czechia", "Dubai, UAE", "Kyiv", "Rabat, Morocco", "MYS - Kuala Lumpur", "HCMC, vn"]) {
      expect([location, isNonUs(location)]).toEqual([location, true]);
    }
  });

  it("places the substring test caught inside a longer word stay foreign", () => {
    for (const location of ["Limassol, Cyprus", "Antwerpen, Vlaanderen", "Canberra, Australian Capital Territory", "Belfast 10 Mays Meadow; Der-Derry/Londonderry", "IN - Hyderabad_HQ", "Plot No 20-21_Noida"]) {
      expect([location, isNonUs(location)]).toEqual([location, true]);
    }
  });

  it("folds accents before matching markers", () => {
    for (const location of ["São Paulo, SP", "Montréal, QC, ca", "Bogotá", "Zürich", "İstanbul - Gebze", "Ciudad de México"]) {
      expect([location, isNonUs(location)]).toEqual([location, true]);
    }
  });

  it("'New England' is a US region, not England", () => {
    expect(isNonUs("New England Baptist Hospital")).toBe(false);
    expect(isNonUs("Daresbury, England")).toBe(true);
  });

  it("reads a SmartRecruiters lowercase country code, but not one that is also a US state", () => {
    for (const location of ["Telok Panglima Garang, my", "Hitachinaka, jp", "Dubai, Dubai, ae", "Leeds, England, gb"]) {
      expect([location, isNonUs(location)]).toEqual([location, true]);
    }
    for (const location of ["Remote, OR, us", "Cambridge, ma", "Seattle, wa", "Denver, co", "Washington, dc", "Austin, TX", "sf", "na", "Remote, xx"]) {
      expect([location, isNonUs(location)]).toEqual([location, false]);
    }
  });

  it("the prefilter drops the UK role", () => {
    const out = prefilterAndRank([posting({ title: "Partner Strategy & Product Lead", location: "Remote (UK)", remote: true })], profile, new Set(), []);
    expect(out.survivors.length + out.stretch.length).toBe(0);
    expect(out.stats.gates.non_us.removed).toBe(1);
  });
});
