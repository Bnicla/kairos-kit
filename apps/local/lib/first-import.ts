/**
 * The confirmations of a first import (save_first_import), as texts.
 *
 * The owner's decisions of 15 November 2026, after the first import was seen in claude.ai as one long
 * paragraph of fields that nobody could read: the confirmation is a summary in plain words, read at a
 * glance; the lines that are not in the user's own document word for word are shown in full; and the
 * user chooses in the box between saving all of it and going through the items one by one.
 *
 * Two confirmations are written here:
 *  - the summary: who, which jobs with their dates and how many lines each, which education and
 *    credential entries, how many lines stand in the document word for word, and every line that does
 *    not, in full;
 *  - a part: one or more items with every line, for the user who chose to go one by one, and for an
 *    import with no document to compare with (an interview). No item is ever cut in two, and no
 *    message is longer than the client's box shows (record-confirm.ts, ConfirmationBox).
 *
 * What a confirmation does not show: the technical fields of a file (its name, its id, the source and
 * year marks inside a skill or a size). What Kairos derives from the lines to match job ads (skills
 * with their level, search words, sizes, the field, the level) is said in plain words in a part. The
 * summary names it in one sentence and lists every derived skill, search word, field, size or other
 * text that the document does not name.
 *
 * The rule the summary keeps: what it only counts is in the user's own document, as whole words in
 * order; what is not is shown in full. The two things it shows in neither way are the level Kairos
 * gives a job (junior to executive) and the level it gives a skill; a part shows both.
 */
import { boxText, show, type ChoiceField, type ConfirmationBox } from "./record-confirm";

export interface ImportInput {
  fileName: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface ImportLine {
  /** The line as it is saved, without its list mark. */
  text: string;
  /** Whether it stands in one of the user's documents word for word; null when there is no document to compare with. */
  verbatim: boolean | null;
}

export interface ImportItem {
  kind: "profile" | "role" | "education";
  /** As a person reads it: "Staff Nurse at Harborline Medical Center, Denver, CO, June 2021 to today". */
  name: string;
  /** Its place among the items of its kind, from 1. */
  nth: number;
  of: number;
  lines: ImportLine[];
  /** What Kairos adds to match job ads, in plain words (a role). */
  added: string[];
  /** Of what Kairos adds, the skills, search words, field, sizes and other texts the user's document does not name. */
  notInDocument?: string[];
  /** The person's own project (a capstone, a personal project), not a job: headed by its name, with no employer. */
  project?: boolean;
  /**
   * What names this entry and does not stand in the user's document: its title, its employer or project name, its
   * school or issuer, its credential; for the profile, an item of the list of skills or languages. Each as it is said
   * to the user ('the title "Backend Engineer"'). Undefined when there is no document to look in.
   */
  nameNotInDocument?: string[];
  /** Already in the knowledge base, with the same content: not asked again. */
  saved: boolean;
  fileName?: string;
}

export const SAVE_ALL = "Save all of it";
export const ONE_BY_ONE = "Show me each item, one by one";
/** The choice the summary offers. */
export const HOW: ChoiceField = { type: "string", title: "What to do", enum: [SAVE_ALL, ONE_BY_ONE], default: SAVE_ALL };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2021-06" as "June 2021"; "present" as "today"; anything else as written. */
export function plainDate(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^(present|current|now|today)$/i.test(s)) return "today";
  const m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return s;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whether an entry is the person's own project. */
export const isProject = (fm: Record<string, unknown>) => text(fm.kind).toLowerCase() === "project";

export function roleName(fm: Record<string, unknown>, fileName: string): string {
  // A project is named by its own name; its title is said only when the person stated their part in it.
  const title = isProject(fm) && /^project$/i.test(text(fm.title)) ? "" : text(fm.title);
  const what = (isProject(fm) ? [text(fm.company), title].filter(Boolean).join(", ") : [title, text(fm.company)].filter(Boolean).join(" at ")) || fileName;
  const dates = [plainDate(fm.start), plainDate(fm.end)].filter(Boolean).join(" to ");
  return [what, text(fm.location), dates].filter(Boolean).join(", ");
}

export function educationName(fm: Record<string, unknown>, fileName: string): string {
  const where = [text(fm.institution), text(fm.dates) || [plainDate(fm.start), plainDate(fm.end)].filter(Boolean).join(" to ")].filter(Boolean).join(", ");
  const what = text(fm.credential) || text(fm.institution) || fileName;
  return where && what !== text(fm.institution) ? `${what} (${where})` : what;
}

/** The lines of a body that state something: not the headings, not the empty lines; each without its list mark. */
export function statedLines(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ""));
}

