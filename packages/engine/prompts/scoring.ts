import type { Experience } from "@kairos/engine/kb/types";
import type { TrackGuidance } from "@kairos/engine/tracks";
import { stripUnverified } from "@kairos/engine/kb/experience";
import { serializeExperience } from "@kairos/engine/kb/experience";
import { UNTRUSTED_AD_NOTICE } from "@kairos/engine/posting-guard";

/**
 * The ATS scoring engine — system prompt is used VERBATIM from
 * ats-scoring-engine-v1.md (§7/§16). Do not paraphrase; the wording is calibrated.
 */
export const SCORING_SYSTEM_PROMPT = `You are an ATS evaluation engine that simulates how modern applicant tracking systems and professional recruiters assess a candidate against a specific job, in 2026. You are rigorous, honest, and calibrated. You never inflate scores, never invent candidate facts, and never present false precision.

You evaluate on THREE INDEPENDENT AXES. Keep them strictly separate.

**AXIS 1 — PARSE-SAFETY (deterministic, authoritative).**
Assess whether the resume will parse cleanly IN THE DETECTED ATS for THIS role — not as a generic checklist. Ground every check in how the named ATS actually ingests and matches (e.g. Greenhouse/Lever build a structured profile from the file and do semantic matching; Taleo/iCIMS do Boolean exact-match and prefer .docx; Workday weights the current title heavily), and in this candidate's real resume — reference the actual sections, titles, and dates and whether they surface the role-relevant material to the parser. Lead with a one-line ATS-specific note. Then report the handful of checks that genuinely matter for this ATS + this resume as PASS/FAIL/UNKNOWN with a specific reason; skip boilerplate that doesn't affect this posting. You MAY state these with confidence — they are rule-based.

**AXIS 2 — MATCH (probabilistic, directional).**
Estimate alignment between the candidate's real, provided experience and the job requirements. You are given the detected ATS; calibrate accordingly:
- Workday: weight current job-title match to the target title very heavily; penalize multi-column.
- Greenhouse: recruiter reads the actual PDF; structured profile matters; semantic matching is capable.
- Lever: recruiter acts on the parsed profile first; parse fidelity is critical; semantic matching capable.
- Taleo / iCIMS: Boolean exact-match dominates; exact keyword strings matter more than synonyms; prefers .docx.
- unknown: assume a modern semantic matcher but reward exact-string coverage too.
Score these dimensions, each 0–100 with a one-line justification grounded ONLY in provided facts: hard-skills match, job-title/seniority match, domain/industry relevance, keyword+semantic coverage, achievement alignment, education/certification match, soft-skills-with-evidence.
Then produce an OVERALL MATCH as a BAND, never a single false-precise number: STRONG (broadly exceeds), COMPETITIVE (meets core bar, some gaps), DEVELOPING (meaningful gaps), WEAK (missing core requirements). Attach a confidence: high/medium/low. ALWAYS include the caveat that true ranking depends on the applicant pool, which is unknowable.

**AXIS 3 — AUTHENTICITY (pattern-based, detector-aware).**
Assess how the candidate's material reads against 2026 AI-content detectors and recruiter skepticism. Flag: buzzword clustering (e.g. spearheaded/orchestrated/synergized together), uniform section depth, generic superlatives without evidence, GPT-default cadence, claims lacking specific/contextual grounding. Reward specificity, real metrics, and consistency with the candidate's own voice profile. Score 0–100 where high = reads as authentically human and specific. This axis exists to prevent a high match score from producing an auto-rejected, robotic-sounding resume.

**GAP ANALYSIS.**
List the specific requirements the candidate does not currently evidence. For each: severity (DEAL-BREAKER / IMPORTANT / NICE-TO-HAVE), and whether it looks like (a) a genuine gap, or (b) possibly-present-but-not-yet-captured (a knowledge-base gap we should ask the user about). NEVER invent experience to close a gap.

**REACHABLE ESTIMATE.**
State what the match band could HONESTLY become IF (a) the resume is tailored using existing real evidence, and (b) the "possibly-present-but-not-captured" items are confirmed by the user. Do not assume unconfirmed facts. Be explicit about which improvements are "reframing existing evidence" vs. "needs user to confirm new facts."

**HONESTY RULES (override everything).**
- Never output a single fake-precise overall percentage. Use bands.
- Never use a candidate fact not present in the input.
- If the candidate is a weak fit, say so plainly — recommending against applying is a valid, valuable output.
- Ground every dimension score in a specific provided fact or its absence.

Output valid JSON matching the OUTPUT CONTRACT exactly. No prose outside the JSON.`;

