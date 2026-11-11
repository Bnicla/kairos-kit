import type { MatchBand, ScoreReport } from "@kairos/engine/types";

/**
 * Cross-application skill-gap report. Pure function over the gaps every
 * scored application already carries in its ScoreReport, so the dashboard
 * (/gaps) and the MCP tool (get_gap_report) recompute it on every call.
 *
 * Gap shape in the data (ScoreReport.gaps[]):
 *   { requirement: free text from the posting,
 *     severity: "DEAL-BREAKER" | "IMPORTANT" | "NICE-TO-HAVE",
 *     type: "genuine_gap" | "possibly_uncaptured",
 *     clarifying_question: string | null }
 * Requirements are long, posting-specific sentences, so exact-label grouping
 * finds almost nothing. Labels are normalized (see normalizeGapLabel) and then
 * mapped onto a small explicit concept table (GAP_CONCEPTS) derived from the
 * real reports; a requirement that matches no concept stays its own group.
 *
 * Scoring, per application and concept:
 *   contribution = BAND_WEIGHT[band] × SEVERITY_WEIGHT[severity] × 0.5^(age_days / HALF_LIFE_DAYS)
 * taking the highest-severity mention when one posting lists the concept twice
 * (a posting counts once; three security bullets in one ad are one data point).
 * A gap's score is the sum of its contributions. One fresh WEAK-band
 * deal-breaker scores 1.0, so the scale reads as "fresh, far-from-fit,
 * blocking postings".
 */

export type GapType = ScoreReport["gaps"][number]["type"];
export type GapSeverity = ScoreReport["gaps"][number]["severity"];
export type GapKind = "genuine" | "possibly_uncaptured" | "mixed";
export type GapTier = "Critical" | "High" | "Medium" | "Low";
/** skill: something to learn, build, or confirm. circumstance: location,
 *  travel, pay, level, tenure or posting-process notes; nothing to learn. */
export type GapCategory = "skill" | "circumstance";
/** Where /gaps shows a gap: confirm = mostly "possibly uncaptured" (a likely
 *  missing knowledge-base fact, the fast win); genuine = mostly real gaps;
 *  circumstance = not a skill. */
export type GapSection = "confirm" | "genuine" | "circumstance";

export interface GapInput {
  appId: string;
  company: string;
  role: string;
  status: string;
  band: MatchBand | string | null;
  /** When the report the gaps come from was written (ISO). */
  scored_at: string;
  archived?: boolean;
  gaps: ScoreReport["gaps"];
}

export interface GapOccurrence {
  appId: string;
  company: string;
  role: string;
  band: string | null;
  type: GapType;
  severity: GapSeverity;
  /** The posting's own wording. */
  requirement: string;
  clarifying_question: string | null;
  scored_at: string;
}

export interface AggregatedGap {
  /** Concept id, or the normalized requirement for an unmatched gap. */
  key: string;
  label: string;
  kind: GapKind;
  category: GapCategory;
  section: GapSection;
  score: number;
  tier: GapTier;
  /** Distinct applications that list the gap. */
  occurrences: number;
  /** Mentions by type (a posting can list the same concept twice). */
  genuine_mentions: number;
  uncaptured_mentions: number;
  /** One entry per application, newest first. */
  applications: GapOccurrence[];
  /** Clarifying questions from the "possibly uncaptured" mentions, deduplicated, newest first (at most 5). */
  questions: string[];
  first_seen: string;
  last_seen: string;
}

export interface GapReport {
  generated_at: string;
  window: { days: number; from: string; to: string };
  totals: {
    /** Scored, non-archived applications inside the window. */
    applications: number;
    applications_with_gaps: number;
    gap_mentions: number;
    distinct_gaps: number;
    by_kind: Record<GapKind, number>;
    by_tier: Record<GapTier, number>;
    excluded: { archived: number; outside_window: number };
  };
  /** Sorted by tier, then score (highest first). */
  gaps: AggregatedGap[];
}

// --- weights -----------------------------------------------------------------

/**
 * How much one posting's gaps say about the market. A WEAK fit means the gap
 * is part of why the role was far away, so it weighs fully; a STRONG fit's
 * gaps are leftovers on a role the candidate already clears, so they weigh least.
 */
export const BAND_WEIGHT: Record<MatchBand, number> = {
  WEAK: 1.0,
  DEVELOPING: 0.8,
  COMPETITIVE: 0.5,
  STRONG: 0.3,
};
const UNKNOWN_BAND_WEIGHT = 0.5;

