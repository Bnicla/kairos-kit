/**
 * The first-run interview (`/setup`) as data: its 14 sections in order, and
 * every setting the engine reads, each mapped to the section that fills it or
 * to a stated default.
 *
 * This file is the single source of truth for three things:
 *   - `/setup --section <name>` (the names below);
 *   - the setup_status tool (which sections are done, which settings are set);
 *   - docs/kit-setup-checklist.md (rendered by renderChecklist, kept in sync by
 *     tests/setup-sections.test.ts).
 *
 * The test also fails when a field is added to the search profile, the
 * profile.md settings, save_profile, save_search_profile or autofill.json
 * without a line here, so a new setting cannot ship without the interview
 * asking for it or a stated default.
 *
 * Setting keys are "<file>.<path>":
 *   profile.*         profile.md frontmatter (save_profile)
 *   search_profile.*  sourcing/search-profile.json (save_search_profile)
 *   autofill.*        autofill.json (save_autofill)
 *   kb.*              knowledge-base files (save_experience, save_education, ...)
 */
import type { StoredSearchProfile } from "../sourcing/search-profile";
import type { ProfileSettings } from "../settings";

export interface SetupSection {
  /** Used in `/setup --section <name>`. */
  name: string;
  /** 1-based order in the interview. */
  order: number;
  title: string;
  /** What the section asks, in the words the command uses. */
  asks: string;
  /** Setting keys this section fills. */
  fills: string[];
  /** MCP tools the section saves with. */
  tools: string[];
}

export interface SettingInfo {
  /** Where it lives, for the student. */
  file: string;
  /** What reads it and what it changes. */
  effect: string;
  /** What happens when it is not set. */
  default: string;
}

