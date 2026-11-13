import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalStore } from "@/store/local-fs";
import LineOrigins from "@/components/LineOrigins";
import { createApplication } from "@kairos/engine/applications";
import { parseExperience, verifiedFacts } from "@kairos/engine/kb/experience";
import {
  checkLineOrigins,
  computeLineOrigins,
  countOrigins,
  ORIGIN_ORDER_MIN,
  ORIGIN_ORDER_STRONG,
  ORIGIN_PARTIAL,
  ORIGIN_STRONG,
  readLineOrigins,
  summarizeOrigins,
} from "@kairos/engine/line-origin";
import { contentStems, summarySentences } from "@kairos/engine/stretch";
import { auditSourceExperiences, COVERAGE_TOKEN_OVERLAP } from "@kairos/engine/tools/checks";
import { saveGeneratedResume } from "@kairos/engine/tools/ops";
import type { GeneratedResume, LineOrigin } from "@kairos/engine/types";

/**
 * Line origins: every bullet, role intro and summary sentence of a résumé is
 * traced in code to the verified fact or facts of the record it comes from.
 * All fixtures are fictional.
 */

const HARBORLINE = `---
id: harborline-pm
company: Harborline Freight
title: Product Manager
start: '2021-02'
end: present
---

## Summary
Product manager for the dispatch console used by regional carriers. [R]

## Achievements
- Rebuilt the dispatch console so that planners assign loads in one screen, cutting planning time by 35%. [R]
- Wrote the carrier onboarding checklist and ran weekly office hours for 60 carriers. [C]
- Interviewed 22 dispatchers and turned the findings into the routing roadmap. [F]
- Correction: the driver mobile app was proposed and never built. [C]
- Negotiated the telematics contract with two vendors. [?]
- Trained the support team on the new console.

Key projects:

## Raw material / notes
- Organised the summer hackathon for the warehouse robotics group. [R]
`;

const LANTERN = `---
id: lantern-analyst
company: Lantern Analytics
title: Data Analyst
start: '2018-06'
end: '2021-01'
---

## Achievements
- Built the weekly churn dashboard in SQL and Looker for the customer success team. [R]
- Automated the invoice reconciliation report, saving the finance team 6 hours a week. [R]
`;

const exps = [parseExperience("01-harborline-pm.md", HARBORLINE), parseExperience("02-lantern-analyst.md", LANTERN)];

const REBUILT = "Rebuilt the dispatch console so that planners assign loads in one screen, cutting planning time by 35%. [R]";
const CHECKLIST = "Wrote the carrier onboarding checklist and ran weekly office hours for 60 carriers. [C]";
const INTERVIEWS = "Interviewed 22 dispatchers and turned the findings into the routing roadmap. [F]";
const CHURN = "Built the weekly churn dashboard in SQL and Looker for the customer success team. [R]";

const resume = (over: { summary?: string; bullets?: string[]; intro?: string; lantern?: string[]; audit?: GeneratedResume["provenance_audit"] } = {}): GeneratedResume => ({
  resume: {
    header: { name: "Noor Haddad", contact: "Tacoma, WA" },
    executive_summary: over.summary ?? "Product manager for the dispatch console used by regional carriers.",
    experience: [
      { company: "Harborline Freight", title: "Product Manager", dates: "Feb 2021 – Present", ...(over.intro ? { summary: over.intro } : {}), bullets: over.bullets ?? ["Interviewed 22 dispatchers and turned the findings into the routing roadmap."] },
      ...(over.lantern ? [{ company: "Lantern Analytics", title: "Data Analyst", dates: "Jun 2018 – Jan 2021", bullets: over.lantern }] : []),
    ],
    education: [],
    skills: [],
  },
  provenance_audit: over.audit ?? [{ claim: "Interviewed 22 dispatchers", source_experience: "harborline-pm", prov: "F" }],
});

/** The origin of one bullet written under Harborline Freight. */
const bulletOrigin = (text: string): LineOrigin => computeLineOrigins(resume({ bullets: [text] }), exps).find((l) => l.kind === "bullet")!;