/** The scorer's own severity call: a deal-breaker counts fully, a nice-to-have a third. */
export const SEVERITY_WEIGHT: Record<GapSeverity, number> = {
  "DEAL-BREAKER": 1.0,
  IMPORTANT: 0.6,
  "NICE-TO-HAVE": 0.3,
};
const UNKNOWN_SEVERITY_WEIGHT = 0.6;

/** A posting from 30 days ago counts half as much as one from today. */
export const HALF_LIFE_DAYS = 30;
export const DEFAULT_WINDOW_DAYS = 90;

/**
 * Fixed thresholds (not quantiles), so a tier means the same thing from week
 * to week and a thin month does not promote noise to Critical. The upper tiers
 * also need recurrence: one posting is never more than Medium, whatever its
 * score, because the report is about what the market keeps asking for.
 *   Critical: score ≥ 1.0 and ≥ 4 postings
 *   High:     score ≥ 0.6 and ≥ 3 postings
 *   Medium:   score ≥ 0.3
 *   Low:      the rest
 * For scale: three COMPETITIVE postings from this week listing the same
 * IMPORTANT gap score about 0.9; the same three postings a month old, about 0.45.
 */
export const TIER_RULES: { tier: GapTier; minScore: number; minPostings: number }[] = [
  { tier: "Critical", minScore: 1.0, minPostings: 4 },
  { tier: "High", minScore: 0.6, minPostings: 3 },
  { tier: "Medium", minScore: 0.3, minPostings: 1 },
];

const TIER_ORDER: Record<GapTier, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

export function tierFor(score: number, postings: number): GapTier {
  for (const r of TIER_RULES) if (score >= r.minScore && postings >= r.minPostings) return r.tier;
  return "Low";
}

// --- normalization -------------------------------------------------------------

/** Phrase-level synonyms, applied after lowercasing and punctuation stripping. */
const ALIASES: [RegExp, string][] = [
  [/\bcomputer science\b/g, "cs"],
  [/\bartificial intelligence\b/g, "ai"],
  [/\bmachine learning\b/g, "ml"],
  [/\blarge language models?\b/g, "llm"],
  [/\bllms\b/g, "llm"],
  [/\bproduct management\b/g, "pm"],
  [/\bproduct managers?\b/g, "pm"],
  [/\bpms\b/g, "pm"],
  [/\b(bachelors?|undergraduate|undergrad)\b/g, "bachelor"],
  [/\b(new york city|new york|nyc)\b/g, "nyc"],
  [/\bsan francisco\b/g, "sf"],
  [/\bgo to market\b/g, "gtm"],
  [/\b(yrs|year)\b/g, "years"],
  [/\bexperimentation\b/g, "experiment"],
  [/\bexperiments\b/g, "experiment"],
  [/\bfin tech\b/g, "fintech"],
  [/\be mail\b/g, "email"],
  [/\bdepartment of (defense|war)\b/g, "defense"],
];

/** Lowercase, strip accents and punctuation, collapse whitespace, apply ALIASES. */
export function normalizeGapLabel(raw: string): string {
  let s = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/\ba\/b\b/g, "ab")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  for (const [re, to] of ALIASES) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").trim();
}

/** Grouping key for a requirement no concept claims: parentheticals dropped. */
function fallbackKey(raw: string): string {
  const bare = raw.replace(/\([^)]*\)/g, " ");
  return normalizeGapLabel(bare) || normalizeGapLabel(raw);
}

// --- concept table ---------------------------------------------------------------

export interface GapConcept {
  id: string;
  label: string;
  category: GapCategory;
  /** Tested against normalizeGapLabel(requirement); any match claims the gap. */
  patterns: RegExp[];
}

/**
 * Explicit synonym groups derived from the real score reports (2026-07 to
 * 2026-11). Order matters: the first matching concept claims a gap, so narrow
 * concepts sit above the broad ones that would also match.
 */
const concept = (id: string, label: string, category: GapCategory, ...patterns: RegExp[]): GapConcept => ({
  id,
  label,
  category,
  patterns,
});