/** A line as the box shows it: the tag of a document's own line is left out, since the box says where the lines come from. */
const shown = (l: string) => l.replace(/\s*\[R\]\s*$/, "");

const LEVELS: Record<string, string> = { ic: "individual contributor", lead: "lead", manager: "manager", director: "director", vp: "vice president", "c-level": "executive" };

/** The fields of a role that a confirmation says in its own way; any other field is said as it is. */
const SAID = new Set(["id", "kind", "sources", "title", "company", "location", "start", "end", "skills", "seniority_level", "title_normalized", "domains", "scope", "keywords"]);

/** What Kairos derives from a role's lines to match job ads, in plain words. Technical marks (source, year) are left out. */
export function addedByKairos(fm: Record<string, unknown>): string[] {
  const out: string[] = [];
  const skills = Array.isArray(fm.skills) ? (fm.skills as unknown[]) : [];
  const byLevel = new Map<string, string[]>();
  for (const s of skills) {
    const name = typeof s === "string" ? s : text((s as { name?: unknown } | null)?.name);
    if (!name) continue;
    const level = typeof s === "string" ? "" : text((s as { proficiency?: unknown }).proficiency);
    byLevel.set(level, [...(byLevel.get(level) ?? []), name]);
  }
  if (byLevel.size) out.push(`skills: ${[...byLevel].map(([level, names]) => `${names.join(", ")}${level ? ` (${level})` : ""}`).join("; ")}`);
  const level = text(fm.seniority_level);
  if (level) out.push(`level: ${LEVELS[level.toLowerCase()] ?? level}`);
  if (text(fm.title_normalized)) out.push(`title read as: ${text(fm.title_normalized)}`);
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : show(x))).filter(Boolean).join(", ") : text(v));
  if (list(fm.domains)) out.push(`field: ${list(fm.domains)}`);
  const scope = fm.scope && typeof fm.scope === "object" ? Object.values(fm.scope as Record<string, unknown>) : [];
  const sizes = scope.map((v) => (v && typeof v === "object" ? text((v as { value?: unknown }).value) || show(v) : String(v ?? ""))).filter(Boolean);
  if (sizes.length) out.push(`sizes: ${sizes.join(", ")}`);
  if (list(fm.keywords)) out.push(`search words: ${list(fm.keywords)}`);
  // Any other field the file carries is said as it is, so that nothing about the person is saved unsaid.
  for (const [k, v] of Object.entries(fm)) if (!SAID.has(k) && v !== undefined && v !== null && v !== "") out.push(`${k.replace(/_/g, " ")}: ${show(v)}`);
  return out;
}

/** Of what Kairos adds to a role, each text that names something about the person: the levels are left out. */
export function addedTexts(fm: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(fm.skills) ? (fm.skills as unknown[]) : []) out.push(typeof s === "string" ? s : text((s as { name?: unknown } | null)?.name));
  out.push(text(fm.title_normalized));
  for (const k of ["domains", "keywords"]) {
    const v = fm[k];
    out.push(...(Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : show(x))) : [text(v)]));
  }
  if (fm.scope && typeof fm.scope === "object") for (const v of Object.values(fm.scope as Record<string, unknown>)) out.push(v && typeof v === "object" ? text((v as { value?: unknown }).value) || show(v) : String(v ?? ""));
  for (const [k, v] of Object.entries(fm)) if (!SAID.has(k) && v !== undefined && v !== null && v !== "") out.push(`${k.replace(/_/g, " ")}: ${show(v)}`);
  return out.map((t) => t.trim()).filter(Boolean);
}

