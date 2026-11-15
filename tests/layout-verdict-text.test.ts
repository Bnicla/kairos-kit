import { describe, expect, it } from "vitest";
import { layoutVerdictText, type LayoutProbe } from "@/lib/layout-probe";

const probe = (over: Partial<LayoutProbe>): LayoutProbe => ({ pages: 2, lastPageFill: 0.9, page2Start: null, verdict: "good", guidance: null, ats: { available: false, reason: "not run" }, ...over });

describe("the layout verdict as a sentence", () => {
  it("gives no fill figure for a one-page résumé, where the last page is the first", () => {
    const text = layoutVerdictText(probe({ pages: 1, lastPageFill: 1 }));
    expect(text).toMatch(/^Layout good \(1 page; how full it is was not measured\)\./);
    expect(text).not.toMatch(/100%/);
  });
  it("gives the last page's fill for two pages", () => {
    expect(layoutVerdictText(probe({}))).toMatch(/^Layout good \(2 pages, last page 90% full\)\./);
  });
});
