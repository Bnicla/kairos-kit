import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  BorderStyle,
  TabStopType,
} from "docx";
import { marked, type Tokens, type Token } from "marked";
import { normalizeDateRangeDashes } from "@kairos/engine/ats-text";

/**
 * Render an editable resume-source.md into a clean, ATS-safe .docx — single
 * column, standard headers, real text. DOCX is the primary deliverable: the user
 * edits it in Word for final polish, and many ATS parse .docx more reliably
 * than PDF.
 *
 * Design is an injectable TemplateSpec (DEC-8): DEFAULT_TEMPLATE is the render-
 * verified house design; a per-user template (e.g. parsed from an uploaded
 * .docx) overrides fonts/sizes/colors/margins WITHOUT touching content. The
 * local lane passes nothing and gets today's exact output.
 */

/** Sizes are docx half-points (21 = 10.5pt); margins are twips (1440 = 1"). */
export interface TemplateSpec {
  font: string;
  ink: string;
  muted: string;
  rule: string;
  base: number;
  name: number;
  headline: number;
  contact: number;
  sectionHeader: number;
  company: number;
  role: number;
  pageMarginTwips: number;
  /**
   * Paper size, always written into the file (the docx library would otherwise
   * fall back to A4). The save and render paths pass the user's setting
   * (settings.resumePaper: profile.md `paper`, else US Letter for a United
   * States search and A4 otherwise).
   */
  paper: Paper;
}

export type Paper = "letter" | "a4";

/** Page dimensions in twips (1440 = 1"). */
export const PAPER_TWIPS: Record<Paper, { width: number; height: number }> = {
  letter: { width: 12240, height: 15840 }, // 8.5" x 11"
  a4: { width: 11906, height: 16838 }, // 210 x 297 mm
};

// Spacing/size RENDER-VERIFIED (not estimated) to fill a full 2 pages without
// spilling to a 3rd — see scripts/render-resume.sh (LibreOffice headless →
// page PNGs). keepNext/keepLines below keep roles intact across the break.
// That calibration was done on A4. US Letter holds a little less: measured
// 2026-11-13 with the layout probe on an invented six-role résumé, two pages
// took up to 1,458 words on A4 (page 2 97% full) and up to 1,365 on Letter
// (94%); 1,393 words and more ran to a third page on Letter. The spacing is
// the same on both papers; the layout probe and the fit loops find the page
// count on whichever paper is used.
export const DEFAULT_TEMPLATE: TemplateSpec = {
  font: "Calibri",
  ink: "222222",
  muted: "666666",
  rule: "AAAAAA",
  base: 21,
  name: 36, // 18pt
  headline: 21, // 10.5pt
  contact: 18, // 9pt
  sectionHeader: 21, // 10.5pt
  company: 22, // 11pt (uppercase)
  role: 22, // 11pt
  pageMarginTwips: 720, // 0.5" — matches the candidate-preferred tight layout
  // US Letter: the default search is limited to the United States. A caller
  // that knows the user passes settings.resumePaper (profile.md `paper`, else
  // Letter for a United States search and A4 otherwise); this value is only
  // what a render with no paper given falls back to.
  paper: "letter",
};

export interface DocxOptions {
  /** Optional tagline shown under the name, e.g. "Data Platform Product Lead". */
  headline?: string;
  font?: string;
  /** Per-user design overrides (DEC-8). Content is never affected. */
  template?: Partial<TemplateSpec>;
}

