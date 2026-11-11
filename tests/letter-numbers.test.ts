import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseExperience } from "../packages/engine/kb/experience";
import { ungroundedNumbers } from "../packages/engine/tools/checks";

describe("cover letters: every number comes from a source", () => {
  const exp = parseExperience("01-fintech-intern.md", readFileSync("tests/fixtures/student-kb/01-fintech-intern.md", "utf8"));

  it("accepts a number on record and one from the posting", () => {
    expect(ungroundedNumbers("I shipped a feature used by 40 internal users, and your team of 12 would gain from it.", [exp], "We are a team of 12.")).toEqual([]);
  });

  it("names a number found nowhere", () => {
    expect(ungroundedNumbers("I grew revenue by 35% in one quarter.", [exp], "")).toEqual(["35%"]);
  });

  it("an unverified fact does not count as a source", () => {
    const withUnverified = parseExperience("x.md", readFileSync("tests/fixtures/student-kb/01-fintech-intern.md", "utf8") + "\n- Cut costs by 18%. [?]\n");
    expect(ungroundedNumbers("I cut costs by 18%.", [withUnverified], "")).toEqual(["18%"]);
  });
});
