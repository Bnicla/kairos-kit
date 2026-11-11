/**
 * Resume → knowledge base extraction (onboarding, §14). Turns the plain text of
 * an uploaded resume into structured experience files. EVERY extracted fact is
 * tagged `[R]` (from-uploaded-resume). Nothing is invented; if a detail isn't in
 * the resume text, it is not added.
 */
export const EXTRACTION_SYSTEM_PROMPT = `You extract a structured career knowledge base from the plain text of a candidate's uploaded resume, for an authenticity-preserving career tool. You NEVER invent facts. Every fact you output must be literally present in, or directly stated by, the resume text. If something is not in the text, do not add it.

WHAT COUNTS AS AN EXPERIENCE. Not only employment. For early-career candidates (students, recent graduates, career changers) the real evidence often lives elsewhere; treat each of these as a first-class experience entry when it has substance:
- internships and part-time jobs
- substantial projects: capstone, research, personal, hackathon (company = the university, lab, or "Personal project")
- club, association, or team leadership (company = the organization)
- teaching/TA roles and structured volunteering
Do NOT pad: a one-line mention with no substance stays out of experiences (coursework lists belong in education). Set seniority_level honestly (IC for most student entries) and scope with what is real (team size, users, dataset size, budget raised).

For EACH distinct role/experience in the resume, produce one experience object with:
- YAML-style frontmatter fields: id (kebab-case, e.g. "northwind-search-platform"), company, company_context (only if stated or obvious from the company name — else omit), location (if present), title, title_normalized (map to a canonical seniority like "Principal/Group Product Manager (leadership track)"), start ("YYYY" or "YYYY-MM"), end ("YYYY", "YYYY-MM", or "present"), seniority_level (IC|Lead|Manager|Director|VP|C-level), domains (array), scope (map of quantified scope like team_size/budget_pnl/users_scale/markets, each {value, prov:"R"}), skills (array of {name, proficiency: exposure|working|strong|expert, recency:"YYYY", prov:"R"}), keywords (ATS-relevant terms the role genuinely supports).
- A markdown body with sections: "## Summary" (one paragraph in the candidate's own voice, tagged [R]), "## Achievements" (each resume bullet as an atomic bullet tagged [R]), "## Context & responsibilities" (any extra detail present), "## Raw material / notes" (leave a note that metrics should be user-confirmed where precise).

Every bullet and the summary end with a provenance tag [R]. Proficiency/recency are inferred conservatively from context (recency = the role's end year). Mark nothing [C] or [?].

Also extract education into a separate list, and a first-pass voice profile.

Output valid JSON matching the OUTPUT CONTRACT exactly. No prose outside JSON.`;

export function buildExtractionUserMessage(resumeText: string): string {
  return [
    "Extract the knowledge base from this resume text. Number experiences reverse-chronologically (01 = most recent). Return ONLY JSON.",
    "",
    "RESUME TEXT:",
    "```",
    resumeText.slice(0, 40_000),
    "```",
    "",
    "OUTPUT CONTRACT:",
    `{
  "candidate": { "name": "...", "headline": "the positioning line under the name, verbatim, if present — else omit", "contact": "email · phone · location · links (only what's present)" },
  "experiences": [
    {
      "fileName": "01-company-role.md",
      "frontmatter": { "id": "...", "company": "...", "title": "...", "title_normalized": "...", "start": "YYYY", "end": "YYYY|present", "seniority_level": "Lead", "domains": ["..."], "scope": { "team_size": { "value": "...", "prov": "R" } }, "skills": [ { "name": "...", "proficiency": "strong", "recency": "2026", "prov": "R" } ], "keywords": ["..."] },
      "body": "## Summary\\n... [R]\\n\\n## Achievements\\n- ... [R]\\n\\n## Context & responsibilities\\n- ... [R]\\n\\n## Raw material / notes\\n- ..."
    }
  ],
  "education": [ { "fileName": "institution.md", "frontmatter": { "institution": "...", "credential": "...", "dates": "..." }, "body": "..." } ],
  "voice_profile": "## Action verb fingerprint\\n...\\n\\n## Sentence rhythm\\n...\\n\\n## Quantification style\\n...\\n\\n## Technical register\\n...\\n\\n## Tone\\n..."
}`,
  ].join("\n");
}

export interface ExtractionResult {
  candidate: { name: string; headline?: string; contact: string };
  experiences: {
    fileName: string;
    frontmatter: Record<string, unknown>;
    body: string;
  }[];
  education: {
    fileName: string;
    frontmatter: Record<string, unknown>;
    body: string;
  }[];
  voice_profile: string;
}
