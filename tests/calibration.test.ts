import { describe, expect, it } from "vitest";
import {
  computeCalibration,
  toCalibrationInput,
  wilsonInterval,
  type CalibrationInput,
} from "@kairos/engine/calibration";

const app = (over: Partial<CalibrationInput>): CalibrationInput => ({
  band: "STRONG",
  recommendation: "APPLY",
  applied: true,
  interviewed: false,
  closedWithoutInterview: false,
  withdrawn: false,
  ...over,
});

describe("wilsonInterval", () => {
  it("is wide at tiny n and centered sanely", () => {
    const [lo, hi] = wilsonInterval(2, 4);
    expect(lo).toBeGreaterThan(0.1);
    expect(hi).toBeLessThan(0.9);
    expect(hi - lo).toBeGreaterThan(0.4); // honest width at n=4
  });
  it("tightens as n grows", () => {
    const small = wilsonInterval(5, 10);
    const large = wilsonInterval(50, 100);
    expect(large[1] - large[0]).toBeLessThan(small[1] - small[0]);
  });
  it("handles 0/0 and boundary counts", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
    const [lo] = wilsonInterval(0, 5);
    expect(lo).toBe(0);
    const [, hi] = wilsonInterval(5, 5);
    expect(hi).toBe(1);
  });
});

describe("computeCalibration", () => {
  it("computes decided and conservative rates per band, censoring pending", () => {
    const r = computeCalibration([
      app({ interviewed: true }),
      app({ interviewed: true }),
      app({ closedWithoutInterview: true }),
      app({}), // pending
      app({ band: "COMPETITIVE", closedWithoutInterview: true }),
      app({ band: "COMPETITIVE", closedWithoutInterview: true }),
    ]);
    const strong = r.byBand.find((b) => b.band === "STRONG")!;
    expect(strong.applied).toBe(4);
    expect(strong.decidedRate).toBeCloseTo(2 / 3);
    expect(strong.pending).toBe(1);
    expect(strong.conservativeRate).toBeCloseTo(2 / 4);
    const comp = r.byBand.find((b) => b.band === "COMPETITIVE")!;
    expect(comp.decidedRate).toBe(0);
    expect(r.monotone).toBe(true);
    expect(r.caveats.some((c) => c.includes("pending"))).toBe(true);
  });

  it("flags a calibration inversion (worse band converting better)", () => {
    const r = computeCalibration([
      app({ closedWithoutInterview: true }),
      app({ band: "COMPETITIVE", interviewed: true }),
    ]);
    expect(r.monotone).toBe(false);
  });

  it("censors withdrawn applications from every rate", () => {
    const r = computeCalibration([
      app({ withdrawn: true, interviewed: false }),
      app({ interviewed: true }),
    ]);
    const strong = r.byBand.find((b) => b.band === "STRONG")!;
    expect(strong.applied).toBe(2);
    expect(strong.decidedRate).toBe(1);
    expect(strong.conservativeRate).toBe(1);
    expect(r.totalWithdrawn).toBe(1);
  });

  it("excludes never-applied and reports unscored applications", () => {
    const r = computeCalibration([
      app({ applied: false }),
      app({ band: undefined, interviewed: true }),
      app({ interviewed: true }),
    ]);
    expect(r.totalApplied).toBe(2);
    expect(r.byBand).toHaveLength(1);
    expect(r.caveats.some((c) => c.includes("never scored"))).toBe(true);
  });
});

describe("toCalibrationInput", () => {
  it("derives labels from status history facts", () => {
    const c = toCalibrationInput({
      score_band: "STRONG",
      recommendation: "APPLY",
      status: "rejected",
      applied_at: "2026-08-01T00:00:00Z",
      status_history: [{ status: "applied" }, { status: "interviewing" }, { status: "rejected" }],
    });
    // Rejected AFTER interviewing still counts as an interview reached — the
    // scorer's claim ends at the first screen.
    expect(c.interviewed).toBe(true);
    expect(c.closedWithoutInterview).toBe(false);
  });

  it("treats rejection with no interview history as a decided failure", () => {
    const c = toCalibrationInput({
      score_band: "STRONG",
      status: "rejected",
      status_history: [{ status: "applied" }, { status: "rejected" }],
    });
    expect(c.applied).toBe(true);
    expect(c.interviewed).toBe(false);
    expect(c.closedWithoutInterview).toBe(true);
  });

  it("treats an expired listing after applying as decided, and withdrawn as censored", () => {
    expect(
      toCalibrationInput({ status: "expired", status_history: [{ status: "applied" }] }).closedWithoutInterview,
    ).toBe(true);
    expect(toCalibrationInput({ status: "withdrawn", status_history: [{ status: "applied" }] }).withdrawn).toBe(true);
  });
});
