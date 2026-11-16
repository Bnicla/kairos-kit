import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "@/store/local-fs";
import { createApplication } from "@kairos/engine/applications";
import { parseExperience } from "@kairos/engine/kb/experience";
import { GENERATION_SYSTEM_PROMPT, buildGenerationUserMessage } from "@kairos/engine/prompts/generation";
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionUserMessage } from "@kairos/engine/prompts/extraction";
import { SCORING_SYSTEM_PROMPT, profileFactsFrom } from "@kairos/engine/prompts/scoring";
import { generatedResumeToHtml, generatedResumeToMarkdown } from "@kairos/engine/resume-render";
import { DEFAULT_RESUME_HEADINGS, cleanHeading, headingsFor, readProfileSettings, renamedHeadings } from "@kairos/engine/settings";
import { atsExpectFromMarkdown } from "@kairos/engine/ats-text";
import { loadLineOriginView, originGroups } from "@kairos/engine/line-origin-view";
import { ADVISORY_GROUNDING, checkResumeGrounding, checkResumePerson, educationRef, isHardStyleViolation, leadingQuestions, namesEducation, presentInEndedRoles, rowDates, sharesOf, thirdPersonOpenings, titleHeld, unknownAudiences } from "@kairos/engine/tools/checks";
import { checkResumeStretch } from "@kairos/engine/stretch";
import { resumeLengthPolicy } from "@kairos/engine/length-policy";
import { SaveRefused, educationStandsFirst, repeatedIntros, saveGeneratedResume, summaryAsBullets } from "@kairos/engine/tools/ops";
import { checkYears, dateAsYears, entriesNamed, yearClaims, yearsCovered } from "@kairos/engine/tools/years";
import type { GeneratedResume } from "@kairos/engine/types";
import { importItems, partMessage, summaryMessage } from "@/lib/first-import";
import { inSources, phraseInSources, rememberSource } from "@/lib/import-source";

/**
 * What the run on other professions found (15 November 2026: four fictional people of other professions through
 * the first run), one group of tests per finding. Invented people, employers and schools.
 */

const NOW = new Date("2026-11-15T12:00:00Z");
const entry = (file: string, fm: string, lines: string[]) => parseExperience(file, `---\n${fm}\n---\n\n## Achievements\n${lines.map((l) => `- ${l} [R]`).join("\n")}\n`);

// A consultant: two roles at one firm and an earlier one.
const senior = entry("01-harborline-senior.md", "id: harborline-senior\ncompany: Harborline Advisory\ntitle: Senior Consultant\nstart: '2022-09'\nend: present", [
  "Workstream lead on 5 engagements for retail and consumer goods clients; teams of 2 to 3 consultants.",
  "Wrote the proposal sections on approach and team for 3 bids; the firm won 2.",
]);
const consultant = entry("02-harborline-consultant.md", "id: harborline-consultant\ncompany: Harborline Advisory\ntitle: Consultant\nstart: '2020-07'\nend: '2022-08'", [
  "Analyst then consultant on 7 engagements: market sizing, customer surveys, cost benchmarking.",
]);
const analyst = entry("03-northwind-analyst.md", "id: northwind-analyst\ncompany: Northwind Foods\ntitle: Operations Analyst\nstart: '2016-06'\nend: '2018-07'", [
  "Analyzed plant yield and waste for 2 snack plants; reported weekly to the plant directors.",
]);
const consulting = [senior, consultant, analyst];

const resume = (over: { summary?: string; experience?: GeneratedResume["resume"]["experience"]; education?: GeneratedResume["resume"]["education"]; skills?: string[]; audit?: GeneratedResume["provenance_audit"] } = {}): GeneratedResume => ({
  resume: {
    header: { name: "Jordan Example", contact: "Columbus, OH · jordan@example.com" },
    executive_summary: over.summary ?? "Consultant for retail clients.",
    experience: over.experience ?? [{ company: "Harborline Advisory", title: "Senior Consultant", dates: "Sep 2022 - Present", bullets: ["Workstream lead on 5 engagements for retail and consumer goods clients."] }],
    education: over.education ?? [],
    skills: over.skills ?? [],
  },
  provenance_audit: over.audit ?? [{ claim: "Workstream lead on 5 engagements", source_experience: "01-harborline-senior.md", prov: "R" }],
});
const kinds = (g: GeneratedResume, exps = consulting, extra = "", opts: Parameters<typeof checkResumeGrounding>[3] = {}) => checkResumeGrounding(g, exps, extra, { now: NOW, ...opts }).map((i) => i.kind);
const details = (g: GeneratedResume, exps = consulting, extra = "", opts: Parameters<typeof checkResumeGrounding>[3] = {}) => checkResumeGrounding(g, exps, extra, { now: NOW, ...opts }).map((i) => `[${i.kind}] ${i.detail}`);

describe("1. the résumé's own list of skills and its languages are kept, and are the person's", () => {
  const profile = "---\nname: Jordan Example\nskills:\n  - Financial modeling\n  - SQL\n  - Java\n  - survey design\n  - client workshops\nlanguages:\n  - English (native)\n  - Italian (fluent)\n---\n";

  it("the extraction asks for the document's skills and languages, in its words, apart from the skills of a role", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("candidate.skills is the resume's skills section, one item per skill, each exactly in its words");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("candidate.languages is its languages with their level, as written.");
    expect(buildExtractionUserMessage("x")).toContain('"skills": ["each item of the resume\'s skills section, in its words"], "languages": ["English (native)", "..."]');
  });

  it("the first import shows the list as the person's own, and names the item their document does not hold", () => {
    const store = {};
    rememberSource(store, "resume.pdf", "Jordan Example\nSenior Consultant, Harborline Advisory\nWorkstream lead on 5 engagements for retail and consumer goods clients.\nSkills\nFinancial modeling, SQL, Java.\nLanguages\nEnglish (native), Italian (fluent).");
    const items = importItems(
      ["name: Jordan Example", "skills: Financial modeling, SQL, Java, Python", "languages: English (native), Italian (fluent)"],
      [{ fileName: "01-harborline-senior.md", frontmatter: { company: "Harborline Advisory", title: "Senior Consultant", start: "2022-09", end: "present" }, body: "- Workstream lead on 5 engagements for retail and consumer goods clients. [R]" }],
      [],
      { verbatim: (l) => inSources(store, l), named: (t) => phraseInSources(store, t), saved: () => false, lists: { skills: ["Financial modeling", "SQL", "Java", "Python"], languages: ["English (native)", "Italian (fluent)"] } },
    );
    const summary = summaryMessage(items, ["resume.pdf"])!;
    expect(summary).toContain("You: Jordan Example; your skills, as you list them: Financial modeling, SQL, Java, Python; languages: English (native), Italian (fluent).");
    expect(summary).toContain('The 1 line is word for word from your document.\nNot in your document: the skill "Python" (your profile). Check it.');
    // One by one, the same is marked on the profile.
    expect(partMessage([items[0]!], 1, 2, true)).toContain('languages: English (native), Italian (fluent). [not in your document: the skill "Python"]');
  });

  it("the Assessor is given the list as stated skills, and told that a listed skill is not a gap", () => {
    expect(profileFactsFrom({ skills: ["SQL", "Java", " "], languages: ["English (native)"] })).toEqual({ languages: ["English (native)"], skills: ["SQL", "Java"], work_authorization: undefined, location: undefined });
    expect(profileFactsFrom({ skills: ["SQL"] })?.skills).toEqual(["SQL"]);
    expect(SCORING_SYSTEM_PROMPT).toContain("An item on either list is stated by the candidate: never report it as a gap, and never ask whether they have it.");
    expect(SCORING_SYSTEM_PROMPT).toContain("you may ask WHERE it was used");
  });

  it("the Writer is given the list and the languages, and starts the Skills section from them", () => {
    const message = buildGenerationUserMessage({
      jobText: "Analyst",
      detectedAts: "unknown",
      company: "Quillstack",
      title: "Analyst",
      scoreReport: {} as never,
      experiences: consulting,
      educationRaw: [],
      voiceProfile: null,
      summaryBlocks: null,
      recruiterFeedback: null,
      statedSkills: ["Financial modeling", "SQL"],
      languages: ["English (native)", "Italian (fluent)"],
    });
    expect(message).toContain('"stated_skills": [\n      "Financial modeling",\n      "SQL"\n    ]');
    expect(message).toContain('"languages": [\n      "English (native)",\n      "Italian (fluent)"\n    ]');
    expect(GENERATION_SYSTEM_PROMPT).toContain("SKILLS. Start from candidate.stated_skills, the candidate's own list in their own words");
    expect(GENERATION_SYSTEM_PROMPT).toContain('end the skills with one item "Languages: …" exactly as given');
  });

  it("with a list of their own, a skills item is theirs or a fact's words; a label of the writer's is refused", () => {
    const g = (skills: string[]) => resume({ skills });
    const check = (skills: string[]) => details(g(skills), consulting, profile).filter((d) => d.startsWith("[skill_not_held]"));
    // Their own items, as written or shortened; the words of a fact; their languages.
    expect(check(["Financial modeling", "SQL", "Java", "Survey design", "Market sizing", "Cost benchmarking", "Languages: English (native), Italian (fluent)"])).toEqual([]);
    // Labels nobody used (the run's own: "Editorial leadership", "Freelance client management", "Safety program management").
    expect(check(["Editorial leadership", "SQL"])).toEqual([
      '[skill_not_held] "Editorial leadership" (skills): not in the person\'s own list of skills and in the words of no verified fact. Use their list as they wrote it, or the words a fact uses; to add a skill, ask them and save it to their profile first',
    ]);
    expect(check(["Freelance client management", "Safety program management"])).toHaveLength(2);
    // One part of an item is theirs and the other is not: the part is named.
    expect(check(["Survey design / inventory placement"])[0]).toContain('"inventory placement" (skills)');
    // A finding, not a stop: the person may keep a skills line of their own.
    expect(ADVISORY_GROUNDING.has("skill_not_held")).toBe(true);
    // A person who gave no list is held to the same rule: an item stands in a fact's words, or stops the save.
    expect(kinds(g(["Editorial leadership"]), consulting, "---\nname: Jordan Example\n---\n")).toEqual(["skill_not_held"]);
    expect(kinds(g(["Market sizing", "Cost benchmarking"]), consulting, "---\nname: Jordan Example\n---\n")).toEqual([]);
    // A skill on their list that the job ad names and the Skills section leaves out is listed for the Writer.
    const left = details(g(["SQL"]), consulting, profile, { statedSkills: ["Financial modeling", "SQL", "Java"], jobText: "We need SQL and Java, and financial modeling for retail clients." });
    expect(left).toEqual([
      '[listed_skill_left_out] "Financial modeling" is on the person\'s own list of skills and the job ad names it; the Skills section leaves it out. Add it as they wrote it',
      '[listed_skill_left_out] "Java" is on the person\'s own list of skills and the job ad names it; the Skills section leaves it out. Add it as they wrote it',
    ]);
    expect(ADVISORY_GROUNDING.has("listed_skill_left_out")).toBe(true);
  });
});