export const SETUP_SECTIONS: SetupSection[] = [
  {
    name: "identity",
    order: 1,
    title: "Identity and contact",
    asks: "Name, contact line, headline, links, languages, work authorization.",
    fills: [
      "profile.name",
      "profile.contact_line",
      "profile.headline",
      "profile.languages",
      "profile.preferences.work_authorization",
      "autofill.contact",
      "autofill.links",
      "autofill.work_authorization",
    ],
    tools: ["save_profile", "save_autofill"],
  },
  {
    name: "education",
    order: 2,
    title: "Education and certifications",
    asks: "Degrees, schools, dates, certifications, honors; coursework only if it matters for the target roles.",
    fills: ["kb.education"],
    tools: ["save_education"],
  },
  {
    name: "experience",
    order: 3,
    title: "Experience",
    asks: "Each role, internship or project: dates, what the student personally built, results with numbers, tools.",
    fills: ["kb.experiences", "kb.metrics_register"],
    tools: ["save_experience", "save_confirmed_fact", "save_metric", "get_enrichment_questions"],
  },
  {
    name: "skills",
    order: 4,
    title: "Skills",
    asks: "Confirm the skills found per role and add missing ones, each tied to a role where it was used.",
    fills: ["kb.skills"],
    tools: ["save_experience", "save_confirmed_fact"],
  },
  {
    name: "goals",
    order: 5,
    title: "Goals and target titles",
    asks: "The work they want day to day, then target titles; propose nearby titles; industries and topics of interest.",
    fills: ["profile.target_roles", "profile.domains", "search_profile.function_terms", "search_profile.boost_terms"],
    tools: ["save_profile", "save_search_profile"],
  },
  {
    name: "level",
    order: 6,
    title: "Role shape and seniority",
    asks: "The level they target, the ceiling they will not go above, and the shape of role (individual work, team lead, mix).",
    fills: [
      "profile.target_seniority",
      "profile.role_shape_preference",
      "search_profile.seniority_terms",
      "search_profile.seniority_ceiling",
      "search_profile.notes",
    ],
    tools: ["save_profile", "save_search_profile"],
  },
  {
    name: "dealbreakers",
    order: 7,
    title: "Deal-breakers",
    asks: "Industries, companies and role types they will not consider.",
    fills: [
      "profile.deal_breakers",
      "search_profile.exclude_terms",
      "search_profile.excluded_companies",
      "search_profile.triage_rules",
    ],
    tools: ["save_profile", "save_search_profile"],
  },
  {
    name: "places",
    order: 8,
    title: "Places",
    asks: "Cities, remote or hybrid, relocation yes or no and where, places that are out, postings abroad.",
    fills: [
      "profile.preferences.location",
      "profile.preferences.remote",
      "profile.preferences.relocation",
      "search_profile.locations",
      "search_profile.secondary_locations",
      "search_profile.excluded_locations",
      "search_profile.international_ok",
      "search_profile.relocation",
    ],
    tools: ["save_profile", "save_search_profile"],
  },
  {
    name: "pay",
    order: 9,
    title: "Pay floor",
    asks: "The lowest base pay they would accept, and a different floor for expensive cities if needed.",
    fills: ["profile.preferences.pay_floor", "search_profile.pay_floor"],
    tools: ["save_profile", "save_search_profile"],
  },
  {
    name: "companies",
    order: 10,
    title: "Dream companies",
    asks: "Companies whose career sites are checked directly every day, and companies to rank higher in the daily search.",
    fills: ["search_profile.dream_companies", "search_profile.watched_companies"],
    tools: ["save_search_profile"],
  },
  {
    name: "voice",
    order: 11,
    title: "Writing voice",
    asks: "Two or three samples of their own writing, and phrases they never want in letters or answers.",
    fills: [
      "kb.voice_profile",
      "kb.writing_samples",
      "profile.voice.banned_patterns",
      "profile.voice.replace_default_patterns",
    ],
    tools: ["save_voice_profile", "save_writing_samples", "save_profile"],
  },
  {
    name: "resume",
    order: 12,
    title: "Résumé format",
    asks: "Page target, which role opens page 2 on a two-page résumé, what education to show (GPA, coursework).",
    fills: ["profile.target_pages", "profile.resume_page2_anchor"],
    tools: ["save_profile", "save_education"],
  },
  {
    name: "forms",
    order: 13,
    title: "Application form answers",
    asks: "Optional: address, standard answers (start date, how they heard, notice period), EEO answers only if they want them filled.",
    fills: [
      "autofill.address",
      "autofill.common_answers",
      "autofill.eeo",
      "autofill.share_eeo",
      "autofill.defaults",
      "autofill.work_history_overrides",
    ],
    tools: ["save_autofill"],
  },
  {
    name: "daily",
    order: 14,
    title: "Daily search",
    asks: "Daily search on or off, the time it runs, how fresh postings must be, how many cards the board shows.",
    fills: [
      "search_profile.daily_run.enabled",
      "search_profile.daily_run.time",
      "search_profile.max_age_days",
      "search_profile.board.max_sourced_cards",
    ],
    tools: ["save_search_profile"],
  },
];

/**
 * Every setting the engine reads. A key that no section fills must say what
 * happens without it (the test checks that each key is in a section or here
 * with `asked: false`).
 */
