import { describe, expect, it } from "vitest";
import { buildScoringUserMessage, profileFactsFrom } from "@kairos/engine/prompts/scoring";

/**
 * The scorer must see candidate-stated profile facts. Without them it calls a
 * native language or a citizenship stated in profile.md unconfirmed.
 */
describe("scoring payload: profile facts", () => {
  const fm = {
    preferences: { location: "Greater Denver (CO)", work_authorization: "U.S. and Canadian dual citizen" },
    languages: ["Portuguese (native)", "English (near-native)"],
  };

  it("extracts languages, work authorization and location from profile frontmatter", () => {
    expect(profileFactsFrom(fm)).toEqual({
      languages: ["Portuguese (native)", "English (near-native)"],
      work_authorization: "U.S. and Canadian dual citizen",
      location: "Greater Denver (CO)",
    });
    expect(profileFactsFrom({})).toBeNull();
    expect(profileFactsFrom(null)).toBeNull();
  });

  it("puts them in the candidate section of the scoring message", () => {
    const msg = buildScoringUserMessage({
      jobText: "Head of Product, Lisbon. Portuguese a strong plus.",
      detectedAts: "unknown",
      experiences: [],
      educationRaw: [],
      voiceProfile: null,
      recruiterFeedback: null,
      mode: "audit",
      profileFacts: profileFactsFrom(fm),
    });
    expect(msg).toContain('"profile_facts"');
    expect(msg).toContain("Portuguese (native)");
    expect(msg).toContain("U.S. and Canadian dual citizen");
  });
});