describe("2. a project is a project; a title and an employer are the knowledge base's, and the document's", () => {
  const document = "Jordan Example\nSoftware Engineering Intern | Ledgerly | Jun 2025 - Aug 2025\nWrote a Python service that reads shipment events from a queue.\nProjects\nCampus Shuttle Tracker (team of 4, capstone) | Jan 2026 - May 2026\nBuilt the backend in Go.";
  const store = {};
  rememberSource(store, "resume.pdf", document);
  const opts = { verbatim: (l: string) => inSources(store, l), named: (t: string) => phraseInSources(store, t), saved: () => false };
  const intern = { fileName: "01-ledgerly.md", frontmatter: { company: "Ledgerly", title: "Software Engineering Intern", start: "2025-06", end: "2025-08" }, body: "- Wrote a Python service that reads shipment events from a queue. [R]" };

  it("the extraction and the Writer are told what a project is, and that it has no job title and no employer", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('Its entry carries kind: "project", company: the project\'s own name exactly as the resume writes it');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('NEVER give a project a job title ("Backend Engineer", "Full-Stack Developer") or an employer (the university, "Personal project")');
    expect(GENERATION_SYSTEM_PROMPT).toContain('An entry with "kind: project" is the candidate\'s own project, not a job.');
    expect(GENERATION_SYSTEM_PROMPT).toContain("TITLES. Every title is the knowledge base's title for that entry, unchanged.");
  });

  it("the first import names a project by its own name and counts it apart from the jobs", () => {
    const project = { fileName: "02-campus-shuttle-tracker.md", frontmatter: { kind: "project", company: "Campus Shuttle Tracker", title: "Project", start: "2026-01", end: "2026-05" }, body: "- Built the backend in Go. [R]" };
    const items = importItems(["name: Jordan Example"], [intern, project], [], opts);
    const summary = summaryMessage(items, ["resume.pdf"])!;
    expect(summary).toContain("1 job: Software Engineering Intern at Ledgerly, June 2025 to August 2025 (1 line).\n1 project: Campus Shuttle Tracker, January 2026 to May 2026 (1 line).");
    expect(summary).toContain("All 2 lines are word for word from your document.\n\n");
    expect(partMessage([items[2]!], 2, 2, true)).toContain("Project 1 of 1: Campus Shuttle Tracker, January 2026 to May 2026.\nIts line: (1) Built the backend in Go.");
  });

  it("a title or an employer that is not in the document is shown as such, in the summary and one by one", () => {
    // What the run saved: the project as a job, with a title and an employer of Claude's own.
    const madeUp = { fileName: "02-campus-shuttle-tracker.md", frontmatter: { company: "State University", title: "Backend Engineer, Campus Shuttle Tracker (Capstone Project)", start: "2026-01", end: "2026-05" }, body: "- Built the backend in Go. [R]" };
    const items = importItems(["name: Jordan Example"], [intern, madeUp], [{ fileName: "course.md", frontmatter: { credential: "Go Programming Certificate", institution: "Online course" }, body: "" }], opts);
    const summary = summaryMessage(items, ["resume.pdf"])!;
    expect(summary).toContain(
      'Not in your document: the title "Backend Engineer, Campus Shuttle Tracker (Capstone Project)" (job 2); the employer "State University" (job 2); the credential "Go Programming Certificate" (entry 1); the school or issuer "Online course" (entry 1). Check them.',
    );
    expect(partMessage([items[2]!], 2, 3, true)).toContain(
      'Job 2 of 2: Backend Engineer, Campus Shuttle Tracker (Capstone Project) at State University, January 2026 to May 2026. [not in your document: the title "Backend Engineer, Campus Shuttle Tracker (Capstone Project)"; the employer "State University"]',
    );
    // With no document to look in, nothing is claimed either way.
    const unknown = importItems([], [madeUp], [], { verbatim: () => null, saved: () => false });
    expect(unknown[0]!.nameNotInDocument).toBeUndefined();
  });

  it("the save refuses a title the knowledge base does not hold for that employer, and takes its own, a shortening or a stated one", () => {
    expect(titleHeld("Senior Consultant", [senior])).toBe(true);
    expect(titleHeld("Consultant", [senior])).toBe(true); // a shortening of the entry's own title
    expect(titleHeld("Workstream lead", [senior])).toBe(true); // a title a verified line states in these words
    expect(titleHeld("Engagement Manager", [senior, consultant])).toBe(false);
    // A title the person wrote themselves, in their profile or their own résumé, is theirs.
    expect(titleHeld("Engagement Manager", [senior, consultant], "headline: Engagement Manager, retail")).toBe(true);
    expect(kinds(resume({ experience: [{ company: "Harborline Advisory", title: "Engagement Manager", dates: "2020 - Present", bullets: ["Workstream lead on 5 engagements for retail and consumer goods clients."] }] }), consulting, "", { ownWriting: "Engagement Manager | Harborline Advisory" })).toEqual([]);
    const row = (title: string) => resume({ experience: [{ company: "Harborline Advisory", title, dates: "2020 - Present", bullets: ["Workstream lead on 5 engagements for retail and consumer goods clients."] }] });
    expect(kinds(row("Senior Consultant"))).toEqual([]);
    expect(details(row("Engagement Manager"))).toEqual([
      '[unknown_title] "Engagement Manager" under "Harborline Advisory" is not a title the knowledge base holds for that entry (it holds "Senior Consultant", "Consultant"). Use the knowledge base\'s title as it is',
    ]);
    expect(ADVISORY_GROUNDING.has("unknown_title")).toBe(true);
  });

  it("a project's row may have no title, and never one the entry does not hold; the save puts it under Projects", async () => {
    const project = parseExperience("01-campus-shuttle-tracker.md", "---\nid: campus-shuttle-tracker\nkind: project\ncompany: Campus Shuttle Tracker\ntitle: Project\nstart: '2026-01'\nend: '2026-05'\n---\n\n## Achievements\n- Built the backend in Go: a REST API and a WebSocket feed of bus positions. [R]\n");
    const job = parseExperience("02-ledgerly.md", "---\nid: ledgerly\ncompany: Ledgerly\ntitle: Software Engineering Intern\nstart: '2025-06'\nend: '2025-08'\n---\n\n## Achievements\n- Wrote a Python service that reads shipment events from a queue. [R]\n");
    const rows = (title: string): GeneratedResume["resume"]["experience"] => [
      { company: "Campus Shuttle Tracker", title, dates: "Jan 2026 - May 2026", bullets: ["Built the backend in Go: a REST API and a WebSocket feed of bus positions."] },
      { company: "Ledgerly", title: "Software Engineering Intern", dates: "Jun 2025 - Aug 2025", bullets: ["Wrote a Python service that reads shipment events from a queue."] },
    ];
    const audit = [{ claim: "Built the backend in Go", source_experience: "01-campus-shuttle-tracker.md", prov: "R" }];
    expect(kinds(resume({ experience: rows(""), audit }), [project, job])).toEqual([]);
    expect(kinds(resume({ experience: rows("Backend Engineer"), audit }), [project, job])).toEqual(["unknown_title"]);

    const store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-trial-")));
    await store.writeFile(["knowledge-base", "experiences", "01-campus-shuttle-tracker.md"], `---\nid: campus-shuttle-tracker\nkind: project\ncompany: Campus Shuttle Tracker\ntitle: Project\nstart: '2026-01'\nend: '2026-05'\n---\n\n## Achievements\n- Built the backend in Go: a REST API and a WebSocket feed of bus positions. [R]\n`);
    await store.writeFile(["knowledge-base", "experiences", "02-ledgerly.md"], `---\nid: ledgerly\ncompany: Ledgerly\ntitle: Software Engineering Intern\nstart: '2025-06'\nend: '2025-08'\n---\n\n## Achievements\n- Wrote a Python service that reads shipment events from a queue. [R]\n`);
    await store.writeFile(["knowledge-base", "education", "state-university.md"], `---\ninstitution: State University\ncredential: B.S. Computer Science\ndates: May 2026\n---\n\n- B.S. Computer Science, State University, May 2026. [R]\n`);
    const app = await createApplication(store, { company: "Quillstack", role: "Junior Backend Engineer", snapshotMarkdown: "# Junior Backend Engineer\nGo and Python.", source_url_unavailable: true });
    // The model marks nothing: the save reads the entry's kind, and decides the order of the sections.
    await saveGeneratedResume(store, app.id, resume({ summary: "Computer science graduate.", experience: rows(""), audit, education: [{ institution: "State University", credential: "B.S. Computer Science", dates: "May 2026" }] }));
    const md = (await store.readFile(["applications", app.id, "resume-source.md"]))!;
    expect(md.split("\n").filter((l) => /^#{2,4} /.test(l))).toEqual([
      "## Executive Summary",
      "## Education",
      "## Professional Experience",
      "### Ledgerly",
      "#### Software Engineering Intern | Jun 2025 - Aug 2025",
      "## Projects",
      "### Campus Shuttle Tracker | Jan 2026 - May 2026",
    ]);
    const saved = JSON.parse((await store.readFile(["applications", app.id, "resume.json"]))!) as GeneratedResume;
    expect(saved.resume.experience.map((e) => e.kind)).toEqual(["project", undefined]);
    expect(saved.resume.education_first).toBe(true);
    // A job with no title is refused; a project row the model marked itself under a job's employer is a job again.
    await expect(saveGeneratedResume(store, app.id, resume({ experience: [{ company: "Ledgerly", title: "", kind: "project", dates: "2025", bullets: ["Wrote a Python service that reads shipment events from a queue."] }], audit: [{ claim: "Wrote a Python service", source_experience: "02-ledgerly.md", prov: "R" }] }))).rejects.toThrow(/the role under "Ledgerly" has no title/);
  });
});

