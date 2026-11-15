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
    // The only verified line that states a three is "over three years": the
    // number rule (2026-11-13) lists "three firms" as attached to another result.
    expect(run("**Pilot:** Owned the pilot program with three firms.").map((x) => [x.rule, x.trigger])).toEqual([
      ["ownership", "owned"],
      ["number", "three firms"],
    ]);
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

/**
 * Verb swaps (15 November 2026, from the outside audit of 14 November): the knowledge base says the candidate took
 * part, or shared the work, and the résumé line says they led it, owned it or made it. Every noun and every number
 * of the fact is kept, so the line's origin is strong and the numbers are grounded: only this check can see it.
 * Invented facts.
 */
describe("verb swaps: the fact's nouns and numbers kept, the candidate's part made bigger", () => {
  const kb = (fact: string) => [
    parseExperience(
      "01-acme.md",
      `---\nid: acme-pm\ncompany: Acme\ntitle: Product Manager\nstart: '2024'\nend: '2026'\n---\n\n## Achievements\n- ${fact} [R]\n`,
    ),
  ];
  const check = (fact: string, bullet: string) => checkResumeStretch(resume([bullet]), kb(fact));

  const swaps: [string, string, string][] = [
    // The four the audit names.
    ["supported to led", "Supported the launch of the billing portal in 12 markets.", "Led the launch of the billing portal in 12 markets."],
    ["helped to owned", "Helped the pricing team with the release metrics for 12 markets.", "Owned the release metrics for 12 markets."],
    ["contributed to created", "Contributed to the onboarding guide for new enterprise customers.", "Created the onboarding guide for new enterprise customers."],
    ["one of a team to sole owner", "One of a team of five that ran the migration of the billing database.", "Sole owner of the migration of the billing database."],
    // The audit's own example sentence.
    ["took part to led and owned", "Took part in launch planning and monitored release metrics for 12 markets.", "Led launch planning and owned release metrics across 12 markets."],
    // The same kind, other words.
    ["assisted to managed", "Assisted the finance lead with the quarterly forecast for three regions.", "Managed the quarterly forecast for three regions."],
    ["helped build to built", "Helped build the reporting dashboard used by 40 account managers.", "Built the reporting dashboard used by 40 account managers."],
    ["contributed to the design to designed", "Contributed to the design of the partner API for 9 integrations.", "Designed the partner API for 9 integrations."],
    ["participated to ran", "Participated in the weekly incident review for the payments service.", "Ran the weekly incident review for the payments service."],
    ["member of the team that delivered to delivered", "Member of the team that delivered the checkout redesign for mobile users.", "Delivered the checkout redesign for mobile users."],
    ["supported to drove", "Supported the rollout of single sign-on to 30 customer teams.", "Drove the rollout of single sign-on to 30 customer teams."],
    ["helped to spearheaded", "Helped the sales team with the renewal playbook for mid-market accounts.", "Spearheaded the renewal playbook for mid-market accounts."],
    ["one of three who wrote to wrote", "One of three engineers who wrote the fraud rules for card payments.", "Wrote the fraud rules for card payments."],
    ["one of a team that ran to ran", "One of a team of five that ran the migration of the billing database.", "Ran the migration of the billing database."],
    ["one of a team to owner of", "One of a team of five that ran the migration of the billing database.", "Owner of the migration of the billing database."],
    ["one of a team to single-handedly", "One of a team of five that ran the migration of the billing database.", "Single-handedly ran the migration of the billing database."],
    // Shared work, then alone.
    ["worked with to led", "Worked with the data team on the churn model for 200 enterprise accounts.", "Led the churn model for 200 enterprise accounts."],
    ["partnered to owned", "Partnered with the legal team on the data retention policy for EU customers.", "Owned the data retention policy for EU customers."],
    ["co-led to led", "Co-led the vendor selection for the support platform with the operations lead.", "Led the vendor selection for the support platform."],
    ["co-wrote to wrote", "Co-wrote the incident runbook for the payments service with two engineers.", "Wrote the incident runbook for the payments service."],
    // "support" as a thing (a team's name) does not keep the candidate's part in view.
    ["helped the support team to led", "Helped the customer support team with ticket triage for enterprise accounts.", "Led ticket triage for enterprise accounts on the customer support team."],
  ];

  it.each(swaps)("%s is listed", (_name, fact, bullet) => {
    const found = check(fact, bullet);
    expect(found.length, bullet).toBeGreaterThan(0);
    expect(found.every((f) => f.kind === "stretch" && f.company === "Acme" && f.bullet === bullet)).toBe(true);
    // The finding quotes what the knowledge base says, or names the absolute word.
    expect(found.some((f) => (f.rule === "drift" && /the knowledge base says "/.test(f.detail)) || f.rule === "absolute" || f.rule === "ownership")).toBe(true);
  });

  it("the audit's four each give the finding that names the swap", () => {
    const rules = (i: number) => check(swaps[i][1], swaps[i][2]).map((f) => `${f.rule}:${f.trigger}`);
    expect(rules(0)).toEqual(["drift:led"]);
    expect(rules(1)).toEqual(["drift:owned"]);
    expect(rules(2)).toEqual(["drift:created"]);
    expect(rules(3)).toContain("absolute:sole");
    expect(rules(3)).toContain("drift:owner");
    expect(check(swaps[0][1], swaps[0][2])[0].detail).toBe('the knowledge base says "supported the launch of the billing portal in 12 markets": the candidate took part, the bullet says "led"');
    expect(check(swaps[18][1], swaps[18][2])[0].detail).toMatch(/the work was shared, the bullet says "led" alone$/);
  });

  const faithful: [string, string, string][] = [
    ["the fact restated", "Led the launch of the billing portal in 12 markets.", "Led the launch of the billing portal in 12 markets."],
    ["the candidate's part kept", "Supported the launch of the billing portal in 12 markets.", "Supported the launch of the billing portal in 12 markets."],
    ["the candidate's own action, which the fact states after \"by\"", "Supported the launch of the billing portal by writing the test plan for 12 markets.", "Wrote the test plan for the launch of the billing portal in 12 markets."],
    ["one delivery verb for another", "Built the reporting dashboard used by 40 account managers.", "Created the reporting dashboard used by 40 account managers."],
    ["the others kept in view", "Worked with the data team on the churn model for 200 enterprise accounts.", "Built the churn model for 200 enterprise accounts with the data team."],
    ["the shared lead kept", "Co-led the vendor selection for the support platform with the operations lead.", "Co-led the vendor selection for the support platform."],
    ["one of several kept", "One of three engineers who wrote the fraud rules for card payments.", "One of three engineers who wrote the fraud rules for card payments."],
    ["support given, said as a noun", "Supported the launch of the billing portal in 12 markets.", "Provided launch support for the billing portal in 12 markets."],
  ];
  it.each(faithful)("%s is not listed", (_name, fact, bullet) => {
    expect(check(fact, bullet)).toEqual([]);
  });

  it("a second fact that says the candidate did lead it supports the line", () => {
    const both = [
      parseExperience(
        "01-acme.md",
        `---\nid: acme-pm\ncompany: Acme\ntitle: Product Manager\nstart: '2024'\nend: '2026'\n---\n\n## Achievements\n- Supported the launch of the billing portal in 12 markets. [R]\n- Led the launch of the billing portal in the last 4 markets. [C]\n`,
      ),
    ];
    expect(checkResumeStretch(resume(["Led the launch of the billing portal in 12 markets."]), both).filter((f) => f.rule === "drift")).toEqual([]);
  });

  it("known limit, stated: work done with others and written as a plain delivery verb is not listed", () => {
    // "Worked with the data team on the churn model" does not say who built it; "Built the churn model" drops the team
    // and claims no lead. The check lists a lead claim ("led", "owned") here, not a delivery verb.
    expect(check("Worked with the data team on the churn model for 200 enterprise accounts.", "Built the churn model for 200 enterprise accounts.")).toEqual([]);
  });
});
