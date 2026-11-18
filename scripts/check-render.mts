// Check that this computer turns a Word résumé into a PDF the way save_resume
// does: it writes a small made-up résumé as a Word file, finds LibreOffice,
// converts the file, and says whether the page count can be measured (that
// part also needs poppler's pdfinfo and pdftotext).
//
//   node --import tsx scripts/check-render.mts
//
// It starts LibreOffice once (on a Mac it shows in the Dock for a moment). The
// kit's CI runs it on Windows after installing LibreOffice.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownResumeToDocx } from "@kairos/engine/docx-render";
import { renderDocxToPdf, sofficePath } from "../apps/local/lib/pdf-render";
import { probeResumeLayout } from "../apps/local/lib/layout-probe";

const RESUME = `# Jane Doe
Denver · jane@example.com

## Professional Experience

### Acme | Denver
#### Product Manager | 2020 – 2022

- **Delivery:** Shipped the scheduling tool to 40 clinics on the planned date.
- **Research:** Ran 25 interviews with clinic staff and wrote the findings up.
`;

const soffice = sofficePath();
if (!existsSync(soffice)) {
  console.error("✗ LibreOffice was not found. Install it from https://www.libreoffice.org, or set SOFFICE_PATH to its soffice program.");
  console.error(`  Looked last at: ${soffice}`);
  process.exit(1);
}
console.log(`✓ LibreOffice: ${soffice}`);

// A folder name with a space, as many Windows user folders have.
const dir = mkdtempSync(join(tmpdir(), "kairos render check-"));
let code = 0;
try {
  const docx = join(dir, "resume.docx");
  writeFileSync(docx, await markdownResumeToDocx(RESUME));
  const pdf = await renderDocxToPdf(docx);
  if (!pdf || !existsSync(pdf) || !readFileSync(pdf).subarray(0, 5).toString("latin1").startsWith("%PDF")) {
    console.error("✗ LibreOffice was found but did not produce a PDF from the Word file.");
    code = 1;
  } else {
    console.log(`✓ PDF written from the Word file (${readFileSync(pdf).length} bytes)`);
    const probe = await probeResumeLayout(docx);
    if (probe) console.log(`✓ Page count measured on the rendered file: ${probe.pages} page(s)`);
    else console.log("! Page count not measured: poppler's pdfinfo and pdftotext were not found. Page fit will be estimated from the word count.");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
