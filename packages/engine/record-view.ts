/**
 * The knowledge base as a view shows it: every role with its facts and their
 * provenance tags, the education entries, and how the user writes. This file
 * holds what the view shows, apart from how it is drawn, so that the local
 * dashboard (HTML from a React page) and the connector's record page (plain
 * DOM, text only) agree: which entries there are, in what order, how deep each
 * role is, and what each depth is called.
 */
import matter from "./front-matter";
import { countFacts } from "./kb/experience";
import { loadExperiences, loadVoiceProfile } from "./kb/store";
import type { Store } from "./store/types";

/** How much of a role comes from the user's own answers, beyond their résumé. */
export type RecordDepth = "résumé-only" | "developing" | "rich";

/** A role's depth: the number of facts the user confirmed in conversation ([C]); none, fewer than four, or more. */
export function recordDepth(body: string): { confirmedCount: number; depth: RecordDepth } {
  const confirmedCount = (body.match(/\[C\]/g) ?? []).length;
  const depth: RecordDepth = confirmedCount === 0 ? "résumé-only" : confirmedCount < 4 ? "developing" : "rich";
  return { confirmedCount, depth };
}

/** What each depth is called, and its colour family. */
export const DEPTH_LABEL: Record<RecordDepth, { label: string; tone: "warn" | "info" | "success" }> = {
  "résumé-only": { label: "Résumé-only", tone: "warn" },
  developing: { label: "Developing", tone: "info" },
  rich: { label: "Rich", tone: "success" },
};

/** What each provenance tag means, for the view's legend. */
export const PROVENANCE_LEGEND: { tag: "R" | "C" | "F"; meaning: string }[] = [
  { tag: "R", meaning: "résumé" },
  { tag: "C", meaning: "confirmed" },
  { tag: "F", meaning: "feedback" },
];

/**
 * A piece of a line: plain text, or a tag. In the knowledge base: [R], [C], [F], or [?] for a fact not
 * confirmed yet. In a preparation note (prep-note-view.ts): [C], [?], [K], [rev].
 */
export interface RecordPart {
  text: string;
  tag?: "R" | "C" | "F" | "?" | "K" | "rev";
}

/** One block of an entry's body: a heading, a list item or a paragraph, as text with its tags apart. */
export interface RecordBlock {
  kind: "heading" | "item" | "text";
  parts: RecordPart[];
}

/** The longest body a view is given for one entry; a longer one is cut at a block's end, and the view says so. */
export const RECORD_BODY_MAX = 12_000;

/** The knowledge base's tags, as the pattern that splits a line (one capturing group around the tag). */
const RECORD_TAGS = /(\[[RCF?]\])/;

const splitTags = (text: string, tags: RegExp): RecordPart[] =>
  text
    .split(tags)
    .filter((part) => part !== "")
    .map((part) => (new RegExp(`^${tags.source}$`).test(part) ? { text: part, tag: part.slice(1, -1) as RecordPart["tag"] } : { text: part }));

/**
 * An entry's Markdown body as blocks of text. Headings, list items and paragraphs are kept apart;
 * bold and italic marks are dropped (the view writes text, never HTML); a line that continues a list
 * item or a paragraph joins it. `cut` is true when the body was longer than `max`. `tags` is the
 * pattern of the tags kept apart: the knowledge base's own unless another is given.
 */
export function bodyBlocks(markdown: string, max: number = RECORD_BODY_MAX, tags: RegExp = RECORD_TAGS): { blocks: RecordBlock[]; cut: boolean } {
  const blocks: { kind: RecordBlock["kind"]; text: string }[] = [];
  let open: { kind: RecordBlock["kind"]; text: string } | null = null;
  let size = 0;
  let cut = false;
  const plain = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      open = null;
      continue;
    }
    size += line.length + 1;
    if (size > max) {
      cut = true;
      break;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) {
      open = null;
      blocks.push({ kind: "heading", text: plain(heading[1]) });
    } else if (item) {
      open = { kind: "item", text: plain(item[1]) };
      blocks.push(open);
    } else if (open) {
      open.text = `${open.text} ${plain(line)}`.trim();
    } else {
      open = { kind: "text", text: plain(line) };
      blocks.push(open);
    }
  }
  return { blocks: blocks.filter((b) => b.text).map((b) => ({ kind: b.kind, parts: splitTags(b.text, tags) })), cut };
}

