/**
 * Contacts and referrals. The user imports the list of their LinkedIn
 * connections (the `Connections.csv` of LinkedIn's data export); Kairos keeps
 * it in the user's own data folder and, when an application is a good match,
 * shows the people the user knows at that company as possible referrals.
 *
 * Kairos only suggests people to talk to. It never contacts anyone.
 *
 * Three layers, so every Kairos can use the same code:
 *   - pure functions, text in and data out, no file system: `parseCsv`,
 *     `parseLinkedInConnections`, `normalizeCompany`, `matchCompany`,
 *     `contactsAtCompany`, `diffContacts`, `qualifiesForReferrals`;
 *   - storage through the engine's `Store` (local files, or the user's Drive):
 *     `loadContacts`, `importLinkedInConnections`;
 *   - the suggestion for one application: `referralsForApplication`.
 *
 * The contacts are the personal data of other people. They live in
 * `contacts/linkedin-connections.json` of the data folder and nowhere else.
 */
import { readMeta, type ApplicationMeta } from "./applications";
import { readProfileSettings, referralRule, type ReferralRule } from "./settings";
import type { Store } from "./store/types";
import type { MatchBand } from "./types";

// --- Types -------------------------------------------------------------------

export interface Contact {
  /** Stable across imports: the profile's LinkedIn handle ("li:<handle>"), or "n:<name>|<company>" when the row has no profile URL. */
  id: string;
  first_name: string;
  last_name: string;
  /** "First Last", as the export writes them. */
  name: string;
  /** The person's LinkedIn profile; null when the row has none or the value is not a linkedin.com address. */
  url: string | null;
  /** Kept only when the import asks for it (see `keepEmails`); LinkedIn exports it for the few members who allow it. */
  email: string | null;
  /** Current company as the person wrote it on LinkedIn; null when blank. */
  company: string | null;
  position: string | null;
  /** Date the connection was made, "YYYY-MM-DD"; null when the export's date cannot be read. */
  connected_on: string | null;
}

export interface ContactsFile {
  version: 1;
  source: "linkedin";
  imported_at: string;
  contacts: Contact[];
}

export interface ParsedConnections {
  contacts: Contact[];
  /** Data rows read after the header (blank lines not counted). */
  rows: number;
  skipped: {
    /** Rows with no first and last name: LinkedIn blanks the row of a member who closed or restricted their account. */
    no_name: number;
    /** A second row for a person already read. */
    duplicate: number;
  };
  /** Expected columns the file does not have; their fields are null on every contact. */
  missing_columns: string[];
}

export interface ContactsDiff {
  total: number;
  /** In the new file, not in the previous import. */
  added: number;
  /** In the previous import, not in the new file. */
  removed: number;
  /** Same person, same details. */
  unchanged: number;
  /** Same person, different company, position, name or profile address. */
  updated: number;
}

// --- CSV ---------------------------------------------------------------------

/**
 * RFC 4180 reader: quoted fields, doubled quotes, commas and line breaks
 * inside quotes, CRLF or LF. Returns every row, blank lines included (as
 * `[""]`), so the caller can find a header that is not on the first line.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// --- LinkedIn connections ----------------------------------------------------

const COLUMNS = {
  first_name: "first name",
  last_name: "last name",
  url: "url",
  email: "email address",
  company: "company",
  position: "position",
  connected_on: "connected on",
} as const;

const FIELD_MAX = 200;

/** One line of plain text: control characters and line breaks out, spaces collapsed, cut at 200 characters. */
function cleanField(v: string | undefined): string {
  return (v ?? "")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FIELD_MAX);
}

/** A linkedin.com profile address, or null: nothing else from the file is ever shown as a link. */
function linkedInUrl(v: string): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    return `https://${u.hostname.toLowerCase()}${u.pathname}`;
  } catch {
    return null;
  }
}