/** The items of an import, in reading order: the profile, the roles, then education and credentials. */
export function importItems(
  identity: string[],
  experiences: ImportInput[],
  education: ImportInput[],
  opts: {
    verbatim: (line: string) => boolean | null;
    saved: (kind: "role" | "education", item: ImportInput) => boolean;
    /** Whether the user's document names this short text; null or absent when there is no document to look in. */
    named?: (phrase: string) => boolean | null;
    /** The person's own lists read from the document (the profile's `skills` and `languages`), when this import saves them. */
    lists?: { skills?: string[]; languages?: string[] };
    /** The document's own summary of the person (the profile's `summary`), when this import saves it. */
    ownSummary?: string;
  },
): ImportItem[] {
  /** Of the names given, as [what it is, the name], those the document does not hold; undefined when that cannot be told. */
  const absent = (names: [string, string][]) => {
    const looked = names.filter(([, name]) => name.trim()).map(([what, name]) => ({ what, name, named: opts.named ? opts.named(name) : null }));
    return looked.some((x) => x.named === null) ? undefined : looked.filter((x) => !x.named).map((x) => `${x.what} "${x.name}"`);
  };
  // Undefined when it cannot be told (no document to look in): the summary then claims nothing about it.
  const unnamed = (fm: Record<string, unknown>) => {
    const texts = addedTexts(fm).map((t) => ({ t, named: opts.named ? opts.named(t) : null }));
    return texts.some((x) => x.named === null) ? undefined : texts.filter((x) => !x.named).map((x) => x.t);
  };
  const line = (l: string): ImportLine => ({ text: l, verbatim: opts.verbatim(l) });
  const items: ImportItem[] = [];
  if (identity.length) {
    const listed = [...(opts.lists?.skills ?? []).map((x): [string, string] => ["the skill", x]), ...(opts.lists?.languages ?? []).map((x): [string, string] => ["the language", x])];
    // Their own summary is theirs word for word: one that is not in the document is Claude's, and is said to be.
    const summaryAbsent = opts.ownSummary && opts.verbatim(opts.ownSummary) === false ? ["the summary of yourself (Claude worded it)"] : [];
    const names = listed.length || summaryAbsent.length ? [...(absent(listed) ?? []), ...summaryAbsent] : undefined;
    items.push({ kind: "profile", name: "your profile", nth: 1, of: 1, lines: identity.map((l) => ({ text: l, verbatim: null })), added: [], saved: false, ...(names ? { nameNotInDocument: names } : {}) });
  }
  // Jobs are counted among jobs and projects among projects: "Job 2 of 2", "Project 1 of 2".
  const count = { job: experiences.filter((e) => !isProject(e.frontmatter)).length, project: experiences.filter((e) => isProject(e.frontmatter)).length };
  const seen = { job: 0, project: 0 };
  for (const e of experiences) {
    const project = isProject(e.frontmatter);
    const which = project ? "project" : "job";
    const title = text(e.frontmatter.title);
    items.push({
      kind: "role",
      ...(project ? { project: true } : {}),
      name: roleName(e.frontmatter, e.fileName),
      nth: ++seen[which],
      of: count[which],
      lines: statedLines(e.body).map(line),
      added: addedByKairos(e.frontmatter),
      notInDocument: unnamed(e.frontmatter),
      // A job's title and employer, a project's name (and the person's part in it, when one is given), must be the document's own.
      nameNotInDocument: absent(project ? [["the project's name", text(e.frontmatter.company)], ...(title && !/^project$/i.test(title) ? [["the title", title] as [string, string]] : [])] : [["the title", title], ["the employer", text(e.frontmatter.company)]]),
      saved: opts.saved("role", e),
      fileName: e.fileName,
    });
  }
  education.forEach((e, i) =>
    items.push({
      kind: "education",
      name: educationName(e.frontmatter, e.fileName),
      nth: i + 1,
      of: education.length,
      lines: statedLines(e.body).map(line),
      added: [],
      nameNotInDocument: absent([["the credential", text(e.frontmatter.credential)], ["the school or issuer", text(e.frontmatter.institution)]]),
      saved: opts.saved("education", e),
      fileName: e.fileName,
    }),
  );
  return items;
}

const numbered = (lines: string[]) => lines.map((l, i) => `(${i + 1}) ${l}`).join(" ");
/** The profile in one sentence: the name and the contact line as they are, the headline named. */
const profileSentence = (item: ImportItem) =>
  `You: ${item.lines
    .map((l) =>
      l.text.includes(" → ")
        ? // A profile that held something already: both values, in words.
          l.text.replace(/^(\w+): /, (_m, k: string) => `${k.replace(/_/g, " ")} changes from `).replace(" → ", " to ")
        : l.text
            .replace(/^(?:name|contact_line): /, "")
            .replace(/^skills: /, "your skills, as you list them: ")
            .replace(/^summary: (.*)$/, (_m, t: string) => `what you say of yourself: "${t}"`)
            .replace(/^(\w+): /, (_m, k: string) => `${k.replace(/_/g, " ")}: `),
    )
    .join("; ")}.`;
