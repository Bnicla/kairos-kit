import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "@/store/local-fs";
import { createApplication } from "@kairos/engine/applications";
import { saveGeneratedResume } from "@kairos/engine/tools/ops";
import { parseExperience } from "@kairos/engine/kb/experience";
import { checkResumeStretch, deniedPhrases } from "@kairos/engine/stretch";
import type { GeneratedResume } from "@kairos/engine/types";

/**
 * Stretch check (2026-11-03): ownership verbs and absolutes on a résumé must be
 * supported by a verified fact of that employer; KB "never claim" phrasings block.
 * Fixtures mirror the three 11/02 slips grounding could not see.
 */

const KB_FILE = `---
id: acme-pm
company: Acme
title: Principal Product Manager
start: '2024'
end: '2026'
---

## Achievements
- Led the build of the document platform with Northwind's engineers on Nimbus AI. [R]
- Owned the launch gates: ingestion success and retrieval accuracy before release. [R]
- Rewrote the agent's instructions so it checked every court decision against the citation service. [C]
- Reduced churn from 20% to 0% over three years. [R]
- Chose the cheaper embedding model after a two-week bake-off. [C]

CORRECTION (2026-11-02): the decision to build on Nimbus predates him. Do not present it as his ("chose to build on Nimbus", "drove build-versus-buy"). [C]
User scale (2026-10-13): the exact number is confidential; never state a figure beyond "tens of millions". [C]
Release gate: never claim "or it did not ship" as an absolute; the honest form is "or it needed a documented exception". [C]
- Ran the pilot program with three firms. [?]
`;

const exps = [parseExperience("01-acme.md", KB_FILE)];

const resume = (bullets: string[]): GeneratedResume => ({
  resume: {
    header: { name: "Alex Sample", contact: "Chicago" },
    executive_summary: "- **Product leader:** ships platforms with measured outcomes.",
    experience: [{ company: "Acme", title: "Principal Product Manager", dates: "2024 - 2026", bullets }],
    education: [{ institution: "Westbrook", credential: "MBA" }],
    skills: ["Evals"],
  },
  provenance_audit: [{ claim: "platform", source_experience: "01-acme", prov: "R" }],
});

const run = (...bullets: string[]) => checkResumeStretch(resume(bullets), exps);

describe("deniedPhrases", () => {
  it("keeps a denial written on a fact line that has no tag", () => {
    const untagged = parseExperience(
      "globex-eng.md",
      `---
id: globex-eng
company: Globex
title: Software Engineer
start: '2023'
end: '2025'
---

## Achievements
- Built the billing service with two other engineers. [R]
- Never say "sole author of the billing service": it was a team of three.
`,
    );
    expect(deniedPhrases([untagged])).toContain("sole author of the billing service");
  });

  it("collects quoted phrases after do not / never, in the same sentence only", () => {
    expect(deniedPhrases(exps)).toEqual(["chose to build on nimbus", "drove build vs buy", "or it did not ship"]);
  });

  it("does not deny a phrase the sentence permits ('never ... beyond \"X\"')", () => {
    expect(deniedPhrases(exps)).not.toContain("tens of millions");
  });
});