export async function markdownResumeToDocx(md: string, opts: DocxOptions = {}): Promise<Buffer> {
  const T: TemplateSpec = { ...DEFAULT_TEMPLATE, ...opts.template };
  const font = opts.font ?? T.font;
  const page = PAPER_TWIPS[T.paper];
  const rightTabTwips = page.width - T.pageMarginTwips * 2;
  // ATS: date ranges go out as "2022 - 2026", never "2022 – 2026" (Workday's
  // import dropped ranges whose year touched a Unicode dash). Normalized here as
  // well as in the markdown serializer, so older or hand-edited sources render
  // clean too. Only a dash between date tokens changes; prose en dashes stay.
  const tokens = marked.lexer(normalizeDateRangeDashes(md));
  const children: Paragraph[] = [];
  let breakNextRole = false; // armed by a <!--PAGEBREAK--> sentinel from the serializer

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Page-break sentinel: force the next role (company or role heading) to open
    // a new page, so a designated role starts cleanly at the top of page 2.
    if (
      t.type === "html" &&
      /PAGEBREAK/i.test((t as { text?: string; raw?: string }).text ?? (t as { raw?: string }).raw ?? "")
    ) {
      breakNextRole = true;
      continue;
    }

    if (t.type === "heading" && t.depth === 1) {
      // Name (uppercase) with the headline inline after a dash.
      const runs: TextRun[] = [
        new TextRun({ text: t.text.toUpperCase(), bold: true, size: T.name, color: T.ink, font }),
      ];
      if (opts.headline) {
        runs.push(new TextRun({ text: `   —   ${opts.headline}`, size: T.headline, color: T.muted, font }));
      }
      children.push(new Paragraph({ spacing: { after: 40 }, children: runs }));
      continue;
    }

    if (t.type === "heading" && t.depth === 2) {
      children.push(
        new Paragraph({
          keepNext: true, // a section header must not sit alone at a page bottom
          keepLines: true,
          spacing: { before: 182, after: 64 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: T.rule, space: 1 } },
          children: [
            new TextRun({
              text: t.text.toUpperCase(),
              bold: true,
              size: T.sectionHeader,
              color: T.ink,
              font,
              characterSpacing: 12,
            }),
          ],
        }),
      );
      continue;
    }

    if (t.type === "heading" && t.depth === 3) {
      // Company header: "Company | Location" — company uppercase on the left,
      // location right-aligned. Roles at this company follow as depth-4 headings.
      const [company, location] = splitPipe(t.text);
      const brk = breakNextRole; breakNextRole = false;
      const runs: TextRun[] = [
        new TextRun({ text: company.toUpperCase(), bold: true, size: T.company, color: T.ink, font, characterSpacing: 8 }),
      ];
      if (location) runs.push(new TextRun({ text: `\t${location}`, size: T.base, color: T.muted, font }));
      children.push(
        new Paragraph({
          pageBreakBefore: brk,
          keepNext: true, // keep the company header with the role beneath it
          keepLines: true,
          spacing: { before: 206, after: 12 },
          tabStops: [{ type: TabStopType.RIGHT, position: rightTabTwips }],
          children: runs,
        }),
      );
      continue;
    }

    if (t.type === "heading" && t.depth === 4) {
      // Role line: "Title | Dates" — title bold on the left, dates right-aligned.
      const [title, dates] = splitPipe(t.text);
      const brk = breakNextRole; breakNextRole = false;
      const runs: TextRun[] = [new TextRun({ text: title, bold: true, size: T.role, color: T.ink, font })];
      if (dates) runs.push(new TextRun({ text: `\t${dates}`, size: T.base, color: T.muted, font }));
      children.push(
        new Paragraph({
          pageBreakBefore: brk,
          keepNext: true, // keep the role line with its first bullet
          keepLines: true,
          spacing: { before: 76, after: 22 },
          tabStops: [{ type: TabStopType.RIGHT, position: rightTabTwips }],
          children: runs,
        }),
      );
      continue;
    }

    if (t.type === "list") {
      for (const item of (t as Tokens.List).items) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            keepLines: true, // never split a single bullet across a page break
            // Tight bullets: near-flush at the margin with a small hanging
            // indent (Word's default numbering pushes bullets ~0.5" right,
            // which the candidate had to fix by hand on every export).
            indent: { left: 200, hanging: 200 },
            spacing: { after: 26, line: 240 },
            children: inlineRuns(item.tokens ?? [], font, T.base, { color: T.ink }),
          }),
        );
      }
      continue;
    }

    if (t.type === "paragraph") {
      // A stray paragraph: contact line (right after the name) or summary text.
      const isContact = children.length <= 1;
      children.push(
        new Paragraph({
          keepLines: true,
          spacing: { after: isContact ? 84 : 44, line: 258 },
          children: inlineRuns((t as Tokens.Paragraph).tokens ?? [], font, isContact ? T.contact : T.base, {
            color: isContact ? T.muted : T.ink,
          }),
        }),
      );
      continue;
    }
  }

  const doc = new Document({
    styles: { default: { document: { run: { font, size: T.base, color: T.ink } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: page.width, height: page.height },
            margin: {
              top: T.pageMarginTwips,
              right: T.pageMarginTwips,
              bottom: T.pageMarginTwips,
              left: T.pageMarginTwips,
            },
          },
        },
        children,
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

/**
 * Render a cover letter (plain prose) to a clean business-letter .docx — no
 * uppercase name, no section rules, generous spacing. The first block is the
 * sender name + contact; the rest are letter paragraphs.
 */
export async function markdownLetterToDocx(
  md: string,
  opts: { font?: string; template?: Partial<TemplateSpec> } = {},
): Promise<Buffer> {
  const T: TemplateSpec = { ...DEFAULT_TEMPLATE, ...opts.template };
  const font = opts.font ?? T.font;
  const blocks = md.trim().split(/\n{2,}/);
  const children: Paragraph[] = [];

  blocks.forEach((block, i) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (i === 0) {
      // Header: name (bold), then contact line (muted).
      children.push(
        new Paragraph({
          spacing: { after: lines[1] ? 0 : 200 },
          children: [new TextRun({ text: decodeEntities(lines[0] ?? ""), bold: true, size: 24, color: T.ink, font })],
        }),
      );
      if (lines[1]) {
        children.push(
          new Paragraph({
            spacing: { after: 240 },
            children: [new TextRun({ text: decodeEntities(lines[1]), size: T.contact, color: T.muted, font })],
          }),
        );
      }
      return;
    }
    // Markdown inline formatting (**bold**, *italic*) is rendered, never printed
    // literally (2026-10-09: a letter with bold bullet lead-ins showed raw "**").
    const inline = (text: string) => inlineRuns(marked.Lexer.lexInline(text), font, T.base, { color: T.ink });
    // A bullet block ("- " / "* " lines) becomes real bullets, tight like the résumé's.
    if (lines.every((l) => /^[-*•]\s+/.test(l))) {
      lines.forEach((line, j) => {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            keepLines: true,
            indent: { left: 360, hanging: 240 },
            spacing: { after: j === lines.length - 1 ? 160 : 80, line: 276 },
            children: inline(line.replace(/^[-*•]\s+/, "")),
          }),
        );
      });
      return;
    }
    // Body paragraph: preserve intra-block line breaks (e.g. a multi-line close).
    const runs: TextRun[] = [];
    lines.forEach((line, j) => {
      if (j > 0) runs.push(new TextRun({ text: "", break: 1 }));
      runs.push(...inline(line));
    });
    children.push(new Paragraph({ spacing: { after: 160, line: 276 }, children: runs }));
  });

  const doc = new Document({
    styles: { default: { document: { run: { font, size: T.base, color: T.ink } } } },
    sections: [
      {
        properties: {
          page: {
            size: PAPER_TWIPS[T.paper],
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children,
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

/** Convert marked inline tokens to styled docx runs (bold/italic preserved). */
function inlineRuns(
  tokens: Token[],
  font: string,
  size: number,
  base: { color?: string; bold?: boolean; italics?: boolean } = {},
): TextRun[] {
  const runs: TextRun[] = [];
  for (const tok of tokens) {
    if (tok.type === "strong") {
      runs.push(...inlineRuns((tok as Tokens.Strong).tokens, font, size, { ...base, bold: true }));
    } else if (tok.type === "em") {
      runs.push(...inlineRuns((tok as Tokens.Em).tokens, font, size, { ...base, italics: true }));
    } else if (tok.type === "link") {
      runs.push(...inlineRuns((tok as Tokens.Link).tokens, font, size, base));
    } else if (tok.type === "text" && Array.isArray((tok as Tokens.Text).tokens) && (tok as Tokens.Text).tokens!.length) {
      // A block-level text token (e.g. a list item) wraps the real inline
      // breakdown in .tokens — recurse so **bold** becomes bold, not literal "**".
      runs.push(...inlineRuns((tok as Tokens.Text).tokens!, font, size, base));
    } else if ("text" in tok && typeof tok.text === "string") {
      runs.push(
        new TextRun({
          text: decodeEntities(tok.text),
          font,
          size,
          color: base.color ?? DEFAULT_TEMPLATE.ink,
          bold: base.bold,
          italics: base.italics,
        }),
      );
    }
  }
  return runs.length ? runs : [new TextRun({ text: "", font, size })];
}

/** Split a "Left | Right" heading into [left, right?]. */
function splitPipe(text: string): [string, string | undefined] {
  const idx = text.indexOf("|");
  if (idx === -1) return [text.trim(), undefined];
  return [text.slice(0, idx).trim(), text.slice(idx + 1).trim() || undefined];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&middot;/g, "·");
}