const documentsWord = (names: string[]) => (names.length === 1 ? `your document, ${names[0]}` : `your ${names.length} documents (${names.join(", ")})`);
const flatWords = (t: string) => t.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The summary of what is still to save. Null when there is no document to compare the lines with: a
 * summary that counts lines says nothing unless it can say where they come from.
 */
export function summaryMessage(items: ImportItem[], documents: string[], box?: ConfirmationBox, choice = true): string | null {
  const todo = items.filter((i) => !i.saved);
  if (!documents.length || !todo.length) return null;
  const done = items.length - todo.length;
  const profile = todo.find((i) => i.kind === "profile");
  const roles = todo.filter((i) => i.kind === "role");
  const jobs = roles.filter((i) => !i.project);
  const projects = roles.filter((i) => i.project);
  const education = todo.filter((i) => i.kind === "education");
  const lines = [...roles, ...education].flatMap((i) => i.lines.map((l) => ({ ...l, item: i })));
  const ref = (i: ImportItem) => (i.kind === "profile" ? "your profile" : `${i.kind === "education" ? "entry" : i.project ? "project" : "job"} ${i.nth}`);
  // The names of entries, and the items of the person's own lists, that the document does not hold.
  const names = todo.flatMap((i) => (i.nameNotInDocument ?? []).map((n) => `${n} (${ref(i)})`));
  const own = lines.filter((l) => l.verbatim === false);
  const will: string[] = [];
  if (profile) will.push(profileSentence(profile));
  if (jobs.length) will.push(`${plural(jobs.length, "job")}: ${jobs.map((r) => `${r.name} (${plural(r.lines.length, "line")})`).join("; ")}.`);
  if (projects.length) will.push(`${plural(projects.length, "project")}: ${projects.map((r) => `${r.name} (${plural(r.lines.length, "line")})`).join("; ")}.`);
  if (education.length) will.push(`${plural(education.length, "education or credential entry", "education and credential entries")}: ${education.map((e) => e.name).join("; ")}.`);
  const from = documentsWord(documents);
  const yours = documents.length === 1 ? "your document" : "your documents";
  // What Kairos adds that the document does not name, each once; `told` is false when that could not be looked up.
  const told = roles.every((r) => !r.added.length || r.notInDocument !== undefined);
  const unnamed = [...new Map(roles.flatMap((r) => r.notInDocument ?? []).map((t) => [flatWords(t), t])).values()];
  const blocks: string[][] = [
    [`Kairos read ${from}. ${done ? `${plural(done, "item")} of this import ${done === 1 ? "is" : "are"} saved already; the rest is not saved yet.` : "Nothing is saved yet."}`],
    ["It will save:", ...will],
    own.length
      ? [
          `${lines.length - own.length} of the ${plural(lines.length, "line")} ${lines.length - own.length === 1 ? "is" : "are"} word for word from ${documents.length === 1 ? "your document" : "your documents"}. ${own.length === 1 ? "1 is not: Claude worded it. Check it:" : `${own.length} are not: Claude worded them. Check them:`}`,
          ...own.map((l, i) => `(${i + 1}) "${shown(l.text)}" (${ref(l.item)}: ${l.item.name.split(",")[0]})`),
          ...(names.length ? [`Also not in ${yours}: ${names.join("; ")}.`] : []),
        ]
      : [
          `${lines.length === 1 ? "The 1 line is" : `All ${lines.length} lines are`} word for word from ${yours}.`,
          ...(names.length ? [`Not in ${yours}: ${names.join("; ")}. Check ${names.length === 1 ? "it" : "them"}.`] : []),
        ],
    ...(roles.some((r) => r.added.length)
      ? [
          [
            `Kairos also adds, to match job ads, the skills, search words and sizes it reads in those lines${
              !told ? "." : unnamed.length ? `. ${unnamed.length === 1 ? "1 is not a word" : `${unnamed.length} are not words`} from ${yours}: ${unnamed.join("; ")}.` : `; all are words from ${yours}.`
            }`,
          ],
        ]
      : []),
    [
      `${choice ? "Choose below: save all of it, or see each item one by one. Decline saves nothing." : `${box?.yes ?? "Accept"} saves all of it. Decline saves nothing.`} You can read and correct every line afterwards: ask to see your knowledge base.`,
    ],
  ];
  return boxText(blocks, box);
}

