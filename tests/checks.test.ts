import { describe, expect, it } from "vitest";
import {
  checkAtsCoverage,
  checkResumeGrounding,
  checkResumePerson,
  checkStyle,
  extractMetricTokens,
  isHardStyleViolation,
  resolveStylePolicy,
} from "@kairos/engine/tools/checks";
import type { Experience } from "@kairos/engine/kb/types";
import type { GeneratedResume } from "@kairos/engine/types";

describe("checkStyle", () => {
  it("flags em dashes, banned words, and the not-just-but pattern as hard violations", () => {
    const v = checkStyle("We spearheaded a change — not just a tweak but a rewrite.");
    const rules = v.map((x) => x.rule);
    expect(rules).toContain("em-dash");
    expect(rules).toContain("banned-word");
    expect(rules).toContain("not-just-but");
    expect(v.filter(isHardStyleViolation).length).toBeGreaterThanOrEqual(3);
  });

  it("treats empty adverbs as soft and passes clean text", () => {
    const soft = checkStyle("This was extremely fast.");
    expect(soft.every((x) => !isHardStyleViolation(x))).toBe(true);
    expect(checkStyle("Cut validation time 60% and improved accuracy 40%.")).toEqual([]);
  });

  it("warns (softly) when the same verb opens 4+ bullets", () => {
    const md = ["- **A:** Drove x.", "- **B:** Drove y.", "- Drove z.", "- **C:** Drove w.", "- **D:** Led v."].join("\n");
    const v = checkStyle(md);
    const cluster = v.find((x) => x.rule === "verb-clustering");
    expect(cluster?.detail).toContain('"drove" opens 4');
    expect(cluster && !isHardStyleViolation(cluster)).toBe(true);
  });
});

describe("checkResumePerson", () => {
  it("flags third-person references to the candidate", () => {
    const v = checkResumePerson("- Builds the evaluation sets, prototypes, and agents himself.");
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("third-person");
    expect(isHardStyleViolation(v[0])).toBe(true);
  });

  it("blocks naming the personal knowledge base", () => {
    expect(checkResumePerson("- Built Kairos, a personal agentic operations system.")).toHaveLength(1);
  });

  it("passes implied first person", () => {
    expect(checkResumePerson("- Builds the evaluation sets and prototypes hands-on. Owned the gate; the team shipped.")).toEqual([]);
  });
});

describe("extractMetricTokens", () => {
  it("extracts claim-bearing metrics and skips years and tenure math", () => {
    const tokens = extractMetricTokens(
      "Delivered $20M in savings, 600% productivity, 35+ teams, 100,000 documents, 500M+ devices in 2024. 15+ years of work.",
    ).map((t) => t.raw);
    expect(tokens).toEqual(expect.arrayContaining(["$20M", "600%", "35+", "100,000", "500M+"]));
    expect(tokens).not.toContain("2024");
    expect(tokens.some((t) => t.startsWith("15+"))).toBe(false);
  });
});

const kbExp = (company: string, body: string, fileName = "01-test.md"): Experience =>
  ({
    fileName,
    frontmatter: { id: "t", company, title: "PM", start: "2020", end: "2022" },
    body,
  }) as unknown as Experience;

const resume = (company: string, bullets: string[], source = "01-test"): GeneratedResume => ({
  resume: {
    header: { name: "A", contact: "b" },
    executive_summary: "Product leader.",
    experience: [{ company, title: "PM", dates: "2020 – 2022", bullets }],
    education: [],
    skills: [],
  },
  provenance_audit: [{ claim: "x", source_experience: source, prov: "R" }],
});

describe("checkResumeGrounding", () => {
  const kb = [kbExp("Acme", "- Delivered $20M in savings and 90% adoption. [R]")];

  it("passes when employers and metrics trace to the KB", () => {
    expect(checkResumeGrounding(resume("Acme", ["Delivered $20M in savings.", "Reached 90% adoption."]), kb)).toEqual([]);
  });

  it("rejects unknown employers, invented metrics, and unknown provenance sources", () => {
    const issues = checkResumeGrounding(resume("Globex", ["Delivered $50M in savings."], "99-nope"), kb);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain("unknown_employer");
    expect(kinds).toContain("ungrounded_metric");
    expect(kinds).toContain("unknown_source");
  });

  it("does not ground metrics on [?] facts (stripped corpus)", () => {
    const kbUnverified = [kbExp("Acme", "- Delivered $20M in savings. [R]\n- Grew revenue 300%. [?]")];
    const issues = checkResumeGrounding(resume("Acme", ["Grew revenue 300%."]), kbUnverified);
    expect(issues.map((i) => i.kind)).toContain("ungrounded_metric");
  });
});

describe("checkAtsCoverage", () => {
  it("reports coverage of the JD's salient terms", () => {
    const jd =
      "We need product roadmaps and product roadmaps discipline. AI governance and AI governance experience. GDPR compliance required. Kubernetes preferred. Kubernetes daily.";
    const good = checkAtsCoverage(jd, "Set AI governance and product roadmaps under GDPR.");
    expect(good.coverage).toBeGreaterThan(0.5);
    expect(good.missing.join(" ")).toContain("kubernetes");
    const bad = checkAtsCoverage(jd, "I write poetry.");
    expect(bad.coverage).toBeLessThan(0.2);
  });
});

