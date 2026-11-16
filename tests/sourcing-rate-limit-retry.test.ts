import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBoards } from "@kairos/engine/sourcing/sweep";

/**
 * 2026-11-16: a Monday run had 3,146 Workday boards throttled at full width. A board that
 * stays throttled after the per-request retry gets one slower second pass after the first
 * pass, and is counted rate-limited only if that fails too (or runs out of budget).
 */
describe("fetchBoards second pass on rate-limited boards", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (throttledCalls: number) => {
    const calls = new Map<string, number>();
    vi.stubGlobal("fetch", async (url: string) => {
      const n = (calls.get(url) ?? 0) + 1;
      calls.set(url, n);
      if (n <= throttledCalls) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
  };
  const boards = [{ ats: "greenhouse" as const, slug: "acme" }];

  it("recovers a board throttled in the first pass", async () => {
    stubFetch(2); // both tries of the first pass answer 429
    const { stats } = await fetchBoards({ boards, rateLimitRetryPauseMs: 1 });
    expect(stats.rate_limited).toBe(0);
    expect(stats.boards_ok).toBe(1);
  });

  it("counts it rate-limited when the second pass is skipped", async () => {
    stubFetch(2);
    const outcomes: string[] = [];
    const { stats } = await fetchBoards({ boards, rateLimitRetryPauseMs: 0, onBoard: (_e, o) => outcomes.push(o) });
    expect(stats.rate_limited).toBe(1);
    expect(outcomes).toEqual(["rate_limited"]);
  });

  it("leaves boards the second pass has no time for counted as rate-limited", async () => {
    stubFetch(2);
    const outcomes: string[] = [];
    const { stats } = await fetchBoards({ boards, rateLimitRetryPauseMs: 1, rateLimitRetryBudgetMs: 0, onBoard: (_e, o) => outcomes.push(o) });
    expect(stats.rate_limited).toBe(1);
    expect(outcomes).toEqual(["rate_limited"]);
  });
});