export interface RecordExperience {
  /** The entry's file name: its key in the view. */
  key: string;
  company: string;
  title: string;
  dates: string;
  location?: string;
  seniority?: string;
  domains: string[];
  scope: { key: string; value: string; prov: string }[];
  skills: { name: string; proficiency: string; recency: string; prov: string }[];
  /** Fact lines in the body, tagged or not. */
  facts: number;
  confirmedCount: number;
  depth: RecordDepth;
  body: RecordBlock[];
  cut: boolean;
}

export interface RecordEducation {
  key: string;
  institution: string;
  credential: string;
  dates?: string;
  body: RecordBlock[];
  cut: boolean;
}

export interface RecordView {
  experiences: RecordExperience[];
  education: RecordEducation[];
  /** How the user writes (the voice profile), or null when there is none yet. */
  voice: { body: RecordBlock[]; cut: boolean } | null;
}

/** The knowledge base for a view: the experiences in the knowledge base's own order, the education entries, the voice profile. */
export async function loadRecordView(store: Store): Promise<RecordView> {
  const [experiences, voice, eduFiles] = await Promise.all([
    loadExperiences(store),
    loadVoiceProfile(store).catch(() => null),
    store.listFiles(["knowledge-base", "education"]).catch(() => []),
  ]);
  const education: RecordEducation[] = [];
  for (const f of eduFiles.filter((x) => x.name.endsWith(".md"))) {
    const raw = await store.readFile(["knowledge-base", "education", f.name]).catch(() => null);
    if (!raw) continue;
    let data: Record<string, unknown> = {};
    let content = raw;
    try {
      const parsed = matter(raw);
      data = (parsed.data ?? {}) as Record<string, unknown>;
      content = parsed.content;
    } catch {
      // unreadable frontmatter: the file's text as it is
    }
    const { blocks, cut } = bodyBlocks(content.trim());
    education.push({
      key: f.name,
      institution: String(data.institution ?? f.name),
      credential: String(data.credential ?? ""),
      ...(data.dates ? { dates: String(data.dates) } : {}),
      body: blocks,
      cut,
    });
  }
  return {
    experiences: experiences.map((e) => {
      const { blocks, cut } = bodyBlocks(e.body);
      return {
        key: e.fileName,
        company: e.frontmatter.company,
        title: e.frontmatter.title,
        dates: `${e.frontmatter.start} – ${e.frontmatter.end}`,
        ...(e.frontmatter.location ? { location: e.frontmatter.location } : {}),
        ...(e.frontmatter.seniority_level ? { seniority: e.frontmatter.seniority_level } : {}),
        domains: e.frontmatter.domains ?? [],
        scope: Object.entries(e.frontmatter.scope ?? {}).map(([key, v]) => ({ key, value: String(v.value), prov: v.prov })),
        skills: (e.frontmatter.skills ?? []).map((s) => ({ name: s.name, proficiency: s.proficiency, recency: s.recency, prov: s.prov })),
        facts: countFacts(e.body),
        ...recordDepth(e.body),
        body: blocks,
        cut,
      };
    }),
    education,
    voice: voice?.trim() ? (({ blocks, cut }) => ({ body: blocks, cut }))(bodyBlocks(voice)) : null,
  };
}

// ---- The health of the knowledge base (the dashboard's "Résumé health check") ----

/** The groups of the health check's dimensions, in the order a view shows them. */
export const HEALTH_GROUPS = ["Mechanics", "Content", "Authenticity", "Depth"] as const;