describe("checkResumeGrounding — source-bound metrics (REQ-3)", () => {
  const kb = [
    kbExp("Acme", "- Delivered $20M in savings. [R]", "01-acme.md"),
    kbExp("Globex", "- Improved accuracy 40%. [R]", "02-globex.md"),
  ];
  const twoCompanyResume = (acmeBullets: string[], globexBullets: string[]): GeneratedResume => ({
    resume: {
      header: { name: "A", contact: "b" },
      executive_summary: "Product leader.",
      experience: [
        { company: "Acme", title: "PM", dates: "2020 – 2022", bullets: acmeBullets },
        { company: "Globex", title: "PM", dates: "2018 – 2020", bullets: globexBullets },
      ],
      education: [],
      skills: [],
    },
    provenance_audit: [
      { claim: "x", source_experience: "01-acme", prov: "R" },
      { claim: "y", source_experience: "02-globex", prov: "R" },
    ],
  });

  it("passes when each section's metrics come from its own experience", () => {
    expect(
      checkResumeGrounding(twoCompanyResume(["Delivered $20M in savings."], ["Improved accuracy 40%."]), kb),
    ).toEqual([]);
  });

  it("flags a true metric recombined under the wrong employer", () => {
    // 40% is real (Globex) but claimed under Acme: corpus-wide grounding passes,
    // source binding must fail.
    const issues = checkResumeGrounding(
      twoCompanyResume(["Improved accuracy 40% at massive scale."], ["Improved accuracy 40%."]),
      kb,
    );
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain("metric_source_mismatch");
    expect(kinds).not.toContain("ungrounded_metric");
    expect(issues.find((i) => i.kind === "metric_source_mismatch")?.detail).toContain("Acme");
  });

  it("lets the executive summary aggregate metrics across experiences", () => {
    const gen = twoCompanyResume(["Delivered $20M in savings."], ["Improved accuracy 40%."]);
    gen.resume.executive_summary = "Delivered $20M in savings and improved accuracy 40%.";
    expect(checkResumeGrounding(gen, kb)).toEqual([]);
  });

  it("grounds section metrics from extraCorpus (profile/education facts)", () => {
    const gen = twoCompanyResume(["Delivered $20M in savings while teaching 120+ students."], []);
    expect(checkResumeGrounding(gen, kb, "Guest lecturer for 120+ students. [R]")).toEqual([]);
  });
});

describe("extractMetricTokens — edge cases (REQ-3)", () => {
  const raws = (s: string) => extractMetricTokens(s).map((t) => t.raw);

  it("keeps 1,200 and $1.2M distinct (no cross-grounding via normalization)", () => {
    const tokens = extractMetricTokens("Handled 1,200 tickets and $1.2M budget.");
    const normals = tokens.map((t) => t.normalized);
    expect(normals).toContain("1,200".toLowerCase().replace(/[,\s]/g, ""));
    expect(normals.filter((n) => n === "1200").length).toBe(1);
    expect(normals.some((n) => n.includes("$1.2m"))).toBe(true);
  });

  it("keeps 40+ and 40% as different claims", () => {
    const normals = extractMetricTokens("Ran 40+ teams at 40% margin.").map((t) => t.normalized);
    expect(normals).toContain("40+");
    expect(normals).toContain("40%");
  });

  it("treats comma-numbers at the year boundary correctly", () => {
    expect(raws("Shipped 1,899 units and 2,100 units.")).toEqual(
      expect.arrayContaining(["1,899", "2,100"]),
    );
    // 2,050 normalizes to a plausible year and is excluded by the year guard.
    expect(raws("Since 2,050 units")).toEqual([]);
  });

  it("excludes tenure phrases but keeps bare N+ claims", () => {
    expect(raws("15+ years of experience")).toEqual([]);
    expect(raws("supported 15+ teams")).toContain("15+");
  });
});

describe("style policy overrides (REQ-14)", () => {
  it("default policy flags em dashes and banned words", () => {
    const v = checkStyle("We leverage synergies — daily.");
    expect(v.some((x) => x.rule === "em-dash")).toBe(true);
    expect(v.some((x) => x.rule === "banned-word")).toBe(true);
  });

  it("a custom policy can relax the em-dash ban and swap the banned list", () => {
    const policy = resolveStylePolicy({ banEmDashes: false, bannedWords: ["moist"] });
    const v = checkStyle("We leverage synergies — daily.", policy);
    expect(v.some((x) => x.rule === "em-dash")).toBe(false);
    expect(v.some((x) => x.rule === "banned-word")).toBe(false);
    expect(checkStyle("A moist opportunity.", policy).some((x) => x.rule === "banned-word")).toBe(true);
  });

  it("partial policies inherit defaults for omitted fields", () => {
    const policy = resolveStylePolicy({ leadinMaxWords: 8 });
    expect(policy.banEmDashes).toBe(true);
    expect(policy.bannedWords.length).toBeGreaterThan(10);
  });
});
