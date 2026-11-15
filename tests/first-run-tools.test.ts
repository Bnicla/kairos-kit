import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
 * (invented data): the first import is approved once, in one confirmation that
 * shows every item in full, and only while the knowledge base is empty; the
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

  it("a list too long to show in full is not cut and not saved: the items then go one by one", async () => {
    const long = Array.from({ length: 12 }, (_, i) => role(i + 1, `Company${i + 1}`, Array.from({ length: 14 }, (_, j) => `- Result number ${j + 1} at company ${i + 1}, told in a full sentence. [R]`)));
    const r = await call("save_first_import", { ...first, experiences: long.map((e, i) => ({ ...e, fileName: `${String(i + 1).padStart(2, "0")}-company.md` })) });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/too long to show in one confirmation/);
    expect(text(r)).toMatch(/call save_profile, then save_experience for each role and save_education for each school/);
    expect(shown).toEqual([]);
    expect(files("knowledge-base", "experiences")).toEqual([]);
  }, 60_000);

  it("declined: one confirmation was shown and nothing is saved, not even the profile", async () => {
    answer = "decline";
    const r = await call("save_first_import", first);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/the user did not approve/);
    expect(shown).toHaveLength(1);
    expect(files("knowledge-base", "experiences")).toEqual([]);
    expect(files("knowledge-base", "education")).toEqual([]);
    expect(existsSync(join(home, "profile.md")) ? readFileSync(join(home, "profile.md"), "utf8") : "").not.toContain("Jordan Example");
  }, 60_000);

  it("approved once: the one confirmation shows every item in full, and everything in it is saved", async () => {
    answer = "accept";
    shown.length = 0;
    const r = await call("save_first_import", first);
    expect(r.isError, text(r)).toBeFalsy();
    // One confirmation, for the whole list.
    expect(shown).toHaveLength(1);
    const box = shown[0];
    expect(box).toMatch(/^Kairos: save your first import: your profile, 2 roles, 1 school\n/);
    expect(box).toContain("Accept saves all of it to your knowledge base. Decline if any of it is wrong: nothing is saved.");
    // Every item in full: the profile's three fields, each role's fields and every line of its text, the school.
    for (const line of ["+ name: Jordan Example", "+ contact_line: Columbus, OH · jordan@example.com", "+ headline: Software Engineer, Internal Tools"]) expect(box).toContain(line);
    expect(box).toContain("Role 1 of 2: Software Engineering Intern at Ledgerly (01-ledgerly.md)");
    expect(box).toContain("Role 2 of 2: Software Engineering Intern at Harborline (02-harborline.md)");
    expect(box).toContain("School 1 of 1: state-university.md");
    for (const item of [ledgerly, harborline, school]) for (const line of item.body.split("\n").filter(Boolean)) expect(box, line).toContain(`+ ${line}`);
    for (const field of ["+ company: Ledgerly", "+ start: 2025-06", "+ institution: State University", "+ credential: B.S. Computer Science"]) expect(box).toContain(field);

    const out = JSON.parse(text(r));
    expect(out).toMatchObject({ ok: true, roles: 2, schools: 1, index_refreshed: true });
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

  it("only the first import: once the knowledge base holds a role, the same call is refused with no confirmation, and a save asks by itself", async () => {
    shown.length = 0;
    const again = await call("save_first_import", first);
    expect(again.isError).toBe(true);
    expect(text(again)).toMatch(/already holds 3 role or school file\(s\): this is not a first import/);
    expect(shown).toEqual([]);

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