export const SETTINGS: Record<string, SettingInfo & { asked?: false }> = {
  // --- profile.md -----------------------------------------------------------
  "profile.name": { file: "profile.md", effect: "Résumé header, file names, form autofill.", default: "Taken from the résumé." },
  "profile.contact_line": { file: "profile.md", effect: "Résumé contact line; health check.", default: "Taken from the résumé." },
  "profile.headline": { file: "profile.md", effect: "Tagline under the name on the résumé.", default: "No tagline." },
  "profile.languages": { file: "profile.md", effect: "Given to scoring so language requirements are not marked unconfirmed.", default: "Not stated: scoring treats language requirements as unconfirmed." },
  "profile.preferences": { file: "profile.md", effect: "Container for the preference fields below.", default: "Empty." },
  "profile.preferences.work_authorization": { file: "profile.md", effect: "Given to scoring (sponsorship and citizenship requirements).", default: "Not stated: scoring flags authorization requirements as unconfirmed." },
  "profile.preferences.location": { file: "profile.md", effect: "Given to scoring; seeds search_profile.locations on first derivation.", default: "Not stated." },
  "profile.preferences.remote": { file: "profile.md", effect: "Read by triage through the profile summary.", default: "Not stated." },
  "profile.preferences.relocation": { file: "profile.md", effect: "Given to scoring as a profile fact.", default: "Not stated." },
  "profile.preferences.pay_floor": { file: "profile.md", effect: "Read by triage through the profile summary; the structured floor is search_profile.pay_floor.", default: "Not stated." },
  "profile.target_roles": { file: "profile.md", effect: "Enrichment questions; seeds function terms; triage summary.", default: "None: the search has nothing to look for until a role is named." },
  "profile.target_seniority": { file: "profile.md", effect: "Seeds seniority terms; triage summary.", default: "Any level." },
  "profile.role_shape_preference": { file: "profile.md", effect: "Copied into the search profile notes on first derivation.", default: "None." },
  "profile.domains": { file: "profile.md", effect: "Seeds boost terms; triage summary.", default: "None." },
  "profile.deal_breakers": { file: "profile.md", effect: "Triage summary (the hard gates are in the search profile).", default: "None." },
  "profile.target_pages": { file: "profile.md", effect: "Résumé length policy and layout check.", default: "Derived from years of experience (1 page for students)." },
  "profile.resume_page2_anchor": { file: "profile.md", effect: "Layout check on two-page résumés.", default: "No anchor: any clean page break passes." },
  "profile.paper": { file: "profile.md", effect: "Paper size of the résumé and cover letter (letter or a4).", default: "US Letter for a United States search; A4 when search_profile.international_ok is true.", asked: false },
  "profile.metrics_allowed_statuses": { file: "profile.md", effect: "Metrics-register statuses whose numbers may appear in a résumé or letter.", default: "DEFENDED and SCOPE.", asked: false },
  "profile.standing_base_app": { file: "profile.md", effect: "Base résumé for tailor-resume when a spec names none.", default: "None until the first tailored résumé; tailor-resume asks for spec.base.", asked: false },
  "profile.resume_leadin_aliases": { file: "profile.md", effect: "Maps renamed bullet lead-ins so old tailoring specs keep matching.", default: "{} (nothing renamed yet).", asked: false },
  "profile.stories_map": { file: "profile.md", effect: "Data-folder path of the stories map the deep-dives page reads.", default: "knowledge-base/stories-map.json.", asked: false },
  "profile.voice": { file: "profile.md", effect: "Container for the voice settings below.", default: "Built-in banned phrase list only." },
  "profile.voice.banned_patterns": { file: "profile.md", effect: "Letter and answer prose check.", default: "Built-in phrase list only." },
  "profile.voice.replace_default_patterns": { file: "profile.md", effect: "true: the user's list replaces the built-in one.", default: "false (the user's list extends the built-in one)." },

  // --- sourcing/search-profile.json -----------------------------------------
  "search_profile.function_terms": { file: "sourcing/search-profile.json", effect: "Hard gate: a title must contain one of these words.", default: "Derived from target_roles." },
  "search_profile.exclude_terms": { file: "sourcing/search-profile.json", effect: "Hard gate: titles with these words are dropped.", default: "None; intern, internship, junior and apprentice when the stated level is senior and not early-career." },
  "search_profile.search_terms": { file: "sourcing/search-profile.json", effect: "Words sent as the search text to job sites that only answer a search (Workday): one paged query per word, at most 3.", default: "The first function terms.", asked: false },
  "search_profile.role_phrases": { file: "sourcing/search-profile.json", effect: "Phrases that name the user's own role in a title; read only with soft_exclude_terms.", default: "None: every exclude term blocks.", asked: false },
  "search_profile.soft_exclude_terms": { file: "sourcing/search-profile.json", effect: "Exclude terms that do not block a title carrying a role phrase in another part of the title.", default: "None: every exclude term blocks.", asked: false },
  "search_profile.locations": { file: "sourcing/search-profile.json", effect: "Places that count as local; others go to the stretch bucket.", default: "Derived from preferences.location; remote postings always match." },
  "search_profile.secondary_locations": { file: "sourcing/search-profile.json", effect: "Higher-bar places (strong fits only), may be abroad.", default: "None." },
  "search_profile.excluded_locations": { file: "sourcing/search-profile.json", effect: "Hard gate: onsite/hybrid postings there are dropped.", default: "None." },
  "search_profile.boost_terms": { file: "sourcing/search-profile.json", effect: "Rank boost for title words.", default: "Derived from domains." },
  "search_profile.seniority_terms": { file: "sourcing/search-profile.json", effect: "Rank boost for level words; never a gate.", default: "Derived from target_seniority." },
  "search_profile.seniority_ceiling": { file: "sourcing/search-profile.json", effect: "Triage rule: skip roles above it.", default: "No ceiling." },
  "search_profile.watched_companies": { file: "sourcing/search-profile.json", effect: "Rank boost for these companies.", default: "None." },
  "search_profile.excluded_companies": { file: "sourcing/search-profile.json", effect: "Hard gate: these companies never reach triage.", default: "None." },
  "search_profile.dream_companies": { file: "sourcing/search-profile.json", effect: "Career sites checked directly every day (dream-watch).", default: "None: dream-watch says so and exits." },
  "search_profile.triage_rules": { file: "sourcing/search-profile.json", effect: "The user's own rules, given verbatim to triage.", default: "None." },
  "search_profile.pay_floor": { file: "sourcing/search-profile.json", effect: "Triage rule: skip postings whose stated range tops out below it.", default: "No floor." },
  "search_profile.relocation": { file: "sourcing/search-profile.json", effect: "Triage rule on onsite roles outside the listed places.", default: "Not stated." },
  "search_profile.max_age_days": { file: "sourcing/search-profile.json", effect: "Hard recency cap for the daily search.", default: "7 days." },
  "search_profile.international_ok": { file: "sourcing/search-profile.json", effect: "Whether postings outside the home country appear.", default: "false." },
  "search_profile.notes": { file: "sourcing/search-profile.json", effect: "Free text added to the triage summary.", default: "None." },
  "search_profile.after_triage_hook": { file: "sourcing/search-profile.json", effect: "Optional module the daily search runs after triage (it can log, never decides).", default: "None.", asked: false },
  "search_profile.board": { file: "sourcing/search-profile.json", effect: "Container for board settings.", default: "Defaults below." },
  "search_profile.board.max_sourced_cards": { file: "sourcing/search-profile.json", effect: "Sourced cards shown on the board column.", default: "10." },
  "search_profile.daily_run": { file: "sourcing/search-profile.json", effect: "Container for the daily-run settings.", default: "On at 08:15." },
  "search_profile.daily_run.enabled": { file: "sourcing/search-profile.json", effect: "Daily search on or off.", default: "On." },
  "search_profile.daily_run.time": { file: "sourcing/search-profile.json", effect: "Local time of the daily search (install.sh --daily HH:MM applies it).", default: "08:15." },
  "search_profile.source": { file: "sourcing/search-profile.json", effect: "'confirmed' once the user has answered; 'derived' when guessed.", default: "derived (set to confirmed by /setup).", asked: false },
  "search_profile.updated_at": { file: "sourcing/search-profile.json", effect: "Written by every save.", default: "Set automatically.", asked: false },

  // --- autofill.json --------------------------------------------------------
  "autofill.contact": { file: "autofill.json", effect: "Form autofill: name, email, phone.", default: "Name from profile.md; the rest is left blank on forms." },
  "autofill.links": { file: "autofill.json", effect: "Form autofill: LinkedIn, GitHub, portfolio.", default: "Left blank on forms." },
  "autofill.work_authorization": { file: "autofill.json", effect: "Form autofill: authorization and sponsorship questions.", default: "Left blank on forms." },
  "autofill.address": { file: "autofill.json", effect: "Form autofill: address fields.", default: "Left blank on forms." },
  "autofill.common_answers": { file: "autofill.json", effect: "Form autofill: standard answers (start date, how they heard, current employer, school).", default: "Employer and school from the record; the rest blank." },
  "autofill.eeo": { file: "autofill.json", effect: "Form autofill: demographic questions, only when share_eeo is true.", default: "Never filled." },
  "autofill.share_eeo": { file: "autofill.json", effect: "Opt-in for serving the EEO answers.", default: "false." },
  "autofill.defaults": { file: "autofill.json", effect: "Extension behaviour flags.", default: "{ never_auto_submit: true }." },
  "autofill.work_history_overrides": { file: "autofill.json", effect: "How each record role appears on application forms: HR title, exact months, ended or current, or left off.", default: "The record's title and years, as on the résumé." },

  // --- knowledge base -------------------------------------------------------
  "kb.education": { file: "knowledge-base/education/*.md", effect: "Résumé education section; scoring.", default: "No education section." },
  "kb.experiences": { file: "knowledge-base/experiences/*.md", effect: "Everything: scoring, résumés, letters, prep.", default: "None: scoring and tailoring refuse to run." },
  "kb.skills": { file: "knowledge-base/experiences/*.md (skills in frontmatter)", effect: "Scoring and résumé skills line.", default: "Skills found in the documents." },
  "kb.metrics_register": { file: "knowledge-base/metrics-register.md", effect: "Which numbers may appear in documents (DEFENDED and SCOPE only).", default: "Empty: numbers stay as tagged in the record." },
  "kb.voice_profile": { file: "knowledge-base/_voice-profile.md", effect: "Résumé and letter style.", default: "Learned from the résumé." },
  "kb.writing_samples": { file: "knowledge-base/_writing-samples.md", effect: "Cover-letter style few-shots.", default: "None: letters follow the house style only." },
  "kb.star_stories": { file: "knowledge-base/star-stories.json", effect: "Dashboard Stories page; interview prep.", default: "Built later by /prep from the record.", asked: false },
};

