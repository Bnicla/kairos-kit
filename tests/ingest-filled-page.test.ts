import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FilledPageError, fetchJobAd } from "@kairos/engine/ingest";

/**
 * A career site's "this job has been filled" page is not a posting. Some sites send it to any
 * program that does not run JavaScript while the posting is open; saved as the ad, it would be
 * scored as the job. The fetch refuses it, and the user pastes the text.
 */
const FILLED = readFileSync(path.join(__dirname, "fixtures", "filled-page.html"), "utf8");
const page = (html: string) => vi.stubGlobal("fetch", async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }));

afterEach(() => vi.unstubAllGlobals());

describe("a 'this job has been filled' page", () => {
  it("is refused and not saved as the job ad", async () => {
    page(FILLED);
    const err = await fetchJobAd("https://careers.example.com/job/12345").catch((e) => e);
    expect(err).toBeInstanceOf(FilledPageError);
    expect(err.code).toBe("filled_page");
    expect(err.message).toContain("open the link in a browser");
  });

  it("is refused whatever the case of the sentence", async () => {
    page(FILLED.replace("The job you are trying to apply for has been filled", "THE JOB YOU ARE TRYING TO APPLY FOR HAS BEEN FILLED"));
    await expect(fetchJobAd("https://careers.example.com/job/12345")).rejects.toBeInstanceOf(FilledPageError);
  });

  it("does not stop an ordinary posting, even one that says an earlier role was filled", async () => {
    const posting = `<html><head><title>Product Manager | Example Corp</title></head><body>
      <h1>Product Manager</h1>
      <p>Example Corp is hiring a Product Manager for its payments team. An earlier opening on this team has been filled; this is a second seat.</p>
      <p>You will own the roadmap for merchant onboarding, work with engineering and design, and report results each quarter.</p>
      <p>Requirements: five years of product work, experience with payments, clear writing.</p>
    </body></html>`;
    page(posting);
    const ad = await fetchJobAd("https://careers.example.com/job/67890");
    expect(ad.text).toContain("merchant onboarding");
  });

  it("is not looked for in text the page hides", async () => {
    const posting = `<html><head><title>Data Analyst | Example Corp</title></head><body>
      <h1>Data Analyst</h1>
      <p style="display:none">The job you are trying to apply for has been filled.</p>
      <p>Example Corp is hiring a Data Analyst for its operations team. You will build the weekly reports, keep the definitions of the numbers, and answer questions from the regional leads.</p>
      <p>Requirements: SQL, a spreadsheet tool, two years of analysis work, clear writing.</p>
    </body></html>`;
    page(posting);
    const ad = await fetchJobAd("https://careers.example.com/job/24680");
    expect(ad.text).toContain("weekly reports");
  });
});
