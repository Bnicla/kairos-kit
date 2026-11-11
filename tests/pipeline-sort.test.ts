import { describe, it, expect } from "vitest";
import { groupByStage } from "@kairos/engine/pipeline";
import type { IndexEntry } from "@kairos/engine/applications";

const entry = (over: Partial<IndexEntry>): IndexEntry => ({
  id: over.id ?? "x",
  company: "Co",
  role: "Role",
  status: "applied",
  captured_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
  ...over,
});

describe("board card sorting", () => {
  it("sorts newest card-date first, band-breaking same-day ties", () => {
    const apps: IndexEntry[] = [
      entry({ id: "old-strong", applied_at: "2026-07-10T09:00:00.000Z", score_band: "STRONG" }),
      entry({ id: "new-weak", applied_at: "2026-07-20T09:00:00.000Z", score_band: "WEAK" }),
      entry({ id: "new-strong", applied_at: "2026-07-20T18:00:00.000Z", score_band: "STRONG" }),
      entry({ id: "new-competitive", applied_at: "2026-07-20T01:00:00.000Z", score_band: "COMPETITIVE" }),
      entry({ id: "new-unscored", applied_at: "2026-07-20T23:00:00.000Z" }),
    ];
    const grouped = groupByStage(apps);
    expect(grouped.applied.map((a) => a.id)).toEqual([
      "new-strong",
      "new-competitive",
      "new-weak",
      "new-unscored",
      "old-strong",
    ]);
  });

  it("uses captured date for draft-stage cards", () => {
    const apps: IndexEntry[] = [
      entry({ id: "d-old", status: "drafted", captured_at: "2026-07-05T00:00:00.000Z", score_band: "WEAK" }),
      entry({ id: "d-new-b", status: "scored", captured_at: "2026-07-22T00:00:00.000Z", score_band: "COMPETITIVE" }),
      entry({ id: "d-new-a", status: "captured", captured_at: "2026-07-22T00:00:00.000Z", score_band: "STRONG" }),
    ];
    const grouped = groupByStage(apps);
    expect(grouped.draft.map((a) => a.id)).toEqual(["d-new-a", "d-new-b", "d-old"]);
  });
});

describe("quiet applied cards", () => {
  it("folds applied cards 21+ days old, keeps recent and non-applied ones", async () => {
    const { splitQuietApplied } = await import("@kairos/engine/pipeline");
    const now = "2026-10-20T12:00:00.000Z";
    const apps: IndexEntry[] = [
      entry({ id: "fresh", applied_at: "2026-10-10T09:00:00.000Z" }),
      entry({ id: "old", applied_at: "2026-09-25T09:00:00.000Z" }),
      entry({ id: "old-no-date", captured_at: "2026-08-01T00:00:00.000Z" }),
      entry({ id: "interviewing-old", status: "interviewing", applied_at: "2026-08-01T00:00:00.000Z" }),
    ];
    const { recent, quiet } = splitQuietApplied(apps, now);
    expect(recent.map((a) => a.id)).toEqual(["fresh", "interviewing-old"]);
    expect(quiet.map((a) => a.id)).toEqual(["old", "old-no-date"]);
  });
});
