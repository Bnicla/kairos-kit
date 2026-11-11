import { describe, expect, it } from "vitest";
import { rankQAEntries } from "@kairos/engine/qabank";

/**
 * Retrieval-quality eval for the Q&A bank ranking (REQ-18 adjacent): a fixture
 * bank + job-shaped queries with expected hits, asserted as ordering facts.
 * Deterministic (IDF-weighted lexical), so it runs in CI as a real retrieval
 * eval rather than a mocked one.
 */

const BANK = [
  { slug: "why-company", canonical_question: "Why do you want to work at Example Labs?", topics: ["motivation", "company-fit"] },
  { slug: "relocation", canonical_question: "Are you willing to relocate for this role?", topics: ["logistics", "relocation"] },
  { slug: "leadership-conflict", canonical_question: "Describe a time you led a team through conflict", topics: ["leadership", "behavioral"] },
  { slug: "visa-status", canonical_question: "Do you require visa sponsorship to work in the United States?", topics: ["logistics", "work-authorization"] },
  { slug: "ai-eval-experience", canonical_question: "Describe your experience building evaluation frameworks for AI systems", topics: ["ai", "evals", "technical"] },
  { slug: "salary", canonical_question: "What are your salary expectations?", topics: ["compensation"] },
];

describe("rankQAEntries (IDF-weighted bank retrieval)", () => {
  it("surfaces the relocation answer for a relocation-heavy job query", () => {
    const ranked = rankQAEntries("Senior PM role in Menlo Park, willing to relocate required, on-site", BANK);
    expect(ranked[0].entry.slug).toBe("relocation");
  });

  it("surfaces the evals answer for an AI-evals job query", () => {
    const ranked = rankQAEntries(
      "AI Product Manager owning evaluation frameworks and model quality for AI systems",
      BANK,
    );
    expect(ranked[0].entry.slug).toBe("ai-eval-experience");
  });

  it("ranks rare-term matches above common-term matches", () => {
    // "visa sponsorship" is rare in the bank; "role/work" are everywhere.
    const ranked = rankQAEntries("Does the role offer visa sponsorship for international candidates?", BANK);
    expect(ranked[0].entry.slug).toBe("visa-status");
  });

  it("hit-rate over a labeled query set is 100% at k=2", () => {
    const labeled: [string, string][] = [
      ["relocating to the Bay Area for an onsite position", "relocation"],
      ["compensation range and salary band for this position", "salary"],
      ["behavioral interview about team leadership and conflict", "leadership-conflict"],
      ["evaluation frameworks, benchmarks and quality metrics for AI", "ai-eval-experience"],
    ];
    const hits = labeled.filter(([q, expected]) =>
      rankQAEntries(q, BANK, 2).some((r) => r.entry.slug === expected),
    ).length;
    expect(hits).toBe(labeled.length);
  });

  it("returns empty for empty query or bank, never throws", () => {
    expect(rankQAEntries("", BANK)).toEqual([]);
    expect(rankQAEntries("anything", [])).toEqual([]);
  });

  it("respects the limit", () => {
    expect(rankQAEntries("role work company salary relocation visa", BANK, 3)).toHaveLength(3);
  });
});
