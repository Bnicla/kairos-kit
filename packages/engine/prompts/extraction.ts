/**
 * Resume → knowledge base extraction (onboarding, §14). Turns the plain text of
 * an uploaded resume into structured experience files. EVERY extracted fact is
 * tagged `[R]` (from-uploaded-resume). Nothing is invented; if a detail isn't in
 * the resume text, it is not added.
 */
import { worded } from "@kairos/engine/wording";

export const EXTRACTION_SYSTEM_PROMPT = `You extract a structured career knowledge base from the plain text of a candidate's uploaded resume, for an authenticity-preserving career tool. You NEVER invent facts. Every fact you output must be literally present in, or directly stated by, the resume text. If something is not in the text, do not add it.

WHAT COUNTS AS AN EXPERIENCE. Not only employment. For early-career candidates (students, recent graduates, career changers) the real evidence often lives elsewhere; treat each of these as a first-class experience entry when it has substance:
- internships and part-time jobs
- substantial projects: capstone, research, personal, hackathon (see PROJECTS below)
- club, association, or team leadership (company = the organization)
- teaching/TA roles and structured volunteering

PROJECTS. A project of the candidate's own is not a job. Its entry carries kind: "project", company: the project's own name exactly as the resume writes it (e.g. "Campus Shuttle Tracker"), and title only when the resume states the candidate's part in words of its own; otherwise leave title out. NEVER give a project a job title ("Backend Engineer", "Full-Stack Developer") or an employer (the university, "Personal project"): the resume gave neither. What the resume says about the project in brackets ("team of 4, capstone") goes into the body as a line, in its words.

TITLES, EMPLOYERS, SCHOOLS AND ISSUERS ARE THE RESUME'S OWN. Copy every title and every employer exactly as the resume writes it. For education and credentials, institution is the school or the issuer the resume names; when it names none (a certificate with no issuer), leave institution out: never write a description ("Online course") or a guess ("Google") in its place.
Do NOT pad: a one-line mention with no substance stays out of experiences (coursework lists belong in education). Set seniority_level honestly (IC for most student entries) and scope with what is real (team size, users, dataset size, budget raised).

For EACH distinct role/experience in the resume, produce one experience object with:
- YAML-style frontmatter fields: id (kebab-case, e.g. "northwind-search-platform"), company, company_context (only if stated or obvious from the company name — else omit), location (if present), title, title_normalized (map to a canonical seniority like "Principal/Group Product Manager (leadership track)"), start ("YYYY" or "YYYY-MM"), end ("YYYY", "YYYY-MM", or "present"), seniority_level (IC|Lead|Manager|Director|VP|C-level), domains (array), scope (map of quantified scope like team_size/budget_pnl/users_scale/markets, each {value, prov:"R"}), skills (array of {name, proficiency: exposure|working|strong|expert, recency:"YYYY", prov:"R"}), keywords (ATS-relevant terms the role genuinely supports).
- A markdown body with sections: "## Summary" (only when the resume itself describes the role in a sentence or a paragraph: that text, in its words, tagged [R]; otherwise leave the section out, and never write a summary of your own), "## Achievements" (each resume bullet as an atomic bullet tagged [R], in the resume's words), "## Context & responsibilities" (any extra detail present). Add no note, comment or reminder of your own to a role: every line of the body is the resume's.

Every bullet and the summary end with a provenance tag [R]. Proficiency/recency are inferred conservatively from context (recency = the role's end year). Mark nothing [C] or [?].

Also extract education into a separate list (every degree, licence and certification is one entry), and a first-pass voice profile.

THE RESUME'S OWN SUMMARY. candidate.summary is the resume's summary or objective about the person as a whole (the paragraph under the name), word for word and complete; leave it out when the resume has none. A count of years stated there ("seven years in corporate finance") is the person's own figure.

WHAT THE PERSON DID NOT DO. A line such as "I did not lead the deal" or "A teammate built the mobile app; I did not work on it" is kept in the role's body as the resume writes it: it limits what may later be claimed, and it is never printed on a resume.

THE RESUME'S OWN LISTS. candidate.skills is the resume's skills section, one item per skill, each exactly in its words (keep a qualifier such as "(basic)" or "(course level)"), none left out and none added. candidate.languages is its languages with their level, as written. Leave either out when the resume has no such section. These lists are separate from the skills you attach to a role.

Output valid JSON matching the OUTPUT CONTRACT exactly. No prose outside JSON.`;

export function buildExtractionUserMessage(resumeText: string): string {
  return [
    worded`Extract the knowledge base from this resume text. Number experiences reverse-chronologically (01 = most recent). Return ONLY JSON.`,
    "",
    "RESUME TEXT:",
    "```",
    resumeText.slice(0, 40_000),
    "```",
    "",
    "OUTPUT CONTRACT:",
    `{
  "candidate": { "name": "...", "headline": "the positioning line under the name, verbatim, if present — else omit", "contact": "email · phone · location · links (only what's present)", "summary": "the resume's own summary of the person, word for word — else omit", "skills": ["each item of the resume's skills section, in its words"], "languages": ["English (native)", "..."] },
  "experiences": [
    {
      "fileName": "01-company-role.md",
      "frontmatter": { "id": "...", "company": "...", "title": "...", "title_normalized": "...", "start": "YYYY", "end": "YYYY|present", "seniority_level": "Lead", "domains": ["..."], "scope": { "team_size": { "value": "...", "prov": "R" } }, "skills": [ { "name": "...", "proficiency": "strong", "recency": "2026", "prov": "R" } ], "keywords": ["..."] },
      "body": "## Achievements\\n- ... [R]\\n\\n## Context & responsibilities\\n- ... [R]"
    }
  ],
  "education": [ { "fileName": "institution-or-credential.md", "frontmatter": { "institution": "the school or issuer the resume names; omit when it names none", "credential": "...", "dates": "..." }, "body": "..." } ],
  "voice_profile": "## Action verb fingerprint\\n...\\n\\n## Sentence rhythm\\n...\\n\\n## Quantification style\\n...\\n\\n## Technical register\\n...\\n\\n## Tone\\n..."
}`,
  ].join("\n");
}

export interface ExtractionResult {
  candidate: { name: string; headline?: string; contact: string; summary?: string; skills?: string[]; languages?: string[] };
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
