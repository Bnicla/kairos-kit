/**
 * ATS text-layer verification of a rendered résumé.
 *
 * Applicant tracking systems read the PDF's embedded text layer, not the page a
 * human sees. This module checks that text (as extracted by `pdftotext -layout`)
 * for the failure modes that silently cost a parse:
 *
 *  - contact-missing   the name, email or phone is absent from the text (a
 *                      contact carried only by a hyperlink or an icon is
 *                      invisible to a parser)
 *  - unicode-date-dash a year or "Present" joined to a Unicode dash: Workday's
 *                      import dropped such date ranges ("2022 – 2026")
 *  - broken-glyphs     "(cid:NN)" markers or U+FFFD replacement characters: a
 *                      font was embedded without a usable Unicode map
 *  - reading-order     section headings or employers come out of the text in a
 *                      different order than the document (multi-column layouts,
 *                      text boxes, floating frames)
 *  - empty-layer       almost no text at all (image-only PDF)
 *
 * Pure and portable: no filesystem, no process spawning. The local lane feeds it
 * the extraction; the expectations come from the résumé markdown source.
 */

export type AtsRule =
  | "contact-missing"
  | "unicode-date-dash"
  | "broken-glyphs"
  | "reading-order"
  | "empty-layer";

export interface AtsIssue {
  rule: AtsRule;
  detail: string;
}

export interface AtsResult {
  ok: boolean;
  issues: AtsIssue[];
}

export interface AtsExpect {
  email?: string;
  phone?: string;
  name?: string;
  /** `##` section headings, in document order. */
  sectionOrder?: string[];
  /** `###` employer names, in document order. */
  companies?: string[];
  /**
   * The section heading the employers sit under (e.g. "Professional
   * Experience"). When it is found in the text, the employer-order search
   * starts there, so an employer named earlier in the summary prose does not
   * stand in for its heading.
   */
  companiesSection?: string;
}

/** Fewer non-whitespace characters than this means the text layer is effectively empty. */
export const MIN_TEXT_LAYER_CHARS = 500;

/** The Unicode dashes that break date-range parsing: ‒ – — ― − (U+2012–U+2015, U+2212). */
const DASH_CLASS = "[\\u2012\\u2013\\u2014\\u2015\\u2212]";
/** Horizontal whitespace only, so a match never spans a line break. */
const HSPACE = "[^\\S\\r\\n]*";
const DATE_TOKEN = "(?:(?:19|20)\\d{2}|present)";
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";

const MAX_SAMPLES = 5;

// --- normalization ---------------------------------------------------------