export const GAP_CONCEPTS: GapConcept[] = [
  // Circumstances first: their wording is distinctive and must not leak into skills.
  concept(
    "location",
    "Location or office attendance",
    "circumstance",
    /\b(location|relocat\w*|remote|time zone|commut\w*)\b/,
    /(?<!back )\boffice\b/,
    /(?<!data )\bresidency\b/,
    /(?<!cloud )\bhybrid\b/,
    /\bdays (a |per )?week\b/,
    /\bonsite\b(?! customer)/,
    /\bon site\b(?! customer)/,
    /\b(sf|nyc) based\b/,
  ),
  concept("travel", "Travel requirement", "circumstance", /\b\d+( \d+)? travel\b/, /\btravel \d+/),
  concept("compensation", "Compensation", "circumstance", /\b(comp|compensation|salary)\b/),
  concept(
    "level",
    "Level or title fit",
    "circumstance",
    /\b(grade fit|level fit|altitude|role level|seniority|ic role vs|ic title|vp title)\b/,
    /\b(principal|head of) level\b/,
    /\btenure at the .*level\b/,
    /\bdirector title\b/,
  ),
  concept(
    "tenure",
    "Short tenure in most recent role",
    "circumstance",
    /\btenure (stability|signal)\b/,
    /\bshort most recent tenure\b/,
    /\bsustained tenure on\b/,
  ),
  concept(
    "posting-process",
    "Posting status or application process",
    "circumstance",
    /\b(unknown employer|undisclosed|truncated|deadline|referral|rejection|rehire|competitor sensitivity)\b/,
    /\bposting freshness\b/,
    /\balready be closed\b/,
    /\brejected from\b/,
    /\bconcurrent \w+ applications\b/,
    /\bopen \w+ application\b/,
    /\bon the application\b/,
    /\bform requires\b/,
    /\bwritten answers and\b/,
    /\bwhat the .* team builds\b/,
  ),
  concept(
    "clearance",
    "Clearance, citizenship or work authorization",
    "circumstance",
    /\bsecurity (clearance|screening)\b/,
    /\bbackground check\b/,
    /\bwork authorization\b/,
    /\bcitizenship\b/,
    /\bts sci\b/,
  ),

  // Credentials and career shape.
  concept(
    "degree-technical",
    "Technical degree (CS or engineering)",
    "skill",
    /\bcs degree\b/,
    /\bbachelor .*\b(cs|engineering|technical)\b/,
    /\b(technical|quantitative) bachelor\b/,
    /\b(engineering|technical) degree\b/,
    /\btechnical quantitative degree\b/,
    /\b(cs|engineering) education\b/,
  ),
  concept("degree", "Bachelor's degree", "skill", /\bbachelor\b/),
  concept(
    "engineering-background",
    "Engineering background before product",
    "skill",
    /\bengineering background\b/,
    /\bprofessional coding\b/,
    /\bexperience as an? (mle|engineer|data scientist)\b/,
    /\bas an mle\b/,
    /\bbackground in software development\b/,
    /\byears in software engineering\b/,
  ),
  concept("chief-of-staff", "Chief of Staff title", "skill", /\bchief of staff\b/),
  concept(
    "manage-pm-team",
    "Managing PM teams (recent, at scale)",
    "skill",
    /\bmanag\w* (a |the )?pm\b/,
    /\bteam of (\w+ )?pm\b/,
    /\bpm (team|teams|managers|org\w*)\b/,
    /\bleading pm\b/,
    /\bmanaging designers\b/,
    /\bmulti team product organizations\b/,
  ),
  concept(
    "manage-technical-team",
    "Managing engineering, data or delivery teams",
    "skill",
    /\bmanage high performing technical\b/,
    /\bteam of data scientists\b/,
    /\bleading and developing customer facing (deployment|delivery)\b/,
    /\bleading (engineers|an engineering team)\b/,
    /\bdelivery team leadership\b/,
  ),

  // Hands-on technical fluency.
  concept(
    "hands-on-coding",
    "Hands-on coding (Python, Git, prototyping)",
    "skill",
    /\bpython\b/,
    /\bgit\b/,
    /\bversion control\b/,
    /\bhands on front end\b/,
  ),
  concept("sql-data", "Hands-on SQL and data analysis", "skill", /\bsql\b/, /\buse data to\b/),

  // AI and platform product depth.
  concept(
    "llm-shipped",
    "Shipped LLM or agent features to paying users, with adoption",
    "skill",
    /\bshipping llm\b/,
    /\bshipped product with demonstrated adoption\b/,
    /\bdirect ai experience\b/,
    /\bshipped ai into\b/,
    /\breal agent builder\b/,
    /\bshipped impactful products using ai\b/,
  ),
  concept(
    "model-training",
    "Model training and fine-tuning",
    "skill",
    /\bfine tuning\b/,
    /\bpost training\b/,
    /\bannotation pipelines\b/,
    /\bcustom model\b/,
  ),
  concept("llm-gateway", "LLM gateway and model routing", "skill", /\bllm gateway\b/, /\bmodel routing\b/, /\brouter\b/),
  concept(
    "ai-cost",
    "AI cost and unit economics",
    "skill",
    /\bunit economics\b/,
    /\bai cost\b/,
    /\bspend data\b/,
    /\bfinops\b/,
    /\bcloud cost\b/,
    /\bthroughput economics\b/,
    /\bcost tracking\b/,
  ),
  concept(
    "ml-infra",
    "ML serving and training infrastructure",
    "skill",
    /\bml (serving|platform)\b/,
    /\bserving inference\b/,
    /\bgpu scheduling\b/,
    /\binference pipelines\b/,
    /\bopen weight\b/,
    /\bmodel registry\b/,
  ),
  concept(
    "developer-platform",
    "Developer platforms and tools",
    "skill",
    /\bdeveloper (platform|tools|tooling|experience|authoring|facing|workflows|productivity)\b/,
    /\binternal (developer|platforms)\b/,
    /\bdevops (tooling|workflows)\b/,
    /\bplatforms? serving (internal|multiple internal)\b/,
    /\bcloud platform\b/,
    /\bsdlc\b/,
    /\bhow engineering teams build\b/,
    /\bai (code review|coding tools)\b/,
    /\bwith developers\b/,
  ),
  concept(
    "observability",
    "Observability and AI operations (monitoring, tracing, versioning)",
    "skill",
    /\bobservability\b/,
    /\bdrift monitoring\b/,
    /\bfleet oversight\b/,
    /\bprompt management\b/,
    /\btraceability\b/,
  ),
  concept(
    "agent-platform",
    "Agent-building platforms and authoring surfaces",
    "skill",
    /\bbuild and deploy agents\b/,
    /\bagent runtime\b/,
    /\blow code\b/,
    /\bauthoring (tools|surfaces)\b/,
    /\bagent (identity|memory)\b/,
    /\bautonomy ladder\b/,
    /\bprototype of an agent\b/,
  ),
  concept(
    "internal-ai-enablement",
    "Internal AI enablement for business teams",
    "skill",
    /\benterprise ai (strategy|tool portfolio)\b/,
    /\bcompanys own employees\b/,
    /\benterprise agents\b/,
  ),

  // Commercial and go-to-market.
  concept(
    "thought-leadership",
    "External thought leadership and speaking",
    "skill",
    /\bthought leadership\b/,
    /\bconferences and webinars\b/,
    /\bpublic speaking\b/,
  ),
  concept(
    "domain-marketing",
    "Marketing, ad tech and lifecycle messaging",
    "skill",
    /\bmarketing\b/,
    /\bad tech\b/,
    /\badtech\b/,
    /\bmarketer facing\b/,
    /\babm\b/,
    /\bconversion and merchandising\b/,
    /\battribution systems\b/,
  ),
  concept(
    "domain-health",
    "Health, life sciences and medical domain",
    "skill",
    /\b(health|healthcare|medical|wellness|physiology|wearables|clinical|ehr|emr|pharma\w*|biopharma|life sciences)\b/,
  ),
  concept(
    "search-personalization",
    "Search, ranking and personalization",
    "skill",
    /\bsearch\b/,
    /\bpersonaliz\w+\b/,
    /\brecommendations?\b/,
    /\b(personalized ranking|ranking query)\b/,
  ),
  concept("experimentation", "Experimentation and A/B testing", "skill", /\bexperiment\b/, /\bab test\w*\b/, /\bab and multivariate\b/),
  concept(
    "data-infrastructure",
    "Data infrastructure and pipelines",
    "skill",
    /\bdata (infrastructure|architecture|architectures|platform|platforms|warehousing)\b/,
    /\betl\b/,
    /\bstorage analytics databases\b/,
    /\binfra data ai products\b/,
  ),
  concept("analytics-products", "Analytics products", "skill", /\banalytics (domain|products)\b/),
  concept(
    "cloud-infrastructure",
    "Cloud and infrastructure platforms",
    "skill",
    /\b(aws|azure|gcp) cloud\b/,
    /\bmulti cloud\b/,
    /\bkubernetes\b/,
    /\bcontainer\w*\b/,
    /\bhpc\b/,
    /\benterprise storage\b/,
    /\bprivate cloud\b/,
    /\bnetwork infrastructure\b/,
  ),
  concept("workflow-automation", "Workflow automation products", "skill", /\bworkflow automation\b/, /\bitsm\b/),
  concept("pricing", "Pricing and packaging", "skill", /\bpricing\b/),
  concept(
    "si-partners",
    "System-integrator and partner ecosystems",
    "skill",
    /\bsystem(s)? integrators\b/,
    /\b(delivery|distribution) partners\b/,
    /\bpartner (enablement|motion)\b/,
    /\bpartner led\b/,
    /\bco sell\b/,
    /\bresellers\b/,
    /\bsis\b/,
    /\bmsp\b/,
  ),
  concept(
    "sales-revenue",
    "Sales and revenue ownership",
    "skill",
    /\bpre sales\b/,
    /\bwinning first customers\b/,
    /\bwin the business\b/,
    /\bsat in deals\b/,
    /\bcommission\b/,
    /\bdemos to customers\b/,
    /\badvisory boards qbrs\b/,
    /\brevenue book\b/,
    /\benterprise (sales support|deals)\b/,
    /\bproof of value\b/,
    /\bsales operations\b/,
  ),
  concept(
    "enterprise-deployment",
    "Customer-facing enterprise deployment",
    "skill",
    /\benterprise (deployment|technology deployments)\b/,
    /\bcustomer (facing )?deployment\b/,
    /\bcustomer adoption\b/,
    /\bfor enterprise customers\b/,
    /\benterprise account ownership\b/,
    /\bexternal enterprise customers\b/,
    /\binside customer operations\b/,
    /\bprocess mapping\b/,
    /\bchampion networks\b/,
    /\bat risk engagements\b/,
    /\bconsumption and revenue timing\b/,
    /\bforward deployed\b/,
    /\bimplementation delivery\b/,
    /\bgrowth accounts\b/,
    /\brenewals\b/,
  ),
  concept("startup-operating", "Recent startup operating experience", "skill", /\bstartup\b/),
  concept(
    "consulting",
    "Consulting or professional-services background",
    "skill",
    /\bconsulting\b/,
    /\bprofessional services\b/,
    /\bbillable economics\b/,
    /\binvestment banking\b/,
  ),
  concept(
    "portfolio-budget",
    "Portfolio, budget and executive reporting",
    "skill",
    /\bportfolio (management|planning|allocation)\b/,
    /\bbudget planning\b/,
    /\breporting mechanisms\b/,
    /\bboard trust\b/,
    /\bvalue cases\b/,
    /\bbusiness cases\b/,
    /\binvestment planning\b/,
    /\bprocurement vendor management\b/,
    /\bfinancial analyst day\b/,
    /\bpmo\b/,
    /\bcfo\b/,
    /\b(platform|use case) portfolio\b/,
    /\bconcurrent projects\b/,
  ),

  // Domains.
  concept(
    "domain-security",
    "Cybersecurity and identity domain",
    "skill",
    /\bcyber\w*\b/,
    /\bsecurity (product|products|teams|buyers|capabilities|and governance)\b/,
    /\b(enterprise|cloud|account|offensive) security\b/,
    /\bred teaming\b/,
    /\bml security\b/,
    /\b(identity|authentication|auth|passkeys|passwordless|vulnerability)\b/,
  ),
  concept(
    "compliance",
    "Compliance, governance and security reviews",
    "skill",
    /\b(soc 2|iso \d+|hipaa|grc|governance)\b/,
    /\bcompliance teams\b/,
    /\bsecurity review\b/,
    /\bquality management systems\b/,
  ),
  concept("domain-government", "Government, defense and public sector", "skill", /\b(government|public sector|public safety|defense)\b/),
  concept(
    "domain-finance",
    "Financial services and fintech domain",
    "skill",
    /\bfintech\b/,
    /\b(wealth|asset management|investing)\b/,
    /\bfinancial (services|advisor|advisory|modeling|products)\b/,
    /\b(banking|lending|mortgage|insurance|underwriting|fund administration|private markets|payments?|payroll|hedge fund|public equity|pe vc)\b/,
    /\btax finance\b/,
  ),
  concept(
    "domain-back-office",
    "Back-office systems (ERP, HR, finance ops, CRM)",
    "skill",
    /\berp\b/,
    /\bcrm\b/,
    /\bbusiness (operations )?systems\b/,
    /\bworkforce management\b/,
    /\bgtm tool stack\b/,
  ),
  concept("domain-hr-tech", "HR tech and recruiting domain", "skill", /\bhr tech\b/, /\brecruiting\b/, /\bhr benefits\b/, /\btalent software\b/),
  concept(
    "domain-science",
    "Science or research-organization background",
    "skill",
    /\bhard science\b/,
    /\bresearch organization\b/,
    /\bml research\b/,
    /\bscientific workflow\b/,
  ),
  concept(
    "domain-media-creative",
    "Media, entertainment and creative tools",
    "skill",
    /\bmedia\b/,
    /\bcreative (teams|tools|professionals)\b/,
    /\bcreators?\b/,
    /\bcreator economy\b/,
  ),
  concept(
    "realtime-comms",
    "Real-time communications and telephony",
    "skill",
    /\b(rtc|real time comm\w*|telephony)\b/,
    /\bcommunications messaging products\b/,
  ),
  concept("contact-center", "Contact-center domain", "skill", /\bcontact center\b/, /\bccaas\b/, /\bagent assist\b/),
  concept("speech-voice", "Speech and voice pipelines (ASR, VAD)", "skill", /\b(asr|vad|diarization|speech|voice shipping)\b/),
  concept("domain-email", "Email and messaging infrastructure", "skill", /\bemail\b/, /\bmessage delivery\b/, /\bmessaging platforms\b/),
  concept(
    "mobile",
    "Native mobile apps (iOS, Android)",
    "skill",
    /\b(ios|android|native mobile|mobile app|mobile applications)\b/,
  ),
  concept(
    "ux-design",
    "UX and product design craft",
    "skill",
    /\b(ux|figma|interaction design|design craft|design lead|hci|design systems)\b/,
  ),
  concept(
    "marketplace",
    "Two-sided marketplaces and network effects",
    "skill",
    /\btwo sided\b/,
    /\bmarketplace (product|dynamics|ownership|domain)\b/,
    /\b(consumer|search or) marketplace\b/,
    /\bnetwork effects\b/,
    /\bgmv\b/,
  ),
  concept(
    "consumer-growth",
    "Consumer product and growth mechanics",
    "skill",
    /\bconsumer (product|grade|subscription|facing|growth|social|or prosumer)\b/,
    /\blarge scale consumer\b/,
    /\bproduct led growth\b/,
    /\bplg\b/,
    /\bself serve\b/,
    /\bdirect to consumer\b/,
    /\bactivation retention\b/,
  ),
  concept(
    "collaboration",
    "Collaboration and productivity software",
    "skill",
    /\bcollaboration software\b/,
    /\bproductivity (software|saas)\b/,
    /\b(collaboration or productivity|productivity collaboration)\b/,
    /\bmultiplayer\b/,
    /\b(microsoft 365|atlassian ecosystem|calendar integration|appointment scheduling|google workspace|scheduling)\b/,
  ),
  concept("open-source", "Open-source ecosystems", "skill", /\bopen source\b/),
  concept("domain-energy", "Energy and utilities domain", "skill", /\b(energy|utilities)\b/),
  concept("domain-retail", "Retail and consumer-brand domain", "skill", /\bretail\b/),
  concept("embedded-hardware", "Embedded, firmware and hardware products", "skill", /\b(embedded|firmware|hardware|on device)\b/),
  concept(
    "pm-frameworks",
    "Named PM frameworks and tools (Jira, JTBD, canvases)",
    "skill",
    /\b(jira|jtbd|continuous discovery|canvas|named tool|product owner cadence|user stories|nfr slo)\b/,
  ),
  concept(
    "structured-data",
    "Knowledge graphs and structured data",
    "skill",
    /\b(knowledge graph|structured data|metadata systems)\b/,
  ),
  concept("legal-tech", "Legal-tech specifics (CLM, e-discovery)", "skill", /\b(clm|e discovery|contract clause)\b/),
  concept("trust-safety", "Trust and safety", "skill", /\btrust and safety\b/, /\bsafety domain\b/),
  concept("education", "Education sector", "skill", /\beducation sector\b/, /\bcertification assessment\b/),
  // Last: a years bar only claims what no topic above did.
  concept(
    "years-pm",
    "Years of PM experience",
    "skill",
    /^\d+( \d+)? years (of )?(related )?(experience|pm)\b/,
    /^\d+ years in b2b saas pm\b/,
  ),
];