describe("3. a certificate's issuer is the entry's own, or none", () => {
  const education = [
    educationRef("northwind-university-ba.md", { institution: "Northwind State University", credential: "B.A. English", dates: "2015" }, "- B.A. English, Northwind State University, 2015. [R]"),
    educationRef("content-marketing-certificate.md", { credential: "Content Marketing Certificate", dates: "2025" }, "- Content Marketing Certificate, an online course of 40 hours, completed 2025. [R]"),
    educationRef("analytics-certification.md", { credential: "Google Analytics Certification", dates: "2025" }, "- Google Analytics Certification, 2025. [R]"),
  ];
  const corpus = education.map((e) => e.text).join("\n");
  const check = (rows: GeneratedResume["resume"]["education"]) => details(resume({ education: rows }), consulting, corpus, { educationRecorded: true, educationEntries: education });

  it("a school the entry names is taken; a description or a guess in an issuer's place is refused; an empty one is taken and written with none", () => {
    expect(check([{ institution: "Northwind State University", credential: "B.A. English", dates: "2015" }])).toEqual([]);
    expect(check([{ institution: "", credential: "Content Marketing Certificate", dates: "2025" }, { institution: "", credential: "Google Analytics Certification", dates: "2025" }])).toEqual([]);
    // What the run wrote: "Online course" and "Google" as the schools. Both words are in the entries' own lines.
    expect(check([{ institution: "Online course", credential: "Content Marketing Certificate", dates: "2025" }])).toEqual([
      '[education_differs] "Content Marketing Certificate, Online course" (education): the knowledge base\'s entry for this credential names no school or issuer. Leave it empty',
    ]);
    expect(check([{ institution: "Google", credential: "Google Analytics Certification", dates: "2025" }])).toHaveLength(1);
    expect(check([{ institution: "State University of Ohio", credential: "B.A. English" }])[0]).toContain("ungrounded_credential");
    const md = generatedResumeToMarkdown(resume({ education: [{ institution: "", credential: "Content Marketing Certificate", dates: "2025" }, { institution: "Northwind State University", credential: "B.A. English", dates: "2015" }] }));
    expect(md).toContain("- **Content Marketing Certificate** (2025)\n- **B.A. English**, Northwind State University (2015)");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('never write a description ("Online course") or a guess ("Google") in its place');
  });
});

describe("4. a count of years is a number: it fits the dates of the roles its sentence names, or it is refused", () => {
  it("reads the counts, in digits and in words, with what they claim", () => {
    expect(yearClaims("Nine years writing; for more than six years; 14 years in operations; 10+ years; nearly three years; a two-year program; 12 years old.")).toEqual([
      { raw: "Nine years", years: 9, more: false, nearly: false },
      { raw: "more than six years", years: 6, more: true, nearly: false },
      { raw: "14 years", years: 14, more: false, nearly: false },
      { raw: "10+ years", years: 10, more: true, nearly: false },
      { raw: "nearly three years", years: 3, more: false, nearly: true },
    ]);
    expect(yearClaims("Eight print issues a year, 410 days, 18 months.")).toEqual([]);
  });

  it("reads the dates of the roles, counted once where they overlap", () => {
    expect(dateAsYears("2022-09", false, NOW)).toBeCloseTo(2022 + 8 / 12);
    expect(dateAsYears("present", true, NOW)).toBeCloseTo(2026 + 11 / 12);
    expect(dateAsYears("2012", false, NOW)).toBe(2012);
    expect(dateAsYears("2012", true, NOW)).toBe(2013);
    expect(dateAsYears("Jun 2025", true, NOW)).toBeCloseTo(2025.5);
    expect(dateAsYears("soon", true, NOW)).toBeNull();
    expect(yearsCovered([senior], NOW)).toBeCloseTo(4.25);
    // July 2020 to today, then with June 2016 to July 2018 added.
    expect(yearsCovered([senior, consultant], NOW)).toBeCloseTo(6.42, 1);
    expect(yearsCovered(consulting, NOW)).toBeCloseTo(8.58, 1);
    expect(yearsCovered([], NOW)).toBeNull();
  });

  it("holds a count against the title the sentence names, else the employer, else every role", () => {
    expect(entriesNamed("Senior Consultant at Harborline Advisory, leading workstreams.", consulting)).toEqual({ entries: [senior], by: "title" });
    expect(entriesNamed("At Harborline Advisory since 2020.", consulting)).toEqual({ entries: [senior, consultant], by: "employer" });
    // "Consultant" is also what the Senior Consultant of the same firm is.
    expect(entriesNamed("Consultant at Harborline Advisory.", consulting)).toEqual({ entries: [senior, consultant], by: "title" });
    expect(entriesNamed("Years of analysis for retail clients.", consulting).by).toBe("none");
  });

  it("the run's own sentence is refused: more than six years said of a role held for four", () => {
    const g = resume({ summary: "**Retail Strategy Consultant:** Senior Consultant at Harborline Advisory, leading workstreams on retail and consumer goods engagements for more than six years." });
    expect(details(g)).toEqual([
      '[years_exceed_dates] "more than six years" (summary): the dates of Senior Consultant at Harborline Advisory give 4.3 years. Write the count the dates give for what the sentence says, or leave the count out',
    ]);
    expect(ADVISORY_GROUNDING.has("years_exceed_dates")).toBe(true);
    // The same count said of "Consultant", which the Senior Consultant of that firm also is, fits the two roles' dates:
    // it is not refused, and is listed for the person.
    expect(kinds(resume({ summary: "Consultant at Harborline Advisory for more than six years." }))).toEqual(["years_from_dates"]);
    expect(kinds(resume({ summary: "Consultant at Harborline Advisory for more than seven years." }))).toEqual(["years_exceed_dates"]);
    // An employer named without a title does not narrow the count: it is held against every role.
    expect(kinds(resume({ summary: "Eight years of analysis, most recently at Harborline Advisory." }))).toEqual(["years_from_dates"]);
    expect(kinds(resume({ summary: "Ten years of analysis, most recently at Harborline Advisory." }))).toEqual(["years_exceed_dates"]);
  });

  it("a count that fits the dates and that nobody stated is listed for the person; one the knowledge base states is theirs", () => {
    // "Nine years writing for a public audience": the dates of all the roles allow it, and code cannot tell what the nine were spent on.
    const found = details(resume({ summary: "Eight years of analysis for retail and food clients." }));
    expect(found).toEqual([
      '[years_from_dates] "Eight years" (summary) is stated nowhere in the knowledge base: it was worked out from the dates of Senior Consultant at Harborline Advisory; Consultant at Harborline Advisory; Operations Analyst at Northwind Foods (8.6 years). Ask the person whether it is true of what the sentence says, or leave the count out',
    ]);
    expect(ADVISORY_GROUNDING.has("years_from_dates")).toBe(true);
    expect(kinds(resume({ summary: "Twelve years of analysis." }))).toEqual(["years_exceed_dates"]);
    // A count the person wrote themselves, in their profile or their own résumé, is theirs: the knowledge base need not hold every role.
    expect(kinds(resume({ summary: "Twelve years of analysis." }), consulting, "", { ownWriting: "Analyst with twelve years in retail and food." })).toEqual([]);
    expect(kinds(resume({ summary: "Twelve years of analysis." }), consulting, "---\nheadline: 12 years in analysis\n---")).toEqual([]);
    // Stated by the person: "wrote the newsletter for four years".
    const teacher = entry("01-northwind-school.md", "id: teacher\ncompany: Northwind High School\ntitle: English Teacher\nstart: '2017-08'\nend: '2025-06'", ["Wrote the school's weekly family newsletter for four years; it went by email to about 1,400 families."]);
    const row = [{ company: "Northwind High School", title: "English Teacher", dates: "2017 - 2025", bullets: ["Wrote the school's weekly family newsletter for four years."] }];
    const audit = [{ claim: "Wrote the school's weekly family newsletter", source_experience: "01-northwind-school.md", prov: "R" }];
    expect(kinds(resume({ summary: "English teacher.", experience: row, audit }), [teacher])).toEqual([]);
    // Under a role, a count is held against that role: nine years under a post held for eight.
    expect(kinds(resume({ summary: "English teacher.", experience: [{ ...row[0]!, bullets: ["Wrote for families for nine years."] }], audit }), [teacher])).toEqual(["years_exceed_dates"]);
    expect(checkYears("Taught for 8 years.", "summary", "", [teacher], [teacher], NOW)).toEqual([{ kind: "from_dates", claim: "8 years", where: "summary", covered: 7.9, roles: ["English Teacher at Northwind High School"], sentence: "Taught for 8 years.", by: "none" }]);
  });
});

describe("6. a line may name an education or credential entry as its source", () => {
  const education = [educationRef("state-university.md", { institution: "State University", credential: "B.S. Computer Science" }, "- B.S. Computer Science, State University, 2026. [R]"), educationRef("scrum-product-owner.md", { credential: "Certified Scrum Product Owner" }, "- Certified Scrum Product Owner, 2021. [R]")];

  it("by its file name, its school or its credential, as an experience is named", () => {
    for (const label of ["state-university.md", "state-university", "State University", "B.S. Computer Science", "scrum-product-owner.md", "Certified Scrum Product Owner", "State University (B.S. Computer Science)"]) expect(namesEducation(label, education), label).toBe(true);
    for (const label of ["harrow-university.md", "Harrow University", "", "State"]) expect(namesEducation(label, education), label).toBe(false);
    const sourced = (source_experience: string) => kinds(resume({ audit: [{ claim: "Computer science graduate", source_experience, prov: "R" }] }), consulting, "", { educationEntries: education });
    // What failed in all four runs: "provenance source … is not a KB experience".
    expect(sourced("state-university.md")).toEqual([]);
    expect(sourced("State University")).toEqual([]);
    expect(sourced("scrum-product-owner.md")).toEqual([]);
    expect(sourced("harrow-university.md")).toEqual(["unknown_source"]);
    expect(GENERATION_SYSTEM_PROMPT).not.toContain("is not a KB experience");
  });
});

describe("7. a question does not suggest its answer", () => {
  it("the run's three questions are found, and a plain one is not", () => {
    const found = leadingQuestions([
      "Was that specifically Kafka, or something else (SQS, RabbitMQ), or do you not remember?",
      "Did you send the newsletter through an email tool (like Northwind Mail, Ledgerly Send, or your school's own system)?",
      "Does the site fulfill e-commerce orders, or is it a different kind of distribution, for example pallet or case shipments?",
      "The ad asks for SQL. Have you used SQL in a job, a project or a class that your résumé does not mention? If not, say no.",
      "Have you owned the full budget of an engagement? If not, say no.",
      null,
    ]);
    expect(found.map((f) => f.marker)).toEqual(["or something else", "(like Northwind Mail, Ledgerly Send, or your school's own system)", "for example"]);
    expect(leadingQuestions(["Which tools did you use, such as Java?", "Did you use a tool like Java?"]).map((f) => f.marker)).toEqual(["such as", "like Java"]);
    expect(SCORING_SYSTEM_PROMPT).toContain('It offers no answer: no example answers, no "like X or Y", no "for example", and no tool, product or option the candidate did not name.');
  });
});