function linkedInHandle(url: string | null): string | null {
  const m = url?.match(/\/in\/([^/?#]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return m[1].toLowerCase();
  }
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** LinkedIn writes "13 Nov 2026"; an ISO date is accepted too. Anything else is null. */
export function parseConnectedOn(v: string): string | null {
  const t = v.trim();
  const dmy = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{4})$/);
  if (dmy) {
    const month = MONTHS[dmy[2].toLowerCase()];
    return month ? `${dmy[3]}-${month}-${dmy[1].padStart(2, "0")}` : null;
  }
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

/**
 * Read the text of a LinkedIn `Connections.csv`. The export opens with a few
 * note lines; the header is the first row that names "First Name" and "Last
 * Name". Columns are found by name, in any order. Throws when there is no
 * such header, so a wrong file never replaces a good import.
 *
 * Email addresses are dropped unless `keepEmails` is true.
 */
export function parseLinkedInConnections(text: string, opts: { keepEmails?: boolean } = {}): ParsedConnections {
  const all = parseCsv(text);
  const lower = (r: string[]) => r.map((c) => c.trim().toLowerCase());
  const headerAt = all.findIndex((r) => {
    const cells = lower(r);
    return cells.includes(COLUMNS.first_name) && cells.includes(COLUMNS.last_name);
  });
  if (headerAt === -1) {
    throw new Error(
      'This is not a LinkedIn connections file: no header row with "First Name" and "Last Name". ' +
        "In LinkedIn: Settings, Data privacy, Get a copy of your data, Connections. The file is Connections.csv.",
    );
  }
  const header = lower(all[headerAt]);
  const at = Object.fromEntries(Object.entries(COLUMNS).map(([k, name]) => [k, header.indexOf(name)])) as Record<keyof typeof COLUMNS, number>;
  const missing_columns = Object.entries(COLUMNS)
    .filter(([k]) => at[k as keyof typeof COLUMNS] === -1)
    .map(([, name]) => name);

  const contacts: Contact[] = [];
  const seen = new Set<string>();
  const skipped = { no_name: 0, duplicate: 0 };
  let rows = 0;
  for (const r of all.slice(headerAt + 1)) {
    if (r.every((c) => !c.trim())) continue;
    rows++;
    const get = (k: keyof typeof COLUMNS) => (at[k] === -1 ? "" : cleanField(r[at[k]]));
    const first_name = get("first_name");
    const last_name = get("last_name");
    const name = `${first_name} ${last_name}`.trim();
    if (!name) {
      skipped.no_name++;
      continue;
    }
    const url = linkedInUrl(get("url"));
    const company = get("company") || null;
    const handle = linkedInHandle(url);
    const id = handle ? `li:${handle}` : `n:${name.toLowerCase()}|${(company ?? "").toLowerCase()}`;
    if (seen.has(id)) {
      skipped.duplicate++;
      continue;
    }
    seen.add(id);
    const email = get("email");
    contacts.push({
      id,
      first_name,
      last_name,
      name,
      url,
      email: opts.keepEmails && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
      company,
      position: get("position") || null,
      connected_on: parseConnectedOn(get("connected_on")),
    });
  }
  return { contacts, rows, skipped, missing_columns };
}

// --- Company names -----------------------------------------------------------

/** Legal forms, dropped from the end of a name. */
const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "lllp", "lp", "ltd", "limited", "corp", "corporation", "co", "company",
  "plc", "pllc", "pc", "gmbh", "ag", "sa", "sas", "sarl", "bv", "nv", "pty", "srl", "spa", "ab", "oy", "kk",
]);
/** Not legal forms, but written or left out freely: "Acme Group" and "Acme" are the same employer. */
const LOOSE_SUFFIXES = new Set(["group", "holdings"]);

/**
 * A lone word too common to say two names are related: "United" does not make
 * "United Lanternworks" a part of "United Quillfeather".
 */
const GENERIC_WORDS = new Set([
  "american", "national", "united", "general", "first", "new", "international", "global", "capital", "advanced",
  "digital", "pacific", "atlantic", "city", "state", "university", "bank", "us", "usa", "north", "south", "east", "west",
]);

/** Lowercase words of a name: accents, punctuation, "The", web endings and legal forms removed. */
function nameTokens(raw: string): string[] {
  const words = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[&+]/g, " and ")
    .replace(/\.(com|io|ai|co|net|org|app|dev)\b/g, "")
    .replace(/['\u2019`.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (words.length > 1 && words[0] === "the") words.shift();
  while (words.length > 1) {
    const last = words[words.length - 1];
    if (LEGAL_SUFFIXES.has(last) || LOOSE_SUFFIXES.has(last) || last === "and") words.pop();
    else break;
  }
  return words;
}

const PAREN = /\(([^)]*)\)/g;

