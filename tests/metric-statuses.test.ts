import { beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "@/store/local-fs";
import { createApplication } from "@kairos/engine/applications";
import { checkLetterNumbers, saveGeneratedResume } from "@kairos/engine/tools/ops";
import { registerBlockedNumbers } from "@kairos/engine/tools/checks";
import { registerEntries } from "@kairos/engine/metrics-register";
import { allowedMetricStatuses, readProfileSettings } from "@kairos/engine/settings";
import type { GeneratedResume } from "@kairos/engine/types";

/** The metrics register decides which recorded numbers may appear in a document (invented demo data). */

const REGISTER = `# Metrics register

## Northwind Voice (02-northwind-voice.md, 2019–2024)

**Review time down 50%** — DEFENDED [C] 2026-09-28
- Baseline → outcome: roughly 10 working days → 5.

**Escalations** — DEFENDED [C] 2026-10-02
- Baseline → outcome: 18% of tickets escalated → 6%.

**Search accuracy up 30%** — OPEN [R]
- Missing: methodology.

**Handle time down 25%** — PARTIAL: baseline not on record

**Scope facts** — SCOPE: 12 markets; 2M users; 40+ languages.

**A note with no status** — the 15% figure is discussed elsewhere

## Brightpath (04-brightpath.md, 2014–2018)

**300% throughput** — RETIRED: do not use.
- Was also written as $7M of extra output.

**Adoption 50%** — RETIRED

**Escalation claim, old wording** — RETIRED: said "18% to 6%" as a satisfaction gain

## Operating rules for this register
1. A number ships only at DEFENDED or SCOPE.
`;

describe("registerBlockedNumbers", () => {
  it("refuses a number whose only register entry is RETIRED, OPEN or PARTIAL, naming the entry", () => {
    expect(registerBlockedNumbers("Raised throughput by 300%.", REGISTER)).toEqual([
      { number: "300%", entry: "300% throughput", section: "Brightpath (04-brightpath.md, 2014–2018)", status: "RETIRED" },
    ]);
    expect(registerBlockedNumbers("Search accuracy rose 30%.", REGISTER).map((i) => i.status)).toEqual(["OPEN"]);
    expect(registerBlockedNumbers("Handle time fell 25 %.", REGISTER).map((i) => i.status)).toEqual(["PARTIAL"]);
  });

  it("lets a number through when it also matches an allowed entry", () => {
    // 50% is RETIRED under Brightpath and DEFENDED under Northwind Voice.
    expect(registerBlockedNumbers("Cut review time by 50%.", REGISTER)).toEqual([]);
    // 18% and 6% are named on a RETIRED header and are the baseline and outcome bullets of a DEFENDED entry.
    expect(registerBlockedNumbers("Escalations fell from 18% to 6% of tickets.", REGISTER)).toEqual([]);
  });

  it("reads the bullets of an entry as well as its header line", () => {
    expect(registerBlockedNumbers("Added $7M of output.", REGISTER).map((i) => `${i.number} ${i.entry} ${i.status}`)).toEqual(["$7M 300% throughput RETIRED"]);
  });

  it("allows DEFENDED and SCOPE numbers, including the ones written after the status", () => {
    expect(registerBlockedNumbers("Serving 2M users in 40+ languages, review time down 50%.", REGISTER)).toEqual([]);
  });

  it("ignores numbers the register does not hold and entries with no status word", () => {
    expect(registerBlockedNumbers("Saved $4M and grew 70%.", REGISTER)).toEqual([]);
    // "15%" sits on a header line that states no status: the user has not ruled on it.
    expect(registerBlockedNumbers("Up 15%.", REGISTER)).toEqual([]);
    expect(registerEntries(REGISTER).map((e) => e.name)).not.toContain("A note with no status");
  });

  it("does nothing without a register", () => {
    expect(registerBlockedNumbers("Raised throughput by 300%.", null)).toEqual([]);
    expect(registerBlockedNumbers("Raised throughput by 300%.", "  \n")).toEqual([]);
  });

  it("follows the allowed statuses it is given", () => {
    expect(registerBlockedNumbers("Handle time fell 25%.", REGISTER, ["DEFENDED", "SCOPE", "PARTIAL"])).toEqual([]);
    expect(registerBlockedNumbers("Up 300%, 30% and 25%.", REGISTER, ["DEFENDED", "PARTIAL", "OPEN", "RETIRED", "SCOPE"])).toEqual([]);
  });

  it("reports a number once, and reads it at the end of a sentence", () => {
    expect(registerBlockedNumbers("Up 300%. Again 300%, and 300%", REGISTER)).toHaveLength(1);
  });
});

describe("profile.md metrics_allowed_statuses", () => {
  const md = (fm: string) => `---\n${fm}\n---\n# Candidate profile\n`;
  it("defaults to DEFENDED and SCOPE", () => {
    expect(allowedMetricStatuses(readProfileSettings(null))).toEqual(["DEFENDED", "SCOPE"]);
    expect(allowedMetricStatuses(readProfileSettings(md("name: Jane Doe")))).toEqual(["DEFENDED", "SCOPE"]);
  });
  it("reads the user's list, any case, and ignores a list with no valid status", () => {
    expect(readProfileSettings(md("metrics_allowed_statuses: [defended, SCOPE, Partial]")).metrics_allowed_statuses).toEqual(["DEFENDED", "PARTIAL", "SCOPE"]);
    expect(readProfileSettings(md("metrics_allowed_statuses: [everything]")).metrics_allowed_statuses).toBeUndefined();
  });
});

// --- The save paths ----------------------------------------------------------

const KB_FILE = `---
id: brightpath-ops
company: Brightpath
title: Operations Lead
start: '2014'
end: '2018'
---

## Achievements
- Raised line throughput by 300% and reached 50% adoption of the new scanners. [R]
- Cut review time by 50% and saved $4M a year. [C]
`;

const resume = (bullets: string[]): GeneratedResume => ({
  resume: {
    header: { name: "Alex Sample", contact: "Chicago" },
    executive_summary: "- **Operations leader:** runs warehouses with measured outcomes.",
    experience: [{ company: "Brightpath", title: "Operations Lead", dates: "2014 – 2018", bullets }],
    education: [{ institution: "Westbrook", credential: "MBA" }],
    skills: ["Operations"],
  },
  provenance_audit: [{ claim: "throughput", source_experience: "01-brightpath-ops", prov: "R" }],
});

const LETTER = (line: string) => `Alex Sample\nChicago\n\nDear team,\n\n${line}\n\nSincerely,\nAlex Sample\n`;

async function home(opts: { register?: string; profile?: string } = {}) {
  const store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-register-")));
  await store.writeFile(["knowledge-base", "experiences", "01-brightpath-ops.md"], KB_FILE);
  if (opts.register) await store.writeFile(["knowledge-base", "metrics-register.md"], opts.register);
  if (opts.profile) await store.writeFile(["profile.md"], opts.profile);
  const meta = await createApplication(store, {
    company: "Globex",
    role: "Head of Operations",
    snapshotMarkdown: "# Head of Operations\nWe run 80% of our volume through two sites.",
    source_url_unavailable: true,
  });
  return { store, appId: meta.id };
}

describe("saveGeneratedResume and the metrics register", () => {
  it("with no register, a grounded number saves exactly as before", async () => {
    const { store, appId } = await home();
    await expect(saveGeneratedResume(store, appId, resume(["Raised line throughput by 300%."]))).resolves.toBeTruthy();
  });

  it("refuses a grounded number the register marks RETIRED, naming the entry", async () => {
    const { store, appId } = await home({ register: REGISTER });
    await expect(saveGeneratedResume(store, appId, resume(["Raised line throughput by 300%."]))).rejects.toThrow(
      /metrics register does not allow: "300%" matches the metrics-register entry "300% throughput" \(RETIRED/,
    );
    expect(await store.readJson(["applications", appId, "resume.json"])).toBeNull();
  });

  it("saves a number that a DEFENDED entry also carries, and one the register does not hold", async () => {
    const { store, appId } = await home({ register: REGISTER });
    await expect(saveGeneratedResume(store, appId, resume(["Cut review time by 50% and saved $4M a year."]))).resolves.toBeTruthy();
  });

  it("still refuses a number that is not in the record, register or not", async () => {
    const { store, appId } = await home({ register: REGISTER });
    await expect(saveGeneratedResume(store, appId, resume(["Saved $9M a year."]))).rejects.toThrow(/ungrounded_metric/);
  });

  it("profile.md metrics_allowed_statuses with all five statuses restores the behaviour without the check", async () => {
    const { store, appId } = await home({
      register: REGISTER,
      profile: "---\nname: Alex Sample\nmetrics_allowed_statuses: [DEFENDED, SCOPE, PARTIAL, OPEN, RETIRED]\n---\n# Candidate profile\n",
    });
    await expect(saveGeneratedResume(store, appId, resume(["Raised line throughput by 300%."]))).resolves.toBeTruthy();
  });
});

describe("checkLetterNumbers: the one number check for every cover-letter path", () => {
  it("passes numbers from the record and from the posting", async () => {
    const { store, appId } = await home({ register: REGISTER });
    const r = await checkLetterNumbers(store, appId, LETTER("I saved $4M a year, and you run 80% of your volume through two sites."));
    expect(r).toEqual({ ungrounded: [], blocked: [], message: null });
  });

  it("names a number found in no source", async () => {
    const { store, appId } = await home();
    const r = await checkLetterNumbers(store, appId, LETTER("I grew revenue by 35% in one quarter."));
    expect(r.ungrounded).toEqual(["35%"]);
    expect(r.message).toMatch(/^Not saved: 1 number\(s\) in the letter are not in the user's verified record, profile, education or the posting: 35%/);
  });

  it("names a recorded number the register withholds", async () => {
    const { store, appId } = await home({ register: REGISTER });
    const r = await checkLetterNumbers(store, appId, LETTER("I raised line throughput by 300%."));
    expect(r.ungrounded).toEqual([]);
    expect(r.blocked.map((b) => `${b.number} ${b.status}`)).toEqual(["300% RETIRED"]);
    expect(r.message).toMatch(/withheld by the metrics register: "300%" matches the metrics-register entry "300% throughput" \(RETIRED/);
  });

  it("with no register, a recorded number passes as before", async () => {
    const { store, appId } = await home();
    expect((await checkLetterNumbers(store, appId, LETTER("I raised line throughput by 300%."))).message).toBeNull();
  });

  it("the MCP tool and the dashboard's one-click letter both call it, and neither keeps its own number check", () => {
    for (const file of ["apps/local/mcp/server.ts", "apps/local/lib/generate.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toMatch(/await checkLetterNumbers\(store, appId, markdown\)/);
      expect(src, file).not.toContain("ungroundedNumbers(");
    }
  });
});
