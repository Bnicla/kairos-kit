import { describe, expect, it } from "vitest";
import { makeClipper } from "@kairos/engine/context-budget";

describe("makeClipper (named context budgets)", () => {
  it("passes text under budget through untouched and records it", () => {
    const c = makeClipper({ snapshot: 100 });
    expect(c.clip("snapshot", "short text")).toBe("short text");
    expect(c.reports).toEqual([
      { label: "snapshot", budget: 100, original: 10, kept: 10, clipped: false },
    ]);
    expect(c.summary()).toBeNull();
  });

  it("clips over-budget text with a visible truncation marker", () => {
    const c = makeClipper({ snapshot: 50 });
    const out = c.clip("snapshot", "x".repeat(200));
    expect(out).toContain("truncated: 150 of 200 characters omitted");
    expect(out).toContain("snapshot context budget");
    expect(c.reports[0]).toMatchObject({ clipped: true, kept: 50, original: 200 });
  });

  it("prefers a line boundary near the budget over a mid-line cut", () => {
    const c = makeClipper({ kb: 100 });
    const text = `${"a".repeat(90)}\n${"b".repeat(90)}`;
    const out = c.clip("kb", text);
    // Cut lands on the newline at index 90 (≥ 75% of budget), not mid-b-run.
    expect(out.startsWith("a".repeat(90))).toBe(true);
    expect(out).not.toContain("ab");
    expect(c.reports[0].kept).toBe(90);
  });

  it("falls back to a hard cut when the last newline is too early", () => {
    const c = makeClipper({ kb: 100 });
    const text = `${"a".repeat(10)}\n${"b".repeat(300)}`;
    const out = c.clip("kb", text);
    expect(c.reports[0].kept).toBe(100);
    expect(out).toContain("truncated");
  });

  it("summary lists only clipped sections", () => {
    const c = makeClipper({ a: 5, b: 100 });
    c.clip("a", "0123456789");
    c.clip("b", "fine");
    expect(c.summary()).toBe("a 5/10");
  });

  it("throws on an unknown budget label (catches wiring typos)", () => {
    const c = makeClipper({ a: 5 });
    expect(() => c.clip("typo", "text")).toThrow(/No context budget named "typo"/);
  });
});
