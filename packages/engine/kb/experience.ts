import matter from "gray-matter";
import type {
  Experience,
  ExperienceFrontmatter,
  Provenance,
} from "@kairos/engine/kb/types";

/** Parse a knowledge-base experience `.md` (YAML frontmatter + markdown body). */
export function parseExperience(fileName: string, raw: string): Experience {
  const { data, content } = matter(raw);
  return {
    fileName,
    frontmatter: data as ExperienceFrontmatter,
    body: content.trim(),
  };
}

/** Serialize an experience back to `.md` for writing to Drive. */
export function serializeExperience(exp: Experience): string {
  return matter.stringify(`\n${exp.body}\n`, exp.frontmatter);
}

const UNVERIFIED_TAG = /\[\?\]/;
/** Any provenance tag: [R], [C], [F] or [?]. */
const ANY_TAG = /\[[RCF?]\]/;

/**
 * ANTI-FABRICATION CORE (§22, non-negotiable behavior #1).
 *
 * Strip every unverified fact before the experience is sent to ANY model call
 * (scoring or generation) or used to ground a number. The model must never see
 * unverified claims, so it cannot score or write based on them.
 *
 * Removes:
 *  - frontmatter skills / scope entries whose `prov` is "?"
 *  - body facts carrying a `[?]` tag
 *  - body facts carrying no provenance tag at all (see `bodyUnits`): a fact
 *    nobody tagged is not verified evidence
 *  - the "Raw material / notes" holding-pen section entirely
 */
export function stripUnverified(exp: Experience): Experience {
  const fm = exp.frontmatter;

  const skills = (fm.skills ?? []).filter((s) => s.prov !== "?");
  const scope = fm.scope
    ? Object.fromEntries(
        Object.entries(fm.scope).filter(([, v]) => v.prov !== "?"),
      )
    : undefined;

  const body = stripUnverifiedBody(exp.body);

  return {
    ...exp,
    frontmatter: { ...fm, skills, ...(scope ? { scope } : {}) },
    body,
  };
}

/**
 * One unit of an experience body. The format is line-based: one fact per line.
 *
 *  - "fact": a line that states something. Either a list item (`-`, `*`, `+`
 *    or `1.` at any indent) together with its indented continuation lines, or
 *    one line of paragraph text. Each list item is its own fact, nested ones
 *    included: a sub-bullet does not inherit the tag of the bullet above it.
 *  - "structure": everything that states nothing by itself and is never
 *    stripped or reported: blank lines, headings, lines with no letter or digit
 *    (rules, table separators, code-fence markers), and label lines (a short
 *    line with no digit that ends with a colon, e.g. "Key projects:" or
 *    "- **Team:**", which only introduces the lines under it).
 *
 * Frontmatter is not part of the body and is not covered here.
 */
