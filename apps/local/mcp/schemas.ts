/**
 * Input shapes of the settings tools, kept apart from server.ts so the setup
 * checklist test can read their fields without starting the server.
 * tests/setup-sections.test.ts fails when a field here has no `/setup`
 * section and no stated default (packages/engine/setup/sections.ts).
 */
import { z } from "zod";

export const saveProfileShape = {
  name: z.string().optional(),
  contact_line: z.string().optional(),
  headline: z.string().optional().describe("Tagline under the name, e.g. 'Data Platform Product Lead'"),
  languages: z
    .array(z.string())
    .optional()
    .describe("Languages with level, e.g. ['English (native)', 'Spanish (professional)']; given to scoring"),
  target_roles: z.array(z.string()).optional(),
  target_seniority: z.string().optional(),
  role_shape_preference: z
    .string()
    .optional()
    .describe("The shape of role they want, in their words, e.g. 'hands-on individual work, some mentoring'"),
  domains: z.array(z.string()).optional(),
  preferences: z
    .object({
      location: z.string().optional().describe("Where they live or want to work, e.g. 'Chicago, IL or remote (US)'"),
      remote: z.string().optional().describe("Remote/hybrid/onsite stance in their words"),
      relocation: z.string().optional().describe("Would they move, and where, e.g. 'yes: Seattle or Denver'"),
      work_authorization: z.string().optional().describe("e.g. 'US citizen' or 'F-1 OPT, will need H-1B sponsorship'"),
      pay_floor: z.string().optional().describe("Plain-words floor, e.g. '$75,000 base; $90,000 in New York'"),
    })
    .catchall(z.any())
    .optional()
    .describe("Preference fields; other keys are kept as given"),
  deal_breakers: z.array(z.string()).optional(),
  target_pages: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .describe("Résumé page target (1 or 2). Omit to derive it from years of experience."),
  resume_page2_anchor: z
    .string()
    .optional()
    .describe("Two-page résumés: a title substring of the role that must open page 2 (the layout check flags a bad break otherwise)"),
  standing_base_app: z
    .string()
    .optional()
    .describe("appId of the standing generic résumé that tailor-resume clones when a spec names no base"),
  voice: z
    .object({
      banned_patterns: z
        .array(z.string())
        .optional()
        .describe("Phrases the user never wants in letters and answers; plain text matches whole words, /regex/ is a pattern"),
      replace_default_patterns: z.boolean().optional().describe("true: the list replaces the built-in banned phrases instead of extending them"),
    })
    .optional(),
};

export const dreamCompanySchema = z.object({
  name: z.string(),
  ats: z.enum(["greenhouse", "ashby", "lever", "google", "eightfold", "browser"]),
  slug: z.string().optional().describe("Board id for greenhouse/ashby/lever, e.g. 'acme' from boards.greenhouse.io/acme"),
  queries: z.array(z.string()).optional().describe("google/eightfold search queries (default: the function terms)"),
  location: z.string().optional().describe("google/eightfold location filter (default 'United States')"),
  host: z.string().optional().describe("eightfold career-site host"),
  domain: z.string().optional().describe("eightfold company domain"),
  url: z.string().optional().describe("browser: the careers page to check by hand"),
  script: z.string().optional().describe("browser: a helper script to run as page JavaScript there"),
  note: z.string().optional(),
});

export const saveSearchProfileShape = {
  function_terms: z.array(z.string()).optional().describe("Title words that gate the discipline (hard filter)"),
  exclude_terms: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional().describe("Place words that count as local; lowercase"),
  secondary_locations: z.array(z.string()).optional().describe("Higher-bar places: only strong fits surface; may include international cities"),
  excluded_locations: z.array(z.string()).optional().describe("Onsite/hybrid locations that are out (lowercase substrings); remote postings are exempt"),
  boost_terms: z.array(z.string()).optional(),
  seniority_terms: z.array(z.string()).optional(),
  seniority_ceiling: z.string().optional().describe("Highest level they will consider, in their words; triage skips roles above it"),
  watched_companies: z.array(z.string()).optional().describe("Priority companies (lowercase substrings); rank boost, never a gate"),
  excluded_companies: z.array(z.string()).optional().describe("Companies they will not work for (lowercase); hard gate on company name and board id"),
  dream_companies: z
    .array(dreamCompanySchema)
    .optional()
    .describe("Companies whose own career sites are checked directly every day (dream-watch). Pass the complete list."),
  pay_floor: z
    .object({
      amount: z.number().positive(),
      currency: z.string().optional().describe("ISO code, default USD"),
      period: z.enum(["year", "month", "hour"]).optional(),
      by_location: z.array(z.object({ place: z.string(), amount: z.number().positive() })).optional(),
      note: z.string().optional(),
    })
    .optional()
    .describe("Lowest base pay they will accept; triage skips postings whose stated range tops out below it"),
  relocation: z
    .object({ open: z.boolean(), places: z.array(z.string()).optional(), note: z.string().optional() })
    .optional()
    .describe("Whether they would move, and where"),
  board: z.object({ max_sourced_cards: z.number().int().min(1).max(200).optional() }).optional().describe("Board column settings (default 10 sourced cards)"),
  daily_run: z
    .object({ enabled: z.boolean().optional(), time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).optional() })
    .optional()
    .describe("Scheduled daily run: on/off and local time 'HH:MM' (default 08:15)"),
  triage_rules: z.array(z.string()).optional().describe("The user's own rules, given verbatim to triage"),
  max_age_days: z.number().int().min(1).max(60).optional(),
  international_ok: z.boolean().optional(),
  notes: z.string().optional(),
  source: z.enum(["derived", "confirmed"]),
};

const strMap = z.record(z.string(), z.string());

export const saveAutofillShape = {
  contact: strMap.optional().describe("full_name, preferred_name, email, phone"),
  address: strMap.optional().describe("street, city, state, postal_code, country"),
  links: strMap.optional().describe("linkedin, github, portfolio, website"),
  work_authorization: z
    .record(z.string(), z.any())
    .optional()
    .describe("e.g. { authorized_us: 'Yes', requires_sponsorship: 'No', status: 'US citizen' }"),
  eeo: strMap.optional().describe("Demographic answers, served to forms ONLY when share_eeo is true. Ask; never guess."),
  share_eeo: z.boolean().optional().describe("Opt-in for filling EEO questions (default false)"),
  common_answers: strMap
    .optional()
    .describe("Standard answers: start_date, how_did_you_hear, notice_period, current_employer, school, …"),
  defaults: z.record(z.string(), z.any()).optional().describe("Extension flags, e.g. { never_auto_submit: true }"),
  work_history_overrides: z
    .record(
      z.string(),
      z.object({
        title: z.string().optional(),
        start: z.string().regex(/^(\d{2}\/)?\d{4}$/).optional(),
        end: z.string().regex(/^(\d{2}\/)?\d{4}$/).optional(),
        current: z.boolean().optional(),
        exclude: z.boolean().optional(),
      }),
    )
    .optional()
    .describe(
      "How record roles appear on application forms, keyed by experience id: the user's own decisions (HR title, exact months as MM/YYYY, current or ended, exclude). Merged id by id; an id maps to its whole override.",
    ),
  mode: z.enum(["merge", "replace"]).optional().describe("merge (default): each object is merged key by key; replace: rewrite the file"),
};