/** Case-folded, whitespace-collapsed form used for every "does X appear" match. */
function normForMatch(s: string): string {
  return s
    .normalize("NFKC") // ligatures (ﬁ → fi), non-breaking/odd spaces → plain
    .replace(/[­​-‍⁠﻿]/g, "") // soft hyphens, zero-width chars
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

/** First whole-word occurrence of `needle` in `hay` at or after `from`, or -1. */
function findWord(hay: string, needle: string, from = 0): number {
  if (!needle) return -1;
  let at = hay.indexOf(needle, from);
  while (at !== -1) {
    const before = at > 0 ? hay[at - 1] : undefined;
    const after = hay[at + needle.length];
    const leftOk = !isWordChar(needle[0]) || !isWordChar(before);
    const rightOk = !isWordChar(needle[needle.length - 1]) || !isWordChar(after);
    if (leftOk && rightOk) return at;
    at = hay.indexOf(needle, at + 1);
  }
  return -1;
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

/**
 * Rewrite a Unicode dash that joins two date tokens as an ASCII hyphen with
 * spaces: "2022–2026" → "2022 - 2026", "2026 — Present" → "2026 - Present",
 * "2019 – Mar 2021" → "2019 - Mar 2021". Only a dash with a year/"Present" on
 * the left and a (month +) year / "Present" on the right is touched, so en
 * dashes elsewhere in prose stay as written.
 */
export function normalizeDateRangeDashes(s: string): string {
  const right = `(?:${MONTH}[^\\S\\r\\n]+)?(?:(?:0?[1-9]|1[0-2])\\/)?(?:(?:19|20)\\d{2}|present|current|now)\\b`;
  const re = new RegExp(`\\b(${DATE_TOKEN})${HSPACE}${DASH_CLASS}${HSPACE}(?=${right})`, "gi");
  return s.replace(re, "$1 - ");
}

// --- rules -----------------------------------------------------------------

function checkContacts(text: string, expect: AtsExpect, issues: AtsIssue[]): void {
  const hay = normForMatch(text);
  const why = "a contact carried only by a hyperlink or an icon is invisible to parsers";

  if (expect.name?.trim()) {
    const name = normForMatch(expect.name);
    if (findWord(hay, name) === -1) {
      issues.push({ rule: "contact-missing", detail: `Name "${expect.name.trim()}" not found in the text layer.` });
    }
  }
  if (expect.email?.trim()) {
    const email = normForMatch(expect.email);
    if (!hay.includes(email)) {
      issues.push({ rule: "contact-missing", detail: `Email "${expect.email.trim()}" not found as text (${why}).` });
    }
  }
  if (expect.phone?.trim()) {
    const want = digitsOf(expect.phone);
    // Accept the number with or without its country code: try the full digit
    // string, then drop up to 3 leading digits, never below 9 digits.
    const variants = [0, 1, 2, 3].map((n) => want.slice(n)).filter((v, i) => i === 0 || v.length >= 9);
    const runs = text.normalize("NFKC").match(/\+?\(?\d[\d\s().\-‐-―−\/]*\d/g) ?? [];
    const found = want.length > 0 && runs.some((r) => variants.some((v) => digitsOf(r).includes(v)));
    if (!found) {
      issues.push({ rule: "contact-missing", detail: `Phone "${expect.phone.trim()}" not found as text (${why}).` });
    }
  }
}

function checkUnicodeDateDash(text: string, issues: AtsIssue[]): void {
  const re = new RegExp(`\\b(${DATE_TOKEN})\\b${HSPACE}${DASH_CLASS}|${DASH_CLASS}${HSPACE}\\b(${DATE_TOKEN})\\b`, "gi");
  const samples: string[] = [];
  let count = 0;
  for (const m of text.matchAll(re)) {
    count++;
    const i = m.index ?? 0;
    const end = i + m[0].length;
    const lineStart = text.lastIndexOf("\n", i) + 1;
    const nl = text.indexOf("\n", end);
    const lineEnd = nl === -1 ? text.length : nl;
    // Widen the match to the whole range: token-then-dash takes the next word
    // (plus a month name before it), dash-then-token takes the previous word;
    // a month name right before the left-hand year comes along too.
    const before = text.slice(lineStart, i);
    const after = text.slice(end, lineEnd);
    const monthBefore = before.match(new RegExp(`\\b${MONTH}[^\\S\\r\\n]+$`, "i"))?.[0] ?? "";
    const sample = m[1] !== undefined
      ? monthBefore + m[0] + (after.match(new RegExp(`^[^\\S\\r\\n]*(?:${MONTH}[^\\S\\r\\n]+)?\\S+`, "i"))?.[0] ?? "")
      : (before.match(/\S+[^\S\r\n]*$/)?.[0] ?? "") + m[0];
    const clean = sample.replace(/\s+/g, " ").trim();
    if (samples.length < MAX_SAMPLES && !samples.includes(clean)) samples.push(clean);
  }
  if (count > 0) {
    issues.push({
      rule: "unicode-date-dash",
      detail:
        `${count} date range(s) join a year or "Present" to a Unicode dash; some ATS imports (Workday) drop these dates. ` +
        `Use an ASCII hyphen with spaces ("2022 - 2026"). Samples: ${samples.map((s) => `"${s}"`).join(", ")}`,
    });
  }
}

function checkBrokenGlyphs(text: string, issues: AtsIssue[]): void {
  const cids = [...text.matchAll(/\(cid:\d+\)/g)];
  const fffd = [...text.matchAll(/�/g)];
  if (!cids.length && !fffd.length) return;
  const samples = [...cids, ...fffd]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .slice(0, 3)
    .map((m) => {
      const i = m.index ?? 0;
      return `"${text.slice(Math.max(0, i - 15), i + m[0].length + 15).replace(/\s+/g, " ").trim()}"`;
    });
  const parts = [
    cids.length ? `${cids.length} (cid:NN) marker(s)` : "",
    fffd.length ? `${fffd.length} U+FFFD replacement character(s)` : "",
  ].filter(Boolean);
  issues.push({
    rule: "broken-glyphs",
    detail: `${parts.join(" and ")} in the text layer: a font is embedded without a usable Unicode map, so parsers read garbage. Samples: ${samples.join(", ")}`,
  });
}

/**
 * Greedy subsequence match: each item must occur (whole-word, case-folded)
 * after the previous one. Greedy earliest-match is exact for "is this list a
 * subsequence", so an issue here is never a false alarm about order; an item
 * mentioned earlier in prose can, however, mask a real disorder.
 */
function checkOrder(hay: string, items: string[], label: string, start: number, issues: AtsIssue[]): void {
  let cursor = start;
  let prev: string | null = null;
  for (const item of items) {
    const needle = normForMatch(item);
    if (!needle) continue;
    const at = findWord(hay, needle, cursor);
    if (at !== -1) {
      cursor = at + needle.length;
      prev = item;
      continue;
    }
    const anywhere = findWord(hay, needle, 0);
    issues.push({
      rule: "reading-order",
      detail:
        anywhere === -1
          ? `${label} "${item}" not found in the text layer.`
          : `${label} "${item}" comes out of the text before ${prev ? `"${prev}"` : "where it belongs"}; a parser would read the document in a different order (multi-column layout, text box, or floating frame).`,
    });
  }
}

/**
 * Check an extracted text layer against what the résumé source says it holds.
 * Every rule runs independently; when the layer is effectively empty, the
 * contact and reading-order findings are suppressed (they would only restate
 * the empty layer).
 */
export function checkAtsText(extracted: string, expect: AtsExpect = {}): AtsResult {
  const issues: AtsIssue[] = [];
  const text = extracted ?? "";
  const chars = text.replace(/\s+/g, "").length;

  if (chars < MIN_TEXT_LAYER_CHARS) {
    issues.push({
      rule: "empty-layer",
      detail: `Text layer holds only ${chars} characters (expected at least ${MIN_TEXT_LAYER_CHARS}): the PDF is image-only or its text did not embed, so an ATS sees an (almost) empty résumé.`,
    });
  }

  checkUnicodeDateDash(text, issues);
  checkBrokenGlyphs(text, issues);

  if (chars >= MIN_TEXT_LAYER_CHARS) {
    checkContacts(text, expect, issues);
    const hay = normForMatch(text);
    if (expect.sectionOrder?.length) checkOrder(hay, expect.sectionOrder, "Section", 0, issues);
    if (expect.companies?.length) {
      const sec = expect.companiesSection ? findWord(hay, normForMatch(expect.companiesSection)) : -1;
      checkOrder(hay, expect.companies, "Employer", sec === -1 ? 0 : sec, issues);
    }
  }

  return { ok: issues.length === 0, issues };
}

// --- expectations from the résumé source -----------------------------------

/** Strip inline markdown (links, emphasis, code ticks, escapes, entities) to the visible text. */
function stripInline(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'")
    .trim();
}

/**
 * Derive what the text layer must contain from the résumé markdown source:
 * name from the `#` line, email and phone from the header block under it,
 * section order from `##` headings, employers from `### Company | Location`.
 */
export function atsExpectFromMarkdown(md: string): AtsExpect {
  const lines = md.split(/\r?\n/);
  const expect: AtsExpect = {};
  const sections: string[] = [];
  const companies: string[] = [];
  let headerBlock: string[] | null = null; // lines between the name and the first other heading
  let currentSection: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) {
      const depth = h[1].length;
      const text = stripInline(h[2]);
      if (depth === 1 && expect.name === undefined) {
        expect.name = text;
        headerBlock = [];
        continue;
      }
      // The header block (contact line) closes at the first heading after the name.
      if (headerBlock) applyHeaderBlock(expect, headerBlock);
      headerBlock = null;
      if (depth === 2) {
        sections.push(text);
        currentSection = text;
      } else if (depth === 3) {
        const company = stripInline(h[2].split("|")[0] ?? "");
        if (company && companies[companies.length - 1] !== company) companies.push(company);
        if (expect.companiesSection === undefined && currentSection) expect.companiesSection = currentSection;
      }
      continue;
    }
    if (headerBlock && line && !line.startsWith("<!--")) headerBlock.push(line);
  }
  if (headerBlock) applyHeaderBlock(expect, headerBlock);

  if (sections.length) expect.sectionOrder = sections;
  if (companies.length) expect.companies = companies;
  return expect;
}

function applyHeaderBlock(expect: AtsExpect, block: string[]): void {
  const header = block.join("\n");
  const email = header.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0];
  if (email) expect.email = email;
  for (const m of header.matchAll(/\+?\(?\d[\d\s().-]{5,}\d/g)) {
    const n = digitsOf(m[0]).length;
    if (n >= 7 && n <= 15) {
      expect.phone = m[0].trim();
      break;
    }
  }
}
