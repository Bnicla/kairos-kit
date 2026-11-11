import { describe, expect, it } from "vitest";
import { parseExperience, serializeExperience, stripUnverified } from "@kairos/engine/kb/experience";

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
