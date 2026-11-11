/**
 * Workspace chat system prompt (§17 two-panel, §22 learning loop). Governs the
 * conversational assistant that helps refine a resume in-context. It must respect
 * anti-fabrication: if the user states a NEW fact, it proposes confirming it into
 * the knowledge base rather than silently using it.
 */
export function buildChatSystemPrompt(ctx: {
  company: string;
  title: string;
  focusedSection?: string;
  voiceProfile: string | null;
}): string {
  return `You are Kairos, an authenticity-preserving resume assistant, helping a candidate tailor their REAL experience for a specific job: ${ctx.title} at ${ctx.company}.

RULES:
- Never fabricate facts (metrics, titles, dates, scope, employers, skills). Only use what the candidate has actually told you or what's in their knowledge base.
- If the candidate mentions a NEW concrete fact, do not silently bake it into the resume. Acknowledge it and tell them it will be saved to their knowledge base once they confirm it (facts require explicit confirmation).
- When rewriting a bullet or section, preserve the candidate's voice; avoid power-verb clustering (spearheaded/orchestrated/pioneered together) and generic GPT-default phrasing. Keep real numbers exactly.
- Be concise and concrete. When you propose new bullet text, wrap the exact proposed text in a line starting with "PROPOSED:" so the app can offer it as an inline edit.
${ctx.focusedSection ? `\nThe candidate is currently focused on this section/bullet:\n"""${ctx.focusedSection}"""\nKeep your help scoped to it unless they broaden the topic.` : "\nYou are in global mode (whole-document help)."}
${ctx.voiceProfile ? `\nCandidate voice profile (honor it):\n${ctx.voiceProfile.slice(0, 2000)}` : ""}`;
}

/**
 * Heuristic fact detector for the learning loop (§22). Flags when a user message
 * likely asserts a new concrete fact (metric/date/scope) that should be routed to
 * explicit confirmation rather than silently used. Deterministic pre-filter; the
 * actual confirmation is always user-driven.
 */
export function looksLikeNewFact(message: string): boolean {
  const factSignals = [
    /\b\d+%/, // percentages
    /\$\s?\d/, // dollar amounts
    /\b\d{4}\b/, // years
    /\bteam of \d+/i,
    /\b\d+\s*(users|customers|markets|people|reports|engineers)\b/i,
    /\bI (led|managed|owned|built|launched|grew|reduced|increased)\b/i,
  ];
  return factSignals.some((re) => re.test(message));
}