/** The name without what stands in parentheses ("Northwind Robotics Works (NRW)" -> "Northwind Robotics Works"). */
const outsideParens = (name: string) => name.replace(PAREN, " ");

/**
 * The comparable form of a company name: lowercase, no accents or
 * punctuation, no leading "The", no legal form at the end. "The Acme Company,
 * Inc." and "ACME" both give "acme".
 */
export function normalizeCompany(name: string): string {
  return nameTokens(outsideParens(name)).join(" ");
}

const SMALL_WORDS = new Set(["and", "of", "the", "for"]);

/**
 * Other names the text in parentheses gives for the same company: the
 * initials of the name ("(NRW)"), or a former or new name ("(formerly
 * Northwind)"). Any other parenthesis (a place, a funding round) is ignored.
 */
function parenAliases(name: string, main: string[]): string[] {
  const out: string[] = [];
  const initials = main.filter((w) => !SMALL_WORDS.has(w)).map((w) => w[0]).join("");
  for (const m of name.matchAll(PAREN)) {
    const inner = m[1].trim();
    const renamed = inner.match(/^(?:formerly|formerly known as|fka|f\/k\/a|previously|now|now part of|acquired by)\s+(.+)$/i);
    if (renamed) {
      const k = nameTokens(renamed[1]).join(" ");
      if (k) out.push(k);
      continue;
    }
    const k = nameTokens(inner).join("");
    if (k.length >= 2 && main.length >= 2 && k === initials) out.push(k);
  }
  return out;
}

const squash = (key: string) => key.replace(/ /g, "");

interface CompanyKey {
  /** Words of the name, normalized. */
  tokens: string[];
  /** Forms that mean the same company when equal: the name, and any other name it gives in parentheses, spaces removed. */
  same: Set<string>;
  /** The name when it is written as initials ("NRW", "H&P" -> "hp"); null otherwise. */
  acronym: string | null;
  /** First letters of the words of a name of two words or more ("Northwind Robotics Works" -> "nrw"); null otherwise. */
  initials: string | null;
}

function companyKey(name: string): CompanyKey {
  const tokens = nameTokens(outsideParens(name));
  const same = new Set<string>();
  for (const k of [tokens.join(" "), ...parenAliases(name, tokens)]) {
    const sq = squash(k);
    if (sq) same.add(sq);
  }
  const words = tokens.filter((w) => !SMALL_WORDS.has(w));
  const lettersOnly = words.length >= 2 && words.every((w) => w.length === 1);
  const acronym = lettersOnly ? words.join("") : tokens.length === 1 && /^[a-z]{2,5}$/.test(tokens[0]) ? tokens[0] : null;
  const initials = words.length >= 2 && !lettersOnly ? words.map((w) => w[0]).join("") : null;
  return { tokens, same, acronym, initials };
}

export type CompanyMatch = "exact" | "related";

function matchKeys(a: CompanyKey, b: CompanyKey): CompanyMatch | null {
  if (!a.tokens.length || !b.tokens.length) return null;
  for (const k of a.same) if (b.same.has(k)) return "exact";
  if ((a.acronym && a.acronym === b.initials) || (b.acronym && b.acronym === a.initials)) return "related";
  const [short, long] = a.tokens.length <= b.tokens.length ? [a.tokens, b.tokens] : [b.tokens, a.tokens];
  if (short.length === long.length) return null;
  if (!short.every((w, i) => long[i] === w)) return null;
  if (short.length === 1 && (short[0].length < 2 || GENERIC_WORDS.has(short[0]))) return null;
  return "related";
}

/**
 * Do two company names mean the same employer?
 *   "exact":   the same name once case, punctuation, "The", legal forms and
 *              spacing are set aside, or a name the other gives in
 *              parentheses ("Northwind Robotics Works (NRW)" and "NRW").
 *   "related": one name is the other plus more words ("Acme" and "Acme
 *              Robotics"), or one is the initials of the other ("NRW" and
 *              "Northwind Robotics Works"): often the same employer or a
 *              division of it, sometimes a different company. Shown apart,
 *              for the user to check.
 *   null:      different names. Whole words only: "Lantern" is not
 *              "Lanternfish".
 *
 * The engine holds no list of real companies: a former name or a brand that
 * shares no word with the registered name is not matched.
 */
