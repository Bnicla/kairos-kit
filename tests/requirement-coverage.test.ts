import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "@/store/local-fs";
import { createApplication } from "@kairos/engine/applications";
import { saveGeneratedResume } from "@kairos/engine/tools/ops";
import { checkRequirementCoverage } from "@kairos/engine/tools/checks";
import { generatedResumeToMarkdown } from "@kairos/engine/resume-render";
import type { GeneratedResume, RequirementCoverageRow } from "@kairos/engine/types";

/**
 * Requirements coverage table (2026-11-03): every requirement the ad states is
 * matched to evidence that is really on the résumé, or honestly marked a gap.
 */

const KB_FILE = `---
id: acme-pm
company: Acme
title: Product Manager
start: '2020'
end: '2022'
---

## Achievements
- Delivered $20M in savings and 90% adoption on the support platform. [R]
- Built the evaluation framework for the conversational assistant across 40+ markets. [R]
`;

const BULLETS = [
  "**Support Platform:** Delivered $20M in savings and 90% adoption on the support platform.",
  "**Evaluation Framework:** Built the evaluation framework for the conversational assistant across 40+ markets.",
];

const resume = (coverage?: RequirementCoverageRow[]): GeneratedResume => ({
  resume: {
    header: { name: "Alex Sample", contact: "Chicago" },
    executive_summary: "- **Product leader:** ships platforms with measured outcomes.",
    experience: [{ company: "Acme", title: "Product Manager", dates: "2020 – 2022", bullets: [...BULLETS] }],
    education: [{ institution: "Westbrook", credential: "MBA" }],
    skills: ["Platforms", "Evals", "SQL"],
  },
  provenance_audit: [{ claim: "savings", source_experience: "01-acme-pm", prov: "R" }],
  ...(coverage ? { requirement_coverage: coverage } : {}),
});

const MD = generatedResumeToMarkdown(resume());

const row = (r: Partial<RequirementCoverageRow> & Pick<RequirementCoverageRow, "requirement" | "status">): RequirementCoverageRow => ({
  priority: "required",
  ...r,
});

const GOOD_ROWS: RequirementCoverageRow[] = [
  row({ requirement: "Platform product experience", status: "covered", evidence: "Delivered $20M in savings and 90% adoption on the support platform." }),
  row({ requirement: "LLM evaluation", status: "partial", evidence: "Built the evaluation framework for the conversational assistant", note: "evals, not model training" }),
  row({ requirement: "Fintech domain", priority: "preferred", status: "gap", note: "no fintech domain experience" }),
];

describe("checkRequirementCoverage: evidence matching", () => {
  it("accepts an exact excerpt regardless of case, bold markers, end punctuation, and dash style", () => {
    const rows = [
      row({ requirement: "a", status: "covered", evidence: "support platform: delivered $20m in savings" }),
      row({ requirement: "b", status: "covered", evidence: "**Evaluation Framework:**  Built the evaluation   framework" }),
      row({ requirement: "c", status: "covered", evidence: "Product Manager | 2020 – 2022" }),
      row({ requirement: "d", status: "covered", evidence: "“Delivered $20M in savings.”" }),
    ];
    expect(checkRequirementCoverage(rows, MD).errors).toEqual([]);
  });

  it("accepts a light paraphrase at the 60% single-line token overlap threshold", () => {
    // content tokens: built, evaluation, framework, shipped, weekly -> 3/5 on one line = 60%
    const rows = [row({ requirement: "Evals", status: "partial", evidence: "built evaluation framework, shipped weekly" })];
    expect(checkRequirementCoverage(rows, MD).errors).toEqual([]);
    // reordered skills still match the skills line
    const skills = [row({ requirement: "SQL", status: "covered", evidence: "SQL, Evals, Platforms" })];
    expect(checkRequirementCoverage(skills, MD).errors).toEqual([]);
  });

  it("rejects a paraphrase below the threshold, naming the row", () => {
    // evaluation, framework, shipped, weekly, review -> 2/5 = 40%
    const rows = [
      ...GOOD_ROWS,
      row({ requirement: "Shipping cadence", status: "covered", evidence: "evaluation framework shipped weekly reviews" }),
    ];
    const { errors } = checkRequirementCoverage(rows, MD);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/requirement_coverage\[3\] "Shipping cadence" \(covered\)/);
    expect(errors[0]).toMatch(/overlap 40%, needs 60%/);
  });

  it("rejects evidence that is not on the résumé at all", () => {
    const rows = [row({ requirement: "Payments", status: "covered", evidence: "Led the card payments rollout for 12 banks" })];
    const { errors } = checkRequirementCoverage(rows, MD);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/"Payments" \(covered\): evidence is not on the résumé/);
  });

  it("matches per line, so words stitched together from different bullets do not pass", () => {
    // every token is somewhere on the résumé, but no single line holds 60% of them
    const rows = [
      row({ requirement: "x", status: "covered", evidence: "support platform evaluation framework conversational assistant savings" }),
    ];
    expect(checkRequirementCoverage(rows, MD).errors).toHaveLength(1);
  });

  it("rejects a paraphrase that quotes a number the line does not contain", () => {
    const rows = [
      row({ requirement: "Scale", status: "covered", evidence: "Built the evaluation framework for the conversational assistant in 50+ markets" }),
    ];
    const { errors } = checkRequirementCoverage(rows, MD);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/lacks 50\+/);
  });

  it("requires evidence on covered and partial rows, not on gap rows", () => {
    const rows = [
      row({ requirement: "Covered without evidence", status: "covered" }),
      row({ requirement: "Partial with blank evidence", status: "partial", evidence: "  ", note: "adjacent" }),
      row({ requirement: "Gap", status: "gap", evidence: null, note: "none" }),
    ];
    const { errors } = checkRequirementCoverage(rows, MD);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/\[0\] "Covered without evidence" \(covered\) has no evidence/);
    expect(errors[1]).toMatch(/\[1\] "Partial with blank evidence" \(partial\) has no evidence/);
  });
});

