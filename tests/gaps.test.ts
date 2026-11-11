import { describe, it, expect } from "vitest";
import {
  buildGapReport,
  compactGapReport,
  matchConcept,
  normalizeGapLabel,
  recencyDecay,
  sectionFor,
  tierFor,
  type GapInput,
} from "@kairos/engine/gaps";
import type { ScoreReport } from "@kairos/engine/types";

type Gap = ScoreReport["gaps"][number];
const NOW = new Date("2026-11-03T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const gap = (requirement: string, over: Partial<Gap> = {}): Gap => ({
  requirement,
  severity: "IMPORTANT",
  type: "genuine_gap",
  clarifying_question: null,
  ...over,
});

let n = 0;
const app = (gaps: Gap[], over: Partial<GapInput> = {}): GapInput => {
  n++;
  return {
    appId: `2026-11-01_co${n}_role`,
    company: `Co${n}`,
    role: "Principal PM",
    status: "scored",
    band: "WEAK",
    scored_at: daysAgo(0),
    gaps,
    ...over,
  };
};
const build = (inputs: GapInput[], days?: number) => buildGapReport(inputs, { now: NOW, days });
const find = (r: ReturnType<typeof build>, key: string) => r.gaps.find((g) => g.key === key)!;

describe("normalizeGapLabel", () => {
  it("lowercases, strips accents and punctuation, applies aliases", () => {
    expect(normalizeGapLabel("Bachelor's degree in Computer Science!")).toBe("bachelor degree in cs");
    expect(normalizeGapLabel("A/B testing & Experimentation")).toBe("ab testing and experiment");
    expect(normalizeGapLabel("Crédit d'Impôt Recherche")).toBe("credit dimpot recherche");
    expect(normalizeGapLabel("10+ yrs of Product Management, New York City")).toBe("10 years of pm nyc");
  });
});

describe("synonym merge", () => {
  it("collapses differently worded degree requirements into one topic", () => {
    const r = build([
      app([gap("Bachelor's degree in Computer Science or equivalent practical experience")]),
      app([gap("CS degree (preferred)")]),
      app([gap("Technical/quantitative bachelor's degree")]),
      app([gap("Bachelor's degree (literal checkbox)")]),
    ]);
    expect(find(r, "degree-technical").occurrences).toBe(3);
    expect(find(r, "degree").occurrences).toBe(1);
  });

  it("keeps unmatched requirements as their own groups, merging only on the same wording", () => {
    const r = build([
      app([gap("Meeting logistics: agendas, minutes")]),
      app([gap("Meeting logistics: agendas, minutes (nice-to-have)")]),
      app([gap("Specialty chemicals domain")]),
    ]);
    const meeting = r.gaps.find((g) => g.label.startsWith("Meeting logistics"))!;
    expect(meeting.occurrences).toBe(2);
    expect(r.gaps).toHaveLength(2);
  });

  it("routes real phrasings to the right topic (regressions from the live data)", () => {
    const id = (s: string) => matchConcept(s)?.id ?? null;
    expect(id("NYC hybrid, 3 days/week (Mon/Wed/Thu) from a Denver base")).toBe("location");
    expect(id("Deep experience with Kubernetes, containerization, cloud/hybrid infrastructure")).toBe("cloud-infrastructure");
    expect(id("Fund administration / back-office domain familiarity")).toBe("domain-finance");
    expect(id("On-site customer adoption in complex enterprise environments")).toBe("enterprise-deployment");
    expect(id("Understanding of the Ad Tech ecosystem — bidding, ranking, targeting")).toBe("domain-marketing");
    expect(id("2+ years of PM experience working on search, personalization, or recommendation features")).toBe(
      "search-personalization",
    );
    expect(id("12+ years of product management experience")).toBe("years-pm");
    expect(id("Titled Chief of Staff experience")).toBe("chief-of-staff");
    expect(id("Specialty chemicals domain")).toBeNull();
  });
});

