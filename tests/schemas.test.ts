import { describe, expect, it } from "vitest";
import { GeneratedResumeSchema, ScoreReportSchema } from "@kairos/engine/tools/schemas";

const validResume = {
  resume: {
    header: { name: "Alex Sample", contact: "Chicago" },
    executive_summary: "- **Leader:** does things.",
    experience: [{ company: "Acme", title: "PM", dates: "2020 – 2022", bullets: ["Did a thing."] }],
    education: [{ institution: "Westbrook", credential: "MBA" }],
    skills: ["AI"],
  },
  provenance_audit: [{ claim: "Did a thing", source_experience: "01-acme", prov: "R" }],
};

describe("GeneratedResumeSchema", () => {
  it("accepts a well-formed resume", () => {
    expect(GeneratedResumeSchema.safeParse(validResume).success).toBe(true);
  });

  it('rejects composite prov tokens like "R/C" (one claim, one provenance)', () => {
    const bad = structuredClone(validResume);
    bad.provenance_audit[0].prov = "R/C";
    expect(GeneratedResumeSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty provenance audit or empty bullets", () => {
    const noAudit = structuredClone(validResume) as Record<string, unknown>;
    (noAudit as typeof validResume).provenance_audit = [];
    expect(GeneratedResumeSchema.safeParse(noAudit).success).toBe(false);
  });

  it("accepts a resume with or without requirement_coverage (optional, backward compatible)", () => {
    expect(GeneratedResumeSchema.safeParse(validResume).success).toBe(true);
    const withCoverage = {
      ...structuredClone(validResume),
      requirement_coverage: [
        { requirement: "Shipped AI products", priority: "required", status: "covered", evidence: "Did a thing." },
        { requirement: "Agent evals", priority: "required", status: "partial", evidence: "Did a thing", note: "adjacent only" },
        { requirement: "Fintech domain", priority: "preferred", status: "gap", evidence: null, note: "no fintech domain experience" },
      ],
    };
    expect(GeneratedResumeSchema.safeParse(withCoverage).success).toBe(true);
  });

  it("rejects requirement_coverage rows with an unknown status or priority", () => {
    const row = { requirement: "X", priority: "required", status: "covered", evidence: "Did a thing." };
    const badStatus = { ...structuredClone(validResume), requirement_coverage: [{ ...row, status: "met" }] };
    const badPriority = { ...structuredClone(validResume), requirement_coverage: [{ ...row, priority: "must" }] };
    expect(GeneratedResumeSchema.safeParse(badStatus).success).toBe(false);
    expect(GeneratedResumeSchema.safeParse(badPriority).success).toBe(false);
  });
});

const validScore = {
  parse_safety: { verdict: "PASS", checks: [{ rule: "x", result: "PASS", detail: "d" }], ats_specific_note: "n" },
  match: {
    detected_ats: "Workday",
    dimensions: [{ name: "hard_skills", score: 80, justification: "j" }],
    overall_band: "COMPETITIVE",
    confidence: "medium",
    pool_caveat: "True ranking is unknowable; band reflects functional fit.",
  },
  authenticity: { score: 90, flags: [], strengths: ["specific"] },
  gaps: [],
  reachable: { band_if_tailored: "STRONG", from_reframing: [], needs_user_confirmation: [], honest_ceiling_note: "n" },
  recommendation: "APPLY",
};

describe("ScoreReportSchema", () => {
  it("accepts a well-formed report", () => {
    expect(ScoreReportSchema.safeParse(validScore).success).toBe(true);
  });

  it("rejects invalid bands and missing pool caveat (N2)", () => {
    const badBand = structuredClone(validScore);
    badBand.match.overall_band = "AMAZING";
    expect(ScoreReportSchema.safeParse(badBand).success).toBe(false);

    const noCaveat = structuredClone(validScore);
    noCaveat.match.pool_caveat = "";
    expect(ScoreReportSchema.safeParse(noCaveat).success).toBe(false);
  });
});
