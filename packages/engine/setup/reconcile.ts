/**
 * Compare what several documents say (a résumé, a LinkedIn export, a
 * transcript, interview answers) with each other and with the record already
 * on file, before anything is saved.
 *
 * The output keeps three things apart:
 *   - conflicts: two sources disagree on a title, a date or a name. Each one
 *     becomes a numbered question; nothing in that role is saved until the
 *     user answers.
 *   - additive: the record already has the role and a new source only adds
 *     to it (a more precise date, a location, a new source). Shown as a list
 *     the user approves once.
 *   - new: the role is not on file yet.
 *
 * Pure and deterministic: the model extracts each document, this compares.
 */

export interface SourceRole {
  company: string;
  title: string;
  start?: string;
  end?: string;
  location?: string;
  /** The record file, for entries that come from the record itself. */
  fileName?: string;
}

export interface SourceEducation {
  institution: string;
  credential?: string;
  start?: string;
  end?: string;
  fileName?: string;
}

export interface SourceExtract {
  /** File name or "interview", e.g. "resume.pdf", "linkedin-export.zip". */
  source: string;
  kind?: string;
  candidate?: { name?: string; contact?: string; headline?: string };
  experiences?: SourceRole[];
  education?: SourceEducation[];
}

export interface RecordOnFile {
  profile?: { name?: string; contact_line?: string; headline?: string };
  experiences: (SourceRole & { fileName: string; sources?: string[] })[];
  education: (SourceEducation & { fileName: string; sources?: string[] })[];
}

export interface Question {
  n: number;
  subject: string;
  field: string;
  text: string;
  options: { value: string; sources: string[] }[];
}

export interface Addition {
  field: string;
  from: string | null;
  to: string;
  source: string;
}

export interface ReconciledItem<T> {
  status: "new" | "additive" | "conflict" | "unchanged";
  subject: string;
  /** Record file when the item is already on file. */
  fileName?: string;
  /** Best value per field from agreeing sources (conflicting fields omitted). */
  merged: Partial<T>;
  sources: string[];
  /** Sources not yet listed on the record file. */
  new_sources: string[];
  additions: Addition[];
  questions: number[];
}

export interface Reconciliation {
  questions: Question[];
  candidate: { merged: Record<string, string>; questions: number[]; additions: Addition[] };
  experiences: ReconciledItem<SourceRole>[];
  education: ReconciledItem<SourceEducation>[];
  summary: { new: number; additive: number; conflict: number; unchanged: number; questions: number };
}

const RECORD = "record on file";

// --- normalization -----------------------------------------------------------

const COMPANY_SUFFIX = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|sa|sas|plc|the)\b/g;

