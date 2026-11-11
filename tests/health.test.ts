import { describe, it, expect } from "vitest";
import { computeHealth } from "@kairos/engine/health";
import { careerStage } from "@kairos/engine/length-policy";
import type { Experience } from "@kairos/engine/kb/types";

const NOW = new Date().getFullYear();

function exp(overrides: Partial<Experience["frontmatter"]>, body: string): Experience {
  return {
    fileName: `${overrides.id ?? "x"}.md`,
    frontmatter: {
      id: "x",
      company: "Acme",
      title: "Intern",
      start: String(NOW - 1),
      end: "present",
      ...overrides,
    } as Experience["frontmatter"],
    body,
  };
}

const STUDENT_KB: Experience[] = [
  exp(
    { id: "intern", company: "Fintech Co", title: "Software Engineering Intern", start: String(NOW - 1) },
    "## Summary\nBuilt internal tooling. [R]\n\n## Achievements\n- Built a dashboard for the ops team. [R]\n- Wrote data pipeline tests. [R]\n- Shipped a feature used by 40 internal users. [R]\n",
  ),
  exp(
    { id: "capstone", company: "State University", title: "Capstone Project Lead", start: String(NOW - 1) },
    "## Summary\nLed a 4-person capstone. [R]\n\n## Achievements\n- Led a team of 4 building a scheduling app. [R]\n- Presented to faculty panel. [R]\n",
  ),
];

const SENIOR_KB: Experience[] = [
  exp(
    { id: "lead", company: "BigCo", title: "Product Lead", start: String(NOW - 12), end: "present" },
    "## Summary\nLed platform. [R]\n\n## Achievements\n- Led a platform serving 10M users. [R]\n- Grew revenue 40%. [R]\n",
  ),
];

describe("careerStage", () => {
  it("derives early for short spans and senior for long ones", () => {
    expect(careerStage(STUDENT_KB)).toBe("early");
    expect(careerStage(SENIOR_KB)).toBe("senior");
  });
});

describe("computeHealth stage calibration", () => {
  it("reports the stage it graded on", () => {
    expect(computeHealth(STUDENT_KB).stage).toBe("early");
    expect(computeHealth(SENIOR_KB).stage).toBe("senior");
  });

  it("grades the same student KB more fairly on the early curve than the senior curve", () => {
    const early = computeHealth(STUDENT_KB); // derived: early
    const forcedSenior = computeHealth(STUDENT_KB, { stage: "senior" });
    expect(early.overall).toBeGreaterThan(forcedSenior.overall);
  });

  it("gives early-career depth partial credit instead of the floor when unenriched", () => {
    const early = computeHealth(STUDENT_KB);
    const depth = early.dimensions.find((d) => d.key === "depth")!;
    expect(depth.score).toBeGreaterThanOrEqual(2);
    expect(depth.fix).toMatch(/project|internship/i);
  });

  it("keeps the senior curve unchanged for senior KBs", () => {
    const senior = computeHealth(SENIOR_KB);
    const q = senior.dimensions.find((d) => d.key === "quantification")!;
    // 2 of 2 bullets quantified on the senior thresholds → top band.
    expect(q.score).toBe(5);
  });

  it("uses encouraging early-career verdict language", () => {
    const early = computeHealth(STUDENT_KB);
    expect(early.verdict.toLowerCase()).not.toContain("excellent.");
    expect(early.verdict.length).toBeGreaterThan(10);
  });
});
