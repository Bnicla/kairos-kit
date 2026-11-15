import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LocalStore } from "@/store/local-fs";
import { createApplication } from "@kairos/engine/applications";
import type { ScoreReport } from "@kairos/engine/types";

/**
 * The real MCP server over stdio against a temporary data folder: import a
 * LinkedIn export, list the contacts at a company, and get them back from
 * save_score when the application is a good match. Every person and company
 * is invented.
 */
describe("Kairos MCP server: contacts and referrals", () => {
  const home = mkdtempSync(join(tmpdir(), "kairos-contacts-"));
  const zipPath = join(home, "export.zip");
  let client: Client;
  let strongApp: string;
  let otherApp: string;
  const json = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]?.text ?? "null");

  const CSV = [
    "Notes:",
    '"Some of the email addresses are missing, see the setting."',
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    "Ada,Okafor,https://www.linkedin.com/in/ada-okafor,ada@example.org,Northwind Robotics,Staff Engineer,13 Nov 2026",
    'Bram,Castell,https://www.linkedin.com/in/bramcastell,,"Northwind Robotics, Inc.",Plant Manager,02 Jan 2019',
    "Chidi,Varga,https://www.linkedin.com/in/chidi-varga,,Northwind Robotics Europe,Buyer,05 Mar 2021",
    "Dana,Iwu,https://www.linkedin.com/in/dana-iwu,,Quillfeather Labs,Nurse Manager,30 Sep 2024",
  ].join("\n");

  const report = (band: ScoreReport["match"]["overall_band"], confidence: ScoreReport["match"]["confidence"]): ScoreReport => ({
    parse_safety: { verdict: "PASS", checks: [], ats_specific_note: "n" },
    match: {
      detected_ats: "x",
      dimensions: [{ name: "hard_skills", score: 70, justification: "j" }],
      overall_band: band,
      confidence,
      pool_caveat: "Band reflects functional fit; true ranking unknowable.",
    },
    authenticity: { score: 90, flags: [], strengths: [] },
    gaps: [],
    reachable: { band_if_tailored: "STRONG", from_reframing: [], needs_user_confirmation: [], honest_ceiling_note: "" },
    recommendation: "APPLY",
  });

  beforeAll(async () => {
    const store = new LocalStore(home);
    await store.writeFile(["profile.md"], "---\nname: Jordan Example\n---\n# Candidate profile\n");
    await store.writeFile(
      ["knowledge-base", "experiences", "01-ledgerly-engineer.md"],
      "---\nid: ledgerly-engineer\ncompany: Ledgerly\ntitle: Software Engineer\nstart: '2023'\nend: '2025'\n---\n\n## Achievements\n- Built a reconciliation tool used every day by 40 people on the finance team. [R]\n",
    );
    const make = async (company: string, role: string) =>
      (await createApplication(store, { company, role, snapshotMarkdown: `# ${role}\nBuild things.`, source_url_unavailable: true })).id;
    strongApp = await make("Northwind Robotics", "Controls Engineer");
    otherApp = await make("Northwind Robotics", "Field Technician");
    const zip = new JSZip();
    zip.file("Connections.csv", CSV);
    zip.file("messages.csv", "FROM,TO,CONTENT\nsomeone,someone else,this file must not be read\n");
    writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
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

  it("list_contacts says so when nothing was imported", async () => {
    const r = json(await client.callTool({ name: "list_contacts", arguments: { company: "Northwind Robotics" } }));
    expect(r).toMatchObject({ imported: false, contacts: [] });
  });

  it("import_linkedin_connections reads Connections.csv out of the export .zip and keeps no email", async () => {
    const r = json(await client.callTool({ name: "import_linkedin_connections", arguments: { path: zipPath } }));
    expect(r).toMatchObject({ ok: true, saved: "contacts/linkedin-connections.json", first_import: true, total: 4, added: 4, emails_kept: 0 });
    const stored = readFileSync(join(home, "contacts", "linkedin-connections.json"), "utf8");
    expect(stored).toContain("Ada Okafor");
    expect(stored).not.toContain("ada@example.org");
    expect(stored).not.toContain("must not be read");
  });

  it("a second import replaces the first and reports added, removed, unchanged and updated", async () => {
    const text = CSV.replace("Plant Manager", "Operations Director").replace(/Dana,Iwu.*$/, "Gus,Reyes,https://www.linkedin.com/in/gus-reyes,,Tidewell,Welder,09 Sep 2025");
    const r = json(await client.callTool({ name: "import_linkedin_connections", arguments: { text } }));
    expect(r).toMatchObject({ first_import: false, total: 4, added: 1, removed: 1, unchanged: 2, updated: 1 });
  });

  it("refuses a file that is not a connections file and keeps the import", async () => {
    const r = await client.callTool({ name: "import_linkedin_connections", arguments: { text: "name,employer\nAda,Northwind\n" } });
    expect(r.isError).toBe(true);
    const still = json(await client.callTool({ name: "list_contacts", arguments: { company: "Tidewell" } }));
    expect(still.total).toBe(1);
  });

  it("list_contacts returns the people at a company, and those at a similar name apart", async () => {
    const r = json(await client.callTool({ name: "list_contacts", arguments: { company: "northwind robotics llc" } }));
    expect(r.contacts.map((c: { name: string }) => c.name)).toEqual(["Ada Okafor", "Bram Castell"]);
    expect(r.contacts[0]).toEqual({
      name: "Ada Okafor",
      position: "Staff Engineer",
      company: "Northwind Robotics",
      url: "https://www.linkedin.com/in/ada-okafor",
      connected_on: "2026-11-13",
    });
    expect(r.similar_company_names.map((c: { name: string }) => c.name)).toEqual(["Chidi Varga"]);
    const none = json(await client.callTool({ name: "list_contacts", arguments: { company: "Lanternfish" } }));
    expect(none).toMatchObject({ imported: true, total: 0, contacts: [], total_similar: 0 });
  });

  it("save_score returns the contacts of a good match with high confidence, and nothing below the rule", async () => {
    const strong = json(await client.callTool({ name: "save_score", arguments: { appId: strongApp, report: report("STRONG", "high") } }));
    expect(strong.possible_referrals.contacts.map((c: { name: string }) => c.name)).toEqual(["Ada Okafor", "Bram Castell"]);
    expect(strong.possible_referrals.similar_company_names).toHaveLength(1);
    expect(strong.possible_referrals.note).toMatch(/never contacts anyone/);

    const medium = json(await client.callTool({ name: "save_score", arguments: { appId: otherApp, report: report("STRONG", "medium") } }));
    expect(medium.ok).toBe(true);
    expect(medium.possible_referrals).toBeUndefined();

    // Asked for directly, the contacts are still listed, with the rule's verdict.
    const asked = json(await client.callTool({ name: "list_contacts", arguments: { appId: otherApp } }));
    expect(asked).toMatchObject({ shown_unasked: false, total: 2, rule: { min_band: "COMPETITIVE", min_confidence: "high" } });
  });

  it("save_profile changes the rule", async () => {
    const saved = await client.callTool({ name: "save_profile", arguments: { referrals: { min_confidence: "medium" } } });
    expect(saved.isError).toBeFalsy();
    const asked = json(await client.callTool({ name: "list_contacts", arguments: { appId: otherApp } }));
    expect(asked).toMatchObject({ shown_unasked: true, rule: { enabled: true, min_band: "COMPETITIVE", min_confidence: "medium", after_applying: false } });
  });

  it("once the application is sent the contacts are no longer shown unasked, unless the profile keeps them; asked for, they are still listed", async () => {
    const sent = await client.callTool({ name: "set_application_status", arguments: { appId: strongApp, status: "applied" } });
    expect(sent.isError).toBeFalsy();
    const after = json(await client.callTool({ name: "list_contacts", arguments: { appId: strongApp } }));
    expect(after).toMatchObject({ shown_unasked: false, total: 2 });
    expect(after.contacts.map((c: { name: string }) => c.name)).toEqual(["Ada Okafor", "Bram Castell"]);

    // A new score on the sent application (the status stays applied) brings no contacts with it.
    const rescored = json(await client.callTool({ name: "save_score", arguments: { appId: strongApp, report: report("STRONG", "high"), label: "Optimized résumé" } }));
    expect(rescored.ok).toBe(true);
    expect(rescored.possible_referrals).toBeUndefined();

    const kept = await client.callTool({ name: "save_profile", arguments: { referrals: { after_applying: true } } });
    expect(kept.isError).toBeFalsy();
    const again = json(await client.callTool({ name: "list_contacts", arguments: { appId: strongApp } }));
    expect(again).toMatchObject({ shown_unasked: true, rule: { after_applying: true, min_confidence: "medium" } });
  });

  it("drafts a message to a contact only through the evidence and the checks, and records the state the user states", async () => {
    const evidence = json(await client.callTool({ name: "get_referral_message_evidence", arguments: { appId: otherApp, contact: "Ada Okafor" } }));
    expect(evidence.system_prompt).toContain("claim NO shared history");
    expect(evidence).toMatchObject({ application_sent: false, ask: "conversation", relationship_given: false, contact: { name: "Ada Okafor", position: "Staff Engineer" } });
    expect(evidence.user_message).toContain("reconciliation tool");

    const text = [
      "Hi Ada,",
      "",
      "I'm planning to apply for the Field Technician role at Northwind Robotics. At Ledgerly I built a reconciliation tool that 40 people on the finance team used every day.",
      "",
      "Would you be open to a short call about the team?",
      "",
      "Thanks,",
      "Jordan",
    ].join("\n");
    const refused = await client.callTool({
      name: "save_referral_message",
      arguments: { appId: otherApp, contact: "Ada Okafor", text: text.replace("I'm planning", "It's been a while since we worked together. I'm planning") },
    });
    expect(refused.isError).toBe(true);
    expect((refused as { content: { text: string }[] }).content[0].text).toMatch(/shared-history/);

    const saved = json(await client.callTool({ name: "save_referral_message", arguments: { appId: otherApp, contact: "Ada Okafor", text } }));
    expect(saved).toMatchObject({ ok: true, to: "Ada Okafor", state: "drafted", profile: "https://www.linkedin.com/in/ada-okafor", warnings: [] });
    expect(saved.note).toMatch(/Not sent/);

    const sent = json(await client.callTool({ name: "set_referral_message_state", arguments: { appId: otherApp, contact: "Ada Okafor", state: "sent", note: "sent this morning" } }));
    expect(sent).toMatchObject({ ok: true, to: "Ada Okafor", state: "sent" });

    const app = json(await client.callTool({ name: "read_application", arguments: { appId: otherApp } }));
    expect(app.referral_messages).toEqual([expect.objectContaining({ to: "Ada Okafor", state: "sent", ask: "conversation" })]);
    const stored = JSON.parse(readFileSync(join(home, "applications", otherApp, "referral-messages.json"), "utf8"));
    expect(stored.messages[0].text).toBe(text);
  });
});
