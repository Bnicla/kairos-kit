import { describe, expect, it } from "vitest";
import { planCleanup } from "@kairos/engine/board-cleanup";
import type { ApplicationMeta } from "@kairos/engine/applications";

const now = new Date("2026-10-25T12:00:00Z");
const m = (o: Partial<ApplicationMeta>): ApplicationMeta =>
  ({ id: o.id ?? "x", company: "Co", role: "PM", status: "applied", captured_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...o }) as ApplicationMeta;

describe("planCleanup", () => {
  it("archives Closed cards idle a week, keeps fresh ones", () => {
    const plan = planCleanup(
      [m({ id: "old", status: "rejected", updated_at: "2026-10-10T00:00:00Z" }), m({ id: "new", status: "rejected", updated_at: "2026-10-24T00:00:00Z" })],
      [], new Set(), now);
    expect(plan.archive.map((a) => a.id)).toEqual(["old"]);
  });

  it("never changes open cards; reports stale drafts and quiet interviews instead", () => {
    const plan = planCleanup(
      [m({ id: "draft", status: "scored", captured_at: "2026-10-01T00:00:00Z" }), m({ id: "itv", status: "interviewing", updated_at: "2026-10-05T00:00:00Z" })],
      [], new Set(), now);
    expect(plan.archive).toEqual([]);
    expect(plan.decide.staleDrafts.map((d) => d.id)).toEqual(["draft"]);
    expect(plan.decide.quietInterviewing.map((d) => d.id)).toEqual(["itv"]);
  });

  it("dismisses Sourced cards that are stale or already on the board, skipping ones already dismissed", () => {
    const plan = planCleanup(
      [m({ company: "Acme", role: "Staff PM", status: "applied", updated_at: "2026-10-24T00:00:00Z" })],
      [
        { url: "https://a/1", company: "Acme", title: "Staff PM", age_days: 2 },
        { url: "https://b/2", company: "Beta", title: "GPM", age_days: 20 },
        { url: "https://c/3", company: "Gamma", title: "PM", age_days: 3 },
        { url: "https://d/4", company: "Delta", title: "PM", age_days: 30 },
      ],
      new Set(["https://d/4"]), now);
    expect(plan.dismissSourced.map((s) => [s.company, s.why])).toEqual([["Acme", "already on the board"], ["Beta", "stale"]]);
  });
});
