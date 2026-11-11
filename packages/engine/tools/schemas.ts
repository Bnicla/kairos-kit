import { z } from "zod";

/**
 * Runtime schemas for the model-authored artifacts. `lib/types.ts` is erased at
 * compile time, so these are the ONLY shape enforcement at the save boundary —
 * every save path (MCP tool, script, future cloud agent) must go through
 * lib/tools/ops.ts, which parses with these before anything touches disk.
 */

export const MatchBandSchema = z.enum(["STRONG", "COMPETITIVE", "DEVELOPING", "WEAK"]);

export const ScoreReportSchema = z.object({
  parse_safety: z.object({
    verdict: z.enum(["PASS", "ISSUES_FOUND"]),
    checks: z.array(
      z.object({
        rule: z.string(),
        result: z.enum(["PASS", "FAIL", "UNKNOWN"]),
        detail: z.string(),
      }),
    ),
    ats_specific_note: z.string(),
  }),
  match: z.object({
    detected_ats: z.string(),
    dimensions: z
      .array(z.object({ name: z.string(), score: z.number().min(0).max(100), justification: z.string() }))
      .min(1),
    overall_band: MatchBandSchema,
    confidence: z.enum(["high", "medium", "low"]),
    // N2: bands need the honest framing; an empty caveat is a rubric violation.
    pool_caveat: z.string().min(20),
  }),
  authenticity: z.object({
    score: z.number().min(0).max(100),
    flags: z.array(z.object({ issue: z.string(), detail: z.string(), where: z.string() })),
    strengths: z.array(z.string()),
  }),
  gaps: z.array(
    z.object({
      requirement: z.string(),
      severity: z.enum(["DEAL-BREAKER", "IMPORTANT", "NICE-TO-HAVE"]),
      type: z.enum(["genuine_gap", "possibly_uncaptured"]),
      clarifying_question: z.string().nullable(),
    }),
  ),
  reachable: z.object({
    band_if_tailored: MatchBandSchema,
    from_reframing: z.array(z.string()),
    needs_user_confirmation: z.array(z.string()),
    honest_ceiling_note: z.string(),
  }),
  recommendation: z.enum(["APPLY", "APPLY_AFTER_TAILORING", "STRETCH", "NOT_RECOMMENDED"]),
});

export type ScoreReportParsed = z.infer<typeof ScoreReportSchema>;

/**
 * Requirements coverage row. `evidence`/`note` accept null as well as absence
 * (models often emit null for an empty field). Whether a covered/partial row's
 * evidence is really on the résumé is checked at save time, not here.
 */
export const RequirementCoverageRowSchema = z.object({
  requirement: z.string().min(1),
  priority: z.enum(["required", "preferred"]),
  status: z.enum(["covered", "partial", "gap"]),
  evidence: z.string().nullish(),
  note: z.string().nullish(),
});

export const GeneratedResumeSchema = z.object({
  resume: z.object({
    header: z.object({ name: z.string().min(1), contact: z.string().min(1) }),
    executive_summary: z.string().min(1),
    experience: z
      .array(
        z.object({
          company: z.string().min(1),
          title: z.string().min(1),
          location: z.string().optional(),
          dates: z.string().min(4),
          summary: z.string().optional(),
          bullets: z.array(z.string().min(1)).min(1),
          // Force this role to start a new page (a real docx page break before
          // it), so a designated role opens cleanly at the top of page 2.
          page_break_before: z.boolean().optional(),
        }),
      )
      .min(1),
    education: z.array(z.object({ institution: z.string(), credential: z.string(), dates: z.string().optional() })),
    skills: z.array(z.string()),
  }),
  // One claim, one source, one provenance token. "R/C" or "05/06/07" composites
  // defeat the audit's purpose and are rejected here.
  provenance_audit: z
    .array(
      z.object({
        claim: z.string().min(1),
        source_experience: z.string().min(1),
        prov: z.enum(["R", "C", "F"]),
      }),
    )
    .min(1),
  voice_notes: z.string().optional(),
  tailoring_notes: z.string().optional(),
  honest_ceiling_note: z.string().optional(),
  dropped_for_relevance: z.array(z.string()).optional(),
  // Optional for backward compatibility with résumés saved before it existed.
  requirement_coverage: z.array(RequirementCoverageRowSchema).optional(),
});

export type GeneratedResumeParsed = z.infer<typeof GeneratedResumeSchema>;

/** Format zod issues into a short, actionable message for the model/operator. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