describe("weighting", () => {
  it("weights by band and severity: a fresh WEAK deal-breaker is 1.0", () => {
    const r = build([
      app([gap("SQL comfort", { severity: "DEAL-BREAKER" })], { band: "WEAK" }),
      app([gap("Python / LLM APIs hands-on", { severity: "NICE-TO-HAVE" })], { band: "STRONG" }),
    ]);
    expect(find(r, "sql-data").score).toBe(1);
    expect(find(r, "hands-on-coding").score).toBe(0.09); // 0.3 band × 0.3 severity
  });

  it("orders bands WEAK > DEVELOPING > COMPETITIVE > STRONG", () => {
    const score = (band: string) => build([app([gap("SQL comfort", { severity: "DEAL-BREAKER" })], { band })]).gaps[0].score;
    expect([score("WEAK"), score("DEVELOPING"), score("COMPETITIVE"), score("STRONG")]).toEqual([1, 0.8, 0.5, 0.3]);
  });

  it("counts a posting once per topic, at its strongest mention", () => {
    const r = build([
      app([
        gap("Enterprise security product strategy", { severity: "NICE-TO-HAVE" }),
        gap("Cybersecurity industry depth", { severity: "DEAL-BREAKER" }),
      ]),
    ]);
    const sec = find(r, "domain-security");
    expect(sec.occurrences).toBe(1);
    expect(sec.genuine_mentions).toBe(2);
    expect(sec.score).toBe(1);
    expect(sec.applications[0].severity).toBe("DEAL-BREAKER");
  });
});

describe("recency", () => {
  it("halves every 30 days and never exceeds 1", () => {
    expect(recencyDecay(daysAgo(0), NOW)).toBe(1);
    expect(recencyDecay(daysAgo(30), NOW)).toBeCloseTo(0.5, 6);
    expect(recencyDecay(daysAgo(60), NOW)).toBeCloseTo(0.25, 6);
    expect(recencyDecay(daysAgo(-5), NOW)).toBe(1);
    expect(recencyDecay("not a date", NOW)).toBe(0);
  });

  it("decays a posting's contribution and records first/last seen", () => {
    const r = build([
      app([gap("SQL comfort", { severity: "DEAL-BREAKER" })], { scored_at: daysAgo(30) }),
      app([gap("Hands-on data fluency (SQL, BI tooling)", { severity: "DEAL-BREAKER" })], { scored_at: daysAgo(0) }),
    ]);
    const g = find(r, "sql-data");
    expect(g.score).toBe(1.5);
    expect(g.first_seen).toBe(daysAgo(30));
    expect(g.last_seen).toBe(daysAgo(0));
    expect(g.applications[0].scored_at).toBe(daysAgo(0)); // newest first
  });

  it("excludes archived cards and postings outside the window", () => {
    const r = build(
      [
        app([gap("SQL comfort")]),
        app([gap("SQL comfort")], { archived: true }),
        app([gap("SQL comfort")], { scored_at: daysAgo(100) }),
      ],
      90,
    );
    expect(r.totals.applications).toBe(1);
    expect(r.totals.excluded).toEqual({ archived: 1, outside_window: 1 });
    expect(r.window.days).toBe(90);
    expect(build([app([gap("SQL comfort")], { scored_at: daysAgo(100) })], 180).totals.applications).toBe(1);
  });
});

describe("kind and section", () => {
  it("classifies genuine, possibly_uncaptured and mixed", () => {
    const r = build([
      app([gap("SQL comfort"), gap("Python hands-on", { type: "possibly_uncaptured" }), gap("Pricing strategy")]),
      app([gap("Pricing and packaging", { type: "possibly_uncaptured" })]),
    ]);
    expect(find(r, "sql-data").kind).toBe("genuine");
    expect(find(r, "hands-on-coding").kind).toBe("possibly_uncaptured");
    expect(find(r, "pricing").kind).toBe("mixed");
    expect(r.totals.by_kind).toEqual({ genuine: 1, possibly_uncaptured: 1, mixed: 1 });
  });

  it("sends mostly-uncaptured gaps to confirm, circumstances to their own section", () => {
    expect(sectionFor("skill", 0, 2)).toBe("confirm");
    expect(sectionFor("skill", 2, 2)).toBe("confirm");
    expect(sectionFor("skill", 3, 1)).toBe("genuine");
    expect(sectionFor("skill", 1, 0)).toBe("genuine");
    expect(sectionFor("circumstance", 0, 3)).toBe("circumstance");
    const r = build([app([gap("Seattle location", { type: "possibly_uncaptured" })])]);
    expect(r.gaps[0]).toMatchObject({ category: "circumstance", section: "circumstance" });
  });

  it("collects clarifying questions from uncaptured mentions, deduplicated and newest first", () => {
    const q = "Did you own a pricing decision?";
    const r = build([
      app([gap("Pricing strategy", { type: "possibly_uncaptured", clarifying_question: "Old question?" })], { scored_at: daysAgo(10) }),
      app([gap("Pricing and packaging", { type: "possibly_uncaptured", clarifying_question: q })], { scored_at: daysAgo(1) }),
      app([gap("Owned pricing", { type: "possibly_uncaptured", clarifying_question: q })], { scored_at: daysAgo(2) }),
      app([gap("Pricing for agents", { type: "genuine_gap", clarifying_question: "Genuine question?" })]),
    ]);
    expect(find(r, "pricing").questions).toEqual([q, "Old question?"]);
  });
});