export function normCompany(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(COMPANY_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const normText = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();

const US_STATES: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co",
  connecticut: "ct", delaware: "de", "district of columbia": "dc", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky",
  louisiana: "la", maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn",
  mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv", "new hampshire": "nh",
  "new jersey": "nj", "new mexico": "nm", "new york": "ny", "north carolina": "nc", "north dakota": "nd",
  ohio: "oh", oklahoma: "ok", oregon: "or", pennsylvania: "pa", "rhode island": "ri",
  "south carolina": "sc", "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi", wyoming: "wy",
};

/**
 * Place comparison: "Denver, CO", "Denver, Colorado" and "Denver,
 * Colorado, United States" are the same place. Only a state written after
 * a comma is shortened, so the city "New York" stays as it is.
 */
export function normPlace(s: string): string {
  const parts = s
    .split(",")
    .map((x) => normText(x))
    .filter((x) => x && !/^(united states( of america)?|usa|us)$/.test(x));
  const out = parts.map((x, i) => (i > 0 && US_STATES[x] ? US_STATES[x] : x));
  return out.join(" ");
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export type DatePoint = { present: true } | { present?: false; y: number; m?: number };

/** "2024", "2024-06", "06/2024", "Jun 2024", "June 2024", "present", "current". */
export function parseDate(s: string | undefined): DatePoint | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  if (!t) return null;
  if (/^(present|current|now|today|ongoing)$/.test(t)) return { present: true };
  let m = t.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (m) return { y: +m[1], m: +m[2] };
  m = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return { y: +m[2], m: +m[1] };
  m = t.match(/^([a-z]+)\.?\s+(\d{4})$/);
  if (m && MONTHS[m[1].slice(0, 4)] !== undefined) return { y: +m[2], m: MONTHS[m[1].slice(0, 4)] };
  if (m && MONTHS[m[1].slice(0, 3)] !== undefined) return { y: +m[2], m: MONTHS[m[1].slice(0, 3)] };
  m = t.match(/^(\d{4})$/);
  if (m) return { y: +m[1] };
  return null;
}

export function formatDate(d: DatePoint): string {
  if (d.present) return "present";
  return d.m ? `${d.y}-${String(d.m).padStart(2, "0")}` : String(d.y);
}

/** Same date, or the same year where one side gives no month. */
function datesAgree(a: DatePoint, b: DatePoint): boolean {
  if (a.present || b.present) return Boolean(a.present && b.present);
  if (a.y !== b.y) return false;
  return a.m === undefined || b.m === undefined || a.m === b.m;
}

const precision = (d: DatePoint) => (d.present ? 2 : d.m ? 2 : 1);

function yearRange(r: { start?: string; end?: string }): [number, number] | null {
  const s = parseDate(r.start);
  const e = parseDate(r.end);
  const now = new Date().getFullYear();
  const sy = s && !s.present ? s.y : null;
  const ey = e ? (e.present ? now : e.y) : sy;
  if (sy === null) return null;
  return [sy, ey ?? sy];
}

const overlaps = (a: [number, number] | null, b: [number, number] | null) =>
  Boolean(a && b && a[0] <= b[1] && b[0] <= a[1]);

function titlesAgree(a: string, b: string): boolean {
  return normText(a) === normText(b);
}

// --- field comparison --------------------------------------------------------

type Valued = { value: string; source: string };

/**
 * Group the values of one field into agreeing clusters. Returns the clusters
 * (one = agreement) with the most precise value of each.
 */
function cluster(field: "date" | "text" | "place", values: Valued[]): { best: string; sources: string[] }[] {
  const out: { best: string; point?: DatePoint; sources: string[] }[] = [];
  for (const v of values) {
    if (field === "date") {
      const p = parseDate(v.value);
      if (!p) {
        // Unparseable: compare as text.
        const hit = out.find((c) => !c.point && normText(c.best) === normText(v.value));
        if (hit) hit.sources.push(v.source);
        else out.push({ best: v.value, sources: [v.source] });
        continue;
      }
      const hit = out.find((c) => c.point && datesAgree(c.point, p));
      if (hit) {
        hit.sources.push(v.source);
        if (precision(p) > precision(hit.point!)) {
          hit.point = p;
          hit.best = formatDate(p);
        }
      } else out.push({ best: formatDate(p), point: p, sources: [v.source] });
    } else {
      const same = field === "place" ? (a: string, b: string) => normPlace(a) === normPlace(b) : (a: string, b: string) => normText(a) === normText(b);
      const hit = out.find((c) => same(c.best, v.value));
      if (hit) hit.sources.push(v.source);
      else out.push({ best: v.value.trim(), sources: [v.source] });
    }
  }
  return out.map(({ best, sources }) => ({ best, sources: [...new Set(sources)] }));
}

// --- main --------------------------------------------------------------------

interface Member<T> {
  item: T;
  source: string;
}

/**
 * Group members that describe the same thing. A group never holds two members
 * from one source (a promotion at one company is two roles, not a conflict),
 * and an exact match (`strong`) wins over a loose one (`same`).
 */
function groupBy<T>(
  members: Member<T>[],
  strong: (a: T, b: T) => boolean,
  same: (a: T, b: T) => boolean,
): Member<T>[][] {
  const groups: Member<T>[][] = [];
  for (const m of members) {
    const open = groups.filter((grp) => !grp.some((x) => x.source === m.source));
    const g =
      open.find((grp) => grp.some((x) => strong(x.item, m.item))) ??
      open.find((grp) => grp.some((x) => same(x.item, m.item)));
    if (g) g.push(m);
    else groups.push([m]);
  }
  return groups;
}

export function reconcileSources(extracts: SourceExtract[], record: RecordOnFile): Reconciliation {
  const questions: Question[] = [];
  const ask = (subject: string, field: string, clusters: { best: string; sources: string[] }[]): number => {
    const n = questions.length + 1;
    const opts = clusters.map((c) => `"${c.best}" (${c.sources.join(", ")})`).join(" or ");
    questions.push({
      n,
      subject,
      field,
      text: `${n}. ${subject}: the ${field.replace(/_/g, " ")} differs. ${opts}. Which is right?`,
      options: clusters.map((c) => ({ value: c.best, sources: c.sources })),
    });
    return n;
  };

  // --- candidate ---
  const cand: Record<string, Valued[]> = { name: [], contact: [], headline: [] };
  if (record.profile?.name) cand.name.push({ value: record.profile.name, source: RECORD });
  if (record.profile?.contact_line) cand.contact.push({ value: record.profile.contact_line, source: RECORD });
  if (record.profile?.headline) cand.headline.push({ value: record.profile.headline, source: RECORD });
  for (const e of extracts) {
    for (const f of ["name", "contact", "headline"] as const) {
      const v = e.candidate?.[f];
      if (v?.trim()) cand[f].push({ value: v, source: e.source });
    }
  }
  const candidate = { merged: {} as Record<string, string>, questions: [] as number[], additions: [] as Addition[] };
  for (const f of ["name", "contact", "headline"] as const) {
    const cl = cluster("text", cand[f]);
    if (cl.length === 1) {
      candidate.merged[f] = cl[0].best;
      const onFile = cand[f].find((v) => v.source === RECORD);
      if (!onFile) {
        const src = cl[0].sources[0];
        if (src) candidate.additions.push({ field: f, from: null, to: cl[0].best, source: src });
      }
    } else if (cl.length > 1) {
      // A headline is a choice, not a fact: still ask, one question.
      candidate.questions.push(ask("Your profile", f, cl));
    }
  }

  // --- experiences ---
  const roleMembers: Member<SourceRole & { sources?: string[] }>[] = [
    ...record.experiences.map((r) => ({ item: r, source: RECORD })),
    ...extracts.flatMap((e) => (e.experiences ?? []).map((r) => ({ item: r, source: e.source }))),
  ];
  const sameRole = (a: SourceRole, b: SourceRole) =>
    normCompany(a.company) === normCompany(b.company) &&
    (titlesAgree(a.title, b.title) || overlaps(yearRange(a), yearRange(b)));
  const exactRole = (a: SourceRole, b: SourceRole) =>
    normCompany(a.company) === normCompany(b.company) && titlesAgree(a.title, b.title);
  const experiences = groupBy(roleMembers, exactRole, sameRole).map((g) =>
    reconcileGroup(g, `${g[0].item.company}, ${g[0].item.title}`, [
      ["title", "text"],
      ["start", "date"],
      ["end", "date"],
      ["location", "place"],
    ], ask, { company: g[0].item.company }),
  );

  // --- education ---
  const eduMembers: Member<SourceEducation & { sources?: string[] }>[] = [
    ...record.education.map((r) => ({ item: r, source: RECORD })),
    ...extracts.flatMap((e) => (e.education ?? []).map((r) => ({ item: r, source: e.source }))),
  ];
  const sameEdu = (a: SourceEducation, b: SourceEducation) =>
    normCompany(a.institution) === normCompany(b.institution) &&
    (!a.credential || !b.credential || normText(a.credential) === normText(b.credential) || overlaps(yearRange(a), yearRange(b)));
  const exactEdu = (a: SourceEducation, b: SourceEducation) =>
    normCompany(a.institution) === normCompany(b.institution) &&
    normText(a.credential ?? "") === normText(b.credential ?? "");
  const education = groupBy(eduMembers, exactEdu, sameEdu).map((g) =>
    reconcileGroup(g, g[0].item.institution, [
      ["credential", "text"],
      ["start", "date"],
      ["end", "date"],
    ], ask, { institution: g[0].item.institution }),
  );

  const all = [...experiences, ...education];
  const count = (s: ReconciledItem<unknown>["status"]) => all.filter((x) => x.status === s).length;
  return {
    questions,
    candidate,
    experiences,
    education,
    summary: {
      new: count("new"),
      additive: count("additive"),
      conflict: count("conflict"),
      unchanged: count("unchanged"),
      questions: questions.length,
    },
  };
}

function reconcileGroup<T extends { fileName?: string; sources?: string[] }>(
  group: Member<T>[],
  subject: string,
  fields: [string, "text" | "date" | "place"][],
  ask: (subject: string, field: string, clusters: { best: string; sources: string[] }[]) => number,
  base: Record<string, string>,
): ReconciledItem<T> {
  const onFile = group.find((m) => m.source === RECORD);
  const merged: Record<string, string> = { ...base };
  const additions: Addition[] = [];
  const qs: number[] = [];
  for (const [field, kind] of fields) {
    const vals: Valued[] = group
      .map((m) => ({ value: (m.item as Record<string, unknown>)[field], source: m.source }))
      .filter((v): v is Valued => typeof v.value === "string" && v.value.trim().length > 0);
    const cl = cluster(kind, vals);
    if (cl.length > 1) {
      qs.push(ask(subject, field, cl));
      continue;
    }
    if (cl.length === 1) {
      merged[field] = cl[0].best;
      if (onFile) {
        const was = (onFile.item as Record<string, unknown>)[field];
        const wasStr = typeof was === "string" && was.trim() ? was.trim() : null;
        if (wasStr !== cl[0].best) {
          const src = cl[0].sources.find((s) => s !== RECORD) ?? cl[0].sources[0];
          additions.push({ field, from: wasStr, to: cl[0].best, source: src });
        }
      }
    }
  }
  const sources = [...new Set(group.map((m) => m.source).filter((s) => s !== RECORD))];
  const recorded = new Set(onFile?.item.sources ?? []);
  const new_sources = onFile ? sources.filter((s) => !recorded.has(s)) : sources;
  const status: ReconciledItem<T>["status"] = qs.length
    ? "conflict"
    : !onFile
      ? "new"
      : additions.length || new_sources.length
        ? "additive"
        : "unchanged";
  return {
    status,
    subject,
    ...(onFile?.item.fileName ? { fileName: onFile.item.fileName } : {}),
    merged: merged as Partial<T>,
    sources,
    new_sources,
    additions,
    questions: qs,
  };
}
