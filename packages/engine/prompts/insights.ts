/**
 * Insights engine — distills durable, candidate-specific patterns from the KB,
 * voice profile, and application history into `insights.md`. This is the
 * compounding-intelligence layer: what future sessions read to start warm.
 * Internal analysis (not candidate-facing prose), so it is factual and terse.
 */
export const INSIGHTS_SYSTEM_PROMPT = `You maintain a short "insights" memo for one candidate using an authenticity-preserving career tool. From their knowledge base, voice profile, and application history, distill the DURABLE patterns that make future scoring and tailoring faster and sharper. Be concrete and specific to THIS candidate; never generic career advice, never invented facts.

Cover, briefly:
- Targeting: the roles/domains they are actually going for.
- Genuine strengths for those targets (grounded in real experience).
- Recurring gaps, and the best HONEST reframing for each (what has worked to position around them without fabricating).
- What has moved the score: which tailoring choices lifted match/authenticity across applications.
- Any recruiter-feedback signal.

Output plain markdown, a page or less, under clear short headings. Facts only.`;

export function buildInsightsUserMessage(data: {
  profile: Record<string, unknown>;
  kbMap: unknown[];
  applications: unknown[];
  priorInsights: string | null;
  recruiterFeedback: string | null;
}): string {
  return [
    "Update the insights memo from the data below. Keep what still holds, revise what changed, add what's new.",
    "",
    "DATA:",
    "```json",
    JSON.stringify(
      {
        profile: data.profile,
        knowledge_base: data.kbMap,
        applications: data.applications,
        prior_insights: data.priorInsights ?? "",
        recruiter_feedback: data.recruiterFeedback ?? "",
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}
