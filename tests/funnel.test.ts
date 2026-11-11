import { describe, expect, it } from "vitest";
import { buildFunnel } from "@kairos/engine/funnel";
import type { ApplicationMeta } from "@kairos/engine/applications";

const NOW = new Date("2026-10-11T12:00:00Z");
const app = (over: Partial<ApplicationMeta>): ApplicationMeta =>
  ({
    id: Math.random().toString(36).slice(2),
    company: "Co",
    role: "PM",
    status: "applied",
    captured_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    applied_at: "2026-08-02T00:00:00Z",
    ...over,
  }) as ApplicationMeta;
const interviewing = [{ status: "interviewing" as const, at: "2026-09-01T00:00:00Z" }];

describe("buildFunnel", () => {
  const funnel = buildFunnel(
    [
      app({ status: "scored", applied_at: undefined }), // never submitted: excluded
      app({ status: "rejected" }),
      app({ status: "applied" }), // 70 days silent
      app({ status: "applied", applied_at: "2026-10-01T00:00:00Z" }), // 10 days
      app({ status: "expired" }),
      // Old card: an "applied" history entry with no timestamp still counts.
      app({ status: "rejected", applied_at: undefined, status_history: [{ status: "applied" } as never] }),
      app({ company: "Brightpath", status: "rejected", status_history: interviewing }), // round 1 by default
      app({ company: "Cobalt", status: "rejected", status_history: interviewing, interview_round: 2 }),
      app({ company: "Harbor", status: "rejected", status_history: interviewing, interview_round: 3 }),
      app({ company: "Northwind", status: "interviewing", status_history: interviewing }),
      // Came in through a referral: interviewed without ever being marked applied.
      app({ company: "Pulsewear", status: "rejected", applied_at: undefined, status_history: interviewing, interview_round: 2 }),
      app({ company: "Ledgerline", status: "on_hold", status_history: interviewing, interview_round: 2 }),
    ],
    NOW,
  );
  const value = (id: string) => funnel.nodes.find((n) => n.id === id)?.value ?? 0;
  const link = (s: string, t: string) => funnel.links.find((l) => l.source === s && l.target === t)?.value ?? 0;

  it("counts only submitted applications and splits the silent ones at 30 days", () => {
    expect(funnel.total).toBe(11);
    expect(value("rejected")).toBe(2);
    expect(value("no-response")).toBe(1);
    expect(value("waiting")).toBe(1);
    expect(value("closed")).toBe(1);
  });

  it("walks each interviewed application through every round it reached", () => {
    expect(funnel.interviewed).toBe(6);
    expect(value("interview-1")).toBe(6);
    expect(value("interview-2")).toBe(4);
    expect(value("interview-3")).toBe(1);
    expect(link("interview-1", "no-offer")).toBe(1);
    expect(link("interview-2", "no-offer")).toBe(2);
    expect(link("interview-3", "no-offer")).toBe(1);
    expect(link("interview-2", "on-hold")).toBe(1);
    expect(link("interview-1", "in-progress")).toBe(1);
  });

  it("conserves flow: what enters a node leaves it", () => {
    for (const n of funnel.nodes.filter((x) => x.kind === "interview" || x.kind === "applications")) {
      const out = funnel.links.filter((l) => l.source === n.id).reduce((a, l) => a + l.value, 0);
      expect(out).toBe(n.value);
    }
  });

  it("names the companies behind interview outcomes", () => {
    expect(funnel.nodes.find((n) => n.id === "no-offer")?.companies?.sort()).toEqual(["Brightpath", "Cobalt", "Harbor", "Pulsewear"]);
  });
});

describe("buildDaily", () => {
  it("counts submissions per local day from the first one to now, keeping empty days", async () => {
    const { buildDaily } = await import("@kairos/engine/funnel");
    const days = buildDaily(
      [
        app({ company: "A", applied_at: new Date(2026, 9, 1, 10).toISOString() }),
        app({ company: "B", applied_at: new Date(2026, 9, 1, 18).toISOString() }),
        app({ company: "C", applied_at: new Date(2026, 9, 3, 9).toISOString() }),
        app({ company: "D", status: "scored", applied_at: undefined }), // never submitted
      ],
      new Date(2026, 9, 4, 12),
    );
    expect(days.map((d) => [d.date, d.count])).toEqual([
      ["2026-10-01", 2],
      ["2026-10-02", 0],
      ["2026-10-03", 1],
      ["2026-10-04", 0],
    ]);
    expect(days[0].companies).toEqual(["A", "B"]);
  });
});
