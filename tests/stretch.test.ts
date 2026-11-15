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
    executive_summary: "- **Role:** Principal Product Manager at Acme.",
    experience: [{ company: "Acme", title: "Principal Product Manager", dates: "2024 - 2026", bullets }],
    education: [],
    skills: [],
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
    // The line keeps the fact's own words and adds an absolute the fact does not state: saved, and listed for the candidate.
    const r = await saveGeneratedResume(store, appId, resume(["**Verification:** Rewrote the agent's instructions so that a check of every court decision against the citation service was mandatory."]));
    expect(r.stretch.map((f) => f.trigger)).toEqual(["mandatory"]);
    // A line that no fact holds at all is saved too, and returned for the Writer to put right before the draft is shown.
    const none = await saveGeneratedResume(store, appId, resume(["**Verification:** Made citation verification mandatory for the agent."]));
    expect(none.findings.put_right.map((f) => [f.kind, f.line])).toEqual([["line_with_no_origin", "**Verification:** Made citation verification mandatory for the agent."]]);
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

/**
 * Verbs stronger than the person's, from the run on other professions (15 November 2026): each line kept the
 * fact's nouns and numbers, and each was saved without a finding. Invented people and employers.
 */
describe("verbs stronger than the person's own: the four of the run on other professions", () => {
  const kb = (facts: string[], title = "Analyst") => [
    parseExperience("01-acme.md", `---\nid: acme\ncompany: Acme\ntitle: ${title}\nstart: '2020'\nend: '2026'\n---\n\n## Achievements\n${facts.map((f) => `- ${f} [R]`).join("\n")}\n`),
  ];
  const doc = (summary: string, bullets: string[]): GeneratedResume => ({
    resume: { header: { name: "A B", contact: "x" }, executive_summary: summary, experience: [{ company: "Acme", title: "Analyst", dates: "2020 - 2026", bullets }], education: [], skills: [] },
    provenance_audit: [{ claim: "x", source_experience: "01-acme", prov: "R" }],
  });
  const found = (facts: string[], summary: string, bullets: string[], title?: string) => checkResumeStretch(doc(summary, bullets), kb(facts, title)).map((f) => `${f.rule}:${f.trigger} (${f.company})`);

  const assistant = ["Held two office hours a week for a class of 120 students and graded programming assignments in Java.", "Wrote the autograder tests for 3 of the 8 assignments."];
  const engagements = ["Analyst then consultant on 7 engagements: market sizing, customer surveys, cost benchmarking."];
  const committee = ["Member of the site safety committee; the site went 410 days without a lost-time injury in 2023-2024.", "Cut mis-picks from 1.9% to 0.7% of order lines over 18 months."];
  const teacher = ["Wrote the school's weekly family newsletter for four years; it went by email to about 1,400 families.", "Advised the student newspaper: 12 student writers, eight print issues a year and a website.", "Led the English department's move to a shared writing rubric across 6 teachers."];

  it("an assistant who held office hours and graded did not teach the section", () => {
    expect(found(assistant, "**Communication:** Taught a 120-student Data Structures section and wrote the autograder tests for 3 assignments.", [assistant[0]!], "Teaching Assistant, Data Structures")).toEqual(["ownership:taught (Executive summary)"]);
    expect(found(assistant, "Teaching assistant.", ["Taught a class of 120 students and graded programming assignments in Java."])).toEqual(["ownership:taught (Acme)"]);
    // A person whose fact says they taught may say so.
    expect(found(["Taught five classes a year, about 150 students, in literature and composition."], "Teacher.", ["Taught literature and composition to about 150 students in five classes a year."])).toEqual([]);
  });

  it("an analyst on engagements did not run them", () => {
    expect(found(engagements, "Consultant.", ["Ran market sizing, customer surveys and cost benchmarking across 7 engagements."])).toEqual(["drift:ran (Acme)"]);
    expect(checkResumeStretch(doc("Consultant.", ["Ran market sizing, customer surveys and cost benchmarking across 7 engagements."]), kb(engagements))[0]!.detail).toBe(
      'the knowledge base says "analyst then consultant on 7 engagements by market sizing customer surveys cost benchmarking": it names the candidate\'s role on it, the bullet says "ran"',
    );
    // The role kept, or a plain verb of work, is not a claim to have run them; nor is a lead the fact itself states.
    expect(found(engagements, "Consultant.", ["Analyst then consultant on 7 engagements: market sizing, customer surveys, cost benchmarking."])).toEqual([]);
    expect(found(engagements, "Consultant.", ["Worked on market sizing, customer surveys and cost benchmarking across 7 engagements."])).toEqual([]);
    expect(found(["Workstream lead on 5 engagements for retail and consumer goods clients; teams of 2 to 3 consultants."], "Leads workstreams on retail and consumer goods engagements.", ["Led workstreams on 5 engagements for retail and consumer goods clients."])).toEqual([]);
  });

  it("a member of the committee did not keep the site's result: a result the fact gives to something else is not the candidate's doing", () => {
    expect(found(committee, "- **Results:** Cut mis-picks from 1.9% to 0.7% of order lines in 18 months and kept the site at 410 days without a lost-time injury.", [committee[1]!])).toEqual(["drift:kept (Executive summary)"]);
    expect(found(committee, "Supervisor.", ["Kept the site at 410 days without a lost-time injury in 2023-2024."])).toEqual(["drift:kept (Acme)"]);
    expect(found(["Wrote the proposal sections on approach and team for 3 bids; the firm won 2."], "Consultant.", ["Won 2 of 3 bids with the proposal sections on approach and team."])).toEqual(["drift:won (Acme)"]);
    // Said as the fact says it, the result stays the site's, and a passive clause's second verb stays with its subject.
    expect(found(committee, "Supervisor.", ["Serves on the site safety committee; the site went 410 days without a lost-time injury in 2023-2024."])).toEqual([]);
    expect(found(["The app was demonstrated to the class and used by classmates during the final two weeks of term."], "Student.", ["The app was demonstrated to the class and used by classmates during the final two weeks of term."])).toEqual([]);
  });

  it("a lead claimed in the middle of a sentence needs a fact that says the candidate led that", () => {
    expect(found(teacher, "**Audience Writer:** English teacher leading the school's audience-facing writing, from a weekly family newsletter to the student newspaper.", [teacher[0]!])).toEqual(["ownership:leading (Executive summary)"]);
    // The fact says they led it, or ran it.
    expect(found(teacher, "English teacher, leading the English department's move to a shared writing rubric.", [teacher[0]!])).toEqual([]);
    expect(found(["Run second shift at a 220,000 square foot distribution center: 34 associates and 3 team leads."], "Supervisor, now running a second shift of 34 associates and 3 team leads.", ["Run second shift at a 220,000 square foot distribution center."])).toEqual([]);
  });
});