/**
 * Compile-time lists of the fields of the stored shapes. A field added to a
 * type without a line here fails `tsc`; the test then checks each one has a
 * SETTINGS entry.
 */
export const SEARCH_PROFILE_FIELDS: Record<keyof StoredSearchProfile, true> = {
  function_terms: true,
  exclude_terms: true,
  search_terms: true,
  role_phrases: true,
  soft_exclude_terms: true,
  locations: true,
  boost_terms: true,
  seniority_terms: true,
  max_age_days: true,
  watched_companies: true,
  triage_rules: true,
  secondary_locations: true,
  excluded_locations: true,
  international_ok: true,
  dream_companies: true,
  board: true,
  daily_run: true,
  after_triage_hook: true,
  excluded_companies: true,
  pay_floor: true,
  seniority_ceiling: true,
  relocation: true,
  notes: true,
  updated_at: true,
  source: true,
};

export const PROFILE_SETTINGS_FIELDS: Record<keyof ProfileSettings, true> = {
  standing_base_app: true,
  resume_leadin_aliases: true,
  target_pages: true,
  resume_page2_anchor: true,
  paper: true,
  metrics_allowed_statuses: true,
  voice: true,
  stories_map: true,
};

export function sectionByName(name: string): SetupSection | undefined {
  const n = name.trim().toLowerCase();
  return SETUP_SECTIONS.find((s) => s.name === n || String(s.order) === n);
}