describe("checkResumeStretch", () => {
  it("passes bullets that keep the KB's verb and scope", () => {
    expect(
      run(
        "**Document Platform:** Led the build of the document platform with Northwind's engineers on Nimbus AI.",
        "**Launch Gates:** Set the launch gates before release: ingestion success and retrieval accuracy.",
        "**Retention:** Drove churn from 20% to 0% over three years.",
        "**Embeddings:** Chose the cheaper embedding model after a bake-off.",
      ),
    ).toEqual([]);
  });

  it("checks the executive summary for forbidden phrasings", () => {
    const g = resume(["**Platform:** Led the build of the document platform with Northwind's engineers on Nimbus AI."]);
    g.resume.executive_summary = "- **Leader:** Drove build-versus-buy for the platform.\n- **Scale:** Tens of millions of users.";
    expect(checkResumeStretch(g, exps).map((f) => [f.company, f.trigger])).toEqual([["Executive summary", "drove build vs buy"]]);
  });

  it("flags a KB-forbidden phrasing as denied, across hyphen and 'versus' variants", () => {
    const f = run("**Foundation:** Drove build-versus-buy for the platform on explicit evidence terms.");
    expect(f.map((x) => [x.kind, x.trigger])).toEqual([["denied", "drove build vs buy"]]);
    expect(run("**Foundation:** Chose to build on Nimbus for speed.")[0]?.kind).toBe("denied");
  });

  it("flags a responsibility verb upgraded to a decision verb", () => {
    const f = run("**Platform:** Chose Northwind's engineers and Nimbus AI for the document platform.");
    expect(f.map((x) => [x.kind, x.trigger])).toEqual([["stretch", "chose"]]);
  });

  it("flags drove/established when the object is a decision", () => {
    const f = run("**Foundation:** Drove the platform foundation decision on explicit evidence terms.");
    expect(f.map((x) => x.trigger)).toEqual(["drove"]);
    expect(f[0]?.detail).toMatch(/made this call/);
    const culture = run("**Culture:** Established a metrics-based decision culture for the launch gates.");
    expect(culture.map((x) => x.detail).join(" ")).not.toMatch(/made this call/);
  });

  it("flags an absolute the KB does not state, and accepts a synonym it does", () => {
    const f = run("**Verification:** Made citation verification mandatory for the agent's instructions.");
    expect(f.map((x) => x.trigger)).toEqual(["mandatory"]);
    expect(run("**Verification:** Rewrote the agent's instructions so every court decision was checked against the citation service.")).toEqual([]);
  });

  it("only counts 'first' as 'the first ...'", () => {
    expect(run("**Platform:** Led the build of the first document platform on Nimbus AI.").map((x) => x.trigger)).toEqual(["the first"]);
    expect(run("**Platform:** Led the build of the voice-first document platform with Northwind's engineers on Nimbus AI.")).toEqual([]);
  });

  it("ignores verbs whose subject is not the candidate", () => {
    expect(run("**Adoption:** Led the build of the document platform, which 90% of firms chose over the old one.")).toEqual([]);
  });

  it("never lets an unverified [?] fact or a correction line support a claim", () => {
    expect(run("**Pilot:** Owned the pilot program with three firms.").map((x) => x.trigger)).toEqual(["owned"]);
  });

  it("accepts the candidate's own curated writing as support", () => {
    const b = "**Pilot:** Owned the pilot program with three firms.";
    expect(checkResumeStretch(resume([b]), exps, "Owned the pilot program with three law firms.")).toEqual([]);
  });

  it("reads 'made before <first name> joined' as a guard when the profile gives the name", () => {
    const b = "**Pilot:** Owned the pilot program with three firms.";
    const extra = "Owned the pilot program with three law firms, made before Alex joined.";
    expect(checkResumeStretch(resume([b]), exps, extra)).toEqual([]);
    expect(checkResumeStretch(resume([b]), exps, extra, { candidateName: "Alex Sample" }).map((x) => x.trigger)).toEqual(["owned"]);
    expect(checkResumeStretch(resume([b]), exps, "Owned the pilot program with three law firms, made before she joined.").map((x) => x.trigger)).toEqual(["owned"]);
  });
});

describe("saveGeneratedResume + stretch", () => {
  let store: LocalStore;
  let appId: string;
  beforeAll(async () => {
    store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-stretch-")));
    await store.writeFile(["knowledge-base", "experiences", "01-acme.md"], KB_FILE);
    appId = (
      await createApplication(store, {
        company: "Beta",
        role: "PM",
        snapshotMarkdown: "# PM\nProduct manager for platforms.",
        source_url_unavailable: true,
      })
    ).id;
  });
  afterAll(() => undefined);

  it("rejects a KB-forbidden phrasing", async () => {
    await expect(
      saveGeneratedResume(store, appId, resume(["**Foundation:** Drove build-versus-buy for the platform."])),
    ).rejects.toThrow(/forbids/);
  });

  it("saves and returns stretch findings for the candidate to decide", async () => {
    const r = await saveGeneratedResume(store, appId, resume(["**Verification:** Made citation verification mandatory for the agent."]));
    expect(r.stretch.map((f) => f.trigger)).toEqual(["mandatory"]);
  });
});
