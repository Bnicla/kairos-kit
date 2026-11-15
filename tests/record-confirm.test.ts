import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { askToSave, bodyChanges, changedFields, diffPreview, fits, jsonDiff, markdownDiff, newLines, recordFileDiff, removedFields, removedLines, type Confirmer } from "../apps/local/lib/record-confirm";

describe("record-confirm helpers", () => {
  const confirmer = (supports: boolean, action: "accept" | "decline" | "cancel", seen: string[] = []): Confirmer => ({
    supportsElicitation: () => supports,
    elicit: async (p) => {
      seen.push(p.message);
      return { action };
    },
  });
  it("newLines keeps only lines that are not already on file", () => {
    expect(newLines("- a [R]\n- b [R]\n", "- a [R]\n- b [R]\n- c [C]\n\n")).toEqual(["- c [C]"]);
    expect(newLines(null, "x\n\ny")).toEqual(["x", "y"]);
  });

  it("changedFields shows new and changed fields, skips equal and skipped ones", () => {
    expect(changedFields({ title: "PM", company: "Acme", sources: ["a"] }, { title: "Senior PM", company: "Acme", sources: ["b"], start: "2020" }, ["sources"])).toEqual([
      "title: PM → Senior PM",
      "start: 2020",
    ]);
  });

  it("a replaced file shows what is removed as well as what is new", () => {
    const before = "- led the launch [R]\n- grew revenue 20% [R]\n";
    const after = "- led the launch [R]\n- managed a team of 4 [C]\n";
    expect(removedLines(before, after)).toEqual(["- grew revenue 20% [R]"]);
    expect(diffPreview(newLines(before, after), removedLines(before, after))).toEqual(["New or changed:", "+ - managed a team of 4 [C]", "", "Removed:", "- - grew revenue 20% [R]"]);
  });

  it("a role saved again shows every change: a field that is dropped, a line that moves, a line that is repeated", () => {
    const before = {
      data: { company: "Ledgerly", start: "2025-06", end: "2025-09", skills: ["Python", "SQL"], sources: ["resume.pdf"] },
      content: "\n## What I did\n- Shipped a reconciliation feature. [R]\n- Wrote tests for the data pipeline. [R]\n\n## Results\n- Used by 40 internal users. [R]\n",
    };
    // The same lines exist afterwards, so a comparison of which lines exist finds nothing.
    const body = "\n## What I did\n- Shipped a reconciliation feature. [R]\n\n## Results\n- Used by 40 internal users. [R]\n- Wrote tests for the data pipeline. [R]\n- Used by 40 internal users. [R]\n";
    expect(newLines(before.content, body)).toEqual([]);
    expect(removedLines(before.content, body)).toEqual([]);
    // The new frontmatter leaves out the skills and the end date.
    const frontmatter = { company: "Ledgerly", start: "2025-06" };
    expect(removedFields(before.data, frontmatter, ["sources"])).toEqual(["end: 2025-09", "skills: Python, SQL"]);
    expect(recordFileDiff(before, frontmatter, body, ["sources"])).toEqual([
      "New or changed:",
      "+ - Used by 40 internal users. [R] (repeated: 2 times, 1 before)",
      "",
      "Removed:",
      "- end: 2025-09",
      "- skills: Python, SQL",
      "",
      "Moved to another section:",
      '~ - Wrote tests for the data pipeline. [R] (from "What I did" to "Results")',
    ]);
    // A copy that goes, a line under no heading, and a file that does not change at all.
    expect(bodyChanges("a\na\nb\n## H\nc", "a\n## H\nb\nc")).toEqual({ added: [], removed: ["a (1 of its 2 copies)"], moved: ['b (from the top of the file to "H")'] });
    expect(markdownDiff(before.content, before.content)).toEqual([]);
    expect(recordFileDiff(before, before.data, before.content)).toEqual([]);
    // A new file shows all of it, as before.
    expect(recordFileDiff(null, { company: "Ledgerly" }, "## What I did\n- One line. [R]")).toEqual(["New or changed:", "+ company: Ledgerly", "+ ## What I did", "+ - One line. [R]"]);
  });

  it("jsonDiff lists changed and removed values by path", () => {
    expect(jsonDiff({ contact: { phone: "1", city: "A" }, t: "x" }, { contact: { phone: "2" }, t: "y" }, ["t"])).toEqual(["New or changed:", "+ contact.phone: 2", "", "Removed:", "- contact.phone: 1", "- contact.city: A"]);
  });

  it("a preview too long to show in full is refused, never cut", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    expect(fits(long)).toBe(false);
    const seen: string[] = [];
    expect(await askToSave(confirmer(true, "accept", seen), "add a role", long)).toMatch(/too long to show/);
    expect(seen).toEqual([]);
  });



  it("askToSave: approved only on the user's Accept", async () => {
    const seen: string[] = [];
    expect(await askToSave(confirmer(true, "accept", seen), "add a fact", "- led a team of 4 [C]")).toBeNull();
    expect(seen[0]).toContain("- led a team of 4 [C]");
    expect(await askToSave(confirmer(true, "decline"), "add a fact", "x")).toMatch(/Nothing was saved/);
    expect(await askToSave(confirmer(true, "cancel"), "add a fact", "x")).toMatch(/Nothing was saved/);
  });

  it("askToSave: a client without confirmations cannot save", async () => {
    expect(await askToSave(confirmer(false, "accept"), "add a fact", "x")).toMatch(/did not offer one/);
  });
});

