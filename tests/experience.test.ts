import { describe, expect, it } from "vitest";
import {
  countFacts,
  hasUnverifiedFacts,
  insertUnderSection,
  parseExperience,
  serializeExperience,
  stripUnverified,
  untaggedFacts,
} from "@kairos/engine/kb/experience";
import { ungroundedNumbers } from "@kairos/engine/tools/checks";

const RAW = `---
id: acme-pm
company: Acme
title: Product Manager
start: '2020'
end: '2022'
skills:
  - name: Roadmapping
    proficiency: strong
    recency: '2022'
    prov: R
  - name: Kubernetes
    proficiency: working
    recency: '2022'
    prov: '?'
---

## Summary
Led product. [R]

## Achievements
- Delivered $20M in savings. [R]
- Grew revenue 300%. [?]

## Delivery notes
- Shipped on a quality-first framework. [C]

## Raw material / notes
- Maybe also ran the offsite? [?]
`;

describe("parse/serialize round-trip", () => {
  it("preserves frontmatter and body through a round trip", () => {
    const exp = parseExperience("01-acme-pm.md", RAW);
    expect(exp.frontmatter.company).toBe("Acme");
    const again = parseExperience("01-acme-pm.md", serializeExperience(exp));
    expect(again.frontmatter).toEqual(exp.frontmatter);
    expect(again.body.trim()).toBe(exp.body.trim());
  });
});

describe("stripUnverified", () => {
  const stripped = stripUnverified(parseExperience("01-acme-pm.md", RAW));

  it("drops [?] facts, [?] skills, and the raw-material holding pen", () => {
    expect(stripped.body).not.toContain("300%");
    expect(stripped.body).not.toContain("offsite");
    expect(stripped.frontmatter.skills?.map((s) => s.name)).not.toContain("Kubernetes");
  });

  it("keeps verified facts AND legitimately-named sections like 'Delivery notes'", () => {
    expect(stripped.body).toContain("$20M");
    // Regression: a loose /notes/ match used to delete this whole section.
    expect(stripped.body).toContain("quality-first framework");
  });
});

// A fact with no provenance tag is not verified evidence (invented demo data).
const UNTAGGED = `---
id: brightpath-analyst
company: Brightpath
title: Operations Analyst
start: '2021'
end: '2023'
---

## Summary
Ran weekly reporting for the regional warehouses. [R]
Also rebuilt the forecasting model, which cut stockouts by 70%.

## Achievements
Key projects:
- **Routing:**
  - Cut delivery time by 15% across four depots. [C]
  - Saved $3M a year in fuel.
- Trained 12 new analysts on the reporting stack,
  including the 250+ dashboards the team maintains. [R]
- Wrapped fact that reaches 88% of the depots
  and still has no tag.

---

## Raw material / notes
- Possibly 400% growth, to check.
`;

describe("facts with no provenance tag", () => {
  const exp = parseExperience("03-brightpath-analyst.md", UNTAGGED);
  const stripped = stripUnverified(exp);

  it("leaves an untagged paragraph line, bullet and sub-bullet out of the evidence", () => {
    expect(stripped.body).not.toContain("70%");
    expect(stripped.body).not.toContain("$3M");
    expect(stripped.body).not.toContain("88%");
    expect(stripped.body).not.toContain("still has no tag");
  });

  it("keeps tagged facts, including a bullet whose tag is on its wrapped last line", () => {
    expect(stripped.body).toContain("Ran weekly reporting");
    expect(stripped.body).toContain("Cut delivery time by 15%");
    expect(stripped.body).toContain("Trained 12 new analysts");
    expect(stripped.body).toContain("250+ dashboards");
  });

  it("does not touch headings, labels, rules or the frontmatter", () => {
    expect(stripped.body).toContain("## Summary");
    expect(stripped.body).toContain("## Achievements");
    expect(stripped.body).toContain("Key projects:");
    expect(stripped.body).toContain("- **Routing:**");
    expect(stripped.body).toContain("---");
    expect(stripped.frontmatter).toEqual({ ...exp.frontmatter, skills: [] }); // existing behaviour: an empty skills list is added
  });

  it("an untagged number does not ground a résumé or letter number", () => {
    expect(ungroundedNumbers("I cut stockouts by 70% and delivery time by 15%.", [exp], "")).toEqual(["70%"]);
  });

  it("reports each untagged fact with its line and section, and nothing else", () => {
    const found = untaggedFacts(exp.body);
    expect(found.map((f) => f.section)).toEqual(["Summary", "Achievements", "Achievements"]);
    expect(found[0]).toEqual({ line: 3, section: "Summary", text: "Also rebuilt the forecasting model, which cut stockouts by 70%." });
    expect(found[1].text).toBe("- Saved $3M a year in fuel.");
    expect(found[2].text).toContain("Wrapped fact that reaches 88%");
    expect(found[2].text).toContain("and still has no tag.");
    // Holding-pen notes are stripped wholesale and are not reported as untagged.
    expect(found.some((f) => f.text.includes("400%"))).toBe(false);
  });

  it("counts fact lines: list items (with their wrapped lines) and paragraph lines, outside the holding pen", () => {
    expect(countFacts(exp.body)).toBe(6);
    expect(hasUnverifiedFacts(exp)).toBe(true);
  });

  it("a fully tagged file has nothing to report and is unchanged by the rule", () => {
    const clean = parseExperience("01-acme-pm.md", RAW.replace("- Grew revenue 300%. [?]\n", "").replace(/## Raw material[\s\S]*$/, ""));
    expect(untaggedFacts(clean.body)).toEqual([]);
    expect(stripUnverified(clean).body).toBe(clean.body);
  });

  it("a [?] on a wrapped line removes the whole bullet", () => {
    const e = parseExperience("x.md", "---\nid: x\ncompany: C\ntitle: T\nstart: '2020'\nend: '2021'\n---\n\n## Achievements\n- Grew revenue 300%\n  in one year. [?]\n- Kept. [R]\n");
    const body = stripUnverified(e).body;
    expect(body).not.toContain("300%");
    expect(body).toContain("Kept.");
  });
});

describe("insertUnderSection tags every fact of a confirmed block", () => {
  it("one [C] per line, so no confirmed line is left untagged", () => {
    const body = insertUnderSection("## Achievements\n- Old fact. [R]\n", "Achievements", "- Ran the pilot in 3 cities.\n- Signed 20+ partners.");
    expect(body).toContain("- Ran the pilot in 3 cities. [C]");
    expect(body).toContain("- Signed 20+ partners. [C]");
    expect(untaggedFacts(body)).toEqual([]);
  });

  it("keeps a tag that is already there and tags a single line as before", () => {
    expect(insertUnderSection("", "Context", "Reported to the COO.")).toContain("Reported to the COO. [C]");
    expect(insertUnderSection("", "Context", "Unsure about the date. [?]")).not.toContain("[C]");
  });
});