/** The concept that claims a requirement, or null when none does. */
export function matchConcept(requirement: string): GapConcept | null {
  const n = normalizeGapLabel(requirement);
  return GAP_CONCEPTS.find((c) => c.patterns.some((p) => p.test(n))) ?? null;
}

// --- aggregation -----------------------------------------------------------------

const DAY_MS = 86_400_000;

export interface GapReportOptions {
  /** Window in days, counted back from `now` (default 90). */
  days?: number;
  /** Reference time (default: the current time). */
  now?: Date;
  includeArchived?: boolean;
}

function bandWeight(band: string | null): number {
  return band && band in BAND_WEIGHT ? BAND_WEIGHT[band as MatchBand] : UNKNOWN_BAND_WEIGHT;
}
function severityWeight(sev: string): number {
  return sev in SEVERITY_WEIGHT ? SEVERITY_WEIGHT[sev as GapSeverity] : UNKNOWN_SEVERITY_WEIGHT;
}
/** 1 today, 0.5 at HALF_LIFE_DAYS, never above 1 for future-dated reports. */
export function recencyDecay(scoredAt: string, now: Date): number {
  const t = Date.parse(scoredAt);
  if (Number.isNaN(t)) return 0;
  const age = Math.max(0, (now.getTime() - t) / DAY_MS);
  return Math.pow(0.5, age / HALF_LIFE_DAYS);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

interface Bucket {
  key: string;
  label: string;
  category: GapCategory;
  /** appId → the strongest mention for that posting. */
  byApp: Map<string, { occ: GapOccurrence; weight: number }>;
  genuine: number;
  uncaptured: number;
  questions: { q: string; at: string }[];
}

/** Mostly-uncaptured gaps go to "confirm" (a tie counts as confirm: one KB fact may close it). */
export function sectionFor(category: GapCategory, genuine: number, uncaptured: number): GapSection {
  if (category === "circumstance") return "circumstance";
  return uncaptured > 0 && uncaptured >= genuine ? "confirm" : "genuine";
}

export function buildGapReport(inputs: GapInput[], opts: GapReportOptions = {}): GapReport {
  const now = opts.now ?? new Date();
  const days = opts.days && opts.days > 0 ? opts.days : DEFAULT_WINDOW_DAYS;
  const from = new Date(now.getTime() - days * DAY_MS);

  let archived = 0;
  let outside = 0;
  const inWindow: GapInput[] = [];
  for (const a of inputs) {
    if (a.archived && !opts.includeArchived) {
      archived++;
      continue;
    }
    const t = Date.parse(a.scored_at);
    if (Number.isNaN(t) || t < from.getTime()) {
      outside++;
      continue;
    }
    inWindow.push(a);
  }

  const buckets = new Map<string, Bucket>();
  let mentions = 0;
  let withGaps = 0;
  for (const a of inWindow) {
    const gaps = Array.isArray(a.gaps) ? a.gaps.filter((g) => g && typeof g.requirement === "string" && g.requirement.trim()) : [];
    if (gaps.length) withGaps++;
    const appWeight = bandWeight(a.band) * recencyDecay(a.scored_at, now);
    for (const g of gaps) {
      mentions++;
      const concept = matchConcept(g.requirement);
      const key = concept ? concept.id : fallbackKey(g.requirement);
      let b = buckets.get(key);
      if (!b) {
        b = {
          key,
          label: concept ? concept.label : g.requirement.trim(),
          category: concept ? concept.category : "skill",
          byApp: new Map(),
          genuine: 0,
          uncaptured: 0,
          questions: [],
        };
        buckets.set(key, b);
      }
      if (g.type === "possibly_uncaptured") {
        b.uncaptured++;
        const q = g.clarifying_question?.trim();
        if (q) b.questions.push({ q, at: a.scored_at });
      } else b.genuine++;
      const weight = appWeight * severityWeight(g.severity);
      const prev = b.byApp.get(a.appId);
      if (!prev || weight > prev.weight) {
        b.byApp.set(a.appId, {
          weight,
          occ: {
            appId: a.appId,
            company: a.company,
            role: a.role,
            band: a.band ?? null,
            type: g.type,
            severity: g.severity,
            requirement: g.requirement,
            clarifying_question: g.clarifying_question ?? null,
            scored_at: a.scored_at,
          },
        });
      }
    }
  }

  const gaps: AggregatedGap[] = [...buckets.values()].map((b) => {
    const entries = [...b.byApp.values()];
    const score = round2(entries.reduce((s, e) => s + e.weight, 0));
    const apps = entries.map((e) => e.occ).sort((x, y) => y.scored_at.localeCompare(x.scored_at));
    const dates = apps.map((o) => o.scored_at).sort();
    const kind: GapKind = b.uncaptured === 0 ? "genuine" : b.genuine === 0 ? "possibly_uncaptured" : "mixed";
    return {
      key: b.key,
      label: b.label,
      kind,
      category: b.category,
      section: sectionFor(b.category, b.genuine, b.uncaptured),
      score,
      tier: tierFor(score, apps.length),
      occurrences: apps.length,
      genuine_mentions: b.genuine,
      uncaptured_mentions: b.uncaptured,
      applications: apps,
      questions: [...new Set([...b.questions].sort((x, y) => y.at.localeCompare(x.at)).map((x) => x.q))].slice(0, 5),
      first_seen: dates[0],
      last_seen: dates[dates.length - 1],
    };
  });
  // Tier first (it carries the recurrence floor), then score within a tier.
  gaps.sort(
    (x, y) =>
      TIER_ORDER[x.tier] - TIER_ORDER[y.tier] ||
      y.score - x.score ||
      y.occurrences - x.occurrences ||
      x.label.localeCompare(y.label),
  );

  const by_kind: Record<GapKind, number> = { genuine: 0, possibly_uncaptured: 0, mixed: 0 };
  const by_tier: Record<GapTier, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const g of gaps) {
    by_kind[g.kind]++;
    by_tier[g.tier]++;
  }

  return {
    generated_at: now.toISOString(),
    window: { days, from: from.toISOString(), to: now.toISOString() },
    totals: {
      applications: inWindow.length,
      applications_with_gaps: withGaps,
      gap_mentions: mentions,
      distinct_gaps: gaps.length,
      by_kind,
      by_tier,
      excluded: { archived, outside_window: outside },
    },
    gaps,
  };
}

