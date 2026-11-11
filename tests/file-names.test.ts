import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { candidateFilePart, companyFilePart, submissionFileName } from "@kairos/engine/file-names";
import { writeSubmissionCopies } from "@/lib/pdf-render";

/**
 * Submit-ready file names (2026-11-03): a recruiter receives
 * "Jane_Doe-acme-labs-resume.pdf", never a bare "resume.pdf".
 */

describe("submissionFileName", () => {
  it("joins candidate, company and document", () => {
    expect(submissionFileName("Jane Doe", "Acme Labs", "resume", "pdf")).toBe("Jane_Doe-acme-labs-resume.pdf");
    expect(submissionFileName("Jane Doe", "Northwind AI", "cover-letter", "docx")).toBe(
      "Jane_Doe-northwind-ai-cover-letter.docx",
    );
  });

  it("makes names file-safe", () => {
    expect(candidateFilePart("Éloïse  O'Brien-Smith")).toBe("Eloise_OBrien-Smith");
    expect(companyFilePart("Bain & Company")).toBe("bain-and-company");
    expect(companyFilePart("Star+Moon Media")).toBe("star-moon-media");
    expect(companyFilePart("Fieldstone (Harbor Group)")).toBe("fieldstone-harbor-group");
  });

  it("falls back when a part is missing", () => {
    expect(submissionFileName(undefined, "", "resume", "pdf")).toBe("Candidate-application-resume.pdf");
  });
});

describe("writeSubmissionCopies", () => {
  let home: string;
  afterAll(async () => home && rm(home, { recursive: true, force: true }));

  it("copies the masters under the submit name, only in an application folder", async () => {
    home = await mkdtemp(path.join(tmpdir(), "kairos-names-"));
    const app = path.join(home, "applications", "2026-11-03_acme_pm");
    await mkdir(app, { recursive: true });
    await writeFile(path.join(home, "profile.md"), "---\nname: Alex Sample\n---\n");
    await writeFile(path.join(app, "application-meta.json"), JSON.stringify({ company: "Acme Corp" }));
    await writeFile(path.join(app, "resume.pdf"), "pdf");
    await writeFile(path.join(app, "resume.docx"), "docx");

    expect((await writeSubmissionCopies(app)).sort()).toEqual([
      "Alex_Sample-acme-corp-resume.docx",
      "Alex_Sample-acme-corp-resume.pdf",
    ]);
    expect(await readdir(app)).toContain("resume.pdf"); // the master stays
    expect(await writeSubmissionCopies(home)).toEqual([]); // not an application folder
  });
});