describe("tiering", () => {
  it("applies fixed thresholds with a recurrence floor", () => {
    expect(tierFor(1.2, 4)).toBe("Critical");
    expect(tierFor(1.2, 3)).toBe("High");
    expect(tierFor(0.6, 3)).toBe("High");
    expect(tierFor(0.9, 2)).toBe("Medium");
    expect(tierFor(5, 1)).toBe("Medium"); // one posting is never more than Medium
    expect(tierFor(0.3, 1)).toBe("Medium");
    expect(tierFor(0.29, 6)).toBe("Low");
  });

  it("tiers the aggregate and sorts by tier, then score", () => {
    const sqlApps = [0, 1, 2, 3].map(() => app([gap("SQL comfort", { severity: "DEAL-BREAKER" })]));
    const r = build([...sqlApps, app([gap("Python hands-on", { severity: "NICE-TO-HAVE" })], { band: "STRONG" })]);
    expect(r.gaps.map((g) => [g.key, g.tier])).toEqual([
      ["sql-data", "Critical"],
      ["hands-on-coding", "Low"],
    ]);
    expect(r.totals.by_tier).toEqual({ Critical: 1, High: 0, Medium: 0, Low: 1 });
  });

  it("ranks a recurring High above a higher-scoring single-posting Medium", () => {
    const pricing = [0, 1, 2].map(() => app([gap("Pricing and packaging")], { band: "COMPETITIVE" })); // 3 × 0.3
    const r = build([...pricing, app([gap("SQL comfort", { severity: "DEAL-BREAKER" })])]); // 1 × 1.0
    expect(r.gaps.map((g) => [g.key, g.tier, g.score])).toEqual([
      ["pricing", "High", 0.9],
      ["sql-data", "Medium", 1],
    ]);
  });
});

describe("empty and malformed input", () => {
  it("returns an empty report", () => {
    const r = build([]);
    expect(r.gaps).toEqual([]);
    expect(r.totals).toMatchObject({ applications: 0, gap_mentions: 0, distinct_gaps: 0 });
    expect(r.window.days).toBe(90);
  });

  it("skips blank requirements and tolerates missing gap arrays", () => {
    const r = build([app([gap("  ")]), app(undefined as unknown as Gap[])]);
    expect(r.totals).toMatchObject({ applications: 2, applications_with_gaps: 0, gap_mentions: 0 });
  });
});

describe("compactGapReport", () => {
  it("keeps headline numbers and trims Low-tier and circumstance detail", () => {
    const sqlApps = [0, 1, 2, 3].map(() =>
      app([gap("SQL comfort", { severity: "DEAL-BREAKER", type: "possibly_uncaptured", clarifying_question: "Q?" })]),
    );
    const c = compactGapReport(build([...sqlApps, app([gap("Seattle location")], { band: "STRONG" })]));
    const sql = c.gaps.find((g) => g.label.startsWith("Hands-on SQL"))!;
    expect(sql).toMatchObject({ tier: "Critical", section: "confirm", postings: 4, questions: ["Q?"] });
    expect("applications" in sql && sql.applications).toHaveLength(4);
    const loc = c.gaps.find((g) => g.section === "circumstance")!;
    expect("applications" in loc).toBe(false);
  });
});