/**
 * The same aggregate, trimmed for an MCP response (the full JSON for 90 days
 * runs past 150 KB): requirement wording is dropped (the label carries it),
 * each posting becomes one short line, clarifying questions ride along only on
 * "confirm" gaps (at most two), and Low-tier and circumstance gaps keep their
 * headline numbers without the posting list.
 */
export function compactGapReport(report: GapReport) {
  const QUESTION_MAX = 300;
  return {
    generated_at: report.generated_at,
    window: report.window,
    totals: report.totals,
    scoring: {
      contribution:
        "band_weight × severity_weight × 0.5^(age_days / half_life_days), strongest mention per posting, summed per gap",
      band_weight: BAND_WEIGHT,
      severity_weight: SEVERITY_WEIGHT,
      half_life_days: HALF_LIFE_DAYS,
      tiers: TIER_RULES,
    },
    gaps: report.gaps.map((g) => {
      const head = {
        label: g.label,
        kind: g.kind,
        section: g.section,
        tier: g.tier,
        score: g.score,
        postings: g.occurrences,
      };
      if (g.tier === "Low" || g.section === "circumstance") return head;
      return {
        ...head,
        mentions: { genuine: g.genuine_mentions, possibly_uncaptured: g.uncaptured_mentions },
        first_seen: g.first_seen.slice(0, 10),
        last_seen: g.last_seen.slice(0, 10),
        applications: g.applications.map(
          (o) => `${o.appId} | ${o.band ?? "?"} | ${o.type === "possibly_uncaptured" ? "uncaptured" : "genuine"} ${o.severity}`,
        ),
        ...(g.section === "confirm" && g.questions.length
          ? { questions: g.questions.slice(0, 2).map((q) => (q.length > QUESTION_MAX ? `${q.slice(0, QUESTION_MAX - 1)}…` : q)) }
          : {}),
      };
    }),
  };
}