describe("the verified facts of an entry", () => {
  it("lists the fact lines tagged [R], [C] or [F], as written, and nothing else", () => {
    const facts = verifiedFacts(exps[0]!.body);
    expect(facts.map((f) => f.text)).toEqual([
      "Product manager for the dispatch console used by regional carriers. [R]",
      `- ${REBUILT}`,
      `- ${CHECKLIST}`,
      `- ${INTERVIEWS}`,
      "- Correction: the driver mobile app was proposed and never built. [C]",
    ]);
    expect(facts[1]).toMatchObject({ line: 5, section: "Achievements" });
  });
});

describe("the origin of a line", () => {
  it("gives a line copied from the record its own fact, tag included, with the id of the entry", () => {
    const o = bulletOrigin("Wrote the carrier onboarding checklist and ran weekly office hours for 60 carriers.");
    expect(o).toEqual({
      kind: "bullet",
      role: 0,
      bullet: 0,
      text: "Wrote the carrier onboarding checklist and ran weekly office hours for 60 carriers.",
      strength: "strong",
      overlap: 1,
      facts: [{ experience_id: "harborline-pm", fact: CHECKLIST }],
    });
  });

  it("finds the fact of a lightly reworded line, and does not match the bold lead-in", () => {
    const o = bulletOrigin("**Dispatch console:** Rebuilt the console for planners, who now assign loads in a single screen; planning time fell 35%.");
    expect(o.strength).toBe("strong");
    expect(o.facts).toEqual([{ experience_id: "harborline-pm", fact: REBUILT }]);
    expect(o.overlap).toBeGreaterThanOrEqual(ORIGIN_STRONG);
    expect(o.overlap).toBeLessThan(1);
  });

  it("gives a line that joins two facts both of them", () => {
    const o = bulletOrigin("Interviewed 22 dispatchers for the routing roadmap, then wrote the carrier onboarding checklist and ran office hours for 60 carriers.");
    expect(o.strength).toBe("strong");
    expect(o.facts.map((f) => f.fact).sort()).toEqual([INTERVIEWS, CHECKLIST].sort());
  });

  it("is partial when the facts hold the words and lack one of the line's numbers", () => {
    const o = bulletOrigin("Rebuilt the dispatch console so that planners assign loads in one screen, cutting planning time by 50%.");
    expect(o.strength).toBe("partial");
    expect(o.facts[0]!.fact).toBe(REBUILT);
  });

  it("is partial when one fact holds part of the line and the rest is not in the record", () => {
    const o = bulletOrigin("Rebuilt the dispatch console for planners and negotiated fuel surcharge terms with brokers.");
    expect(o.strength).toBe("partial");
    expect(o.overlap).toBeGreaterThanOrEqual(ORIGIN_PARTIAL);
    expect(o.overlap).toBeLessThan(ORIGIN_STRONG);
    expect(o.facts).toEqual([{ experience_id: "harborline-pm", fact: REBUILT }]);
  });

  it("finds nothing for a line the record does not hold", () => {
    expect(bulletOrigin("Launched a loyalty programme for retail shoppers in three countries.")).toMatchObject({ strength: "none", facts: [] });
  });

  it("does not take a number and one common word for an origin", () => {
    // "60 carriers" is in the record; the line is about something else.
    expect(bulletOrigin("Signed 60 carriers to the premium insurance plan.").strength).toBe("none");
  });

  it("does not take the vocabulary of the record for an origin: the words must also follow a fact", () => {
    // Every word is in the Harborline facts, from three of them, and no two stand together as the record writes them.
    const jumble = "Screen roadmap for carriers, console checklist with dispatchers, onboarding planners.";
    expect(bulletOrigin(jumble)).toMatchObject({ strength: "none", overlap: 1, facts: [] });
    // A summary sentence is a composition across facts: the same words there are partial, with the lines that support them.
    const inSummary = computeLineOrigins(resume({ summary: jumble }), exps)[0]!;
    expect(inSummary).toMatchObject({ kind: "summary", sentence: 0, strength: "partial", overlap: 1 });
    expect(inSummary.facts.map((f) => f.fact).sort()).toEqual([INTERVIEWS, REBUILT, CHECKLIST].sort());
    expect(ORIGIN_ORDER_MIN).toBeLessThan(ORIGIN_ORDER_STRONG);
  });

  it("looks for a bullet's fact under its own employer only", () => {
    expect(bulletOrigin("Built the weekly churn dashboard in SQL and Looker for the customer success team.").strength).toBe("none");
    const own = computeLineOrigins(resume({ lantern: ["Built the weekly churn dashboard in SQL and Looker for the customer success team."] }), exps).find((l) => l.role === 1)!;
    expect(own).toMatchObject({ kind: "bullet", role: 1, bullet: 0, strength: "strong", facts: [{ experience_id: "lantern-analyst", fact: CHURN }] });
  });

  it("never takes an unverified, untagged, holding-pen or correction line as an origin", () => {
    for (const line of [
      "Negotiated the telematics contract with two vendors.",
      "Trained the support team on the new console.",
      "Organised the summer hackathon for the warehouse robotics group.",
      "The driver mobile app was proposed and built.",
    ]) {
      expect(bulletOrigin(line).strength, line).toBe("none");
    }
  });

  it("reads the summary sentence by sentence against every entry, and a role intro against its employer", () => {
    const summary = "Product manager for the dispatch console used by regional carriers. Earlier, built the weekly churn dashboard in SQL and Looker. Known for calm under pressure.";
    const lines = computeLineOrigins(resume({ summary, intro: "Product manager for the dispatch console used by regional carriers." }), exps);
    expect(lines.map((l) => [l.kind, l.sentence ?? l.role, l.bullet ?? null, l.strength, l.facts[0]?.experience_id ?? null])).toEqual([
      ["summary", 0, null, "strong", "harborline-pm"],
      ["summary", 1, null, "strong", "lantern-analyst"],
      ["summary", 2, null, "none", null],
      ["role_intro", 0, null, "strong", "harborline-pm"],
      ["bullet", 0, 0, "strong", "harborline-pm"],
    ]);
    expect(lines.filter((l) => l.kind === "summary").map((l) => l.text)).toEqual(summarySentences(summary));
    expect(countOrigins(lines)).toEqual({ strong: 4, partial: 0, none: 1 });
  });

  it("uses the share of the coverage check and the words of the stretch check", () => {
    expect(ORIGIN_STRONG).toBe(COVERAGE_TOKEN_OVERLAP);
    expect(contentStems("Rebuilt the dispatch consoles, cutting planning time by 35%")).toEqual(["rebuilt", "dispatch", "consol", "cutt", "plann", "time"]);
  });
});

