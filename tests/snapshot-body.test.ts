import { describe, expect, it } from "vitest";
import { snapshotBody } from "@kairos/engine/tools/ops";
import { checkAtsCoverage } from "@kairos/engine/tools/checks";

// A captured posting as Kairos stores it: its own front matter, then the posting's text. Fictional company.
const SNAPSHOT = `---
captured_at: "2026-11-14"
source: pasted
capture_note: "Full text snapshot preserved so the candidate can review pre-interview even if the posting is removed."
posting_guard:
  verdict: clean
  hidden_elements: 0
  invisible_chars: 0
  smuggled_chars: 0
  hidden_urls: 0
  hidden_instruction_hits: 0
  mixed_script_words: 0
---

Northwind Labs, Junior Frontend Engineer. You will build React dashboards and write tests in Python.
Requirements: React dashboards, tests in Python, SQL basics. Nice to have: SQL reporting.
`;
const RESUME = "Built React dashboards used daily. Wrote tests in Python for the data pipeline.";

describe("the posting's text without Kairos's front matter", () => {
  it("drops the front matter and keeps the posting", () => {
    const body = snapshotBody(SNAPSHOT);
    expect(body.startsWith("Northwind Labs, Junior Frontend Engineer.")).toBe(true);
    expect(body).not.toMatch(/posting_guard|capture_note|hidden_elements/);
    expect(snapshotBody("No front matter here.")).toBe("No front matter here.");
    expect(snapshotBody(null)).toBe("");
  });

  it("the words of the front matter are not counted as terms the résumé is missing", () => {
    const withFrontMatter = checkAtsCoverage(SNAPSHOT, RESUME).missing;
    expect(withFrontMatter).toEqual(expect.arrayContaining(["hidden", "chars"])); // the fault, as seen on the deployed connector
    const missing = checkAtsCoverage(snapshotBody(SNAPSHOT), RESUME).missing;
    expect(missing).not.toEqual(expect.arrayContaining(["hidden"]));
    expect(missing).not.toEqual(expect.arrayContaining(["chars"]));
    expect(missing).not.toEqual(expect.arrayContaining(["posting"]));
    expect(missing).toContain("sql");
  });
});
