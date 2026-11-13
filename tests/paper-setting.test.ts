import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { LocalStore } from "@/store/local-fs";
import { createApplication } from "@kairos/engine/applications";
import { saveGeneratedResume } from "@kairos/engine/tools/ops";
import { loadResumePaper, readProfileSettings, resumePaper } from "@kairos/engine/settings";
import type { GeneratedResume } from "@kairos/engine/types";

/** Paper size: profile.md `paper`, else US Letter for a United States search and A4 otherwise (invented demo data). */

const profileMd = (fm: string) => `---\n${fm}\n---\n# Candidate profile\n`;

describe("profile.md paper", () => {
  it("reads letter or a4, any case, and ignores anything else", () => {
    expect(readProfileSettings(profileMd("paper: a4")).paper).toBe("a4");
    expect(readProfileSettings(profileMd("paper: Letter")).paper).toBe("letter");
    expect(readProfileSettings(profileMd("paper: legal")).paper).toBeUndefined();
    expect(readProfileSettings(profileMd("name: Jane Doe")).paper).toBeUndefined();
  });
});

describe("resumePaper", () => {
  it("is US Letter for the default search (United States only), with or without a search profile", () => {
    expect(resumePaper({}, null)).toBe("letter");
    expect(resumePaper({}, {})).toBe("letter");
    expect(resumePaper({}, { international_ok: false })).toBe("letter");
  });

  it("is A4 when the search takes postings from other countries", () => {
    expect(resumePaper({}, { international_ok: true })).toBe("a4");
  });

  it("the profile's own setting wins over the search", () => {
    expect(resumePaper({ paper: "a4" }, { international_ok: false })).toBe("a4");
    expect(resumePaper({ paper: "letter" }, { international_ok: true })).toBe("letter");
  });
});

// --- Through the save path ---------------------------------------------------

const KB_FILE = `---
id: acme-pm
company: Acme
title: Product Manager
start: '2020'
end: '2022'
---

## Achievements
- Delivered $20M in savings on the support platform. [R]
`;

const RESUME: GeneratedResume = {
  resume: {
    header: { name: "Alex Sample", contact: "Chicago" },
    executive_summary: "- **Product leader:** ships platforms with measured outcomes.",
    experience: [{ company: "Acme", title: "Product Manager", dates: "2020 – 2022", bullets: ["Delivered $20M in savings."] }],
    education: [{ institution: "Westbrook", credential: "MBA" }],
    skills: ["Platforms"],
  },
  provenance_audit: [{ claim: "savings", source_experience: "01-acme-pm", prov: "R" }],
};

const LETTER = /<w:pgSz[^>]*w:w="12240"[^>]*w:h="15840"/;
const A4 = /<w:pgSz[^>]*w:w="11906"[^>]*w:h="16838"/;

async function savedDocx(opts: { profile?: string; search?: object; template?: { paper: "letter" | "a4" } } = {}) {
  const store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-paper-")));
  await store.writeFile(["knowledge-base", "experiences", "01-acme-pm.md"], KB_FILE);
  if (opts.profile) await store.writeFile(["profile.md"], opts.profile);
  if (opts.search) await store.writeJson(["sourcing", "search-profile.json"], opts.search);
  const meta = await createApplication(store, { company: "Globex", role: "Head of Product", snapshotMarkdown: "# Head of Product\nPlatform work.", source_url_unavailable: true });
  const result = await saveGeneratedResume(store, meta.id, RESUME, opts.template ? { template: opts.template } : {});
  const docx = await store.readBinary(["applications", meta.id, "resume.docx"]);
  const xml = await (await JSZip.loadAsync(docx!)).file("word/document.xml")!.async("string");
  return { xml, result, store };
}

describe("saveGeneratedResume renders on the user's paper", () => {
  it("an empty data folder (the default United States search) gets US Letter", async () => {
    const { xml, result, store } = await savedDocx();
    expect(xml).toMatch(LETTER);
    expect(result.paper).toBe("letter");
    expect(await loadResumePaper(store)).toBe("letter");
  });

  it("profile.md `paper: a4` gets A4", async () => {
    const { xml, result } = await savedDocx({ profile: profileMd("name: Alex Sample\npaper: a4") });
    expect(xml).toMatch(A4);
    expect(result.paper).toBe("a4");
  });

  it("a search that includes other countries gets A4, unless the profile says letter", async () => {
    expect((await savedDocx({ search: { international_ok: true } })).xml).toMatch(A4);
    expect((await savedDocx({ search: { international_ok: true }, profile: profileMd("paper: letter") })).xml).toMatch(LETTER);
  });

  it("an uploaded template's own paper wins over the setting", async () => {
    const { xml, result } = await savedDocx({ profile: profileMd("paper: a4"), template: { paper: "letter" } });
    expect(xml).toMatch(LETTER);
    expect(result.paper).toBe("letter");
  });
});

describe("every local render path reads the paper setting", () => {
  it("render_docx, both cover-letter paths and tailor-resume pass or report it", () => {
    const server = readFileSync("apps/local/mcp/server.ts", "utf8");
    expect(server).toMatch(/markdownResumeToDocx\(md, \{ headline, template: \{ paper \} \}\)/);
    expect(server).toMatch(/markdownLetterToDocx\(markdown, \{ template: \{ paper: await loadResumePaper\(store\) \} \}\)/);
    expect(readFileSync("apps/local/lib/generate.ts", "utf8")).toMatch(/markdownLetterToDocx\(markdown, \{ template: \{ paper: await loadResumePaper\(store\) \} \}\)/);
    // The headless résumé and tailor-resume go through saveGeneratedResume, which resolves the paper itself.
    expect(readFileSync("apps/local/scripts/tailor-resume.mts", "utf8")).toMatch(/\{ stretch, paper, origins \} = await saveGeneratedResume\(/);
  });
});
