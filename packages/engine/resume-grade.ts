import type { Experience } from "@kairos/engine/kb/types";

/**
 * Deterministic raw-résumé parsing for DIRECT grading: turn the plain text of
 * any résumé into a pseudo-KB good enough for computeHealth, with no AI call.
 * This is the key-free grading path (Health Lab today; the pre-key funnel
 * check later). It is heuristic by design; the full Claude extraction remains
 * the real onboarding path.
 */
export interface RawResumeParse {
  experiences: Experience[];
  contactLine: string;
  headline?: string;
  bulletsFound: number;
  yearSpan: { start: number; end: number | "present" };
}

const BULLET_RE = /^[-•▪◦‣*·–]\s+/;

export function parseResumeText(text: string, nowYear = new Date().getFullYear()): RawResumeParse {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const nonEmpty = lines.filter(Boolean);
  const top = nonEmpty.slice(0, 10);

  // Contact: extract TOKENS, not lines. PDF extraction often loses line breaks
  // entirely, and a line-based match then swallows the whole document.
  const email = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
  const phone = [...text.matchAll(/\+?\d[\d\s().-]{7,}\d/g)]
    .map((m) => m[0].trim())
    .find((p) => {
      const digits = p.replace(/\D/g, "");
      return digits.length >= 9 && digits.length <= 15;
    });
  const link = text.match(/(?:linkedin\.com|github\.com)\/[\w/-]+/i)?.[0];
  const location = text.slice(0, 400).match(/\b[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?,\s?[A-Z]{2}\b/)?.[0];
  const contactLine = [email, phone, link, location].filter(Boolean).join(" · ").slice(0, 200);

  // Headline: a short, early, non-contact line (not the name: skip line 1).
  const headline = top
    .slice(1, 6)
    .find(
      (l) =>
        l.length < 90 &&
        l.split(/\s+/).length >= 2 &&
        l.split(/\s+/).length <= 12 &&
        !/@|\d|linkedin|github|http/i.test(l) &&
        l !== l.toUpperCase(),
    );

  // Bullets: marked lines first; if the résumé is paragraph-styled, fall back
  // to content-length lines that aren't headers.
  let bullets = lines.filter((l) => BULLET_RE.test(l)).map((l) => l.replace(BULLET_RE, ""));
  if (bullets.length < 3) {
    // Break-less PDFs: split on the bullet glyphs themselves. The middot is
    // deliberately NOT in this set; it doubles as a contact-line separator.
    bullets = text
      .split(/[•▪◦‣]/)
      .slice(1)
      .map((s) => s.trim())
      .filter((s) => s.length >= 20 && s.length <= 300);
  }
  if (bullets.length < 3) {
    bullets = nonEmpty.filter(
      (l) =>
        l.length >= 40 &&
        l.length <= 300 &&
        !BULLET_RE.test(l) &&
        l !== l.toUpperCase() &&
        !l.endsWith(":") &&
        !/@|linkedin|github|http/i.test(l),
    );
  }
  bullets = bullets.slice(0, 60);

  // Career span from every plausible year in the document.
  const years = [...text.matchAll(/\b(19[89]\d|20[0-4]\d)\b/g)]
    .map((m) => parseInt(m[1], 10))
    .filter((y) => y <= nowYear + 1);
  const start = years.length ? Math.min(...years) : nowYear;
  const present = /\b(present|current|now)\b/i.test(text);
  const end: number | "present" = present ? "present" : years.length ? Math.max(...years) : nowYear;

  const experience: Experience = {
    fileName: "resume.md",
    frontmatter: {
      id: "resume",
      company: "Résumé",
      title: headline ?? "Candidate",
      start: String(start),
      end: end === "present" ? "present" : String(end),
    },
    body: `## Achievements\n${bullets.map((b) => `- ${b} [R]`).join("\n")}`,
  };

  return {
    experiences: [experience],
    contactLine,
    headline,
    bulletsFound: bullets.length,
    yearSpan: { start, end },
  };
}
