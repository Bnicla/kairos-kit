import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LocalStore } from "@/store/local-fs";
import { createApplication } from "@kairos/engine/applications";
import { afterStop } from "@/mcp/after-stop";

/**
 * The real MCP server over stdio against an empty temporary data folder
 * (invented data): the first import is approved in Kairos's own confirmation,
 * in plain words, every line shown when there is no document to compare with,
 * in parts when it is long, and only while the knowledge base is empty; the
 * tools the first run used to call one after the other answer in one call.
 */
describe("Kairos MCP server: the first import and the merged calls", () => {
  const home = mkdtempSync(join(tmpdir(), "kairos-first-run-"));
  let client: Client;
  /** What the user answers to the next confirmations, and every confirmation shown. */
  let answer: "accept" | "decline" = "accept";
  const shown: string[] = [];
  const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const files = (...folder: string[]) => (existsSync(join(home, ...folder)) ? readdirSync(join(home, ...folder)).sort() : []);

  const role = (n: number, company: string, lines: string[]) => ({
    fileName: `0${n}-${company.toLowerCase()}.md`,
    frontmatter: { id: company.toLowerCase(), company, title: "Software Engineering Intern", start: "2025-06", end: "2025-08", skills: [{ name: "Python", prov: "R" }] },
    body: ["## Summary", `Internship on the internal tools team at ${company}. [R]`, "", "## Achievements", ...lines].join("\n"),
  });
  const ledgerly = role(1, "Ledgerly", ["- Built a dashboard the operations team uses daily. [R]", "- Wrote tests for the data pipeline. [R]"]);
  const harborline = role(2, "Harborline", ["- Shipped a reconciliation feature used by 40 internal users. [R]", "- A line with no tag."]);
  const school = { fileName: "state-university.md", frontmatter: { institution: "State University", credential: "B.S. Computer Science", end: "2027" }, body: "Expected May 2027. [R]" };
  const first = {
    profile: { name: "Jordan Example", contact_line: "Columbus, OH · jordan@example.com", headline: "Software Engineer, Internal Tools" },
    experiences: [ledgerly, harborline],
    education: [school],
    sources: ["resume.pdf"],
  };

  beforeAll(async () => {
    client = new Client({ name: "test", version: "0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      shown.push(request.params.message);
      return { action: answer };
    });
    await client.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["tsx", "apps/local/mcp/server.ts"],
        env: { ...process.env, KAIROS_HOME: home } as Record<string, string>,
        stderr: "ignore",
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("the session brief says how many tracks there are, so that the track list is not asked for one track", async () => {
    const brief = JSON.parse(text(await call("load_context")));
    expect(brief.tracks).toEqual({ active: 1, saved: false });
    expect(brief.kb_map).toEqual([]);
  }, 60_000);

  it("a first import is refused before any confirmation when a file name is not one plain name, or is given twice", async () => {
    const path = await call("save_first_import", { ...first, experiences: [{ ...ledgerly, fileName: "../outside.md" }] });
    expect(path.isError).toBe(true);
    expect(text(path)).toMatch(/file names are not accepted.*\.\.\/outside\.md/);
    const twice = await call("save_first_import", { ...first, experiences: [ledgerly, { ...harborline, fileName: "01-LEDGERLY.md" }] });
    expect(twice.isError).toBe(true);
    expect(text(twice)).toMatch(/same file name/);
    expect(shown).toEqual([]);
    expect(files("knowledge-base", "experiences")).toEqual([]);
  }, 60_000);

  it("a list longer than one confirmation shows is asked in parts, no item cut; a declined part saves nothing", async () => {
    answer = "decline";
    const long = Array.from({ length: 12 }, (_, i) => ({
      ...role(i + 1, `Company${i + 1}`, Array.from({ length: 14 }, (_, j) => `- Result number ${j + 1} at company ${i + 1}, told in a full sentence. [R]`)),
      fileName: `${String(i + 1).padStart(2, "0")}-company.md`,
    }));
    const r = await call("save_first_import", { ...first, experiences: long });
    expect(r.isError).toBe(true);
    // One confirmation was shown, the first of several, and the call stopped at the answer.
    expect(shown).toHaveLength(1);
    const box = shown[0];
    const parts = Number(/^Kairos: your first import, part 1 of (\d+)\. Nothing of this part is saved yet\./.exec(box)?.[1]);
    expect(parts).toBeGreaterThan(1);
    // Under what one confirmation shows here, and every job in it has its 15 lines whole.
    expect(box.length).toBeLessThanOrEqual(12_000);
    const jobs = [...box.matchAll(/^Job (\d+) of 12: /gm)].map((m) => Number(m[1]));
    expect(jobs.length).toBeGreaterThan(1);
    expect(jobs.length).toBeLessThan(12);
    expect(jobs).toEqual(jobs.map((_, i) => i + 1));
    for (const n of jobs) for (let j = 1; j <= 14; j++) expect(box, `job ${n}, line ${j}`).toContain(`Result number ${j} at company ${n}, told in a full sentence.`);
    expect(box).not.toContain(`at company ${jobs.length + 1},`);
    expect(box).toContain(`Accept saves part 1 only. Decline saves nothing of it. ${parts - 1} more part${parts === 2 ? " follows" : "s follow"}.`);
    expect(text(r)).toMatch(new RegExp(`^Part 1 of ${parts} was not saved: the user declined it\\. Not saved: `));
    expect(text(r)).toContain("call save_first_import again with the same items");
    expect(files("knowledge-base", "experiences")).toEqual([]);
    expect(existsSync(join(home, "profile.md")) ? readFileSync(join(home, "profile.md"), "utf8") : "").not.toContain("Jordan Example");
  }, 60_000);

  it("declined: one confirmation was shown and nothing is saved, not even the profile", async () => {
    answer = "decline";
    shown.length = 0;
    const r = await call("save_first_import", first);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Nothing was saved: the user declined it\./);
    expect(shown).toHaveLength(1);
    expect(files("knowledge-base", "experiences")).toEqual([]);
    expect(files("knowledge-base", "education")).toEqual([]);
    expect(existsSync(join(home, "profile.md")) ? readFileSync(join(home, "profile.md"), "utf8") : "").not.toContain("Jordan Example");
  }, 60_000);

  it("approved once: with no document to compare with, the one confirmation shows every line in plain words, and everything in it is saved", async () => {
    answer = "accept";
    shown.length = 0;
    const r = await call("save_first_import", first);
    expect(r.isError, text(r)).toBeFalsy();
    // One confirmation, for the whole list, with line breaks (this client keeps them).
    expect(shown).toHaveLength(1);
    const box = shown[0];
    expect(box).toBe(
      [
        "Kairos: your first import. Nothing is saved yet.",
        "",
        "You: Jordan Example; Columbus, OH · jordan@example.com; headline: Software Engineer, Internal Tools.",
        "",
        "Job 1 of 2: Software Engineering Intern at Ledgerly, June 2025 to August 2025.",
        "Its 3 lines: (1) Internship on the internal tools team at Ledgerly. (2) Built a dashboard the operations team uses daily. (3) Wrote tests for the data pipeline.",
        "Kairos adds, to match job ads: skills: Python.",
        "",
        "Job 2 of 2: Software Engineering Intern at Harborline, June 2025 to August 2025.",
        "Its 3 lines: (1) Internship on the internal tools team at Harborline. (2) Shipped a reconciliation feature used by 40 internal users. (3) A line with no tag.",
        "Kairos adds, to match job ads: skills: Python.",
        "",
        "Education and credentials, 1 of 1: B.S. Computer Science (State University, 2027).",
        "Its line: (1) Expected May 2027.",
        "",
        "Accept saves all of it. Decline saves nothing.",
      ].join("\n"),
    );

    const out = JSON.parse(text(r));
    expect(out).toMatchObject({ ok: true, roles: 2, education: 1, approved: "all at once", confirmations: 1, index_refreshed: true });
    // No document's text was read through the tools here, so nothing is said about where the lines stand.
    expect(out.lines).toBeUndefined();
    expect(out.saved).toEqual(["profile.md", "knowledge-base/experiences/01-ledgerly.md", "knowledge-base/experiences/02-harborline.md", "knowledge-base/education/state-university.md"]);
    // A line with no tag is saved and named, as a single save names it.
    expect(out.untagged_facts).toEqual([{ file: "02-harborline.md", facts: [expect.objectContaining({ text: "- A line with no tag." })] }]);
    expect(files("knowledge-base", "experiences")).toEqual(["01-ledgerly.md", "02-harborline.md"]);
    expect(files("knowledge-base", "education")).toEqual(["state-university.md"]);
    expect(readFileSync(join(home, "profile.md"), "utf8")).toMatch(/headline: '?Software Engineer, Internal Tools/);
    // The documents are on every item, and the map of the knowledge base is written.
    expect(readFileSync(join(home, "knowledge-base", "experiences", "01-ledgerly.md"), "utf8")).toMatch(/sources:\n\s+- resume\.pdf/);
    expect(readFileSync(join(home, "knowledge-base", "_index.md"), "utf8")).toContain("02-harborline");
  }, 60_000);

  it("only the first import: what it saved is not asked again, a changed or other file refuses the call with no confirmation, and a save asks by itself", async () => {
    shown.length = 0;
    // The same items again: all of it is in the knowledge base as approved, so nothing is asked and nothing is written.
    const same = await call("save_first_import", first);
    expect(same.isError, text(same)).toBeFalsy();
    expect(JSON.parse(text(same))).toMatchObject({ ok: true, saved: [], approved: "nothing left to approve", confirmations: 0 });
    // One saved role with other content, or a knowledge base that holds a file this call does not name: not a first import.
    const changed = await call("save_first_import", { ...first, experiences: [ledgerly, { ...harborline, body: `${harborline.body}\n- A line added after the approval. [R]` }] });
    expect(changed.isError).toBe(true);
    expect(text(changed)).toMatch(/already holds 1 role or education file\(s\) that are not part of this import: this is not a first import/);
    const others = await call("save_first_import", { ...first, experiences: [role(7, "Quillstack", ["- A role of another import. [R]"])], education: [] });
    expect(others.isError).toBe(true);
    expect(text(others)).toMatch(/already holds 3 role or education file\(s\) that are not part of this import/);
    expect(shown).toEqual([]);
    expect(files("knowledge-base", "experiences")).toEqual(["01-ledgerly.md", "02-harborline.md"]);

    // A later save is shown and approved by itself, and refreshes the map without a rebuild_index call.
    const third = role(3, "Quillstack", ["- Wrote the SQL behind the weekly report. [C]"]);
    const saved = await call("save_experience", { ...third, expect_new: true });
    expect(saved.isError, text(saved)).toBeFalsy();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/^Kairos: add the role Software Engineering Intern at Quillstack \(03-quillstack\.md\)/);
    expect(JSON.parse(text(saved)).index_refreshed).toBe(true);
    expect(readFileSync(join(home, "knowledge-base", "_index.md"), "utf8")).toContain("03-quillstack");
  }, 60_000);

  it("save_resume writes the Word file with the profile's headline and returns the file and its layout: no second and third call", async () => {
    const appId = (
      await createApplication(new LocalStore(home), {
        company: "Brightwater Systems",
        role: "Junior Software Engineer",
        snapshotMarkdown: "# Junior Software Engineer\nBuild dashboards and data pipeline tests for our operations teams.",
        source_url_unavailable: true,
      })
    ).id;
    const resume = {
      resume: {
        header: { name: "Jordan Example", contact: "Columbus, OH · jordan@example.com" },
        executive_summary: "- **Internal tools:** internship on the internal tools team at Ledgerly.",
        experience: [{ company: "Ledgerly", title: "Software Engineering Intern", dates: "2025", bullets: ["Built a dashboard the operations team uses daily.", "Wrote tests for the data pipeline."] }],
        education: [{ institution: "State University", credential: "B.S. Computer Science" }],
        skills: ["Python"],
      },
      provenance_audit: [{ claim: "dashboard", source_experience: "01-ledgerly", prov: "R" }],
    };
    const saved = await call("save_resume", { appId, resume });
    expect(saved.isError, text(saved)).toBeFalsy();
    const out = JSON.parse(text(saved));
    // The file, by its full path on this disk, as render_docx names it.
    expect(out.docxPath).toBe(join(home, "applications", appId, "resume.docx"));
    // The layout's measure, in the shape check_resume_layout returns: a verdict with its text, or the note that
    // nothing could be measured (no render program on this machine, or it was busy: other tests use it too).
    if (out.layout.available) {
      expect(out.layout.verdict).toMatch(/^(good|short|overflow|bad-break)$/);
      expect(typeof out.layout.verdict_text).toBe("string");
      const checked = JSON.parse(text(await call("check_resume_layout", { appId })));
      if (checked.available) expect(Object.keys(out.layout).sort()).toEqual(Object.keys(checked).sort());
    } else expect(out.layout).toEqual({ available: false, note: expect.any(String) });
    // No headline was given: the Word file carries the profile's, and remembers it.
    const xml = await (await JSZip.loadAsync(readFileSync(out.docxPath))).file("word/document.xml")!.async("string");
    expect(xml).toContain("Software Engineer, Internal Tools");
    expect(JSON.parse(readFileSync(join(home, "applications", appId, "resume.json"), "utf8")).docx_headline).toBe("Software Engineer, Internal Tools");
    // A headline given wins over the profile's.
    const other = await call("save_resume", { appId, resume, headline: "Data Tools Engineer" });
    expect(other.isError, text(other)).toBeFalsy();
    const again = await (await JSZip.loadAsync(readFileSync(out.docxPath))).file("word/document.xml")!.async("string");
    expect(again).toContain("Data Tools Engineer");
    expect(again).not.toContain("Software Engineer, Internal Tools");
  }, 240_000);

  it("get_search_profile with nothing on file proposes settings and stores none; the save stores them, after the user's approval", async () => {
    const file = join(home, "sourcing", "search-profile.json");
    expect(existsSync(file)).toBe(false);
    const proposed = JSON.parse(text(await call("get_search_profile")));
    expect(proposed.stored).toBe(false);
    expect(proposed.profile.source).toBe("derived");
    expect(proposed.note).toMatch(/Nothing is stored yet/);
    // Read twice: still nothing on file.
    await call("get_search_profile");
    expect(existsSync(file)).toBe(false);

    // Declined: nothing on file.
    shown.length = 0;
    answer = "decline";
    const declined = await call("save_search_profile", { source: "confirmed", locations: ["columbus"] });
    expect(declined.isError).toBe(true);
    expect(existsSync(file)).toBe(false);
    // Approved: the file holds the derived settings with the user's change, and the confirmation showed all of it.
    answer = "accept";
    const saved = await call("save_search_profile", { source: "confirmed", locations: ["columbus"] });
    expect(saved.isError, text(saved)).toBeFalsy();
    expect(shown).toHaveLength(2);
    expect(shown[1]).toMatch(/^Kairos: save what the job search looks for/);
    expect(shown[1]).toContain("columbus");
    expect(shown[1]).toContain("max_age_days");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored).toMatchObject({ source: "confirmed", locations: ["columbus"], max_age_days: proposed.profile.max_age_days });
    expect(stored.function_terms).toEqual(proposed.profile.function_terms);
    const again = JSON.parse(text(await call("get_search_profile")));
    expect(again.stored).toBe(true);
    expect(again.note).toBeUndefined();
    // A later change shows only what changes.
    shown.length = 0;
    const changed = await call("save_search_profile", { source: "confirmed", boost_terms: ["internal tools"] });
    expect(changed.isError, text(changed)).toBeFalsy();
    expect(shown[0]).toMatch(/^Kairos: change what the job search looks for/);
    expect(shown[0]).toContain("internal tools");
    expect(shown[0]).not.toContain("columbus");
  }, 60_000);

  it("a tool that stopped on an error says what may have been saved and whether to call again, by what the tool does", () => {
    for (const read of ["list_applications", "read_application", "get_scoring_evidence", "load_context", "setup_status", "get_search_profile", "check_resume_layout"]) expect(afterStop(read), read).toBe("Nothing was changed. Calling this tool again is safe.");
    for (const write of ["save_resume", "save_cover_letter", "save_experience", "render_docx", "render_pdf", "mark_setup_section", "rebuild_index"]) {
      expect(afterStop(write), write).toMatch(/part of it may have been saved/);
      expect(afterStop(write), write).toMatch(/Calling the tool again with the same input writes the same content again: it is safe/);
    }
    // A second score is a second version: look first.
    expect(afterStop("save_score")).toMatch(/Call read_application to see whether it is there before saving again: saving it again when it was saved adds a second version/);
    expect(afterStop("capture_job_ad")).toMatch(/Call list_applications to see whether it is there\. Capturing the same posting again .* is safe/);
    expect(afterStop("set_application_status")).toMatch(/may or may not have been changed\. Call read_application to see it\. Setting the same status again is safe\.$/);
    // No tool is left without a sentence.
    expect(afterStop("a_tool_added_later")).toMatch(/may have been saved/);
  });
});

