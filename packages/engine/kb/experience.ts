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

/**
 * ANTI-FABRICATION CORE (§22, non-negotiable behavior #1).
 *
 * Strip every unverified `[?]` fact before the experience is sent to ANY model
 * call (scoring or generation). The model must never see unverified claims, so
 * it cannot score or write based on them.
 *
 * Removes:
 *  - frontmatter skills / scope entries whose `prov` is "?"
 *  - body lines carrying a `[?]` tag
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

function stripUnverifiedBody(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let inHoldingPen = false;

  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const title = heading[1].toLowerCase();
      // ONLY the "Raw material / notes" holding pen is stripped wholesale. Match
      // it specifically: a loose /notes/ match silently deleted legitimate
      // confirmed sections like "Delivery notes" from all model evidence.
      inHoldingPen = /^raw material\b/.test(title);
      if (inHoldingPen) continue;
    }
    if (inHoldingPen) continue;
    if (UNVERIFIED_TAG.test(line)) continue; // drop any [?]-tagged fact
    out.push(line);
  }

  // Collapse 3+ blank lines left by removals.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** True if the file still contains any unverified facts awaiting confirmation. */
export function hasUnverifiedFacts(exp: Experience): boolean {
  if ((exp.frontmatter.skills ?? []).some((s) => s.prov === "?")) return true;
  if (
    exp.frontmatter.scope &&
    Object.values(exp.frontmatter.scope).some((v) => v.prov === "?")
  ) {
    return true;
  }
  return UNVERIFIED_TAG.test(exp.body);
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

/** Ensure a fact line carries a provenance tag (default [C] for user-confirmed). */
function ensureTag(text: string, prov: Provenance = "C"): string {
  const t = text.trim();
  return /\[[RCF?]\]\s*$/.test(t) ? t : `${t} [${prov}]`;
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
