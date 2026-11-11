/**
 * Names for the documents a candidate submits (2026-11-03). Inside an
 * application folder the masters stay `resume.docx` / `resume.pdf` (the
 * dashboard, layout probe and download routes read those names); the file a
 * recruiter receives carries the candidate and the company instead:
 * `Jane_Doe-acme-resume.pdf`. The dashboard download, the autofill
 * extension and the named copies in the folder all use this one rule.
 */

export type SubmissionDoc = "resume" | "cover-letter";

const ascii = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** "Jane Doe" → "Jane_Doe"; empty → "Candidate". */
export function candidateFilePart(name: string | null | undefined): string {
  const words = ascii(name ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9'-]/g, "").replace(/'/g, ""))
    .filter(Boolean);
  return words.length ? words.join("_") : "Candidate";
}

/** "Acme Labs" → "acme-labs"; empty → "application". */
export function companyFilePart(company: string | null | undefined): string {
  const slug = ascii(company ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "application";
}

export function submissionFileName(
  candidateName: string | null | undefined,
  company: string | null | undefined,
  doc: SubmissionDoc,
  ext: "pdf" | "docx",
): string {
  return `${candidateFilePart(candidateName)}-${companyFilePart(company)}-${doc}.${ext}`;
}
