import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJobAd } from "@kairos/engine/ingest";

/**
 * BambooHR careers pages are a JS shell: the HTML carries only "BambooHR", so
 * two postings had to be pasted as PDFs (2026-10-08, and again
 * 2026-10-13). The page's own /careers/{id}/detail JSON has the full posting.
 */
const DETAIL = {
  result: {
    jobOpening: {
      jobOpeningName: "Head of Product",
      departmentLabel: "Platform",
      locationType: "2",
      location: { city: null, state: null, addressCountry: null },
      atsLocation: { city: "Madrid", state: null, country: "Spain" },
      compensation: "Madrid: €90,000-€120,000",
      description: "<p>Own Atlas end to end.</p><ul><li>6+ years in Product Management</li></ul>",
    },
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("fetchJobAd: BambooHR", () => {
  it("reads the posting from the /detail JSON instead of the empty HTML shell", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(DETAIL), { status: 200, headers: { "content-type": "application/json" } });
    });
    const ad = await fetchJobAd("https://acmelabs.bamboohr.com/careers/37?source=LinkedIn");
    expect(calls[0]).toBe("https://acmelabs.bamboohr.com/careers/37/detail");
    expect(ad.text).toContain("Head of Product");
    expect(ad.text).toContain("Madrid, Spain");
    expect(ad.text).toContain("€90,000-€120,000");
    expect(ad.text).toContain("6+ years in Product Management");
    expect(ad.text).not.toContain("<li>");
  });

  it("falls through to the normal fetch (and its error) when the detail endpoint has nothing", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).endsWith("/detail")
        ? new Response("{}", { status: 404 })
        : new Response("<html><title>BambooHR</title>BambooHR</html>", { status: 200 }),
    );
    await expect(fetchJobAd("https://acme.bamboohr.com/careers/9")).rejects.toThrow(/no readable text|Paste/i);
  });
});
