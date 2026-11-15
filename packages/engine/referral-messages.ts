/**
 * Referral messages. For one application and one contact the user picks,
 * Kairos drafts a short LinkedIn message asking that person for a
 * conversation or a referral. The user reads it, edits it and sends it.
 * Kairos never sends anything and never opens LinkedIn.
 *
 * Only on request, like a cover letter: nothing here runs after a score.
 *
 * This file holds:
 *   - the evidence for the draft (`referralMessageEvidence`): the application,
 *     the stored contact, the verified knowledge base, the voice, and what the user
 *     said about how they know the person;
 *   - the checks on the text before it is saved (`checkReferralMessage`, pure,
 *     and `saveReferralMessage`, which adds the prose gate and the numbers);
 *   - storage with the application, `applications/<id>/referral-messages.json`,
 *     and the state the user sets: drafted, sent, answered.
 *
 * Everything reads and writes through the engine's Store.
 */
import { readMeta, readScoreReport, readSnapshot, type ApplicationMeta } from "./applications";
import { applicationIsSent, contactsAtCompany, loadContacts, type Contact } from "./contacts";
import { serializeExperience, stripUnverified } from "./kb/experience";
import { loadEducation, loadExperiences, loadVoiceProfile } from "./kb/store";
import {
  MESSAGE_MAX_CHARS,
  MESSAGE_SOFT_WORDS,
  REFERRAL_MESSAGE_SYSTEM_PROMPT,
  buildReferralMessageUserMessage,
  type ReferralAsk,
} from "./prompts/referral-message";
import { readProfileSettings } from "./settings";
import type { Store } from "./store/types";
import { checkLetterNumbers, profileName, snapshotBody } from "./tools/ops";
import { checkProse } from "./tools/prose-checks";
import type { ScoreReport } from "./types";

// --- Types -------------------------------------------------------------------

/** drafted: written by Kairos, not sent. sent: the user says they sent it. answered: the user says the person answered. */
export type MessageState = "drafted" | "sent" | "answered";
export const MESSAGE_STATES: MessageState[] = ["drafted", "sent", "answered"];

/** The contact as kept with the draft, so the page can show it after a later import. No email. */
export interface MessageContact {
  id: string;
  first_name: string;
  name: string;
  position: string | null;
  company: string | null;
  url: string | null;
  connected_on: string | null;
}

export interface ReferralMessage {
  contact: MessageContact;
  /** How the user knows the person, as the user said it; null when they said nothing (the draft then claims no shared history). */
  relationship: string | null;
  ask: ReferralAsk;
  /** The message, plain text. */
  text: string;
  state: MessageState;
  drafted_at: string;
  updated_at: string;
  /** Every change of state, with the user's note when they gave one. */
  history: { state: MessageState; at: string; note?: string }[];
}

export interface ReferralMessagesFile {
  version: 1;
  messages: ReferralMessage[];
}

const messagesPath = (appId: string) => ["applications", appId, "referral-messages.json"];

/** The drafts kept with an application, oldest first; [] when there is none. */
export async function loadReferralMessages(store: Pick<Store, "readJson">, appId: string): Promise<ReferralMessage[]> {
  const file = await store.readJson<ReferralMessagesFile>(messagesPath(appId));
  return Array.isArray(file?.messages) ? file.messages : [];
}

// --- Which contact -----------------------------------------------------------

export type ContactPlace = "at_company" | "similar_company_name" | "another_company";

