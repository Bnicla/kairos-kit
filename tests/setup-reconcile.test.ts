import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { reconcileSources, parseDate, normCompany } from "@kairos/engine/setup/reconcile";
import { parseCsv, linkedInToText, listSourceDocuments, readSourceDocument, guessKind } from "@/lib/source-docs";
import { ensureDataFolder, parseGitHubRemote, checkInstall } from "@/lib/setup-check";
import { mergeAutofill } from "@/lib/autofill";
import { inExcludedCompany, prefilterAndRank } from "@kairos/engine/sourcing/filter";
import { allTriageRules, describePayFloor, describeSearchProfile, deriveSearchProfile } from "@kairos/engine/sourcing/search-profile";
import type { Posting } from "@kairos/engine/sourcing/types";

// Made-up student and companies only.
const resume = {
  source: "jordan-lee-resume.pdf",
  candidate: { name: "Jordan Lee", contact: "jordan.lee@example.edu" },
  experiences: [
    { company: "Lumen Analytics, Inc.", title: "Data Analyst Intern", start: "2025-06", end: "2025-08" },
    { company: "Riverside University", title: "Research Assistant", start: "2024", end: "present" },
  ],
  education: [{ institution: "Riverside University", credential: "B.S. Statistics", start: "2022", end: "2026" }],
};

describe("reconcile_sources", () => {
  it("parses common date shapes", () => {
    expect(parseDate("2025-06")).toEqual({ y: 2025, m: 6 });
    expect(parseDate("Jun 2025")).toEqual({ y: 2025, m: 6 });
    expect(parseDate("September 2024")).toEqual({ y: 2024, m: 9 });
    expect(parseDate("06/2025")).toEqual({ y: 2025, m: 6 });
    expect(parseDate("Present")).toEqual({ present: true });
    expect(normCompany("Lumen Analytics, Inc.")).toBe("lumen analytics");
  });

  it("one résumé into an empty record: everything new, no questions", () => {
    const r = reconcileSources([resume], { experiences: [], education: [] });
    expect(r.questions).toEqual([]);
    expect(r.experiences.map((x) => x.status)).toEqual(["new", "new"]);
    expect(r.education[0].status).toBe("new");
    expect(r.experiences[0].sources).toEqual(["jordan-lee-resume.pdf"]);
    expect(r.candidate.merged.name).toBe("Jordan Lee");
  });

  it("the same place written two ways is not a question", () => {
    const a = { source: "resume.pdf", experiences: [{ company: "Lumen Analytics", title: "Analyst", start: "2025-06", end: "2025-08", location: "Denver, CO" }] };
    const b = { source: "linkedin", experiences: [{ company: "Lumen Analytics", title: "Analyst", start: "Jun 2025", end: "Aug 2025", location: "Denver, Colorado, United States" }] };
    const r = reconcileSources([a, b], { experiences: [], education: [] });
    expect(r.questions).toEqual([]);
    const c = { source: "other.pdf", experiences: [{ company: "Lumen Analytics", title: "Analyst", start: "2025-06", end: "2025-08", location: "Boulder, CO" }] };
    expect(reconcileSources([a, c], { experiences: [], education: [] }).questions).toHaveLength(1);
  });

  it("agreeing sources merge to the most precise date; disagreements become numbered questions", () => {
    const linkedin = {
      source: "linkedin-export.zip",
      candidate: { name: "Jordan Lee" },
      experiences: [
        { company: "Lumen Analytics", title: "Data Analyst Intern", start: "2025", end: "Aug 2025", location: "Denver, CO" },
        { company: "Riverside University", title: "Undergraduate Research Assistant", start: "2024-01", end: "present" },
      ],
      education: [{ institution: "Riverside University", credential: "B.S. Statistics", start: "2022", end: "2027" }],
    };
    const r = reconcileSources([resume, linkedin], { experiences: [], education: [] });
    const lumen = r.experiences.find((x) => x.subject.startsWith("Lumen"))!;
    expect(lumen.status).toBe("new");
    expect(lumen.merged).toMatchObject({ start: "2025-06", end: "2025-08", location: "Denver, CO" });
    expect(lumen.sources).toEqual(["jordan-lee-resume.pdf", "linkedin-export.zip"]);

    const ra = r.experiences.find((x) => x.subject.startsWith("Riverside"))!;
    expect(ra.status).toBe("conflict");
    expect(r.questions.map((q) => q.n)).toEqual([1, 2]);
    expect(r.questions[0].field).toBe("title");
    expect(r.questions[0].text).toMatch(/^1\. Riverside University, Research Assistant: the title differs\./);
    expect(r.questions[0].options.map((o) => o.value)).toEqual(["Research Assistant", "Undergraduate Research Assistant"]);
    expect(r.questions[1]).toMatchObject({ field: "end", options: [{ value: "2026" }, { value: "2027" }] });
    expect(r.summary).toMatchObject({ new: 1, conflict: 2, questions: 2 });
  });

  it("a promotion at one company is two roles, not a conflict", () => {
    const r = reconcileSources(
      [
        {
          source: "cv.pdf",
          experiences: [
            { company: "Northwind Labs", title: "Analyst", start: "2023-01", end: "2024-03" },
            { company: "Northwind Labs", title: "Senior Analyst", start: "2024-03", end: "present" },
          ],
        },
      ],
      { experiences: [], education: [] },
    );
    expect(r.questions).toEqual([]);
    expect(r.experiences).toHaveLength(2);
  });

  it("a re-run keeps additive changes apart from conflicts and never marks a known role new", () => {
    const record = {
      profile: { name: "Jordan Lee" },
      experiences: [
        { fileName: "01-lumen-analytics.md", company: "Lumen Analytics", title: "Data Analyst Intern", start: "2025", end: "2025", sources: ["jordan-lee-resume.pdf"] },
      ],
      education: [],
    };
    const r = reconcileSources(
      [{ source: "linkedin-export.zip", experiences: [{ company: "Lumen Analytics", title: "Data Analyst Intern", start: "2025-06", end: "2025-08" }] }],
      record,
    );
    const lumen = r.experiences[0];
    expect(lumen.status).toBe("additive");
    expect(lumen.fileName).toBe("01-lumen-analytics.md");
    expect(lumen.new_sources).toEqual(["linkedin-export.zip"]);
    expect(lumen.additions).toEqual([
      { field: "start", from: "2025", to: "2025-06", source: "linkedin-export.zip" },
      { field: "end", from: "2025", to: "2025-08", source: "linkedin-export.zip" },
    ]);

    const same = reconcileSources([{ source: "jordan-lee-resume.pdf", experiences: [{ company: "Lumen Analytics", title: "Data Analyst Intern", start: "2025", end: "2025" }] }], record);
    expect(same.experiences[0].status).toBe("unchanged");

    const clash = reconcileSources([{ source: "new-cv.pdf", candidate: { name: "Jordan A. Lee" }, experiences: [{ company: "Lumen Analytics", title: "Data Analyst Intern", start: "2024", end: "2024" }] }], record);
    expect(clash.experiences[0].status).toBe("conflict");
    expect(clash.questions.map((q) => q.field)).toEqual(["name", "start", "end"]);
  });
});