/** The colour family of a dimension's status. */
export const HEALTH_STATUS_TONE: Record<"strong" | "ok" | "weak", "success" | "warn" | "danger"> = { strong: "success", ok: "warn", weak: "danger" };

/** The colour family of the overall score: 85 and above, 60 and above, below. */
export const healthScoreTone = (overall: number): "success" | "warn" | "danger" => (overall >= 85 ? "success" : overall >= 60 ? "warn" : "danger");

// ---- The gaps across postings (the dashboard's gaps page) ----

/** The colour family of a gap's tier. */
export const GAP_TIER_TONE: Record<"Critical" | "High" | "Medium" | "Low", "danger" | "warn" | "info" | "neutral"> = { Critical: "danger", High: "warn", Medium: "info", Low: "neutral" };

/** The windows, in days, a view offers for the gap report. */
export const GAP_WINDOWS = [30, 90, 180] as const;

// ---- The interview stories (the dashboard's stories page) ----

/** The badge of a story's numbers: both sides on record, one side, or neither. */
export const STORY_STATUS: Record<"anchored" | "partial" | "gap", { label: string; tone: "success" | "warn" | "danger" }> = {
  anchored: { label: "anchored", tone: "success" },
  partial: { label: "partial", tone: "warn" },
  gap: { label: "gap", tone: "danger" },
};

/** Themes that hold long technical accounts: the dashboard's full table leaves them to its deep-dives page. */
export const isWarStoriesTheme = (theme: string): boolean => theme.startsWith("War Stories");

/** A story's source as the dashboard names it: the experience file without its number and extension. */
export const storySourceLabel = (source: string): string => source.replace(/^\d+-|\.md$/g, "");

/** A piece of a one-glance line: plain text, bold, or the mark of a reconstructed detail (≈: say "roughly", never quote as exact). */
export interface GlancePart {
  text: string;
  bold?: true;
  recon?: true;
}

/** What the ≈ mark means, as the dashboard's page says it. */
export const RECON_NOTE = "≈ = reconstructed detail, say \"roughly\", never quote as exact";

/** A one-glance line as parts: **bold** and the ≈ mark, the two marks the dashboard's page draws. Everything else is text. */
export function glanceParts(text: string): GlancePart[] {
  const out: GlancePart[] = [];
  const plainRun = (run: string, bold: boolean) => {
    for (const piece of run.split(/(≈)/)) {
      if (!piece) continue;
      out.push(piece === "≈" ? { text: piece, recon: true } : bold ? { text: piece, bold: true } : { text: piece });
    }
  };
  let at = 0;
  for (const m of text.matchAll(/\*\*(.+?)\*\*/g)) {
    plainRun(text.slice(at, m.index), false);
    plainRun(m[1], true);
    at = m.index! + m[0].length;
  }
  plainRun(text.slice(at), false);
  return out;
}

// ---- The numbers (the dashboard's metrics pages) ----

/** The statuses of a number in the order the dashboard counts them, each with its colour family and what it means. */
export const METRIC_STATUS_META: Record<"DEFENDED" | "PARTIAL" | "OPEN" | "RETIRED" | "SCOPE", { tone: "success" | "info" | "warn" | "danger" | "neutral"; hint: string }> = {
  DEFENDED: { tone: "success", hint: "methodology confirmed; ships anywhere" },
  PARTIAL: { tone: "info", hint: "mechanism known; ships with its honest frame" },
  OPEN: { tone: "warn", hint: "no confirmed methodology; does NOT ship in new documents" },
  RETIRED: { tone: "danger", hint: "do not use" },
  SCOPE: { tone: "neutral", hint: "a size fact, not a result claim" },
};
export const METRIC_STATUS_ORDER = ["DEFENDED", "PARTIAL", "OPEN", "RETIRED", "SCOPE"] as const;