/** One item with every line, as the blocks of a part. */
function itemBlock(item: ImportItem, compared: boolean): string[] {
  const absent = compared && item.nameNotInDocument?.length ? ` [not in your document: ${item.nameNotInDocument.join("; ")}]` : "";
  if (item.kind === "profile") return [`${profileSentence(item)}${absent}`];
  const head = `${item.kind === "role" ? `${item.project ? "Project" : "Job"} ${item.nth} of ${item.of}` : `Education and credentials, ${item.nth} of ${item.of}`}: ${item.name}.${absent}`;
  // A line that only repeats the entry's own name (a degree, a certification) is not said twice.
  const named = ` ${flatWords(item.name)} `;
  const lines = item.lines
    .filter((l) => !(item.kind === "education" && shown(l.text).split(/\s+/).every((w) => !flatWords(w) || named.includes(` ${flatWords(w)} `))))
    .map((l) => `${shown(l.text)}${compared && l.verbatim === false ? " [Claude's wording, not in your document]" : ""}`);
  return [head, ...(lines.length ? [`${lines.length === 1 ? "Its line" : `Its ${lines.length} lines`}: ${numbered(lines)}`] : []), ...(item.added.length ? [`Kairos adds, to match job ads: ${item.added.join("; ")}.`] : [])];
}

/** The message of one part: `part` of `parts`, holding `items`. */
export function partMessage(items: ImportItem[], part: number, parts: number, compared: boolean, box?: ConfirmationBox): string {
  const yes = box?.yes ?? "Accept";
  const head = parts > 1 ? `your first import, part ${part} of ${parts}. Nothing of this part is saved yet.` : "your first import. Nothing is saved yet.";
  const end =
    parts > 1
      ? `${yes} saves part ${part} only. Decline saves nothing of it${part > 1 ? "; what you approved before stays" : ""}.${part < parts ? ` ${plural(parts - part, "more part")} ${parts - part === 1 ? "follows" : "follow"}.` : ""}`
      : `${yes} saves all of it. Decline saves nothing.`;
  return boxText([[`Kairos: ${head}`], ...items.map((i) => itemBlock(i, compared)), [end]], box);
}

/** What the head and the last sentence of a part take, at most. */
const FRAME_CHARS = 260;
/** A part this small takes the next item with it, even a long one: a profile alone is not worth a box. */
const SMALL_CHARS = 400;

/**
 * The items in parts, in reading order, none cut in two. A part holds what is read before the box
 * closes (`aim`); one item longer than that still gets a part of its own, up to what the box shows
 * (`max`). Roles and education do not share a part unless everything fits one. With `apart`, every
 * role has a part of its own (the user asked to go one by one). An item longer than `max` cannot be
 * shown whole: it is returned in `tooLong`, in no part.
 */
export function partsOf(items: ImportItem[], compared: boolean, limits: { aim: number; max: number; apart?: boolean }, box?: ConfirmationBox): { parts: ImportItem[][]; tooLong: ImportItem[] } {
  const size = (i: ImportItem) => boxText([itemBlock(i, compared)], box).length + 3;
  const max = limits.max - FRAME_CHARS;
  const aim = Math.min(limits.aim, limits.max) - FRAME_CHARS;
  const tooLong = items.filter((i) => size(i) > max);
  const fit = items.filter((i) => !tooLong.includes(i));
  const total = fit.reduce((n, i) => n + size(i), 0);
  if (!limits.apart && total <= aim) return { parts: fit.length ? [fit] : [], tooLong };
  const parts: ImportItem[][] = [];
  let now: ImportItem[] = [];
  let chars = 0;
  const close = () => {
    if (now.length) parts.push(now);
    now = [];
    chars = 0;
  };
  for (const item of fit) {
    const s = size(item);
    const sameGroup = !now.length || (now[now.length - 1].kind === "education") === (item.kind === "education");
    const roleApart = Boolean(limits.apart) && item.kind === "role" && now.some((i) => i.kind === "role");
    const room = chars + s <= aim || (chars <= SMALL_CHARS && chars + s <= max);
    if (now.length && (!sameGroup || roleApart || !room)) close();
    now.push(item);
    chars += s;
  }
  close();
  return { parts, tooLong };
}