describe("source documents", () => {
  const positions = 'Company Name,Title,Description,Location,Started On,Finished On\n"Lumen Analytics","Data Analyst Intern","Built a churn dashboard, used weekly","Denver, CO",Jun 2025,Aug 2025\n';
  const profile = "First Name,Last Name,Headline,Summary,Geo Location\nJordan,Lee,Statistics student,,Denver\n";

  it("parses LinkedIn CSVs, quoted commas included", () => {
    expect(parseCsv(positions)[0]).toMatchObject({ "Company Name": "Lumen Analytics", Description: "Built a churn dashboard, used weekly" });
    const text = linkedInToText({ "Positions.csv": positions, "Profile.csv": profile });
    expect(text).toContain("Jordan Lee · Denver");
    expect(text).toContain("Data Analyst Intern · Lumen Analytics · Denver, CO");
    expect(text).toContain("Jun 2025 – Aug 2025");
  });

  it("lists a documents folder and reads a LinkedIn zip and a text résumé", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kairos-src-"));
    writeFileSync(path.join(dir, "Jordan_Lee_Resume.md"), "# Jordan Lee\n\nData Analyst Intern, Lumen Analytics, 2025.\n");
    writeFileSync(path.join(dir, "notes.png"), "x");
    const zip = new JSZip();
    zip.file("Basic_LinkedInDataExport/Positions.csv", positions);
    zip.file("Basic_LinkedInDataExport/Profile.csv", profile);
    writeFileSync(path.join(dir, "export.zip"), await zip.generateAsync({ type: "nodebuffer" }));
    mkdirSync(path.join(dir, "school"));
    writeFileSync(path.join(dir, "school", "transcript.txt"), "Riverside University transcript");

    const docs = await listSourceDocuments(dir);
    expect(docs.map((d) => [d.name, d.kind]).sort()).toEqual([
      ["Jordan_Lee_Resume.md", "resume"],
      ["export.zip", "linkedin"],
      ["transcript.txt", "transcript"],
    ]);
    const li = await readSourceDocument(path.join(dir, "export.zip"));
    expect(li.kind).toBe("linkedin");
    expect(li.text).toContain("Lumen Analytics");
    const md = await readSourceDocument(path.join(dir, "Jordan_Lee_Resume.md"));
    expect(md.text).toContain("Data Analyst Intern");
    expect(guessKind("my-cv.pdf")).toBe("resume");
  });
});