describe("the source a provenance entry names", () => {
  it("is resolved by file name, id or company, with or without a detail after it", () => {
    const ids = (label: string) => auditSourceExperiences(label, exps)?.map((e) => e.frontmatter.id);
    expect(ids("harborline-pm")).toEqual(["harborline-pm"]);
    expect(ids("02-lantern-analyst.md")).toEqual(["lantern-analyst"]);
    expect(ids("Lantern Analytics (Data Analyst)")).toEqual(["lantern-analyst"]);
    expect(ids("Harborline Freight Product Manager")).toEqual(["harborline-pm"]);
  });

  it("gives no entry for the profile or the education record, and null for a name the record does not hold", () => {
    expect(auditSourceExperiences("profile", exps)).toEqual([]);
    expect(auditSourceExperiences("Education: B.A. Economics", exps)).toEqual([]);
    expect(auditSourceExperiences("Quorvex Labs", exps)).toBeNull();
  });
});

describe("the origin check", () => {
  it("lists a line with no origin, under rule origin, with its employer", () => {
    const report = checkLineOrigins(resume({ summary: "Known for calm under pressure.", bullets: ["Launched a loyalty programme for retail shoppers in three countries."] }), exps);
    expect(report.findings).toEqual([
      { rule: "origin", kind: "none", company: "Executive summary", line: "Known for calm under pressure.", detail: "no verified fact of the record was found for this sentence" },
      {
        rule: "origin",
        kind: "none",
        company: "Harborline Freight",
        line: "Launched a loyalty programme for retail shoppers in three countries.",
        detail: "no verified fact of the Harborline Freight record was found for this line",
      },
    ]);
    expect(report.counts).toEqual({ strong: 0, partial: 0, none: 2 });
  });

  it("gives no finding when the audit names the entry the line comes from, by any of its names", () => {
    const churn = "Built the weekly churn dashboard in SQL and Looker for the customer success team.";
    for (const source of ["lantern-analyst", "Lantern Analytics (Data Analyst)", "02-lantern-analyst.md"]) {
      const report = checkLineOrigins(resume({ lantern: [churn], audit: [{ claim: churn, source_experience: source, prov: "R" }] }), exps);
      expect(report.findings, source).toEqual([]);
    }
  });

  it("lists an audit entry whose named source holds no fact for the line", () => {
    const churn = "Built the weekly churn dashboard in SQL and Looker for the customer success team.";
    const report = checkLineOrigins(
      resume({
        lantern: [churn],
        audit: [
          { claim: "Built the weekly churn dashboard in SQL and Looker", source_experience: "harborline-pm", prov: "R" },
          { claim: "Built the weekly churn dashboard in SQL and Looker", source_experience: "Harborline Freight", prov: "R" },
        ],
      }),
      exps,
    );
    // One finding for the line and the source, however often the audit repeats it.
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ rule: "origin", kind: "audit", company: "Lantern Analytics", line: churn });
    expect(report.findings[0]!.detail).toContain('names "harborline-pm"');
    expect(report.findings[0]!.detail).toContain("lantern-analyst");
    expect(summarizeOrigins(report).audit_disagreements).toEqual([{ company: "Lantern Analytics", line: churn, why: report.findings[0]!.detail }]);
  });

  it("compares a summary sentence the same way: any entry may hold its fact, the named one must", () => {
    const sentence = "Earlier, built the weekly churn dashboard in SQL and Looker.";
    const audit = (source: string) => [{ claim: "built the weekly churn dashboard in SQL and Looker", source_experience: source, prov: "R" as const }];
    expect(checkLineOrigins(resume({ summary: sentence, audit: audit("lantern-analyst") }), exps).findings).toEqual([]);
    expect(checkLineOrigins(resume({ summary: sentence, audit: audit("harborline-pm") }), exps).findings.map((f) => [f.kind, f.company, f.line])).toEqual([["audit", "Executive summary", sentence]]);
  });

  it("does not compare an entry that names the profile, or whose claim is on no line", () => {
    const report = checkLineOrigins(
      resume({
        audit: [
          { claim: "Interviewed 22 dispatchers and turned the findings into the routing roadmap", source_experience: "profile", prov: "R" },
          { claim: "Runs marathons at the weekend", source_experience: "lantern-analyst", prov: "R" },
        ],
      }),
      exps,
    );
    expect(report.findings).toEqual([]);
  });

  it("gives the save a compact summary: counts, the lines with no origin, the audit disagreements", () => {
    const report = checkLineOrigins(resume({ bullets: ["Interviewed 22 dispatchers and turned the findings into the routing roadmap.", "Launched a loyalty programme for retail shoppers."] }), exps);
    expect(summarizeOrigins(report)).toEqual({
      strong: 2,
      partial: 0,
      none: 1,
      no_origin: [{ company: "Harborline Freight", line: "Launched a loyalty programme for retail shoppers." }],
      audit_disagreements: [],
    });
  });
});