export interface ScoringInput {
  jobText: string;
  detectedAts: string;
  sourceUrl?: string;
  experiences: Experience[];
  educationRaw: string[];
  voiceProfile: string | null;
  recruiterFeedback: string | null;
  mode: "audit" | "match";
  /**
   * Candidate-stated profile facts that are not in any experience file
   * (languages, work authorization, home location). Without them the scorer
   * flags a stated language or citizenship as unconfirmed.
   */
  /** The application's track (direction); positioning only, never facts. */
  track?: TrackGuidance | null;
  profileFacts?: { languages?: string[]; work_authorization?: string; location?: string; relocation?: string } | null;
}

/** Pull the scoring-relevant facts out of profile.md frontmatter. */
export function profileFactsFrom(fm: Record<string, unknown> | null | undefined): ScoringInput["profileFacts"] {
  if (!fm) return null;
  const prefs = (fm.preferences ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const languages = Array.isArray(fm.languages) ? fm.languages.filter((l): l is string => typeof l === "string") : undefined;
  const relocation = str(prefs.relocation);
  const facts = {
    languages,
    work_authorization: str(prefs.work_authorization),
    location: str(prefs.location),
    ...(relocation ? { relocation } : {}),
  };
  return facts.languages?.length || facts.work_authorization || facts.location || relocation ? facts : null;
}

/**
 * Assemble the user message payload for the scoring call. Strips all `[?]` facts
 * from every experience first — the scorer never sees unverified claims.
 */
export function buildScoringUserMessage(input: ScoringInput): string {
  const cleanedExperiences = input.experiences
    .map(stripUnverified)
    .map(serializeExperience);

  const payload = {
    job: {
      raw_text: input.jobText,
      detected_ats: input.detectedAts,
      source_url: input.sourceUrl,
    },
    candidate: {
      experiences: cleanedExperiences,
      voice_profile: input.voiceProfile ?? "",
      education: input.educationRaw,
      recruiter_feedback: input.recruiterFeedback ?? "",
      ...(input.profileFacts ? { profile_facts: input.profileFacts } : {}),
    },
    ...(input.track ? { track_guidance: input.track } : {}),
    mode: input.mode,
  };

  return [
    "Score this candidate against this job. Return ONLY the JSON matching the OUTPUT CONTRACT.",
    "",
    UNTRUSTED_AD_NOTICE,
    "INPUT:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
    "OUTPUT CONTRACT (return exactly this shape):",
    OUTPUT_CONTRACT,
  ].join("\n");
}

const OUTPUT_CONTRACT = `{
  "parse_safety": { "verdict": "PASS | ISSUES_FOUND", "checks": [ { "rule": "single_column", "result": "PASS|FAIL|UNKNOWN", "detail": "..." } ], "ats_specific_note": "..." },
  "match": { "detected_ats": "...", "dimensions": [ { "name": "hard_skills", "score": 0, "justification": "..." }, { "name": "title_seniority", "score": 0, "justification": "..." }, { "name": "domain_relevance", "score": 0, "justification": "..." }, { "name": "keyword_semantic_coverage", "score": 0, "justification": "..." }, { "name": "achievement_alignment", "score": 0, "justification": "..." }, { "name": "education_certs", "score": 0, "justification": "..." }, { "name": "soft_skills_evidence", "score": 0, "justification": "..." } ], "overall_band": "STRONG | COMPETITIVE | DEVELOPING | WEAK", "confidence": "high | medium | low", "pool_caveat": "..." },
  "authenticity": { "score": 0, "flags": [ { "issue": "...", "detail": "...", "where": "..." } ], "strengths": [ "..." ] },
  "gaps": [ { "requirement": "...", "severity": "DEAL-BREAKER | IMPORTANT | NICE-TO-HAVE", "type": "genuine_gap | possibly_uncaptured", "clarifying_question": "..." } ],
  "reachable": { "band_if_tailored": "STRONG | COMPETITIVE | DEVELOPING | WEAK", "from_reframing": [ "..." ], "needs_user_confirmation": [ "..." ], "honest_ceiling_note": "..." },
  "recommendation": "APPLY | APPLY_AFTER_TAILORING | STRETCH | NOT_RECOMMENDED"
}`;
