import { marked } from "marked";
import type { GeneratedResume } from "@kairos/engine/types";
import { normalizeDateRangeDashes } from "@kairos/engine/ats-text";

/**
 * Render a generated resume to (a) an editable markdown source that round-trips
 * cleanly, and (b) parse-safe single-column HTML for preview + PDF. The HTML uses
 * standard section headers and no tables/columns so it parses cleanly on ATS.
 *
 * Date ranges are emitted with an ASCII hyphen and spaces ("2022 - 2026",
 * "2026 - Present"): Workday's import dropped ranges whose year touched an en
 * or em dash. The model's `dates` strings often carry "–", so every renderer
 * normalizes at render time (normalizeDateRangeDashes touches only a dash
 * between date tokens; en dashes in prose stay).
 */

export function generatedResumeToMarkdown(gen: GeneratedResume): string {
  const r = gen.resume;
  const lines: string[] = [];
  lines.push(`# ${r.header.name}`);
  if (r.header.contact) lines.push(r.header.contact);
  lines.push("");
  if (r.executive_summary) {
    lines.push("## Executive Summary", "", r.executive_summary, "");
  }
  lines.push("## Professional Experience", "");
  // Group consecutive roles at the same company under one company header, so
  // career progression at one employer reads as nested roles (matches a
  // company-centric resume layout). "### Company | Location" then "#### Role | Dates".
  let lastCompany: string | null = null;
  for (const exp of r.experience) {
    // A flagged role starts a new page: emit a sentinel the docx renderer turns
    // into a real page break before this role's heading (company or role line).
    if ((exp as { page_break_before?: boolean }).page_break_before) {
      lines.push("<!--PAGEBREAK-->");
    }
    if (exp.company !== lastCompany) {
      lines.push(`### ${exp.company}${exp.location ? ` | ${exp.location}` : ""}`);
      lastCompany = exp.company;
    }
    lines.push(`#### ${exp.title}${exp.dates ? ` | ${exp.dates}` : ""}`);
    if (exp.summary) lines.push("", exp.summary);
    lines.push("");
    for (const b of exp.bullets) lines.push(`- ${b}`);
    lines.push("");
  }
  if (r.education?.length) {
    lines.push("## Education", "");
    for (const ed of r.education) {
      lines.push(`- **${ed.credential}**, ${ed.institution}${ed.dates ? ` (${ed.dates})` : ""}`);
    }
    lines.push("");
  }
  if (r.skills?.length) {
    lines.push("## Skills", "", r.skills.join(" · "), "");
  }
  return normalizeDateRangeDashes(lines.join("\n").trim()) + "\n";
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Parse-safe, print-faithful HTML. Single column, standard headers, text-based. */
export function generatedResumeToHtml(
  gen: GeneratedResume,
  { forPrint = false }: { forPrint?: boolean } = {},
): string {
  const r = gen.resume;
  const body = `
  <header class="r-head">
    <h1>${esc(r.header.name)}</h1>
    ${r.header.contact ? `<p class="contact">${esc(r.header.contact)}</p>` : ""}
  </header>
  ${
    r.executive_summary
      ? `<section><h2>Executive Summary</h2><p>${esc(r.executive_summary)}</p></section>`
      : ""
  }
  <section>
    <h2>Professional Experience</h2>
    ${r.experience
      .map(
        (exp) => `
      <div class="role">
        <div class="role-head">
          <span class="role-title">${esc(exp.title)} — ${esc(exp.company)}</span>
          <span class="role-meta">${esc([exp.location, exp.dates && normalizeDateRangeDashes(exp.dates)].filter(Boolean).join(" · "))}</span>
        </div>
        <ul>${exp.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
      </div>`,
      )
      .join("")}
  </section>
  ${
    r.education?.length
      ? `<section><h2>Education</h2><ul>${r.education
          .map(
            (ed) =>
              `<li><strong>${esc(ed.credential)}</strong>, ${esc(ed.institution)}${
                ed.dates ? ` (${esc(normalizeDateRangeDashes(ed.dates))})` : ""
              }</li>`,
          )
          .join("")}</ul></section>`
      : ""
  }
  ${
    r.skills?.length
      ? `<section><h2>Skills</h2><p class="skills">${r.skills.map(esc).join(" · ")}</p></section>`
      : ""
  }`;

  const css = `
    :root { --ink:#111; --muted:#555; }
    * { box-sizing: border-box; }
    html, body { background: #fff; }
    body { font-family: Georgia, 'Times New Roman', serif; color: var(--ink); line-height: 1.4; margin: 0; }
    .resume { max-width: 720px; margin: 0 auto; padding: ${forPrint ? "0" : "40px"}; font-size: 11pt; }
    .r-head h1 { font-size: 20pt; margin: 0 0 4px; letter-spacing: .5px; }
    .contact { color: var(--muted); margin: 0 0 8px; font-size: 10pt; }
    h2 { font-size: 12pt; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #ccc; padding-bottom: 2px; margin: 16px 0 8px; }
    .role { margin-bottom: 12px; }
    .role-head { display: flex; justify-content: space-between; gap: 12px; }
    .role-title { font-weight: bold; }
    .role-meta { color: var(--muted); font-size: 10pt; white-space: nowrap; }
    ul { margin: 6px 0; padding-left: 18px; }
    li { margin: 3px 0; }
    .skills { font-size: 10pt; }
    @page { margin: 1.6cm; }
  `;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="resume">${body}</div></body></html>`;
}

const RESUME_CSS = `
  * { box-sizing: border-box; }
  html, body { background: #fff; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; line-height: 1.4; margin: 0; }
  .resume { max-width: 720px; margin: 0 auto; padding: 0; font-size: 11pt; }
  h1 { font-size: 20pt; margin: 0 0 4px; }
  h1 + p { color: #555; font-size: 10pt; margin: 0 0 8px; }
  h2 { font-size: 12pt; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #ccc; padding-bottom: 2px; margin: 16px 0 8px; }
  h3 { font-size: 11.5pt; margin: 12px 0 2px; }
  ul { margin: 6px 0; padding-left: 18px; }
  li { margin: 3px 0; }
  em { color: #555; font-size: 10pt; }
  @page { margin: 1.6cm; }
`;

/** Render an edited resume-source.md into the same parse-safe styled HTML for PDF. */
export function markdownResumeToHtml(md: string): string {
  // Turn the serializer's page-break sentinel into a real CSS page break so the
  // PDF export matches the docx (a designated role starts a new page).
  const withBreaks = normalizeDateRangeDashes(md).replace(/<!--\s*PAGEBREAK\s*-->/gi, '\n<div class="page-break"></div>\n');
  const inner = marked.parse(withBreaks, { async: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${RESUME_CSS}\n.page-break { page-break-before: always; }</style></head><body><div class="resume">${inner}</div></body></html>`;
}