export function matchCompany(a: string, b: string): CompanyMatch | null {
  return matchKeys(companyKey(a), companyKey(b));
}

export interface ContactIndex {
  size: number;
  entries: { contact: Contact; key: CompanyKey }[];
}

/** Normalize every contact's company once; reuse the index for many companies (the board). */
export function buildContactIndex(contacts: Contact[]): ContactIndex {
  return {
    size: contacts.length,
    entries: contacts.filter((c) => c.company).map((c) => ({ contact: c, key: companyKey(c.company!) })),
  };
}

export interface ContactMatches {
  /** At the company itself. */
  exact: Contact[];
  /** At a company whose name is this one plus more words, or the reverse. */
  related: Contact[];
}

/** Most recently connected first; people with no date last; then by name. */
function byRecency(a: Contact, b: Contact): number {
  return (b.connected_on ?? "").localeCompare(a.connected_on ?? "") || a.name.localeCompare(b.name);
}

/** The contacts whose current company is `company`. A contact with no company never matches. */
export function contactsAtCompany(contacts: Contact[] | ContactIndex, company: string): ContactMatches {
  const index = Array.isArray(contacts) ? buildContactIndex(contacts) : contacts;
  const key = companyKey(company);
  const out: ContactMatches = { exact: [], related: [] };
  for (const e of index.entries) {
    const m = matchKeys(key, e.key);
    if (m) out[m].push(e.contact);
  }
  out.exact.sort(byRecency);
  out.related.sort(byRecency);
  return out;
}

// --- Re-import ---------------------------------------------------------------

const sameDetails = (a: Contact, b: Contact) =>
  a.name === b.name && a.company === b.company && a.position === b.position && a.url === b.url;

/** What a new import changes against the previous one. People are matched by id (the LinkedIn handle). */
export function diffContacts(previous: Contact[], next: Contact[]): ContactsDiff {
  const before = new Map(previous.map((c) => [c.id, c]));
  const diff: ContactsDiff = { total: next.length, added: 0, removed: 0, unchanged: 0, updated: 0 };
  for (const c of next) {
    const was = before.get(c.id);
    if (!was) diff.added++;
    else if (sameDetails(was, c)) diff.unchanged++;
    else diff.updated++;
    before.delete(c.id);
  }
  diff.removed = before.size;
  return diff;
}

// --- Storage -----------------------------------------------------------------

/** Where the import lives in a data folder (local: ~/Kairos; connector: the user's Drive). */
export const CONTACTS_PATH = ["contacts", "linkedin-connections.json"];

type ReadStore = Pick<Store, "readJson" | "readFile">;

/** The stored import; null before the first one or when the file cannot be read. */
export async function loadContacts(store: Pick<Store, "readJson">): Promise<ContactsFile | null> {
  const file = await store.readJson<ContactsFile>(CONTACTS_PATH);
  return file && Array.isArray(file.contacts) ? file : null;
}

export interface ImportResult extends ContactsDiff {
  imported_at: string;
  /** True when there was no import before this one. */
  first_import: boolean;
  rows: number;
  skipped: ParsedConnections["skipped"];
  missing_columns: string[];
  with_company: number;
  emails_kept: number;
}

/**
 * Import the text of a `Connections.csv` into the data folder. A new import
 * replaces the previous one whole (LinkedIn's export is the full list every
 * time) and reports what changed. A file that is not a connections file
 * throws before anything is written.
 */
export async function importLinkedInConnections(
  store: Pick<Store, "readJson" | "writeJson">,
  text: string,
  opts: { keepEmails?: boolean; at?: string } = {},
): Promise<ImportResult> {
  const parsed = parseLinkedInConnections(text, { keepEmails: opts.keepEmails });
  const previous = await loadContacts(store);
  const imported_at = opts.at ?? new Date().toISOString();
  const file: ContactsFile = { version: 1, source: "linkedin", imported_at, contacts: parsed.contacts };
  await store.writeJson(CONTACTS_PATH, file);
  return {
    ...diffContacts(previous?.contacts ?? [], parsed.contacts),
    imported_at,
    first_import: previous === null,
    rows: parsed.rows,
    skipped: parsed.skipped,
    missing_columns: parsed.missing_columns,
    with_company: parsed.contacts.filter((c) => c.company).length,
    emails_kept: parsed.contacts.filter((c) => c.email).length,
  };
}