describe("save path and read path", () => {
  const prevHome = process.env.KAIROS_HOME;
  let root: string;
  let store: LocalStore;
  let saved: string;
  let old: string;
  const invented = "Launched a loyalty programme for retail shoppers.";
  const gen = resume({ bullets: ["Interviewed 22 dispatchers and turned the findings into the routing roadmap.", invented] });

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kairos-origin-"));
    process.env.KAIROS_HOME = root;
    store = new LocalStore(root);
    await store.writeFile(["profile.md"], "---\nname: Noor Haddad\n---\n");
    await store.writeFile(["knowledge-base", "experiences", "01-harborline-pm.md"], HARBORLINE);
    await store.writeFile(["knowledge-base", "experiences", "02-lantern-analyst.md"], LANTERN);
    const mk = (company: string) => createApplication(store, { company, role: "Product Manager", snapshotMarkdown: "# Product Manager\nDispatch.", source_url_unavailable: true });
    saved = (await mk("Ridgeway")).id;
    old = (await mk("Pinecrest")).id;
    // A résumé saved before origins were recorded.
    await store.writeJson(["applications", old, "resume.json"], gen);
    await store.writeFile(["applications", old, "resume-source.md"], "# Noor Haddad\n");
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.KAIROS_HOME;
    else process.env.KAIROS_HOME = prevHome;
  });

  it("saves a résumé with a line of no origin, returns the finding, and writes line_origins to resume.json", async () => {
    // A line_origins sent in by the caller is not trusted: the save computes its own.
    const res = await saveGeneratedResume(store, saved, { ...gen, line_origins: [{ kind: "bullet", role: 0, bullet: 1, text: invented, strength: "strong", overlap: 1, facts: [] }] });
    expect(res.origins.counts).toEqual({ strong: 2, partial: 0, none: 1 });
    expect(res.origins.findings.map((f) => [f.rule, f.kind, f.line])).toEqual([["origin", "none", invented]]);
    expect(res.stretch).toEqual([]);
    const written = await store.readJson<GeneratedResume>(["applications", saved, "resume.json"]);
    expect(written!.line_origins).toEqual(res.origins.lines);
    expect(written!.line_origins!.map((l) => l.strength)).toEqual(["strong", "strong", "none"]);
    expect(written!.resume).toEqual(gen.resume);
  });

  it("reads back the saved origins, skips malformed ones, and computes them for a résumé saved without", () => {
    const good: LineOrigin = { kind: "bullet", role: 0, bullet: 0, text: "x", strength: "partial", overlap: 0.5, facts: [{ experience_id: "harborline-pm", fact: REBUILT }] };
    const bad = [{ kind: "bullet", strength: "certain", text: "x", facts: [] }, { kind: "bullet", strength: "strong", text: "x" }, null] as unknown as LineOrigin[];
    expect(readLineOrigins({ ...gen, line_origins: [good, ...bad] }, [])).toEqual({ lines: [good], saved: true });
    const computed = readLineOrigins(gen, exps);
    expect(computed.saved).toBe(false);
    expect(computed.lines).toEqual(computeLineOrigins(gen, exps));
  });

  it("gives the application page the saved origins, computes them for an older résumé, and nothing without a résumé", async () => {
    const { getApplication } = await import("@/lib/dashboard");
    const withSaved = (await getApplication(saved))!.lineOrigins!;
    expect(withSaved.saved).toBe(true);
    expect(withSaved.roles).toEqual(["Harborline Freight · Product Manager"]);
    expect(withSaved.lines.map((l) => l.strength)).toEqual(["strong", "strong", "none"]);
    const older = (await getApplication(old))!.lineOrigins!;
    expect(older.saved).toBe(false);
    expect(older.lines).toEqual(withSaved.lines);
    const none = await createApplication(store, { company: "Hollowell", role: "Product Manager", snapshotMarkdown: "# Product Manager\nad", source_url_unavailable: true });
    expect((await getApplication(none.id))!.lineOrigins).toBeNull();
  });
});

