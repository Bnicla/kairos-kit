import { describe, expect, it } from "vitest";
import { parseMetricsRegister } from "../apps/local/lib/metrics-register";

const SAMPLE = `# Metrics register
### Canonical accounting of every number. Created 2026-10-01.
### Statuses: DEFENDED · PARTIAL · OPEN · SCOPE · RETIRED.

## Northwind Voice (02-file.md, 2019–2024)

**Review time down 50%** — DEFENDED [C] 2026-09-28
- Is: the validation window per release.
- Baseline → outcome: roughly 10 working days → 5.

**Search accuracy up 30%** — OPEN [R]
- Missing: methodology.

**Scope facts** — SCOPE: 12 markets; 2M users.

## Brightpath (04-file.md, 2014–2018)

**300% throughput** — RETIRED: do not use.

## Operating rules for this register
1. A number ships only at DEFENDED or SCOPE.
2. New numbers are adjudicated first.
`;

describe("parseMetricsRegister", () => {
  const reg = parseMetricsRegister(SAMPLE);

  it("parses sections by experience", () => {
    expect(reg.sections.map((s) => s.section)).toEqual([
      "Northwind Voice (02-file.md, 2019–2024)",
      "Brightpath (04-file.md, 2014–2018)",
    ]);
  });

  it("assigns statuses from the header line and counts them", () => {
    expect(reg.counts).toMatchObject({ DEFENDED: 1, OPEN: 1, SCOPE: 1, RETIRED: 1, PARTIAL: 0 });
    const first = reg.sections[0];
    expect(first.entries[0]).toMatchObject({ name: "Review time down 50%", status: "DEFENDED" });
    expect(first.entries[1].status).toBe("OPEN");
  });

  it("captures detail bullets under the right entry", () => {
    expect(reg.sections[0].entries[0].details).toHaveLength(2);
    expect(reg.sections[0].entries[0].details[1]).toContain("10 working days");
  });

  it("keeps operating rules out of sections and in rules", () => {
    expect(reg.rules).toHaveLength(2);
    expect(reg.rules[0]).toContain("DEFENDED or SCOPE");
  });

  it("extracts the header note", () => {
    expect(reg.headerNote).toContain("Canonical accounting");
  });
});