// --- The rule ----------------------------------------------------------------

const BAND_RANK: Record<MatchBand, number> = { WEAK: 0, DEVELOPING: 1, COMPETITIVE: 2, STRONG: 3 };
const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };
/** A referral is of no use once the application is over. */
const OVER = new Set(["rejected", "withdrawn", "expired"]);
/** The statuses of an application that is not sent yet. */
const NOT_SENT = new Set(["captured", "scored", "drafted"]);

/** True once the application is sent: any status other than captured, scored or drafted. */
export const applicationIsSent = (status: string | undefined): boolean => !!status && !NOT_SENT.has(status);

/**
 * Is this application a good enough match for Kairos to bring up, by itself,
 * the people the user knows there? Yes when the score's band and confidence
 * both reach the rule (profile.md `referrals`; default COMPETITIVE or better
 * with high confidence), the score does not advise against applying, and the
 * application is not sent yet (captured, scored or drafted). With
 * `after_applying: true` a sent application qualifies too, until it is
 * rejected, withdrawn or expired. An application with no score never
 * qualifies. The user can always ask for the contacts at any company.
 */
export function qualifiesForReferrals(
  app: Pick<ApplicationMeta, "score_band" | "score_confidence" | "recommendation"> & { status?: string; archived?: boolean },
  rule: ReferralRule,
): boolean {
  if (!rule.enabled || app.archived) return false;
  if (app.status && (rule.after_applying ? OVER.has(app.status) : !NOT_SENT.has(app.status))) return false;
  const band = BAND_RANK[app.score_band as MatchBand];
  const confidence = CONFIDENCE_RANK[app.score_confidence ?? ""];
  if (band === undefined || confidence === undefined) return false;
  if (app.recommendation === "NOT_RECOMMENDED") return false;
  return band >= BAND_RANK[rule.min_band] && confidence >= CONFIDENCE_RANK[rule.min_confidence];
}

// --- The suggestion for one application --------------------------------------

/** A contact as shown to the user and to the model: no email, no id. */
export interface ContactView {
  name: string;
  position: string | null;
  company: string | null;
  url: string | null;
  connected_on: string | null;
}

export const toContactView = (c: Contact): ContactView => ({
  name: c.name,
  position: c.position,
  company: c.company,
  url: c.url,
  connected_on: c.connected_on,
});

export interface ApplicationReferrals {
  company: string;
  /** True when the application passes the rule: Kairos shows the contacts without being asked. */
  qualifies: boolean;
  rule: ReferralRule;
  /** When the connections were imported; null when there is no import. */
  imported_at: string | null;
  /** People at the company. */
  contacts: ContactView[];
  /** People at a company with a longer or shorter form of the name; to check before writing to them. */
  related: ContactView[];
}

/**
 * The people the user knows at the company of one application, with whether
 * the application passes the rule. Reads the stored import and profile.md.
 * Lists are empty when nothing was imported or nobody matches.
 */
export async function referralsForApplication(
  store: ReadStore,
  app: Pick<ApplicationMeta, "company" | "score_band" | "score_confidence" | "recommendation" | "status" | "archived">,
): Promise<ApplicationReferrals> {
  const [file, profileRaw] = await Promise.all([loadContacts(store), store.readFile(["profile.md"])]);
  const rule = referralRule(readProfileSettings(profileRaw));
  const found = file ? contactsAtCompany(file.contacts, app.company) : { exact: [], related: [] };
  return {
    company: app.company,
    qualifies: qualifiesForReferrals(app, rule),
    rule,
    imported_at: file?.imported_at ?? null,
    contacts: found.exact.map(toContactView),
    related: found.related.map(toContactView),
  };
}

/**
 * What Kairos brings up by itself after a score is saved: the contacts of a
 * qualifying application, or null (no import, nobody there, or below the
 * rule). Never throws: a broken contacts file must not fail a score save.
 */
export async function suggestReferrals(store: ReadStore, appId: string): Promise<ApplicationReferrals | null> {
  try {
    const meta = await readMeta(store as Store, appId);
    if (!meta) return null;
    const r = await referralsForApplication(store, meta);
    return r.qualifies && r.contacts.length + r.related.length > 0 ? r : null;
  } catch {
    return null;
  }
}
