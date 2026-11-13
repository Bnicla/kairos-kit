import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LocalStore } from "@/store/local-fs";
import { createApplication } from "@kairos/engine/applications";

/**
 * The real MCP server over stdio against a temporary data folder (invented
 * demo data): untagged facts are reported on save, a cover letter's numbers
 * are checked against the record and the metrics register, and documents are
 * rendered on the paper the settings give.
 */
describe("Kairos MCP server: record, register and paper", () => {
  const home = mkdtempSync(join(tmpdir(), "kairos-repairs-"));
  let client: Client;
  let appId: string;
  const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
  const pageSize = async (file: string) =>
    (await (await JSZip.loadAsync(readFileSync(join(home, "applications", appId, file)))).file("word/document.xml")!.async("string")).match(/<w:pgSz[^>]*>/)?.[0] ?? "";

  beforeAll(async () => {
    const store = new LocalStore(home);
    await store.writeFile(["profile.md"], "---\nname: Jordan Example\ncontact_line: Springfield · jordan@example.com\n---\n# Candidate profile\n");
    await store.writeFile(
      ["knowledge-base", "metrics-register.md"],
      "# Metrics register\n\n## Ledgerly (01-ledgerly-intern.md, 2025)\n\n**Checkout errors down 60%** — RETIRED: never measured\n\n**Internal users 40+** — SCOPE\n",
    );
    appId = (
      await createApplication(store, {
        company: "Globex",
        role: "Software Engineer",
        snapshotMarkdown: "# Software Engineer\nJoin a team of engineers building internal tools for finance.",
        source_url_unavailable: true,
      })
    ).id;
    client = new Client({ name: "test", version: "0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept" }));
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

  it("save_experience saves the file and lists the fact lines that carry no tag", async () => {
    const r = await client.callTool({
      name: "save_experience",
      arguments: {
        fileName: "01-ledgerly-intern.md",
        frontmatter: { id: "ledgerly-intern", company: "Ledgerly", title: "Software Engineering Intern", start: "2025", end: "2025" },
        body: [
          "## Summary",
          "Summer internship on the internal tools team. [R]",
          "",
          "## Achievements",
          "- Shipped a reconciliation feature used by 40+ internal users. [R]",
          "- Cut checkout errors by 60%. [R]",
          "- Rewrote the nightly export, which now runs in 12% of the time.",
        ].join("\n"),
      },
    });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(text(r));
    expect(out.saved).toBe("knowledge-base/experiences/01-ledgerly-intern.md");
    expect(out.untagged_facts).toEqual([{ line: 7, section: "Achievements", text: "- Rewrote the nightly export, which now runs in 12% of the time." }]);
    expect(out.untagged_note).toMatch(/not used as evidence until tagged/);
    // The evidence view leaves the untagged line out.
    const evidence = JSON.parse(text(await client.callTool({ name: "read_experience", arguments: { fileName: "01-ledgerly-intern.md" } })));
    expect(evidence.markdown).toContain("40+ internal users");
    expect(evidence.markdown).not.toContain("12%");
  }, 60_000);

  // A body long enough for the prose gate (80 words), with one sentence that carries the number under test.
  const letter = (line: string) =>
    [
      "Jordan Example",
      "Springfield · jordan@example.com",
      "",
      "Dear hiring team,",
      "",
      `I am applying for the Software Engineer role on your internal tools team. ${line}`,
      "",
      "During my internship at Ledgerly I worked with the operations staff every week, watched how they closed the books, and built the tool around the steps they already followed. I wrote the tests for the data pipeline myself and kept the feature small enough to ship before the internship ended.",
      "",
      "Your posting describes tools for finance teams, which is the work I did and the work I would like to keep doing. I can walk through the code and the decisions behind it whenever it suits you.",
      "",
      "Sincerely,",
      "Jordan Example",
      "",
    ].join("\n");

  it("save_cover_letter refuses a number from an untagged line and a number the register withholds", async () => {
    const untagged = await client.callTool({ name: "save_cover_letter", arguments: { appId, markdown: letter("At Ledgerly I rewrote the nightly export, which now runs in 12% of the time.") } });
    expect(untagged.isError).toBe(true);
    expect(text(untagged)).toMatch(/not in the user's verified record, profile, education or the posting: 12%/);

    const retired = await client.callTool({ name: "save_cover_letter", arguments: { appId, markdown: letter("At Ledgerly I cut checkout errors by 60%.") } });
    expect(retired.isError).toBe(true);
    expect(text(retired)).toMatch(/withheld by the metrics register: "60%" matches the metrics-register entry "Checkout errors down 60%" \(RETIRED/);
  }, 60_000);

  it("save_cover_letter saves a letter with an allowed number, on US Letter by default", async () => {
    const r = await client.callTool({ name: "save_cover_letter", arguments: { appId, markdown: letter("At Ledgerly I shipped a reconciliation feature used by 40+ internal users.") } });
    expect(r.isError, text(r)).toBeFalsy();
    expect(await pageSize("cover-letter.docx")).toMatch(/w:w="12240"[^>]*w:h="15840"/);
  }, 120_000);

  it("save_resume and render_docx use the paper setting, and save_resume refuses the retired number", async () => {
    const resume = (bullet: string) => ({
      resume: {
        header: { name: "Jordan Example", contact: "Springfield · jordan@example.com" },
        executive_summary: "- **Software engineer:** builds internal tools for finance teams.",
        experience: [{ company: "Ledgerly", title: "Software Engineering Intern", dates: "2025", bullets: [bullet] }],
        education: [{ institution: "Springfield State", credential: "BSc Computer Science" }],
        skills: ["React", "Python"],
      },
      provenance_audit: [{ claim: "reconciliation feature", source_experience: "01-ledgerly-intern", prov: "R" }],
    });
    const refused = await client.callTool({ name: "save_resume", arguments: { appId, resume: resume("Cut checkout errors by 60%.") } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/metrics register does not allow: "60%"/);

    const saved = await client.callTool({ name: "save_resume", arguments: { appId, resume: resume("Shipped a reconciliation feature used by 40+ internal users.") } });
    expect(saved.isError, text(saved)).toBeFalsy();
    expect(JSON.parse(text(saved)).paper).toBe("letter");
    // The origin of each line, found in code: the bullet is its own fact, the summary rests on the role's summary line.
    expect(JSON.parse(text(saved)).line_origins).toEqual({ strong: 2, partial: 0, none: 0, no_origin: [], audit_disagreements: [] });
    expect(await pageSize("resume.docx")).toMatch(/w:w="12240"/);

    // The user asks for A4 in profile.md: the next render follows it.
    const store = new LocalStore(home);
    await store.writeFile(["profile.md"], "---\nname: Jordan Example\ncontact_line: Springfield · jordan@example.com\npaper: a4\n---\n# Candidate profile\n");
    const rendered = await client.callTool({ name: "render_docx", arguments: { appId } });
    expect(JSON.parse(text(rendered)).paper).toBe("a4");
    expect(await pageSize("resume.docx")).toMatch(/w:w="11906"[^>]*w:h="16838"/);
  }, 180_000);
});