describe("step 0", () => {
  it("creates the data folder and never overwrites what is there", async () => {
    const home = path.join(mkdtempSync(path.join(os.tmpdir(), "kairos-home-")), "Kairos");
    const first = await ensureDataFolder(home);
    expect(first.existed).toBe(false);
    expect(first.created).toContain("knowledge-base/experiences/");
    expect(first.created).toContain("setup-state.json");
    writeFileSync(path.join(home, "setup-state.json"), '{"keep":true}');
    writeFileSync(path.join(home, "profile.md"), "---\nname: Jordan Lee\n---\n");
    const again = await ensureDataFolder(home);
    expect(again).toMatchObject({ existed: true, created: [], has_data: true });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path.join(home, "setup-state.json"), "utf8")).toBe('{"keep":true}');
  });

  it("reads GitHub remotes and flags a public fork", async () => {
    expect(parseGitHubRemote("git@github.com:jlee/kairos-kit.git")).toEqual({ owner: "jlee", repo: "kairos-kit" });
    expect(parseGitHubRemote("https://github.com/jlee/kairos-kit")).toEqual({ owner: "jlee", repo: "kairos-kit" });
    expect(parseGitHubRemote("https://gitlab.com/jlee/kit.git")).toBeNull();
    const fakeFetch = (async () => new Response(JSON.stringify({ fork: true }), { status: 200 })) as unknown as typeof fetch;
    const dir = mkdtempSync(path.join(os.tmpdir(), "kairos-repo-"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/jlee/kairos-kit.git"]);
    const r = await checkInstall({ root: dir, fetchImpl: fakeFetch });
    expect(r.repo.github).toMatchObject({ owner: "jlee", visibility: "public", fork: true });
    expect(r.warnings.some((w) => /public fork/.test(w))).toBe(true);
    const priv = await checkInstall({ root: dir, fetchImpl: (async () => new Response("", { status: 404 })) as unknown as typeof fetch });
    expect(priv.repo.warning).toBeUndefined();
  }, 30_000); // checkInstall spawns git, node and claude; slow when the full suite runs in parallel
});

describe("new settings", () => {
  it("autofill merges key by key and keeps never_auto_submit", () => {
    const a = mergeAutofill(null, { contact: { full_name: "Jordan Lee", email: "j@example.edu" } });
    expect(a).toEqual({ contact: { full_name: "Jordan Lee", email: "j@example.edu" }, defaults: { never_auto_submit: true } });
    const b = mergeAutofill(a, { contact: { phone: "555-0100", email: "" }, share_eeo: false });
    expect(b.contact).toEqual({ full_name: "Jordan Lee", phone: "555-0100" });
    expect(b.share_eeo).toBe(false);
  });

  it("excluded companies are a hard gate on name and board id", () => {
    const profile = { ...deriveSearchProfile({ target_roles: ["Data Analyst"] }), excluded_companies: ["globex"] };
    const p = (company: string, slug: string): Posting => ({
      ats: "greenhouse", slug, company, title: "Data Analyst", url: `https://x/${slug}`, location: "Remote", remote: true, posted_at: null, age_days: 1,
    });
    expect(inExcludedCompany(p("Globex Corporation", "globexcorp"), profile)).toBe(true);
    expect(inExcludedCompany(p("Initech", "globex"), profile)).toBe(true);
    expect(inExcludedCompany(p("Globexia", "globexia"), profile)).toBe(false);
    const out = prefilterAndRank([p("Globex Corporation", "globexcorp"), p("Initech", "initech")], profile, new Set(), []);
    expect(out.survivors.map((x) => x.company)).toEqual(["Initech"]);
  });

  it("pay floor, ceiling, relocation and exclusions reach triage as rules", () => {
    const profile = {
      ...deriveSearchProfile({}),
      triage_rules: ["Prefer teams with a mentor."],
      seniority_ceiling: "nothing above Analyst II",
      pay_floor: { amount: 70000, by_location: [{ place: "new york", amount: 85000 }] },
      relocation: { open: true, places: ["seattle"] },
      excluded_companies: ["globex"],
    };
    const rules = allTriageRules(profile);
    expect(rules[0]).toBe("Prefer teams with a mentor.");
    expect(rules.join("\n")).toMatch(/Seniority ceiling: nothing above Analyst II/);
    expect(rules.join("\n")).toMatch(/Pay floor: \$70,000 a year \(new york: \$85,000\)/);
    expect(rules.join("\n")).toMatch(/Open to relocating to seattle/);
    expect(rules.join("\n")).toMatch(/globex/);
    expect(describePayFloor({ pay_floor: { amount: 25, period: "hour" } })).toBe("$25 an hour");
    expect(describeSearchProfile(profile)).toMatch(/Pay floor: \$70,000/);
    expect(allTriageRules(deriveSearchProfile({}))).toEqual([]);
  });
});