const fold = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const handleOf = (s: string) => s.match(/linkedin\.com\/in\/([^/?#\s]+)/i)?.[1]?.toLowerCase() ?? null;

function matches(c: Contact, query: string): "full" | "partial" | null {
  const q = fold(query);
  if (!q) return null;
  const handle = handleOf(query);
  if (c.id === query.trim().toLowerCase() || (handle && c.id === `li:${decodeSafe(handle)}`)) return "full";
  const name = fold(c.name);
  if (name === q) return "full";
  return q.split(" ").every((w) => name.split(/[\s,]+/).includes(w)) ? "partial" : null;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The contact a request names: a full name, a part of it, a profile address
 * or a contact id. People at the application's company come first, then
 * people at a similar company name, then anyone in the import by full name.
 * Throws when nobody or more than one person fits, naming the choices.
 */
export function findContact(contacts: Contact[], company: string, query: string): { contact: Contact; place: ContactPlace } {
  const at = contactsAtCompany(contacts, company);
  const tiers: [ContactPlace, Contact[]][] = [
    ["at_company", at.exact],
    ["similar_company_name", at.related],
  ];
  for (const [place, people] of tiers) {
    const full = people.filter((c) => matches(c, query) === "full");
    const hits = full.length ? full : people.filter((c) => matches(c, query));
    if (hits.length === 1) return { contact: hits[0], place };
    if (hits.length > 1) {
      throw new Error(`More than one contact fits "${query}": ${hits.map((c) => `${c.name} (${c.position ?? "no position"})`).join("; ")}. Give the full name or the profile address.`);
    }
  }
  const elsewhere = contacts.filter((c) => matches(c, query) === "full");
  if (elsewhere.length === 1) return { contact: elsewhere[0], place: "another_company" };
  if (elsewhere.length > 1) throw new Error(`More than one contact is named "${query}". Give the profile address.`);
  throw new Error(`No contact fits "${query}" at ${company} or by full name in the import. list_contacts shows the people at a company.`);
}

const toMessageContact = (c: Contact): MessageContact => ({
  id: c.id,
  first_name: c.first_name,
  name: c.name,
  position: c.position,
  company: c.company,
  url: c.url,
  connected_on: c.connected_on,
});

async function resolve(store: Pick<Store, "readJson">, meta: ApplicationMeta, query: string) {
  const file = await loadContacts(store);
  if (!file) throw new Error("No connections imported yet: import_linkedin_connections reads the user's LinkedIn export first.");
  return findContact(file.contacts, meta.company, query);
}

// --- Evidence ----------------------------------------------------------------

export interface ReferralMessageRequest {
  /** Full name, part of it, profile address or contact id. */
  contact: string;
  /** How the user knows the person, in their words. Omit when they said nothing. */
  relationship?: string | null;
  /** Default: "conversation" when the user said nothing about knowing the person, else "referral". */
  ask?: ReferralAsk;
}

export interface ReferralMessageEvidence {
  system_prompt: string;
  user_message: string;
  contact: MessageContact;
  contact_place: ContactPlace;
  application_sent: boolean;
  ask: ReferralAsk;
  relationship: string | null;
  /** The state of a draft already kept for this person, if any. */
  existing_state: MessageState | null;
}

const cleanRelationship = (r: string | null | undefined) => r?.replace(/\s+/g, " ").trim() || null;

/** The ask when the request names none: a referral is asked of someone the user can say they know. */
export const defaultAsk = (relationship: string | null): ReferralAsk => (relationship ? "referral" : "conversation");

/** Everything the model needs to draft the message, and nothing it could invent from. */
export async function referralMessageEvidence(store: Store, appId: string, req: ReferralMessageRequest): Promise<ReferralMessageEvidence> {
  const meta = await readMeta(store, appId);
  if (!meta) throw new Error(`Application not found: ${appId}`);
  const { contact, place } = await resolve(store, meta, req.contact);
  const relationship = cleanRelationship(req.relationship);
  const ask = req.ask ?? defaultAsk(relationship);
  const [experiences, voiceProfile, writingSamples, snapshot, report, profileRaw, existing] = await Promise.all([
    loadExperiences(store),
    loadVoiceProfile(store),
    store.readFile(["knowledge-base", "_writing-samples.md"]),
    readSnapshot(store, appId),
    readScoreReport<ScoreReport>(store, appId),
    store.readFile(["profile.md"]),
    loadReferralMessages(store, appId),
  ]);
  const sent = applicationIsSent(meta.status);
  const user_message = buildReferralMessageUserMessage({
    jobText: snapshotBody(snapshot),
    jobUrl: meta.source_url ?? null,
    company: meta.company,
    title: meta.role,
    sent,
    appliedOn: meta.applied_at?.slice(0, 10) ?? null,
    contact,
    similarCompanyName: place !== "at_company",
    relationship,
    ask,
    experiences,
    voiceProfile,
    writingSamples,
    candidateName: profileRaw ? profileName(profileRaw) : undefined,
    keyStrengths: report?.authenticity?.strengths ?? [],
  });
  return {
    system_prompt: REFERRAL_MESSAGE_SYSTEM_PROMPT,
    user_message,
    contact: toMessageContact(contact),
    contact_place: place,
    application_sent: sent,
    ask,
    relationship,
    existing_state: existing.find((m) => m.contact.id === contact.id)?.state ?? null,
  };
}

// --- Checks ------------------------------------------------------------------

export interface MessageViolation {
  rule: "length" | "format" | "greeting" | "stock-opener" | "shared-history" | "contact-claim" | "ungrounded-name" | "link" | "ask";
  detail: string;
  hard: boolean;
}

/** Said to a stranger as if to a friend: a claim of shared history the user never made. */
const SHARED_HISTORY: RegExp[] = [
  /\b(?:we|you and I)\s+(?:worked|met|overlapped|collaborated|spoke|talked|chatted|studied|were both|both|shared|crossed paths|go way back)\b/i,
  /\bour time (?:together|at|in|on)\b/i,
  /\bit(?:'s| has|\u2019s) been (?:a while|too long|ages|some time|a long time|years|a minute)\b/i,
  /\blong time(?:,| no)\b/i,
  /\b(?:former|old|fellow|ex-)\s?(?:colleague|classmate|teammate|coworker|co-worker|alum|alumnus|alumna|alumni)\b/i,
  /\bfellow\b/i,
  /\b(?:catch|catching|caught) up\b/i,
  /\breconnect(?:ing|ed)?\b/i,
  /\bremember (?:me|when|our|us)\b/i,
  /\bas you (?:know|may remember|might remember|may recall|might recall)\b/i,
  /\bsince we (?:last|met|spoke|worked|talked)\b/i,
  /\b(?:good|great|nice) to (?:see|hear from) you\b/i,
  /\bback (?:when|in the day)\b/i,
];

/** A statement about the contact that the four stored fields cannot support. */
const CONTACT_CLAIMS: RegExp[] = [
  /\bI (?:saw|read|noticed|came across|have been following|follow|enjoyed|loved|admire)\b[^.?!]{0,40}\byour?\b/i,
  /\byour (?:work on|recent|post|posts|article|talk|journey|success|achievements?|accomplishments?|leadership|career|background|experience|expertise|insights?|track record|promotion|new role)\b/i,
  /\bcongrat(?:s|ulations)\b/i,
  /\bimpress(?:ed|ive)\b/i,
  /\byou(?:'ve| have) (?:built|done|led|grown|achieved|been at|been with|spent)\b/i,
];

const STOCK_OPENERS: RegExp[] = [
  /\bhope (?:this (?:message|note|email) finds you|you(?:'re|\u2019re| are) (?:doing |keeping )?(?:well|great|good)|all is well|you(?:'ve|\u2019ve| have) been well)\b/i,
  /\bI know you(?:'re|\u2019re| are) (?:very |really )?busy\b/i,
  /\bsorry to (?:bother|trouble|disturb)\b/i,
  /\bout of the blue\b/i,
];

const FORMAT_MARKS: [RegExp, string][] = [
  [/\*\*|__/, "bold markers"],
  [/^#{1,6}\s/m, "a heading"],
  [/^\s*[-*•]\s+\S/m, "a bullet list"],
  [/`/, "a code mark"],
  [/^subject\s*:/im, "a subject line"],
  [/\[[^\]\n]{0,80}\]|\{[^}\n]{0,80}\}|<[^>\n]{1,80}>/, "a placeholder in brackets"],
];

const ALWAYS_KNOWN = new Set([
  "linkedin", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november",
  "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

const wordsIn = (s: string) => new Set(s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/**
 * Capitalized words of the message, other than the first word of a sentence
 * or a line, that appear nowhere in the evidence: the name of a company, a
 * product, a school or a person the draft brought in from outside.
 */
export function ungroundedNames(text: string, evidence: string): string[] {
  const known = wordsIn(evidence);
  const out = new Set<string>();
  for (const line of text.split(/\n+/)) {
    if (/^\s*https?:\/\/\S+\s*$/.test(line)) continue;
    for (const sentence of line.split(/(?<=[.!?:])\s+/)) {
      const tokens = [...sentence.matchAll(/[\p{L}\p{N}]+(?:['\u2019.&-][\p{L}\p{N}]+)*/gu)].map((m) => m[0]);
      tokens.slice(1).forEach((token) => {
        if (!/^\p{Lu}/u.test(token)) return;
        const parts = token.split(/['\u2019.&-]/).filter((p) => p.length > 1 && /^\p{Lu}/u.test(p));
        const missing = parts.filter((p) => {
          const w = [...wordsIn(p)][0];
          return w && !known.has(w) && !ALWAYS_KNOWN.has(w);
        });
        if (missing.length) out.add(token);
      });
    }
  }
  return [...out];
}

export interface MessageCheckContext {
  contact: Pick<MessageContact, "first_name" | "name" | "position" | "company">;
  /** What the user said about knowing the person; null: the message must claim no shared history. */
  relationship: string | null;
  /** Everything a name in the message may come from: the knowledge base, the profile, the posting, the application, the contact, the user's words. */
  evidence: string;
  /** The posting's address, the only link a message may carry. */
  jobUrl?: string | null;
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * The checks that are specific to a message to a contact. Pure. Hard
 * violations refuse the save; the others come back as warnings.
 */
export function checkReferralMessage(text: string, ctx: MessageCheckContext): MessageViolation[] {
  const out: MessageViolation[] = [];
  const body = text.trim();
  const words = countWords(body);

  if (body.length > MESSAGE_MAX_CHARS) out.push({ rule: "length", detail: `${body.length} characters; the limit is ${MESSAGE_MAX_CHARS}`, hard: true });
  else if (words > MESSAGE_SOFT_WORDS) out.push({ rule: "length", detail: `${words} words; a message to a contact reads best under ${MESSAGE_SOFT_WORDS}`, hard: false });
  if (words < 25) out.push({ rule: "length", detail: `${words} words: too short to say the role, one fact and the ask`, hard: words < 12 });

  for (const [re, what] of FORMAT_MARKS) if (re.test(body)) out.push({ rule: "format", detail: `${what}: a LinkedIn message is plain text`, hard: true });

  const first = body.split("\n")[0] ?? "";
  const firstName = ctx.contact.first_name.trim();
  if (firstName && !first.toLowerCase().includes(firstName.toLowerCase())) {
    out.push({ rule: "greeting", detail: `the first line does not greet ${firstName}`, hard: true });
  }

  const hit = (family: RegExp[]) => family.map((re) => body.match(re)?.[0]).filter((m): m is string => !!m);
  for (const h of hit(STOCK_OPENERS)) out.push({ rule: "stock-opener", detail: `"${h}": start with the reason for writing`, hard: true });
  for (const h of hit(CONTACT_CLAIMS)) {
    out.push({ rule: "contact-claim", detail: `"${h}": Kairos knows the contact's name, position, company and date connected, nothing else`, hard: true });
  }
  if (!ctx.relationship) {
    for (const h of new Set(hit(SHARED_HISTORY))) {
      out.push({
        rule: "shared-history",
        detail: `"${h}": the user has not said how they know ${firstName || "this person"}. Remove it, or ask the user and pass their answer as relationship`,
        hard: true,
      });
    }
  }

  const names = ungroundedNames(body, ctx.evidence);
  if (names.length) {
    out.push({
      rule: "ungrounded-name",
      detail: `${names.map((n) => `"${n}"`).join(", ")}: not in the knowledge base, the profile, the posting, the contact or what the user said. Remove, or record the fact first`,
      hard: true,
    });
  }

  const links = body.match(/https?:\/\/\S+/g) ?? [];
  const allowed = ctx.jobUrl?.trim().replace(/[/]+$/, "");
  for (const l of links) {
    if (!allowed || l.replace(/[).,;]+$/, "").replace(/[/]+$/, "") !== allowed) out.push({ rule: "link", detail: `"${l}": the only link a message may carry is the posting's`, hard: true });
  }

  if (!/\?/.test(body) && !/\b(?:would|could|can) you\b|\bopen to\b|\bwilling to\b|\blet me know\b/i.test(body)) {
    out.push({ rule: "ask", detail: "the message asks nothing: end on one question that is easy to answer", hard: false });
  }
  return out;
}

// --- Save --------------------------------------------------------------------

export interface SaveMessageResult {
  saved: string;
  contact: MessageContact;
  state: MessageState;
  words: number;
  characters: number;
  /** Findings that did not refuse the save. */
  warnings: string[];
}

/** Thrown when a check refuses the text; `message` lists what to fix. */
export class MessageRejected extends Error {}

/**
 * Check the draft and keep it with the application. One draft per contact:
 * saving again replaces the text of a draft that is not sent. A message the
 * user marked sent or answered is not overwritten.
 */
export async function saveReferralMessage(
  store: Store,
  appId: string,
  input: ReferralMessageRequest & { text: string; at?: string },
): Promise<SaveMessageResult> {
  const meta = await readMeta(store, appId);
  if (!meta) throw new Error(`Application not found: ${appId}`);
  const { contact } = await resolve(store, meta, input.contact);
  const relationship = cleanRelationship(input.relationship);
  const text = input.text.replace(/\r\n/g, "\n").trim();

  const messages = await loadReferralMessages(store, appId);
  const existing = messages.find((m) => m.contact.id === contact.id);
  if (existing && existing.state !== "drafted") {
    throw new MessageRejected(
      `Not saved: the message to ${contact.name} is marked ${existing.state}. A sent message is kept as it was sent. To write a new draft, the user first sets its state back to drafted.`,
    );
  }

  const [experiences, education, profileRaw, snapshot] = await Promise.all([
    loadExperiences(store),
    loadEducation(store).catch(() => [] as string[]),
    store.readFile(["profile.md"]),
    readSnapshot(store, appId),
  ]);
  const posting = snapshotBody(snapshot);
  const contactText = [contact.name, contact.position ?? "", contact.company ?? "", contact.connected_on ?? ""].join("\n");
  const evidence = [
    experiences.map(stripUnverified).map(serializeExperience).join("\n"),
    profileRaw ?? "",
    education.join("\n"),
    posting,
    meta.company,
    meta.role,
    contactText,
    relationship ?? "",
  ].join("\n");

  const prose = checkProse(text, { jobText: posting, voice: readProfileSettings(profileRaw).voice, kind: "message" });
  const own = checkReferralMessage(text, { contact, relationship, evidence, jobUrl: meta.source_url });
  const hard = [...prose, ...own].filter((v) => v.hard);
  if (hard.length) {
    throw new MessageRejected(
      `The checks refused the message (${hard.length} to fix). Rewrite these and save again:\n` + hard.map((v) => `- ${v.rule}: ${v.detail}`).join("\n"),
    );
  }
  const numbers = await checkLetterNumbers(store, appId, text, {
    what: "message",
    extraSources: [contactText, relationship ?? "", meta.applied_at ?? ""].join("\n"),
  });
  if (numbers.message) throw new MessageRejected(numbers.message);

  const at = input.at ?? new Date().toISOString();
  const ask = input.ask ?? existing?.ask ?? defaultAsk(relationship);
  const next: ReferralMessage = existing
    ? { ...existing, contact: toMessageContact(contact), relationship, ask, text, updated_at: at }
    : { contact: toMessageContact(contact), relationship, ask, text, state: "drafted", drafted_at: at, updated_at: at, history: [{ state: "drafted", at }] };
  const file: ReferralMessagesFile = { version: 1, messages: existing ? messages.map((m) => (m === existing ? next : m)) : [...messages, next] };
  await store.writeJson(messagesPath(appId), file);
  return {
    saved: messagesPath(appId).join("/"),
    contact: next.contact,
    state: next.state,
    words: countWords(text),
    characters: text.length,
    warnings: [...prose, ...own].filter((v) => !v.hard).map((v) => `${v.rule}: ${v.detail}`),
  };
}

// --- State -------------------------------------------------------------------

/**
 * Record what the user says happened to a message: they sent it, the person
 * answered, or it goes back to a draft. Kairos does not detect any of this.
 * `contact` is a name, a part of it, a profile address or a contact id, read
 * against the drafts kept with the application.
 */
export async function setReferralMessageState(
  store: Pick<Store, "readJson" | "writeJson">,
  appId: string,
  contact: string,
  state: MessageState,
  opts: { note?: string; at?: string } = {},
): Promise<ReferralMessage> {
  if (!MESSAGE_STATES.includes(state)) throw new Error(`Unknown state "${state}". One of: ${MESSAGE_STATES.join(", ")}.`);
  const messages = await loadReferralMessages(store, appId);
  if (!messages.length) throw new Error(`No message is kept with application ${appId}.`);
  const q = fold(contact);
  const handle = handleOf(contact);
  const hits = messages.filter(
    (m) => m.contact.id === contact.trim().toLowerCase() || (handle && m.contact.id === `li:${decodeSafe(handle)}`) || q.split(" ").every((w) => fold(m.contact.name).split(/[\s,]+/).includes(w)),
  );
  if (hits.length !== 1) {
    throw new Error(`${hits.length ? "More than one message fits" : "No message fits"} "${contact}". Messages kept: ${messages.map((m) => m.contact.name).join("; ")}.`);
  }
  const at = opts.at ?? new Date().toISOString();
  const note = opts.note?.trim();
  const next: ReferralMessage = { ...hits[0], state, updated_at: at, history: [...hits[0].history, { state, at, ...(note ? { note } : {}) }] };
  await store.writeJson(messagesPath(appId), { version: 1, messages: messages.map((m) => (m === hits[0] ? next : m)) } satisfies ReferralMessagesFile);
  return next;
}