describe("8. a line's wrong source is put right by the save, not reported", () => {
  it("the audit that is saved names the entry the facts were found in", async () => {
    const store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-trial-")));
    const file = (e: typeof senior) => `---\nid: ${e.frontmatter.id}\ncompany: ${e.frontmatter.company}\ntitle: ${e.frontmatter.title}\nstart: '${e.frontmatter.start}'\nend: ${e.frontmatter.end === "present" ? "present" : `'${e.frontmatter.end}'`}\n---\n\n${e.body}\n`;
    for (const e of consulting) await store.writeFile(["knowledge-base", "experiences", e.fileName], file(e));
    const app = await createApplication(store, { company: "Quillstack", role: "Engagement Manager", snapshotMarkdown: "# Engagement Manager\nRetail.", source_url_unavailable: true });
    const g = resume({
      summary: "Consultant for retail and consumer goods clients.",
      experience: [
        { company: "Harborline Advisory", title: "Senior Consultant", dates: "Sep 2022 - Present", bullets: ["Workstream lead on 5 engagements for retail and consumer goods clients; teams of 2 to 3 consultants."] },
        { company: "Northwind Foods", title: "Operations Analyst", dates: "Jun 2016 - Jul 2018", bullets: ["Analyzed plant yield and waste for 2 snack plants; reported weekly to the plant directors."] },
      ],
      // The second line is given to the wrong entry.
      audit: [
        { claim: "Workstream lead on 5 engagements for retail and consumer goods clients", source_experience: "01-harborline-senior.md", prov: "R" },
        { claim: "Analyzed plant yield and waste for 2 snack plants", source_experience: "01-harborline-senior.md", prov: "R" },
      ],
    });
    const res = await saveGeneratedResume(store, app.id, g);
    expect(res.sourcesCorrected).toBe(1);
    expect(res.origins.findings.filter((f) => f.kind === "audit")).toEqual([]);
    const saved = JSON.parse((await store.readFile(["applications", app.id, "resume.json"]))!) as GeneratedResume;
    expect(saved.provenance_audit.map((a) => a.source_experience)).toEqual(["01-harborline-senior.md", "03-northwind-analyst.md"]);
  });
});

describe("9. a student or a recent graduate: education first, projects in their own section", () => {
  const project = parseExperience("01-campus-shuttle-tracker.md", "---\nid: p\nkind: project\ncompany: Campus Shuttle Tracker\ntitle: Project\nstart: '2026-01'\nend: '2026-05'\n---\n\n- Built the backend. [R]\n");
  const internship = parseExperience("02-ledgerly.md", "---\nid: l\ncompany: Ledgerly\ntitle: Intern\nstart: '2025-06'\nend: '2025-08'\n---\n\n- Wrote a service. [R]\n");
  const degree = (dates: string, credential = "B.S. Computer Science") => resume({ education: [{ institution: "State University", credential, dates }] });

  it("education stands first when the degree is the latest entry and the person has under three years of work", () => {
    expect(educationStandsFirst(degree("May 2026"), [project, internship], NOW)).toBe(true);
    expect(educationStandsFirst(degree("expected 2027"), [project, internship], NOW)).toBe(true);
    // No job at all, only projects.
    expect(educationStandsFirst(degree("2026"), [project], NOW)).toBe(true);
    // The degree is older than the last job; a job still held; a certificate is not a degree; a working history of years.
    expect(educationStandsFirst(degree("2024"), [project, internship], NOW)).toBe(false);
    expect(educationStandsFirst(degree("May 2026"), [parseExperience("03-x.md", "---\nid: x\ncompany: Quillstack\ntitle: Clerk\nstart: '2026-01'\nend: present\n---\n\n- x [R]\n")], NOW)).toBe(false);
    expect(educationStandsFirst(degree("2026", "Content Marketing Certificate"), [internship], NOW)).toBe(false);
    expect(educationStandsFirst(degree("2026", "MBA"), consulting, NOW)).toBe(false);
    expect(educationStandsFirst(resume(), [internship], NOW)).toBe(false);
  });

  it("the sections of anyone else are as they were: summary, experience, education, skills", () => {
    const md = generatedResumeToMarkdown(resume({ education: [{ institution: "State University", credential: "MBA", dates: "2020" }], skills: ["SQL"] }));
    expect(md.split("\n").filter((l) => l.startsWith("## "))).toEqual(["## Executive Summary", "## Professional Experience", "## Education", "## Skills"]);
    // A project with a part the person stated keeps it under its name.
    const withPart = generatedResumeToMarkdown(resume({ experience: [{ company: "Campus Shuttle Tracker", kind: "project", title: "Team lead", dates: "Jan 2026 - May 2026", bullets: ["Built the backend."] }] }));
    expect(withPart).toContain("## Projects\n\n### Campus Shuttle Tracker\n#### Team lead | Jan 2026 - May 2026\n\n- Built the backend.");
    expect(withPart).not.toContain("## Professional Experience");
  });
});