/** Section that fills a key, or null when it is default-only. */
export function sectionFor(key: string): SetupSection | null {
  return SETUP_SECTIONS.find((s) => s.fills.includes(key)) ?? null;
}

/** The checklist as markdown (docs/kit-setup-checklist.md is this output). */
export function renderChecklist(): string {
  const lines = [
    "# Kairos Kit: `/setup` checklist",
    "",
    "Generated from `packages/engine/setup/sections.ts` (`renderChecklist`). Do not edit by hand:",
    "`tests/setup-sections.test.ts` fails when this file and the code disagree, and when a",
    "setting the engine reads has no section and no stated default.",
    "",
    "## Sections",
    "",
    "| # | `/setup --section` | Asks | Saves with |",
    "|---|---|---|---|",
    ...SETUP_SECTIONS.map((s) => `| ${s.order} | \`${s.name}\` | ${s.asks} | ${s.tools.map((t) => `\`${t}\``).join(", ")} |`),
    "",
    "## Settings",
    "",
    "| Setting | File | Filled by | Default when not set | What it changes |",
    "|---|---|---|---|---|",
  ];
  for (const [key, info] of Object.entries(SETTINGS)) {
    const s = sectionFor(key);
    lines.push(`| \`${key}\` | ${info.file} | ${s ? `${s.order}. ${s.name}` : "not asked"} | ${info.default} | ${info.effect} |`);
  }
  return lines.join("\n") + "\n";
}