describe("the application page section", () => {
  const view = {
    saved: true,
    roles: ["Harborline Freight · Product Manager"],
    lines: computeLineOrigins(resume({ summary: "Known for calm under pressure.", intro: "Product manager for the dispatch console used by regional carriers.", bullets: ["**Research:** Interviewed 22 dispatchers and turned the findings into the routing roadmap."] }), exps),
  };
  const html = renderToStaticMarkup(createElement(LineOrigins, { view }));

  it("is collapsed by default and gives the counts in its heading", () => {
    expect(html).toMatch(/^<details class="card mb-6 p-4">/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain("2 strong · 0 partial · 1 none");
  });

  it("shows each line beside its fact, with the tag, grouped by role", () => {
    expect(html).toContain("Executive summary");
    expect(html).toContain("Harborline Freight · Product Manager");
    expect(html).toContain("Research: Interviewed 22 dispatchers"); // bold markers removed
    expect(html).toContain('Interviewed 22 dispatchers and turned the findings into the routing roadmap. <span class="prov-F font-semibold">[F]</span>');
    expect(html).toContain("role intro");
    expect(html).toContain('<span class="badge badge-warn">None</span>');
    expect(html).not.toContain("computed now");
  });

  it("says so when the origins were computed on read, and cuts a very long fact with the whole text on hover", () => {
    const long = `${"Kept the dispatch console running through the winter storms. ".repeat(12)}[C]`;
    const line: LineOrigin = { kind: "bullet", role: 0, bullet: 0, text: "Kept the console running.", strength: "partial", overlap: 0.5, facts: [{ experience_id: "harborline-pm", fact: long }] };
    const out = renderToStaticMarkup(createElement(LineOrigins, { view: { saved: false, roles: view.roles, lines: [line] } }));
    expect(out).toContain("computed now, from your record as it is today");
    expect(out).toContain(`title="${long}"`);
    expect(out).toContain('… <span class="prov-C font-semibold">[C]</span>');
  });
});