describe("10. smaller ones", () => {
  it('"I" in a line is found, for the Writer to take out; it does not stop the save', () => {
    const found = checkResumePerson("**Logistics:** Interned at Ledgerly, where I built a Python service.\n- Trained my shift.");
    expect(found).toEqual([{ rule: "first-person", detail: 'I, my (résumés use implied first person: "Built…", not "I built…")' }]);
    expect(found.some(isHardStyleViolation)).toBe(false);
    for (const fine of ["Ran Phase I trials and Type I tests.", "Columbus, OH · about.me/jordan · jordan@example.com", "Built the service."]) expect(checkResumePerson(fine), fine).toEqual([]);
    expect(GENERATION_SYSTEM_PROMPT).toContain('NO "I", "my" or "me"');
  });

  it("the summary is a list, one line per bold opener, however it was written", () => {
    const list = "- **Scope:** Runs second shift.\n- **Results:** Cut mis-picks.";
    expect(summaryAsBullets("**Scope:** Runs second shift. **Results:** Cut mis-picks.")).toBe(list);
    expect(summaryAsBullets("**Scope:** Runs second shift.\n**Results:** Cut mis-picks.")).toBe(list);
    expect(summaryAsBullets(list)).toBe(list);
    // One opener, none, or text before the first opener: left as written.
    for (const kept of ["**Scope:** Runs second shift.", "Runs second shift. Cut mis-picks.", "Supervisor. **Scope:** Runs second shift. **Results:** Cut mis-picks."]) expect(summaryAsBullets(kept)).toBe(kept);
  });

  it("a bullet that says the role's introduction again is named", () => {
    const g = resume({
      experience: [
        {
          company: "Harborline Advisory",
          title: "Senior Consultant",
          dates: "2022 - Present",
          summary: "Workstream lead on 5 retail and consumer goods engagements, in teams of 2 to 3 consultants.",
          bullets: ["**Consultant Development:** Mentors 2 first-year analysts while leading workstreams across 5 retail and consumer goods engagements, in teams of 2 to 3 consultants.", "Wrote the proposal sections for 3 bids."],
        },
      ],
    });
    expect(repeatedIntros(g)).toEqual([expect.stringMatching(/^repeat: under "Harborline Advisory", a bullet says the role's introduction again \("\*\*Consultant Development:\*\* Mentors 2 first-year analysts/)]);
    expect(repeatedIntros(resume())).toEqual([]);
  });

  it("a refused save says that nothing was saved, and what shape is expected when the inner object was given", async () => {
    const store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-trial-")));
    const app = await createApplication(store, { company: "Quillstack", role: "Analyst", snapshotMarkdown: "# Analyst\nSQL.", source_url_unavailable: true });
    const inner = resume().resume as unknown as GeneratedResume;
    const refused = await saveGeneratedResume(store, app.id, inner).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SaveRefused);
    expect((refused as Error).message).toContain('The whole object is expected: { "resume": { "header", "executive_summary", "experience", "education", "skills" }, "provenance_audit": [ ... ]');
    // Nothing was written.
    expect(await store.readFile(["applications", app.id, "resume.json"])).toBeNull();
  });
});

/**
 * The guardrails of 15 November 2026 ("where code can tell, a fault stops the save"), and what the fifth run added.
 * None of them needs a numbers register, a voice profile or a reference résumé to be there.
 */
describe("guardrails: what the knowledge base does not hold is found, and told; it does not stop the save", () => {
  const finance = entry("01-northwind-supply.md", "id: northwind-supply\ncompany: Northwind Supply\ntitle: Senior Financial Analyst\nstart: '2022-03'\nend: present", [
    "Own the monthly forecast for the Fasteners division ($140M revenue): build it with the sales and plant controllers and present variances to the division CFO.",
    "Built the payback analysis for a $2.1M automated packing line in 2023; the plant manager presented it.",
    "Supported the acquisition of a distributor in 2024: prepared the revenue and margin analysis for the diligence team. I did not lead the deal.",
  ]);
  const earlier = entry("02-ledgerly.md", "id: ledgerly\ncompany: Ledgerly\ntitle: Financial Analyst\nstart: '2018-07'\nend: '2022-02'", ["Prepared the annual budget for the Hand Tools business unit ($60M revenue) with the unit controller."]);
  const kb = [finance, earlier];
  const profile = "---\nname: Jordan Example\nsummary: 'Financial analyst with seven years in corporate finance for manufacturing companies: budgeting, forecasting and monthly reporting.'\n---\n";
  const row = (over: Partial<GeneratedResume["resume"]["experience"][number]> = {}) => ({ company: "Northwind Supply", title: "Senior Financial Analyst", dates: "Mar 2022 - Present", bullets: ["Own the monthly forecast for the Fasteners division ($140M revenue)."], ...over });
  const doc = (over: { summary?: string; experience?: GeneratedResume["resume"]["experience"] } = {}) =>
    resume({ summary: over.summary ?? "Senior Financial Analyst at Northwind Supply.", experience: over.experience ?? [row()], audit: [{ claim: "Own the monthly forecast", source_experience: "01-northwind-supply.md", prov: "R" }] });
  const found = (g: GeneratedResume, extra = profile) => details(g, kb, extra);

  it("1. a role's dates are the entry's: a year or a month that differs stops the save", () => {
    expect(rowDates("Mar 2022 - Present")).toEqual({ start: { year: 2022, month: 3, present: false }, end: { year: 0, month: null, present: true } });
    expect(rowDates("2018 – 2022")).toEqual({ start: { year: 2018, month: null, present: false }, end: { year: 2022, month: null, present: false } });
    expect(rowDates("Spring 2025")).toEqual({ start: { year: 2025, month: null, present: false }, end: { year: 2025, month: null, present: false } });
    expect(rowDates("ongoing")).toBeNull();
    // As the entry has them, with or without the months.
    for (const dates of ["Mar 2022 - Present", "2022 - Present", "March 2022 – present"]) expect(found(doc({ experience: [row({ dates })] })), dates).toEqual([]);
    expect(found(doc({ experience: [row({ dates: "Mar 2021 - Present" })] }))).toEqual(['[dates_differ] "Mar 2021 - Present" under "Northwind Supply": the knowledge base holds 2022-03 to present for that entry. Write its dates as they are']);
    for (const dates of ["Apr 2022 - Present", "Mar 2022 - 2025", "sometime"]) expect(kinds(doc({ experience: [row({ dates })] }), kb, profile), dates).toEqual(["dates_differ"]);
    // A role that has ended is not written as still held.
    expect(kinds(doc({ experience: [{ company: "Ledgerly", title: "Financial Analyst", dates: "Jul 2018 - Present", bullets: ["Prepared the annual budget for the Hand Tools business unit ($60M revenue) with the unit controller."] }] }), kb, profile)).toEqual(["dates_differ"]);
    // Two roles at one employer written as one row: from the first one's start to the last one's end.
    const audit = [{ claim: "Workstream lead on 5 engagements", source_experience: "01-harborline-senior.md", prov: "R" }];
    const merged = (dates: string) => kinds(resume({ experience: [{ company: "Harborline Advisory", title: "Senior Consultant", dates, bullets: ["Workstream lead on 5 engagements for retail and consumer goods clients."] }], audit }));
    expect(merged("Jul 2020 - Present")).toEqual([]);
    expect(merged("Jul 2019 - Present")).toEqual(["dates_differ"]);
  });

  it("2. the person's own count of years stands: a summary gives their figure, not one worked out from dates", () => {
    // The dates give eight years; the person says seven.
    expect(found(doc({ summary: "Eight years in corporate finance for manufacturing companies." }))).toEqual([
      '[years_not_the_persons] "Eight years" (summary): the person states their own count of years ("seven years"). Their figure stands: write it as they did, or ask them whether it has changed',
    ]);
    expect(found(doc({ summary: "Seven years in corporate finance for manufacturing companies." }))).toEqual([]);
    expect(ADVISORY_GROUNDING.has("years_not_the_persons")).toBe(true);
    // With no figure of their own on file, a count that fits the dates is listed, as before.
    expect(kinds(doc({ summary: "Eight years in corporate finance for manufacturing companies." }), kb, "---\nname: Jordan Example\n---\n")).toEqual(["years_from_dates"]);
  });

  it("6. what the person did not do is never a line; a result said with \"without\" or \"no\" is not that", () => {
    const negative = (bullet: string) => found(doc({ experience: [row({ bullets: [bullet] })] })).filter((d) => d.startsWith("[negative_statement]"));
    expect(negative("Prepared the revenue and margin analysis for the diligence team on a 2024 distributor acquisition; did not lead the deal.")).toEqual([
      '[negative_statement] "did not lead" (under "Northwind Supply"): a résumé says what the person did, never what they did not do. Leave the statement out; it limits what the other lines may claim',
    ]);
    for (const line of ["Prepared the analysis for the diligence team. I did not lead the deal.", "Prepared the analysis, but never managed the diligence team.", "Prepared the analysis; not responsible for the deal."]) expect(negative(line), line).toHaveLength(1);
    for (const line of ["Kept the close on schedule with no downtime and without a restatement.", "Rebuilt the model so that the forecast is not built by hand.", "Trained 2 analysts who had not used the close calendar."]) expect(negative(line), line).toEqual([]);
    expect(GENERATION_SYSTEM_PROMPT).toContain("WHAT THEY DID NOT DO.");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("it limits what may later be claimed, and it is never printed on a resume");
  });

  it("an audience the person did not give stops the save; one their fact names does not", () => {
    expect(unknownAudiences("Built the payback analysis and presented it to leadership.", "the plant manager presented it")).toEqual(["to leadership"]);
    expect(unknownAudiences("Presented variances to the division CFO each month and reported results to senior leadership.", "present variances to the division CFO")).toEqual(["to senior leadership"]);
    expect(unknownAudiences("Reported weekly to the plant directors.", "reported weekly to the plant directors")).toEqual([]);
    expect(unknownAudiences("Presented the model to finance.", "x")).toEqual([]); // not one of the plain words for an audience
    const g = doc({ experience: [row({ bullets: ["Built the payback analysis for a $2.1M automated packing line in 2023, which the plant manager presented to leadership."] })] });
    expect(found(g)).toEqual(['[unknown_audience] "to leadership" under "Northwind Supply": no verified fact of that role names this audience. Say who it was in the person\'s own words, or leave the audience out']);
    expect(found(doc({ experience: [row({ bullets: ["Own the monthly forecast for the Fasteners division ($140M revenue) and present variances to the division CFO."] })] }))).toEqual([]);
  });

  it("a line opens in the implied first person, never the third", () => {
    const g = doc({ experience: [row({ summary: "Builds the monthly forecast for the $140M Fasteners division.", bullets: ["**Division Forecast:** Own the monthly forecast for the Fasteners division ($140M revenue).", "Rebuilt the forecast model.", "Sales and plant controllers build it with the analyst.", "- Mentors 2 junior analysts."] })] });
    expect(thirdPersonOpenings(g)).toEqual(["Builds", "Mentors"]);
    expect(thirdPersonOpenings(doc())).toEqual([]);
    expect(GENERATION_SYSTEM_PROMPT).toContain('VERB FORMS. Lines open in the implied first person: "Build", "Own" for what is still done');
  });

  it("the save succeeds and returns each of these with its line and what the knowledge base holds; a choice the person made once is not raised again", async () => {
    const store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-guard-")));
    const file = (e: typeof finance) => `---\nid: ${e.frontmatter.id}\ncompany: ${e.frontmatter.company}\ntitle: ${e.frontmatter.title}\nstart: '${e.frontmatter.start}'\nend: ${e.frontmatter.end === "present" ? "present" : `'${e.frontmatter.end}'`}\n---\n\n${e.body}\n`;
    for (const e of kb) await store.writeFile(["knowledge-base", "experiences", e.fileName], file(e));
    await store.writeFile(["profile.md"], `${profile}# Candidate profile\n`);
    const app = await createApplication(store, { company: "Quillstack", role: "Finance Manager", snapshotMarkdown: "# Finance Manager\nForecasting and SQL.", source_url_unavailable: true });

    // What the fifth run wrote, and more: a figure of years that is not the person's, a role that ended written as
    // current, a title of the Writer's, what the person did not do, an audience and a doing they did not give, the
    // third person, "I", a skill in nobody's words, and a line no fact holds.
    const drafted = doc({
      summary: "- **Corporate finance:** Eight years in corporate finance for manufacturing companies.",
      experience: [
        row({
          title: "Finance Manager",
          summary: "Builds the monthly forecast for the Fasteners division.",
          bullets: [
            "Prepared the revenue and margin analysis for the diligence team; did not lead the deal.",
            "Built the payback analysis for a $2.1M automated packing line in 2023 and presented it to leadership.",
            "Supported the acquisition of a distributor in 2024, where I prepared the revenue and margin analysis.",
            "Negotiated supplier contracts across the region.",
          ],
        }),
        { company: "Ledgerly", title: "Financial Analyst", dates: "Jul 2018 - Present", bullets: ["Prepared the annual budget for the Hand Tools business unit ($60M revenue) with the unit controller."] },
      ],
    });
    drafted.resume.skills = ["Financial storytelling"];
    const res = await saveGeneratedResume(store, app.id, drafted);
    // Saved: how a person presents themselves is theirs to decide.
    expect(await store.readFile(["applications", app.id, "resume.json"])).not.toBeNull();
    expect(res.findings.put_right.map((f) => f.kind).sort()).toEqual(
      ["dates_differ", "first-person", "line_with_no_origin", "negative_statement", "says_more_than_the_fact", "skill_not_held", "unknown_audience", "unknown_title", "verb-form", "years_not_the_persons"].sort(),
    );
    expect(res.findings.tell_user).toEqual([]);
    expect(res.findings.kept_by_choice).toEqual([]);
    const of = (kind: string) => res.findings.put_right.find((f) => f.kind === kind)!;
    // Each says which line and what the knowledge base holds.
    expect(of("years_not_the_persons")).toEqual({
      key: "years|eight years",
      kind: "years_not_the_persons",
      line: "Eight years in corporate finance for manufacturing companies.",
      what: '"Eight years" (summary): the person states their own count of years ("seven years"). Their figure stands: write it as they did, or ask them whether it has changed',
      say: 'The summary says "Eight years". The figure you give of yourself is another.',
    });
    expect(of("dates_differ")).toMatchObject({ key: "dates|ledgerly|2018 present", what: '"Jul 2018 - Present" under "Ledgerly": the knowledge base holds 2018-07 to 2022-02 for that entry. Write its dates as they are' });
    expect(of("unknown_title").what).toContain('"Finance Manager" under "Northwind Supply" is not a title the knowledge base holds for that entry (it holds "Senior Financial Analyst")');
    expect(of("says_more_than_the_fact")).toMatchObject({ line: "Built the payback analysis for a $2.1M automated packing line in 2023 and presented it to leadership." });
    expect(of("says_more_than_the_fact").what).toContain('the knowledge base says "the plant manager presented it": it states that result, not that the candidate brought it about');
    expect(of("line_with_no_origin")).toMatchObject({ line: "Negotiated supplier contracts across the region." });
    expect(of("skill_not_held")).toMatchObject({ key: "skills|financial storytelling", line: "Financial storytelling" });

    // The person keeps two of them for every résumé: the role written to "Present", and a skills line of their own.
    await store.writeFile(["profile.md"], `${profile.replace("---\n", "---\nresume_choices:\n  - key: 'dates|ledgerly|2018 present'\n    says: My Ledgerly role stays written to Present\n    since: '2026-11-15'\n  - key: 'skills|*'\n    says: My skills line is my own\n")}# Candidate profile\n`);
    const again = await saveGeneratedResume(store, app.id, drafted);
    expect(again.findings.kept_by_choice.map((f) => f.kind).sort()).toEqual(["dates_differ", "skill_not_held"]);
    expect(again.findings.put_right.map((f) => f.kind)).not.toContain("dates_differ");
    expect(again.findings.put_right.map((f) => f.kind)).not.toContain("skill_not_held");
    expect(again.findings.put_right).toHaveLength(res.findings.put_right.length - 2);
    // Another date that differs is still raised: the choice was for that one.
    drafted.resume.experience[0]!.dates = "Mar 2021 - Present";
    expect((await saveGeneratedResume(store, app.id, drafted)).findings.put_right.map((f) => f.key)).toContain("dates|northwind supply|2021 present");

    // In the person's own words nothing is found: their seven years, their dates, what they did and what the plant manager did.
    const own = doc({
      summary: "- **Corporate finance:** Financial analyst with seven years in corporate finance for manufacturing companies.\n- **Forecast:** Own the monthly forecast for the Fasteners division ($140M revenue).",
      experience: [
        row({ bullets: ["**Division Forecast:** Own the monthly forecast for the Fasteners division ($140M revenue): build it with the sales and plant controllers and present variances to the division CFO.", "**Capital Expenditure:** Built the payback analysis for a $2.1M automated packing line in 2023; the plant manager presented it.", "**Acquisition Support:** Supported the acquisition of a distributor in 2024: prepared the revenue and margin analysis for the diligence team."] }),
        { company: "Ledgerly", title: "Financial Analyst", dates: "Jul 2018 - Feb 2022", bullets: ["Prepared the annual budget for the Hand Tools business unit ($60M revenue) with the unit controller."] },
      ],
    });
    const clean = await saveGeneratedResume(store, app.id, own);
    expect(clean.findings).toEqual({ put_right: [], tell_user: [], kept_by_choice: [] });
    expect(clean.stretch).toEqual([]);
    // The sentence that is the person's own summary rests on their profile.
    expect(clean.origins.counts.none).toBe(0);
    expect(clean.origins.lines[0]!.facts[0]!.education).toBe("the person's own summary");
  });

  it("what stopped a save before: in a conversation it is a finding the user can keep; with nobody to tell, it still stops", async () => {
    const store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-guard-")));
    const body = `${finance.body}\n- Cut the close from 9 days to 6 days, a 33% cut. [R]\n\nNote: never claim "led the acquisition". [C]`;
    await store.writeFile(["knowledge-base", "experiences", "01-northwind-supply.md"], `---\nid: northwind-supply\ncompany: Northwind Supply\ntitle: Senior Financial Analyst\nstart: '2022-03'\nend: present\n---\n\n${body}\n`);
    await store.writeFile(["knowledge-base", "metrics-register.md"], "# Metrics register\n\n## Northwind Supply\n\n**Close time down 33%** — OPEN [R]\n- Not yet checked against the calendar.\n");
    await store.writeFile(["profile.md"], "---\nname: Jordan Example\n---\n# Candidate profile\n");
    const app = await createApplication(store, { company: "Quillstack", role: "Finance Manager", snapshotMarkdown: "# Finance Manager\nForecasting.", source_url_unavailable: true });
    const ways = "Two honest ways out for each: write it in the person's own words, as the knowledge base has them; or ask the person, save what they confirm as a fact of theirs (save_confirmed_fact), and save the résumé again. Do not reword a line to get it past a check.";
    const first = "Own the monthly forecast for the Fasteners division ($140M revenue).";
    const cases: [string, GeneratedResume, RegExp, string, string][] = [
      ["an employer the knowledge base does not know", doc({ experience: [row({ company: "Quillstack" })] }), /^SaveRefused: Resume failed grounding against the knowledge base: \[unknown_employer\] "Quillstack" is not a knowledge-base experience\./, "unknown_employer", '"Quillstack" is on this résumé as an employer. Your knowledge base has no entry for it.'],
      ["a number on no line of it", doc({ experience: [row({ bullets: ["Own the monthly forecast for the Fasteners division ($190M revenue)."] })] }), /\[ungrounded_metric\] "\$190M"/, "ungrounded_metric", 'The number "$190M" is on this résumé. It is not in your knowledge base.'],
      ["an organisation named in a sentence", doc({ experience: [row({ bullets: [first, "At Quorvex Labs, built the payback analysis."] })] }), /\[unknown_organisation\] "at Quorvex Labs"/, "unknown_organisation", 'A line says you were "at Quorvex Labs". Your knowledge base does not mention that organisation.'],
      ["a number the register withholds", doc({ experience: [row({ bullets: [first, "Cut the close from 9 days to 6 days, a 33% cut."] })] }), /^SaveRefused: Resume uses a number the metrics register does not allow: "33%"/, "register_withholds", 'The number "33%" is on this résumé. Your numbers register has it as OPEN ("Close time down 33%"), which is not a status you put on a document.'],
      ["a phrasing the person wrote never to claim", doc({ experience: [row({ bullets: [first, "Led the acquisition of a distributor in 2024."] })] }), /^SaveRefused: Resume uses phrasing the knowledge base forbids: \[Northwind Supply\] "led the acquisition"/, "forbidden_phrasing", 'A line says "led the acquisition". Your knowledge base has a note of yours never to claim that.'],
      ["a writing rule", doc({ experience: [row({ bullets: ["Own the monthly forecast for the Fasteners division — $140M revenue."] })] }), /^SaveRefused: Resume violates house style: em-dash/, "style_em_dash", "The wording goes against a writing rule of this résumé (em-dash): "],
    ];
    for (const [name, g, refusal, kind, say] of cases) {
      // With nobody to tell (the one-click résumé, a script): stopped, as before, and nothing is written.
      const stopped = await saveGeneratedResume(store, app.id, structuredClone(g)).then(() => "saved", (e: Error) => `${e.name}: ${e.message}`);
      expect(stopped, name).toMatch(refusal);
      if (/failed grounding/.test(stopped)) expect(stopped.endsWith(ways), name).toBe(true);
      expect(await store.readFile(["applications", app.id, "resume.json"]), name).toBeNull();
    }
    for (const [name, g, , kind, say] of cases) {
      // In a conversation: saved, and returned with the sentence the user reads. No judgement, no "must".
      const res = await saveGeneratedResume(store, app.id, structuredClone(g), { whenItDiffers: "warn" });
      const item = res.findings.put_right.find((f) => f.kind === kind);
      expect(item, name).toBeDefined();
      expect(item!.say!.startsWith(say), `${name}: ${item!.say}`).toBe(true);
      expect(item!.say, name).not.toMatch(/\bmust\b|\bshould\b|\bcannot\b|\bnot allowed\b/i);
    }
    // The user keeps the withheld number on every résumé, on their own word: it is not raised again, and it no longer
    // stops the save that has nobody to tell. Without the choice it is raised every time.
    const withheld = cases[3]![1];
    for (let i = 0; i < 2; i++) expect((await saveGeneratedResume(store, app.id, structuredClone(withheld), { whenItDiffers: "warn" })).findings.put_right.map((f) => f.kind)).toContain("register_withholds");
    await store.writeFile(["profile.md"], "---\nname: Jordan Example\nresume_choices:\n  - key: 'register|33%'\n    says: I state the 33% cut of the close\n    since: '2026-11-15'\n---\n# Candidate profile\n");
    const kept = await saveGeneratedResume(store, app.id, structuredClone(withheld), { whenItDiffers: "warn" });
    expect(kept.findings.put_right.map((f) => f.kind)).not.toContain("register_withholds");
    expect(kept.findings.kept_by_choice.map((f) => f.kind)).toEqual(["register_withholds"]);
    await expect(saveGeneratedResume(store, app.id, structuredClone(withheld))).resolves.toBeTruthy();
    // A résumé that is not in the tool's shape stops in both.
    await expect(saveGeneratedResume(store, app.id, { resume: {} } as never, { whenItDiffers: "warn" })).rejects.toThrow(/GeneratedResume failed validation/);
  });

  it("7. the Writer is told the page target that fits the knowledge base, and never to fill a page", () => {
    const message = (targetPages?: 1 | 2) =>
      buildGenerationUserMessage({ jobText: "x", detectedAts: "unknown", company: "Quillstack", title: "Analyst", scoreReport: {} as never, experiences: kb, educationRaw: [], voiceProfile: null, summaryBlocks: null, recruiterFeedback: null, ownSummary: "Financial analyst with seven years in corporate finance.", ...(targetPages ? { targetPages } : {}) });
    expect(message(1)).toContain('"max_pages": 1');
    expect(message(1)).toContain("At most ONE page: select only the most relevant roles and strongest bullets; condense older roles to one line or drop them. A page that is not full is the right result when the knowledge base holds no more: never add, repeat or stretch a line to fill it.");
    expect(message(2)).toContain("never add, repeat or stretch a line to fill one");
    expect(message(1)).toContain('"own_summary": "Financial analyst with seven years in corporate finance."');
    // Eight years of work and a few lines read from one résumé: one page.
    expect(resumeLengthPolicy(kb, { nowYear: 2026 }).targetPages).toBe(1);
  });

  it("the first import keeps what the person says of themselves, word for word, and says so when the words are Claude's", () => {
    const text = "Jordan Example\nFinancial analyst with seven years in corporate finance for manufacturing companies.\nSenior Financial Analyst, Northwind Supply\nOwn the monthly forecast for the Fasteners division.";
    const store = {};
    rememberSource(store, "resume.pdf", text);
    const item = { fileName: "01-northwind-supply.md", frontmatter: { company: "Northwind Supply", title: "Senior Financial Analyst", start: "2022-03", end: "present" }, body: "- Own the monthly forecast for the Fasteners division. [R]" };
    const items = (summary: string) => importItems(["name: Jordan Example", `summary: ${summary}`], [item], [], { verbatim: (l) => inSources(store, l), named: (t) => phraseInSources(store, t), saved: () => false, ownSummary: summary });
    const theirs = summaryMessage(items("Financial analyst with seven years in corporate finance for manufacturing companies."), ["resume.pdf"])!;
    expect(theirs).toContain('You: Jordan Example; what you say of yourself: "Financial analyst with seven years in corporate finance for manufacturing companies.".');
    expect(theirs).not.toContain("Not in your document");
    const claudes = summaryMessage(items("Seasoned finance professional with eight years of experience."), ["resume.pdf"])!;
    expect(claudes).toContain("Not in your document: the summary of yourself (Claude worded it) (your profile). Check it.");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("candidate.summary is the resume's summary or objective about the person as a whole (the paragraph under the name), word for word and complete");
  });
});

/**
 * What still reached the person with no warning in the second run on the five people (15 November 2026, Sonnet, on
 * main at 6ede64c): each is a case here, with what is found now.
 */
describe("the second run's three leftovers", () => {
  const ended = entry("02-northwind-shipping.md", "id: northwind-shipping\ncompany: Northwind Distribution\ntitle: 'Team Lead, Shipping'\nstart: '2012-02'\nend: '2016-05'", ["Led 9 loaders on the outbound dock, 40 to 55 trailers a night.", "Kept on-time departure above 97% in 2015."]);
  const current = parseExperience(
    "01-northwind-supervisor.md",
    "---\nid: northwind-supervisor\ncompany: Northwind Distribution\ntitle: Warehouse Operations Supervisor\nstart: '2016-05'\nend: present\n---\n\n## Achievements\n- Run second shift at a 220,000 square foot distribution center: 34 associates and 3 team leads. [R]\n- Hire, schedule and train for the shift; trained 60 new associates since 2019. [R]\n- Built the payback analysis for a $2.1M automated packing line in 2023. [R]\n\n## Context & responsibilities\nAbout 30% of Northwind's volume is each-picks for online retailers, which my shift handles. [C]\n",
  );
  const warehouse = [current, ended];
  const sup = (over: Partial<GeneratedResume["resume"]["experience"][number]> = {}) => ({ company: "Northwind Distribution", title: "Warehouse Operations Supervisor", dates: "May 2016 - Present", bullets: ["Run second shift at a 220,000 square foot distribution center: 34 associates and 3 team leads."], ...over });
  const lead = (over: Partial<GeneratedResume["resume"]["experience"][number]> = {}) => ({ company: "Northwind Distribution", title: "Team Lead, Shipping", dates: "Feb 2012 - May 2016", bullets: ["Led 9 loaders on the outbound dock, 40 to 55 trailers a night."], ...over });
  const cv = (summary: string, experience: GeneratedResume["resume"]["experience"]) => resume({ summary, experience, audit: [{ claim: "Run second shift", source_experience: "01-northwind-supervisor.md", prov: "R" }] });
  const of = (g: GeneratedResume, kind: string) => details(g, warehouse).filter((d) => d.startsWith(`[${kind}]`));

  it("1. a lead claimed over a list of things: where the knowledge base says the person took part in one of them, it is found", () => {
    const facts = [...consulting];
    const pharmacy = entry("02-harborline-consultant.md", "id: harborline-consultant\ncompany: Harborline Advisory\ntitle: Consultant\nstart: '2020-07'\nend: '2022-08'", [
      "Analyst then consultant on 7 engagements: market sizing, customer surveys, cost benchmarking.",
      "Supported the due diligence of a regional pharmacy chain for a private equity client: built the store-level profitability model. A partner led the engagement.",
    ]);
    const grocery = entry("01-harborline-senior.md", "id: harborline-senior\ncompany: Harborline Advisory\ntitle: Senior Consultant\nstart: '2022-09'\nend: present", [
      "Workstream lead on 5 engagements for retail and consumer goods clients; teams of 2 to 3 consultants.",
      "For a grocery chain of 85 stores, led the pricing workstream: built the price-elasticity analysis for 12 categories.",
      "For a home goods retailer, built the store labor model that the client used to set schedules in 140 stores.",
    ]);
    const kb = [grocery, pharmacy, facts[2]!];
    const stretch = (summary: string) => checkResumeStretch(resume({ summary }), kb).map((f) => `${f.rule}:${f.trigger}`);
    // The run's own sentence.
    expect(stretch("- **Retail Consulting Leadership:** Leads retail and consumer goods engagements at Harborline Advisory, including a grocery chain, a home goods retailer and a regional pharmacy chain.")).toEqual(["drift:leads"]);
    expect(checkResumeStretch(resume({ summary: "Leads retail engagements, including a regional pharmacy chain." }), kb)[0]!.detail).toBe(
      'the knowledge base says "supported the due diligence of a regional pharmacy chain for a private equity client": the candidate took part, the bullet says "leads"',
    );
    // Without the thing they only took part in, or said as the fact says it, nothing is found.
    expect(stretch("- **Retail Consulting:** Leads workstreams on retail and consumer goods engagements, including a grocery chain and a home goods retailer.")).toEqual([]);
    expect(stretch("- **Retail Consulting:** Workstream lead on retail and consumer goods engagements; supported the due diligence of a regional pharmacy chain.")).toEqual([]);
  });

  it("2. a share keeps what it is a share of", () => {
    expect(sharesOf("About 30% of Northwind's volume is each-picks; cut mis-picks from 1.9% to 0.7% of order lines.")).toEqual([
      { raw: "30% of Northwind's volume", percent: "30", whole: ["northwind", "volume"] },
      { raw: "0.7% of order lines", percent: "0.7", whole: ["order", "line"] },
    ]);
    const moved = cv("Warehouse Operations Supervisor at Northwind Distribution.", [sup({ bullets: ["**E-Commerce Fulfillment:** About 30% of the shift's volume is each-picks for online retailers."] })]);
    expect(of(moved, "share_of_another_whole")).toEqual([
      '[share_of_another_whole] "30% of the shift\'s volume" (under "Northwind Distribution"): the knowledge base gives this share of something else ("30% of Northwind\'s volume"). Say what it is a share of in the person\'s own words',
    ]);
    expect(of(cv("Warehouse Operations Supervisor at Northwind Distribution.", [sup({ bullets: ["About 30% of Northwind's volume is each-picks for online retailers, which the shift handles."] })]), "share_of_another_whole")).toEqual([]);
    expect(ADVISORY_GROUNDING.has("share_of_another_whole")).toBe(true);
  });

  it("2. a rate the knowledge base gives for one year keeps its year; the year of a piece of work may be left out", () => {
    const summary = "- **Operational Results:** Run second shift at a 220,000 square foot distribution center and kept on-time departure above 97%.";
    expect(of(cv(summary, [sup(), lead()]), "year_left_out")).toEqual([
      '[year_left_out] "97%" (summary): the knowledge base gives this figure for 2015 ("Kept on-time departure above 97% in 2015."). Say the year with it, or leave the figure out',
    ]);
    expect(of(cv(`${summary.slice(0, -1)} in 2015.`, [sup(), lead()]), "year_left_out")).toEqual([]);
    expect(of(cv("Warehouse Operations Supervisor at Northwind Distribution.", [sup(), lead({ bullets: ["Kept on-time departure above 97% in 2015."] })]), "year_left_out")).toEqual([]);
    // "$2.1M … in 2023" says when the work was done.
    expect(of(cv("Warehouse Operations Supervisor at Northwind Distribution.", [sup({ bullets: ["Built the payback analysis for a $2.1M automated packing line."] })]), "year_left_out")).toEqual([]);
  });

  it("3. the third person is found behind a bold lead-in and a list mark (it was not), and the present tense under a role that has ended", () => {
    const g = cv("- **Shift Leadership:** Runs the second shift at a 220,000 square foot distribution center.\n- **Safety:** Serves on the site safety committee.", [
      sup({ summary: "Run second shift at a 220,000 square foot distribution center: 34 associates and 3 team leads.", bullets: ["**Hiring and Training:** Hires, schedules and trains for the shift; trained 60 new associates since 2019.", "**Labor Planning:** Track the shift's overtime hours.", "**Sales Operations:** Sales and plant controllers build the forecast."] }),
      lead({ bullets: ["**Outbound Operations:** Lead 9 loaders on the outbound dock.", "Run the outbound dock, 40 to 55 trailers a night.", "Lead engineer on the dock layout.", "Kept on-time departure above 97% in 2015."] }),
    ]);
    expect(thirdPersonOpenings(g)).toEqual(["Runs", "Serves", "Hires"]);
    // In the current role the present is right ("Run", "Track"). In the role that ended in 2016 it is not.
    expect(presentInEndedRoles(g, warehouse).map((t) => [t.company, t.word])).toEqual([
      ["Northwind Distribution", "Lead"],
      ["Northwind Distribution", "Run"],
    ]);
    expect(presentInEndedRoles(cv("x", [sup(), lead()]), warehouse)).toEqual([]);
  });

  it("the save returns each of them with the sentence the user reads", async () => {
    const store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-left-")));
    for (const e of warehouse) await store.writeFile(["knowledge-base", "experiences", e.fileName], `---\nid: ${e.frontmatter.id}\ncompany: ${e.frontmatter.company}\ntitle: '${e.frontmatter.title}'\nstart: '${e.frontmatter.start}'\nend: ${e.frontmatter.end === "present" ? "present" : `'${e.frontmatter.end}'`}\n---\n\n${e.body}\n`);
    const app = await createApplication(store, { company: "Quillstack", role: "Operations Manager", snapshotMarkdown: "# Operations Manager\nShifts.", source_url_unavailable: true });
    const g = cv("- **Operational Results:** Run second shift at a 220,000 square foot distribution center and kept on-time departure above 97%.", [
      sup({ bullets: ["**E-Commerce Fulfillment:** About 30% of the shift's volume is each-picks for online retailers.", "**Hiring and Training:** Hires, schedules and trains for the shift; trained 60 new associates since 2019."] }),
      lead({ bullets: ["Run the outbound dock, 40 to 55 trailers a night."] }),
    ]);
    const res = await saveGeneratedResume(store, app.id, g, { whenItDiffers: "warn" });
    const say = Object.fromEntries(res.findings.put_right.map((f) => [f.kind, f.say]));
    expect(say).toMatchObject({
      share_of_another_whole: 'A line says "30% of the shift\'s volume". Your knowledge base gives that share of something else.',
      year_left_out: 'The figure "97%" is on this résumé without its year. Your knowledge base gives it for one year.',
      "verb-form": 'A line opens in the third person ("Hires").',
      present_in_an_ended_role: 'A line under Northwind Distribution opens in the present ("Run"). Your knowledge base has that role as ended.',
    });
  });
});

/**
 * The owner's decision on the headings (15 November 2026): "Keep them, but users can change them through
 * conversation". The defaults are his; a user who asks gets their own, on every later résumé.
 */
describe("a résumé's section headings: the defaults stay, and a user can rename one", () => {
  const full = () => {
    const g = resume({ education: [{ institution: "State University", credential: "MBA", dates: "2020" }], skills: ["SQL"] });
    g.resume.experience.push({ company: "Campus Shuttle Tracker", kind: "project", title: "", dates: "2026", bullets: ["Built the backend."] });
    return g;
  };
  const sections = (md: string) => md.split("\n").filter((l) => l.startsWith("## "));

  it("with nothing renamed the headings are the ones they were", () => {
    expect(sections(generatedResumeToMarkdown(full()))).toEqual(["## Executive Summary", "## Professional Experience", "## Projects", "## Education", "## Skills"]);
    expect(headingsFor(undefined)).toEqual(DEFAULT_RESUME_HEADINGS);
    expect(readProfileSettings("---\nname: Jordan Example\n---\n").resume_headings).toBeUndefined();
  });

  it("reads the renamed ones from the profile, and nothing that is not a heading", () => {
    expect(readProfileSettings("---\nresume_headings:\n  summary: Summary\n  experience: Experience\n---\n").resume_headings).toEqual({ summary: "Summary", experience: "Experience" });
    // The default's own name is not a renaming; markup, a line break and an empty or overlong text are not headings.
    expect(renamedHeadings({ summary: "Executive Summary", experience: "  Work history  ", education: "## Schools | here", skills: "", projects: "x".repeat(41) })).toEqual({ experience: "Work history", education: "Schools here" });
    for (const bad of ["", " ", "#", "12", "x".repeat(41), 7, null]) expect(cleanHeading(bad), String(bad)).toBeUndefined();
    expect(headingsFor({ summary: "Summary" })).toEqual({ ...DEFAULT_RESUME_HEADINGS, summary: "Summary" });
  });

  it("the save writes the user's headings into the résumé, the Word file's source and the page's view; the checks that read sections follow", async () => {
    const store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-headings-")));
    for (const e of consulting) await store.writeFile(["knowledge-base", "experiences", e.fileName], `---\nid: ${e.frontmatter.id}\ncompany: ${e.frontmatter.company}\ntitle: ${e.frontmatter.title}\nstart: '${e.frontmatter.start}'\nend: ${e.frontmatter.end === "present" ? "present" : `'${e.frontmatter.end}'`}\n---\n\n${e.body}\n`);
    await store.writeFile(["knowledge-base", "education", "mba.md"], "---\ninstitution: State University\ncredential: MBA\ndates: '2020'\n---\n\n- MBA, State University, 2020. [R]\n");
    await store.writeFile(["profile.md"], "---\nname: Jordan Example\nresume_headings:\n  summary: Summary\n  experience: Experience\n---\n# Candidate profile\n");
    const app = await createApplication(store, { company: "Quillstack", role: "Engagement Manager", snapshotMarkdown: "# Engagement Manager\nRetail.", source_url_unavailable: true });
    const g = resume({
      summary: "Senior Consultant at Harborline Advisory.",
      experience: [{ company: "Harborline Advisory", title: "Senior Consultant", dates: "Sep 2022 - Present", bullets: ["Workstream lead on 5 engagements for retail and consumer goods clients; teams of 2 to 3 consultants."] }],
      education: [{ institution: "State University", credential: "MBA", dates: "2020" }],
    });
    // A heading the model sends is not the user's: only the profile's counts.
    g.resume.headings = { summary: "Career Highlights", skills: "Superpowers" };
    const res = await saveGeneratedResume(store, app.id, g);
    expect(res.findings).toEqual({ put_right: [], tell_user: [], kept_by_choice: [] });
    const md = (await store.readFile(["applications", app.id, "resume-source.md"]))!;
    expect(sections(md)).toEqual(["## Summary", "## Experience", "## Education"]);
    const saved = JSON.parse((await store.readFile(["applications", app.id, "resume.json"]))!) as GeneratedResume;
    expect(saved.resume.headings).toEqual({ summary: "Summary", experience: "Experience" });
    // The Word file is written from that source: its text holds the renamed headings and not the defaults.
    const { default: JSZip } = await import("jszip");
    const xml = await (await JSZip.loadAsync((await store.readBinary(["applications", app.id, "resume.docx"]))!)).file("word/document.xml")!.async("string");
    expect(xml.toUpperCase()).toContain(">SUMMARY<");
    expect(xml.toUpperCase()).toContain(">EXPERIENCE<");
    expect(xml.toUpperCase()).not.toContain("EXECUTIVE SUMMARY");
    expect(xml.toUpperCase()).not.toContain("PROFESSIONAL EXPERIENCE");
    // What the layout and the text-layer check expect is read from the résumé's own headings.
    expect(atsExpectFromMarkdown(md)).toMatchObject({ sectionOrder: ["Summary", "Experience", "Education"], companiesSection: "Experience", companies: ["Harborline Advisory"] });
    // The application page names the summary as the user does.
    const view = (await loadLineOriginView(store, saved))!;
    expect(view.summaryHeading).toBe("Summary");
    expect(originGroups(view).map((x) => x.label)).toEqual(["Summary", "Harborline Advisory · Senior Consultant"]);
    // Someone who renamed nothing: no heading on the résumé, and the page's label as before.
    await store.writeFile(["profile.md"], "---\nname: Jordan Example\n---\n# Candidate profile\n");
    await saveGeneratedResume(store, app.id, g);
    const plain = JSON.parse((await store.readFile(["applications", app.id, "resume.json"]))!) as GeneratedResume;
    expect(plain.resume.headings).toBeUndefined();
    expect(sections((await store.readFile(["applications", app.id, "resume-source.md"]))!)).toEqual(["## Executive Summary", "## Professional Experience", "## Education"]);
    expect(originGroups((await loadLineOriginView(store, plain))!)[0]!.label).toBe("Executive summary");
  });

  it("the Writer is given the user's headings and told that the save writes them; the HTML preview uses them too", () => {
    const message = buildGenerationUserMessage({ jobText: "x", detectedAts: "unknown", company: "Quillstack", title: "Analyst", scoreReport: {} as never, experiences: consulting, educationRaw: [], voiceProfile: null, summaryBlocks: null, recruiterFeedback: null, headings: headingsFor({ summary: "Summary" }) });
    expect(message).toContain('"sections": [\n      "Summary",\n      "Professional Experience",\n      "Education",\n      "Skills"\n    ]');
    expect(GENERATION_SYSTEM_PROMPT).toContain("the section headings given in template.sections (the save step writes them; never invent a label of your own)");
    const g = full();
    g.resume.headings = { summary: "Summary", experience: "Experience" };
    const html = generatedResumeToHtml(g);
    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toContain("<h2>Experience</h2>");
    expect(html).not.toContain("Executive Summary");
  });
});

describe("what the checks in claude.ai found (15 November 2026)", () => {
  // A student: a capstone and an internship. The profile says what they look for.
  const capstone = entry("01-state-university-capstone.md", "id: capstone\ncompany: State University\ntitle: Capstone Project Lead\nstart: '2025-09'\nend: present", [
    "Lead a team of 4 building a study-scheduling app for students in Flutter.",
    "Presented to a faculty panel and won second place.",
  ]);
  const intern = entry("02-ledgerly-intern.md", "id: ledgerly-intern\ncompany: Ledgerly\ntitle: Software Engineering Intern\nstart: '2025-06'\nend: '2025-08'", [
    "Built a dashboard in React that the operations team uses daily.",
    "Wrote Python tests for the data pipeline.",
  ]);
  const profile = (extra = "") => `---\nname: Jordan Example\nheadline: Junior Frontend Engineer, React\ntarget_roles:\n  - Frontend Engineer\n${extra}---\n# Candidate profile\n`;
  const draft = (over: { title?: string; summary?: string } = {}): GeneratedResume =>
    resume({
      summary: over.summary ?? "- **Internal Tools:** Built a dashboard in React that the operations team uses daily.",
      experience: [
        { company: "State University", title: "Capstone Project Lead", dates: "Sep 2025 - Present", bullets: ["Lead a team of 4 building a study-scheduling app for students in Flutter."] },
        { company: "Ledgerly", title: over.title ?? "Software Engineering Intern", dates: "Jun 2025 - Aug 2025", bullets: ["Built a dashboard in React that the operations team uses daily.", "Wrote Python tests for the data pipeline."] },
      ],
      audit: [{ claim: "Built a dashboard in React", source_experience: "02-ledgerly-intern.md", prov: "R" }],
    });
  const home = async (profileText = profile()) => {
    const store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-open-checks-")));
    const file = (e: typeof intern) => `---\nid: ${e.frontmatter.id}\ncompany: ${e.frontmatter.company}\ntitle: ${e.frontmatter.title}\nstart: '${e.frontmatter.start}'\nend: ${e.frontmatter.end === "present" ? "present" : `'${e.frontmatter.end}'`}\n---\n\n${e.body}\n`;
    for (const e of [capstone, intern]) await store.writeFile(["knowledge-base", "experiences", e.fileName], file(e));
    await store.writeFile(["profile.md"], profileText);
    const app = await createApplication(store, { company: "Northwind Labs", role: "Junior Frontend Engineer", snapshotMarkdown: "# Junior Frontend Engineer\nReact dashboards.", source_url_unavailable: true });
    return { store, appId: app.id };
  };

  it("a title the profile only looks for is not a title held: put on a role, it is raised", async () => {
    const { store, appId } = await home();
    const res = await saveGeneratedResume(store, appId, draft({ title: "Frontend Engineer" }), { whenItDiffers: "warn" });
    const title = res.findings.put_right.find((f) => f.kind === "unknown_title");
    expect(title).toMatchObject({ key: "title|ledgerly|frontend engineer", say: 'The title "Frontend Engineer" is on this résumé. Your knowledge base has another title for that entry.' });
    expect(title!.what).toContain('"Frontend Engineer" under "Ledgerly" is not a title the knowledge base holds for that entry (it holds "Software Engineering Intern")');
    // The entry's own title raises nothing.
    expect((await saveGeneratedResume(store, appId, draft(), { whenItDiffers: "warn" })).findings.put_right.map((f) => f.kind)).not.toContain("unknown_title");
    // A title the person wrote of themselves, in their own résumé, is still theirs.
    await store.writeFile(["knowledge-base", "reference-resume.md"], "Jordan Example\n\nLedgerly\nFrontend Engineer, summer 2025\n");
    expect((await saveGeneratedResume(store, appId, draft({ title: "Frontend Engineer" }), { whenItDiffers: "warn" })).findings.put_right.map((f) => f.kind)).not.toContain("unknown_title");
  });

  it("a count of years the dates do not give is raised once, not a second time as a total; kept, both of its findings are kept", async () => {
    const { store, appId } = await home();
    const summary = "- Three years building React interfaces.\n- **Internal Tools:** Built a dashboard in React that the operations team uses daily.";
    const res = await saveGeneratedResume(store, appId, draft({ summary }), { whenItDiffers: "warn" });
    const mine = res.findings.put_right.filter((f) => /three years/i.test(`${f.line ?? ""} ${f.what}`));
    expect(mine.map((f) => [f.kind, f.key])).toEqual([
      ["years_exceed_dates", "years|three years"],
      ["line_with_no_origin", "line|three years building react interfaces"],
    ]);
    expect(mine[0]!.say).toBe('A line says "Three years". The dates of that role in your knowledge base give fewer.');
    expect(mine[1]!.say).toBe('This line rests on nothing in your knowledge base: "Three years building React interfaces.".');
    // The same count is not listed again by the check of wording, which finds it on its own.
    expect(checkResumeStretch(draft({ summary }), [capstone, intern], "").filter((f) => f.rule === "total").map((f) => f.trigger)).toEqual(["Three years"]);
    expect(res.stretch.filter((f) => f.rule === "total")).toEqual([]);
    // The user keeps the sentence: neither finding is raised again, and both are counted as kept.
    await store.writeFile(["profile.md"], profile("resume_choices:\n  - key: 'years|three years'\n    says: The sentence stays as it is\n    since: '2026-11-15'\n  - key: 'line|three years building react interfaces'\n    says: The sentence stays as it is\n    since: '2026-11-15'\n"));
    const again = await saveGeneratedResume(store, appId, draft({ summary }), { whenItDiffers: "warn" });
    expect(again.findings.put_right.filter((f) => /three years/i.test(`${f.line ?? ""} ${f.what}`))).toEqual([]);
    expect(again.findings.kept_by_choice.map((f) => f.kind).sort()).toEqual(["line_with_no_origin", "years_exceed_dates"]);
    expect(again.stretch.filter((f) => f.rule === "total")).toEqual([]);
  });
});
