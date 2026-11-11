import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { askToSave, changedFields, clip, newLines, type Confirmer } from "../apps/local/lib/record-confirm";

describe("record-confirm helpers", () => {
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

  it("clip caps a long preview", () => {
    const out = clip(Array.from({ length: 100 }, (_, i) => `line ${i}`));
    expect(out.split("\n")).toHaveLength(41);
    expect(out).toMatch(/and 60 more line/);
  });

  const confirmer = (supports: boolean, action: "accept" | "decline" | "cancel", seen: string[] = []): Confirmer => ({
    supportsElicitation: () => supports,
    elicit: async (p) => {
      seen.push(p.message);
      return { action };
    },
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
describe("Kairos MCP server: writes to the record need the user's approval", () => {
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

  it("accept: saved", async () => {
    const { client } = await connect("accept");
    const r = await client.callTool({ name: "save_profile", arguments: { headline: "Product Manager" } });
    await client.close();
    expect(r.isError).toBeFalsy();
    expect(profile()).toContain("Product Manager");
  }, 60_000);
});