/**
 * The same server, a document read through its own tool first: the first import is then a summary the
 * user reads at a glance, with the choice to go one by one (invented data).
 */
describe("Kairos MCP server: the first import after a document was read", () => {
  const home = mkdtempSync(join(tmpdir(), "kairos-first-run-doc-"));
  const folder = mkdtempSync(join(tmpdir(), "kairos-first-run-files-"));
  let client: Client;
  const asked: { message: string; fields: string[] }[] = [];
  const answers: { action: "accept" | "decline" | "cancel"; content?: Record<string, string> }[] = [];
  const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
  const resume = [
    "Jordan Example",
    "Columbus, OH · jordan@example.com",
    "Software Engineering Intern, Ledgerly, June 2025 to August 2025",
    "Built a dashboard the operations team uses daily.",
    "Wrote tests for the data pipeline in Python.",
    "B.S. Computer Science, State University, expected 2027",
    "Summary",
    "Computer science student with two years of Python.",
    "Skills",
    "Python, SQL, Git",
    "Languages",
    "English (native)",
  ].join("\n");
  const list = {
    // The résumé's own list of skills and its languages, in its words; "Kafka" is not on it.
    profile: { name: "Jordan Example", contact_line: "Columbus, OH · jordan@example.com", summary: "Computer science student with two years of Python.", skills: ["Python", "SQL", "Git", "Kafka"], languages: ["English (native)"] },
    experiences: [
      {
        fileName: "01-ledgerly.md",
        frontmatter: { id: "ledgerly", company: "Ledgerly", title: "Software Engineering Intern", start: "2025-06", end: "2025-08", skills: [{ name: "Python", prov: "R" }, { name: "Kubernetes", prov: "R" }] },
        body: "## Achievements\n- Built a dashboard the operations team uses daily. [R]\n- Wrote tests for the data pipeline in Python. [R]\n- Owned the release process. [R]",
      },
    ],
    education: [{ fileName: "state-university.md", frontmatter: { institution: "State University", credential: "B.S. Computer Science", dates: "expected 2027" }, body: "- B.S. Computer Science, State University, expected 2027 [R]" }],
    sources: ["resume.txt"],
  };

  beforeAll(async () => {
    writeFileSync(join(folder, "resume.txt"), resume);
    client = new Client({ name: "test", version: "0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push({ message: request.params.message, fields: Object.keys((request.params as { requestedSchema?: { properties?: object } }).requestedSchema?.properties ?? {}) });
      return answers.shift() ?? { action: "decline" };
    });
    await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "apps/local/mcp/server.ts"], env: { ...process.env, KAIROS_HOME: home } as Record<string, string>, stderr: "ignore" }));
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it("the summary counts the lines that are the document's own, shows the line and the skill that are not, and offers the choice; one by one then shows every line", async () => {
    answers.push({ action: "accept" });
    const read = await client.callTool({ name: "prepare_extraction", arguments: { path: join(folder, "resume.txt") } });
    expect(read.isError, text(read)).toBeFalsy();
    answers.push({ action: "accept", content: { how: "Show me each item, one by one" } }, { action: "accept" }, { action: "accept" });
    const saved = await client.callTool({ name: "save_first_import", arguments: list });
    expect(saved.isError, text(saved)).toBeFalsy();
    const [, summary, job, entry] = asked;
    expect(asked).toHaveLength(4);
    expect(summary.fields).toEqual(["how"]);
    expect(summary.message).toBe(
      [
        "Kairos read your document, resume.txt. Nothing is saved yet.",
        "",
        "It will save:",
        'You: Jordan Example; Columbus, OH · jordan@example.com; what you say of yourself: "Computer science student with two years of Python."; your skills, as you list them: Python, SQL, Git, Kafka; languages: English (native).',
        "1 job: Software Engineering Intern at Ledgerly, June 2025 to August 2025 (3 lines).",
        "1 education or credential entry: B.S. Computer Science (State University, expected 2027).",
        "",
        "3 of the 4 lines are word for word from your document. 1 is not: Claude worded it. Check it:",
        '(1) "Owned the release process." (job 1: Software Engineering Intern at Ledgerly)',
        'Also not in your document: the skill "Kafka" (your profile).',
        "",
        "Kairos also adds, to match job ads, the skills, search words and sizes it reads in those lines. 1 is not a word from your document: Kubernetes.",
        "",
        "Choose below: save all of it, or see each item one by one. Decline saves nothing. You can read and correct every line afterwards: ask to see your knowledge base.",
      ].join("\n"),
    );
    expect(job.fields).toEqual([]);
    expect(job.message).toContain("Kairos: your first import, part 1 of 2. Nothing of this part is saved yet.");
    expect(job.message).toContain("Its 3 lines: (1) Built a dashboard the operations team uses daily. (2) Wrote tests for the data pipeline in Python. (3) Owned the release process. [Claude's wording, not in your document]");
    expect(job.message).toContain("Kairos adds, to match job ads: skills: Python, Kubernetes.");
    expect(entry.message).toContain("part 2 of 2");
    const out = JSON.parse(text(saved));
    expect(out).toMatchObject({ ok: true, approved: "one by one", confirmations: 3, lines: { total: 4, word_for_word: 3, claude_wording: ["Owned the release process. [R]"] } });
    expect(readdirSync(join(home, "knowledge-base", "experiences")).filter((f) => !f.startsWith("_"))).toEqual(["01-ledgerly.md"]);
    // The person's own list and their languages are in the profile, as approved, for the Assessor and the Writer.
    const profile = readFileSync(join(home, "profile.md"), "utf8");
    expect(profile).toMatch(/skills:\n\s+- Python\n\s+- SQL\n\s+- Git\n\s+- Kafka\n/);
    expect(profile).toMatch(/languages:\n\s+- English \(native\)\n/);
    expect(profile).toContain("summary: Computer science student with two years of Python.");
  }, 60_000);

  it("the Assessor and the Writer are given the list; a question that suggests its answer comes back to be reworded; a résumé in the wrong shape says that nothing was saved", async () => {
    const appId = (await createApplication(new LocalStore(home), { company: "Brightwater Systems", role: "Junior Software Engineer", snapshotMarkdown: "# Junior Software Engineer\nPython, SQL and Git.", source_url_unavailable: true })).id;
    const scoring = JSON.parse(text(await client.callTool({ name: "get_scoring_evidence", arguments: { appId } })));
    expect(scoring.user_message).toContain('"skills": [\n        "Python",\n        "SQL",\n        "Git",\n        "Kafka"\n      ]');
    expect(scoring.system_prompt).toContain("An item on either list is stated by the candidate: never report it as a gap");

    // A question that suggests its answer does not stop the score: it is saved, and the question comes back to be reworded before it is asked.
    const report = {
      parse_safety: { verdict: "PASS", checks: [], ats_specific_note: "Plain text." },
      match: { detected_ats: "unknown", dimensions: [{ name: "hard_skills", score: 60, justification: "Python is on the résumé." }], overall_band: "COMPETITIVE", confidence: "medium", pool_caveat: "The ranking depends on who else applies, which cannot be known." },
      authenticity: { score: 80, flags: [], strengths: [] },
      gaps: [{ requirement: "Git", severity: "IMPORTANT", type: "possibly_uncaptured", clarifying_question: "Did you use Git (commits, branches, pull requests) in the internship?" }],
      reachable: { band_if_tailored: "COMPETITIVE", from_reframing: [], needs_user_confirmation: [], honest_ceiling_note: "None." },
      recommendation: "APPLY_AFTER_TAILORING",
    };
    const leading = await client.callTool({ name: "save_score", arguments: { appId, report } });
    expect(leading.isError, text(leading)).toBeFalsy();
    expect(JSON.parse(text(leading)).questions_to_reword_before_asking.items).toEqual([{ question: "Did you use Git (commits, branches, pull requests) in the internship?", suggests: "(commits, branches, pull requests)" }]);

    // The inner object where the whole one is expected (the run's first failed save): refused with the shape, and "nothing was saved".
    const inner = await client.callTool({ name: "save_resume", arguments: { appId, resume: { header: { name: "Jordan Example", contact: "x" }, executive_summary: "x", experience: [], education: [], skills: [] } } });
    expect(inner.isError).toBe(true);
    expect(text(inner)).toContain('The whole object is expected: { "resume": {');
    expect(text(inner)).toMatch(/Nothing was saved\.$/);
    expect(text(inner)).not.toContain("This stopped before it finished");
    // (The Writer's evidence needs a score first; that it carries the list is tested in tests/trial-fixes.test.ts.)
  }, 60_000);

  it("a résumé that differs from the knowledge base is saved, with what to put right; a choice the user makes once is remembered in the profile, shown to them, and not raised again", async () => {
    const appId = (await createApplication(new LocalStore(home), { company: "Northwind", role: "Software Engineer", snapshotMarkdown: "# Software Engineer\nPython.", source_url_unavailable: true })).id;
    const resume = {
      resume: {
        header: { name: "Jordan Example", contact: "Columbus, OH · jordan@example.com" },
        executive_summary: "- **Intern:** Software Engineering Intern at Ledgerly.",
        // The role ended in August 2025 in the knowledge base; the user wants it written as current.
        experience: [{ company: "Ledgerly", title: "Software Engineering Intern", dates: "Jun 2025 - Present", bullets: ["Built a dashboard the operations team uses daily."] }],
        education: [],
        skills: ["Python"],
      },
      provenance_audit: [{ claim: "Built a dashboard", source_experience: "01-ledgerly.md", prov: "R" }],
    };
    const first = await client.callTool({ name: "save_resume", arguments: { appId, resume } });
    expect(first.isError, text(first)).toBeFalsy();
    const out = JSON.parse(text(first));
    expect(out.put_right_before_showing.items).toEqual([
      {
        key: "dates|ledgerly|2025 present",
        kind: "dates_differ",
        what: '"Jun 2025 - Present" under "Ledgerly": the knowledge base holds 2025-06 to 2025-08 for that entry. Write its dates as they are',
        // What the user reads: what is on the résumé and what their knowledge base holds, and nothing more.
        say: 'The dates "Jun 2025 - Present" are on this résumé. Your knowledge base has other dates for that entry.',
      },
    ]);
    expect(out.put_right_before_showing.how).toContain("If the user asked for it themselves, change nothing: it is theirs");
    expect(out.tell_the_user.how).toContain('in plain words, with no judgement and no "you must"');
    expect(out.kept_by_the_users_choice).toBeUndefined();

    // The user says: keep it, on every résumé. Their choice goes into the profile, with their approval and in their words.
    asked.length = 0;
    answers.push({ action: "accept" });
    const kept = await client.callTool({ name: "save_profile", arguments: { resume_choices: [{ key: out.put_right_before_showing.items[0].key, says: "My Ledgerly internship stays written to Present" }] } });
    expect(kept.isError, text(kept)).toBeFalsy();
    expect(asked[0]!.message).toContain("+ kept on every résumé, and not raised again: My Ledgerly internship stays written to Present");
    expect(readFileSync(join(home, "profile.md"), "utf8")).toMatch(/resume_choices:\n\s+- key: dates\|ledgerly\|2025 present\n\s+says: My Ledgerly internship stays written to Present\n\s+since: '?\d{4}-\d{2}-\d{2}/);
    const second = JSON.parse(text(await client.callTool({ name: "save_resume", arguments: { appId, resume } })));
    expect(second.put_right_before_showing.items).toEqual([]);
    expect(second.kept_by_the_users_choice.count).toBe(1);

    // They change their mind: the choice is taken off, shown to them, and the difference is raised again.
    answers.push({ action: "accept" });
    await client.callTool({ name: "save_profile", arguments: { resume_choices: [{ key: "dates|ledgerly|2025 present", remove: true }] } });
    expect(asked[asked.length - 1]!.message).toContain("- no longer kept on every résumé: My Ledgerly internship stays written to Present");
    const third = JSON.parse(text(await client.callTool({ name: "save_resume", arguments: { appId, resume } })));
    expect(third.put_right_before_showing.items).toHaveLength(1);
  }, 60_000);

  it("the user asks to rename a section heading: it is saved as theirs with their approval, and the next résumé is written with it", async () => {
    const appId = (await createApplication(new LocalStore(home), { company: "Quillstack", role: "Software Engineer", snapshotMarkdown: "# Software Engineer\nPython.", source_url_unavailable: true })).id;
    const resume = {
      resume: {
        header: { name: "Jordan Example", contact: "Columbus, OH · jordan@example.com" },
        executive_summary: "- **Intern:** Software Engineering Intern at Ledgerly.",
        experience: [{ company: "Ledgerly", title: "Software Engineering Intern", dates: "Jun 2025 - Aug 2025", bullets: ["Built a dashboard the operations team uses daily."] }],
        education: [],
        skills: ["Python"],
      },
      provenance_audit: [{ claim: "Built a dashboard", source_experience: "01-ledgerly.md", prov: "R" }],
    };
    const headings = async () => (await new LocalStore(home).readFile(["applications", appId, "resume-source.md"]))!.split("\n").filter((l) => l.startsWith("## "));
    await client.callTool({ name: "save_resume", arguments: { appId, resume } });
    expect(await headings()).toEqual(["## Executive Summary", "## Professional Experience", "## Skills"]);

    // "Call it Summary, and call the jobs Experience."
    asked.length = 0;
    answers.push({ action: "accept" });
    const renamed = await client.callTool({ name: "save_profile", arguments: { resume_headings: { summary: "Summary", experience: "Experience" } } });
    expect(renamed.isError, text(renamed)).toBeFalsy();
    expect(asked[0]!.message).toContain('+ résumé heading: "Executive Summary" becomes "Summary" on every later résumé');
    expect(asked[0]!.message).toContain('+ résumé heading: "Professional Experience" becomes "Experience" on every later résumé');
    expect(readFileSync(join(home, "profile.md"), "utf8")).toMatch(/resume_headings:\n\s+summary: Summary\n\s+experience: Experience\n/);
    // The answer says that a résumé already saved keeps its headings, so that Claude does not write the saved files again for nothing.
    expect(JSON.parse(text(renamed)).headings_note).toBe(
      "The new heading is on every résumé written from now on (save_resume). A résumé already saved keeps the headings it was written with, and writing its Word file again (render_docx) does not change them: do not render saved résumés again for this. Tell the user in one line that the résumés already written keep the old heading until they are written again, and write one again only if they ask.",
    );
    // Which is so: the Word file written again from the saved résumé has the headings it was saved with.
    await client.callTool({ name: "render_docx", arguments: { appId } });
    expect(await headings()).toEqual(["## Executive Summary", "## Professional Experience", "## Skills"]);
    await client.callTool({ name: "save_resume", arguments: { appId, resume } });
    expect(await headings()).toEqual(["## Summary", "## Experience", "## Skills"]);
    // A change of the profile that renames no heading carries no such note.
    answers.push({ action: "accept" });
    expect(JSON.parse(text(await client.callTool({ name: "save_profile", arguments: { headline: "Software engineer" } })))).not.toHaveProperty("headings_note");
    // One sentence kept under two findings is one line in the approval, not the same line twice.
    asked.length = 0;
    answers.push({ action: "accept" });
    await client.callTool({ name: "save_profile", arguments: { resume_choices: [{ key: "years|three years", says: "The sentence stays as it is" }, { key: "line|three years building dashboards", says: "The sentence stays as it is" }] } });
    expect(asked[0]!.message.match(/kept on every résumé, and not raised again: The sentence stays as it is/g)).toHaveLength(1);
    expect(readFileSync(join(home, "profile.md"), "utf8")).toMatch(/key: years\|three years[\s\S]*key: line\|three years building dashboards/);
    asked.length = 0;
    answers.push({ action: "accept" });
    await client.callTool({ name: "save_profile", arguments: { resume_choices: [{ key: "years|three years", remove: true }, { key: "line|three years building dashboards", remove: true }] } });
    expect(asked[0]!.message.match(/no longer kept on every résumé: The sentence stays as it is/g)).toHaveLength(1);
    expect(readFileSync(join(home, "profile.md"), "utf8")).not.toContain("three years");
    // The Writer's evidence names the user's headings.
    // One heading renamed later leaves the other as it is; its default name puts the default back.
    answers.push({ action: "accept" });
    await client.callTool({ name: "save_profile", arguments: { resume_headings: { summary: "Executive Summary" } } });
    expect(asked[asked.length - 1]!.message).toContain('+ résumé heading: "Summary" becomes "Executive Summary" on every later résumé');
    await client.callTool({ name: "save_resume", arguments: { appId, resume } });
    expect(await headings()).toEqual(["## Executive Summary", "## Experience", "## Skills"]);
    // What is not a heading is refused before anything is asked.
    const before = asked.length;
    const bad = await client.callTool({ name: "save_profile", arguments: { resume_headings: { skills: "#" } } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('"#" cannot be a section heading');
    expect(asked).toHaveLength(before);
    // A declined change leaves the headings as they were.
    answers.push({ action: "decline" });
    await client.callTool({ name: "save_profile", arguments: { resume_headings: { experience: "Work History" } } });
    await client.callTool({ name: "save_resume", arguments: { appId, resume } });
    expect(await headings()).toEqual(["## Executive Summary", "## Experience", "## Skills"]);
  }, 60_000);
});