// The real server over stdio, against a client that answers its confirmations.
describe("Kairos MCP server: writes to the knowledge base need the user's approval", () => {
  const home = mkdtempSync(join(tmpdir(), "kairos-confirm-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  async function connect(answer: "accept" | "decline" | null) {
    const client = new Client({ name: "test", version: "0" }, { capabilities: answer ? { elicitation: {} } : {} });
    const asked: string[] = [];
    if (answer) {
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        asked.push(String((req.params as { message?: string }).message));
        return { action: answer };
      });
    }
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "apps/local/mcp/server.ts"],
      env: { ...process.env, KAIROS_HOME: home } as Record<string, string>,
      stderr: "ignore",
    });
    await client.connect(transport);
    return { client, asked };
  }
  const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
  const profile = () => (existsSync(join(home, "profile.md")) ? readFileSync(join(home, "profile.md"), "utf8") : "");

  it("decline: nothing saved, and the user saw the change", async () => {
    const { client, asked } = await connect("decline");
    const r = await client.callTool({ name: "save_profile", arguments: { headline: "Head of Everything" } });
    await client.close();
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/did not approve/);
    expect(asked[0]).toContain("headline: Head of Everything");
    expect(profile()).not.toContain("Head of Everything");
  }, 60_000);

  it("no confirmation support: nothing saved", async () => {
    const { client } = await connect(null);
    const r = await client.callTool({ name: "save_profile", arguments: { headline: "Head of Everything" } });
    await client.close();
    expect(r.isError).toBe(true);
    expect(profile()).not.toContain("Head of Everything");
  }, 60_000);

  it("prepare_extraction: the user approves the exact file before it is read", async () => {
    const doc = join(home, "resume.txt");
    writeFileSync(doc, "Jordan Example\nData analyst intern at Acme, 2024. Built the weekly dashboard used by the sales team. ".repeat(3));
    const { client, asked } = await connect("decline");
    const r = await client.callTool({ name: "prepare_extraction", arguments: { path: doc } });
    await client.close();
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Nothing was read/);
    expect(asked[0]).toContain("resume.txt");
    expect(text(r)).not.toContain("weekly dashboard");
  }, 60_000);

  it("save_autofill asks too", async () => {
    const { client, asked } = await connect("decline");
    const r = await client.callTool({ name: "save_autofill", arguments: { contact: { phone: "555-0100" } } });
    await client.close();
    expect(r.isError).toBe(true);
    expect(asked[0]).toContain("555-0100");
    expect(existsSync(join(home, "autofill.json"))).toBe(false);
  }, 60_000);

  it("accept: saved", async () => {
    const { client } = await connect("accept");
    const r = await client.callTool({ name: "save_profile", arguments: { headline: "Product Manager" } });
    await client.close();
    expect(r.isError).toBeFalsy();
    expect(profile()).toContain("Product Manager");
  }, 60_000);
});