describe("checkRequirementCoverage: warnings and summary", () => {
  it("lists gap rows as a warning and counts rows by status", () => {
    const { errors, warnings, summary } = checkRequirementCoverage(GOOD_ROWS, MD);
    expect(errors).toEqual([]);
    expect(warnings).toEqual(["requirement coverage: 1 gap to surface: Fintech domain (preferred): no fintech domain experience"]);
    expect(summary).toEqual({
      rows: 3,
      covered: 1,
      partial: 1,
      gap: 1,
      gaps: [{ requirement: "Fintech domain", priority: "preferred", note: "no fintech domain experience" }],
    });
  });

  it("warns when the table has fewer than 3 rows", () => {
    const { warnings } = checkRequirementCoverage(GOOD_ROWS.slice(0, 2), MD);
    expect(warnings).toEqual([expect.stringMatching(/only 2 rows; the ad likely states more requirements/)]);
    expect(checkRequirementCoverage([], MD).warnings).toEqual([expect.stringMatching(/only 0 rows/)]);
  });
});

describe("saveGeneratedResume with requirement_coverage", () => {
  let store: LocalStore;
  let appId: string;

  beforeAll(async () => {
    store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-cov-")));
    await store.writeFile(["knowledge-base", "experiences", "01-acme-pm.md"], KB_FILE);
    const meta = await createApplication(store, {
      company: "Globex",
      role: "Head of Product",
      snapshotMarkdown: "# Head of Product\nRequired: platform experience, LLM evaluation. Preferred: fintech.",
      source_url_unavailable: true,
    });
    appId = meta.id;
  });

  it("persists the table in resume.json and returns the summary + gap warning", async () => {
    const result = await saveGeneratedResume(store, appId, resume(GOOD_ROWS));
    expect(result.coverage).toMatchObject({ rows: 3, covered: 1, partial: 1, gap: 1 });
    expect(result.warnings.some((w) => /1 gap to surface: Fintech domain/.test(w))).toBe(true);
    const saved = await store.readJson<GeneratedResume>(["applications", appId, "resume.json"]);
    expect(saved?.requirement_coverage).toEqual(GOOD_ROWS);
  });

  it("hard-fails when a covered row's evidence is not on the résumé, naming the row", async () => {
    const rows = [
      ...GOOD_ROWS,
      row({ requirement: "Payments at scale", status: "covered", evidence: "Ran the payments platform for 12 banks" }),
    ];
    await expect(saveGeneratedResume(store, appId, resume(rows))).rejects.toThrow(
      /Requirement coverage failed: requirement_coverage\[3\] "Payments at scale" \(covered\): evidence is not on the résumé/,
    );
  });

  it("warns (does not fail) on a short table", async () => {
    const result = await saveGeneratedResume(store, appId, resume(GOOD_ROWS.slice(0, 1)));
    expect(result.warnings.some((w) => /only 1 row;/.test(w))).toBe(true);
  });

  it("stays backward compatible: no field, no coverage checks", async () => {
    const result = await saveGeneratedResume(store, appId, resume());
    expect(result.coverage).toBeNull();
    expect(result.warnings.some((w) => w.startsWith("requirement coverage"))).toBe(false);
  });
});

describe("dashboard getApplication exposes requirementCoverage", () => {
  const prevHome = process.env.KAIROS_HOME;
  let root: string;
  let withCov: string;
  let without: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kairos-dash-"));
    process.env.KAIROS_HOME = root;
    const store = new LocalStore(root);
    const mk = (company: string) =>
      createApplication(store, { company, role: "PM", snapshotMarkdown: "# PM\nad", source_url_unavailable: true });
    withCov = (await mk("Initech")).id;
    without = (await mk("Hooli")).id;
    await store.writeJson(["applications", withCov, "resume.json"], {
      ...resume(GOOD_ROWS),
      requirement_coverage: [...GOOD_ROWS, { requirement: "malformed", status: "unknown" }],
    });
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.KAIROS_HOME;
    else process.env.KAIROS_HOME = prevHome;
  });

  it("returns the rows from resume.json (malformed rows skipped) and null when absent", async () => {
    const { getApplication } = await import("@/lib/dashboard");
    expect((await getApplication(withCov))?.requirementCoverage).toEqual(GOOD_ROWS);
    expect((await getApplication(without))?.requirementCoverage).toBeNull();
  });
});