interface BodyUnit {
  kind: "fact" | "structure";
  /** Index of the unit's first and last line in the body (0-based, inclusive). */
  start: number;
  end: number;
  /** Inside the "Raw material / notes" holding pen (heading included). */
  holdingPen: boolean;
  /** Title of the nearest heading above, or null. */
  section: string | null;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const LABEL_MAX_WORDS = 8;

function isLabelLine(line: string): boolean {
  const text = line.replace(LIST_ITEM, "").replace(/[*_`]/g, "").trim();
  return /:$/.test(text) && !/\d/.test(text) && text.split(/\s+/).length <= LABEL_MAX_WORDS;
}

function bodyUnits(lines: string[]): BodyUnit[] {
  const units: BodyUnit[] = [];
  let holdingPen = false;
  let section: string | null = null;
  let openItem: BodyUnit | null = null; // the list item that indented lines continue

  lines.forEach((line, i) => {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      // ONLY the "Raw material / notes" holding pen is stripped wholesale. Match
      // it specifically: a loose /notes/ match silently deleted legitimate
      // confirmed sections like "Delivery notes" from all model evidence.
      holdingPen = /^raw material\b/.test(heading[1].toLowerCase());
      section = heading[1].trim();
      openItem = null;
      units.push({ kind: "structure", start: i, end: i, holdingPen, section });
      return;
    }
    if (!/[\p{L}\p{N}]/u.test(line)) {
      if (!line.trim()) openItem = null; // a blank line ends the item
      units.push({ kind: "structure", start: i, end: i, holdingPen, section });
      return;
    }
    if (openItem && /^\s+\S/.test(line) && !LIST_ITEM.test(line)) {
      openItem.end = i; // wrapped text of the list item above
      return;
    }
    const isItem = LIST_ITEM.test(line);
    const unit: BodyUnit = { kind: isLabelLine(line) ? "structure" : "fact", start: i, end: i, holdingPen, section };
    units.push(unit);
    openItem = isItem && unit.kind === "fact" ? unit : null;
  });
  return units;
}

const unitText = (lines: string[], u: BodyUnit) => lines.slice(u.start, u.end + 1).join("\n");

function stripUnverifiedBody(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];

  for (const unit of bodyUnits(lines)) {
    if (unit.holdingPen) continue;
    const text = unitText(lines, unit);
    if (UNVERIFIED_TAG.test(text)) continue; // drop any [?]-tagged line, fact or not
    if (unit.kind === "fact" && !ANY_TAG.test(text)) continue; // no tag: not verified
    out.push(text);
  }

  // Collapse 3+ blank lines left by removals.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A fact in an experience body that carries no provenance tag. */
export interface UntaggedFact {
  /** 1-based line number within the body. */
  line: number;
  /** Heading the fact sits under, or null. */
  section: string | null;
  text: string;
}

/**
 * The body facts with no provenance tag ([R], [C], [F] or [?]), outside the
 * holding pen. `stripUnverified` leaves them out of the evidence; a save
 * reports them so the user can confirm each one ([C]) or mark it [?].
 */
export function untaggedFacts(body: string): UntaggedFact[] {
  const lines = body.split("\n");
  return bodyUnits(lines)
    .filter((u) => u.kind === "fact" && !u.holdingPen && !ANY_TAG.test(unitText(lines, u)))
    .map((u) => ({ line: u.start + 1, section: u.section, text: unitText(lines, u).trim() }));
}

/** Number of fact lines in a body, outside the holding pen (tagged or not). */
export function countFacts(body: string): number {
  return bodyUnits(body.split("\n")).filter((u) => u.kind === "fact" && !u.holdingPen).length;
}

/** True if the file still contains any unverified facts awaiting confirmation (a [?] tag, or no tag). */
export function hasUnverifiedFacts(exp: Experience): boolean {
  if ((exp.frontmatter.skills ?? []).some((s) => s.prov === "?")) return true;
  if (
    exp.frontmatter.scope &&
    Object.values(exp.frontmatter.scope).some((v) => v.prov === "?")
  ) {
    return true;
  }
  return UNVERIFIED_TAG.test(exp.body) || untaggedFacts(exp.body).length > 0;
}

/**
 * Strip provenance tags for human-facing display (e.g. rendering a bullet in the
 * document panel). Removes trailing/inline [R]/[C]/[F]/[?] markers.
 */
export function stripProvenanceTags(text: string): string {
  return text.replace(/\s*\[[RCF?]\]/g, "").trim();
}

export const ALL_PROVENANCE: Provenance[] = ["R", "C", "F", "?"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ensure every fact in a block carries a provenance tag (default [C] for
 * user-confirmed). A block of several lines gets one tag per fact, not one at
 * the end of the block: an untagged line is not evidence. A fact that already
 * ends with a tag is left as it is; headings, blank lines and labels get none.
 */
function ensureTag(text: string, prov: Provenance = "C"): string {
  const t = text.trim();
  const lines = t.split("\n");
  const facts = bodyUnits(lines).filter((u) => u.kind === "fact");
  // Nothing recognised as a fact (a lone label, say): tag the block as a whole.
  if (!facts.length) return /\[[RCF?]\]\s*$/.test(t) ? t : `${t} [${prov}]`;
  for (const u of facts) {
    const last = lines[u.end].trimEnd();
    if (!/\[[RCF?]\]\s*$/.test(last)) lines[u.end] = `${last} [${prov}]`;
  }
  return lines.join("\n");
}

/**
 * Append a user-confirmed fact (§22 learning loop) under a `## section` heading in
 * an experience body, creating the section if absent. The content is tagged [C]
 * unless it already carries a provenance tag. Enrichment stores only what the
 * candidate actually said — never fabricated.
 */
export function insertUnderSection(body: string, section: string, content: string): string {
  const block = ensureTag(content, "C");
  const re = new RegExp(`(^|\\n)##\\s+${escapeRegExp(section)}\\s*\\n`, "i");
  const m = re.exec(body);
  if (!m) {
    return `${body.trimEnd()}\n\n## ${section}\n${block}\n`;
  }
  const sectionStart = m.index + m[0].length;
  const rest = body.slice(sectionStart);
  const nextHeading = rest.search(/\n##\s+/);
  const insertAt = nextHeading === -1 ? body.length : sectionStart + nextHeading;
  return `${body.slice(0, insertAt).trimEnd()}\n${block}\n${body.slice(insertAt)}`;
}
