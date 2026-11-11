import type { Experience } from "@kairos/engine/kb/types";
import { careerStage, type CareerStage } from "@kairos/engine/length-policy";

/**
 * Résumé Health Check — a JOB-AGNOSTIC quality report on the knowledge base
 * itself (distinct from the job-specific three-axis score). Mostly deterministic
 * so it is trustworthy, evidence-linked, and honest — the "fix" is always a
 * Kairos action, never an upsell. Runs at onboarding to give immediate value and
 * route the user into enrichment.
 *
 * CAREER-STAGE AWARE: a sophomore with one internship and a senior operator are
 * not graded on the same curve. Thresholds, depth expectations, fix texts, and
 * verdict language calibrate to the stage derived from the KB's date spans
 * (overridable via opts.stage).
 */

export interface HealthDimension {
  key: string;
  label: string;
  group: "Mechanics" | "Content" | "Authenticity" | "Depth";
  score: number; // 0–5
  status: "strong" | "ok" | "weak";
  detail: string;
  evidence?: string;
  fix?: string;
}
export interface FlaggedBullet {
  experience: string;
  bullet: string;
  why: string;
}
export interface HealthReport {
  overall: number; // 0–100
  verdict: string;
  /** The curve this report was graded on. */
  stage: CareerStage;
  dimensions: HealthDimension[];
  topFixes: string[];
  flaggedBullets: FlaggedBullet[];
  counts: { experiences: number; bullets: number; quantified: number; confirmed: number };
}

const BUZZWORDS = [
  "leverage", "utilize", "robust", "synergy", "seamless", "spearhead", "pivotal",
  "holistic", "cutting-edge", "world-class", "results-driven", "detail-oriented", "proven track record",
];
// "orchestrat*" is real AI terminology (agent/tool/model orchestration) and a
// worn-out power-verb everywhere else — same context rule as the style gate in
// tools/checks.ts (owner directive): count it only when no AI/system term sits
// within ±60 chars.
const ORCH_CONTEXT = /\b(agent|agents|model|models|llm|llms|ai|ml|mcp|workflow|workflows|pipeline|pipelines|retrieval|rag|eval|evals|evaluation|service|services|task|tasks|prompt|prompts|tool|tools|system|systems|data)\b/i;
function genericOrchestrations(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/\borchestrat\w*/gi)) {
    const i = m.index ?? 0;
    const ctx = text.slice(Math.max(0, i - 60), i + m[0].length + 60);
    if (!ORCH_CONTEXT.test(ctx)) n++;
  }
  return n;
}
const ABSTRACT = [
  "composed", "cleanly", "ensure", "ensuring", "align", "broader", "capabilities", "stakeholder",
  "cross-functional", "holistic", "seamless", "robust", "various", "effectively", "best practices", "value-add",
];
const WEAK_OPENER = /^(responsible for|worked on|helped|assisted|participated|involved in|tasked with|duties included)/i;
const POWER_VERBS = ["orchestrated", "spearheaded", "pioneered", "leveraged", "championed"];

function getBullets(body: string): string[] {
  return body
    .split("\n")
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, "").trim());
}
/** Strip a "**Lead-in:**" and any trailing provenance tag for analysis. */
function clean(b: string): string {
  return b.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\s*\[[RCF?]\]\s*$/g, "").trim();
}
function hasMetric(t: string): boolean {
  return (
    /[%$€£]/.test(t) ||
    /\b\d[\d,.]*\s?(x|k|m|bn|b|\+|million|billion|users?|mau|documents?|markets?|devices?|teams?|developers?|pms?|years?|points?|pts)\b/i.test(t) ||
    /\b\d{2,}\b/.test(t)
  );
}
const band = (s: number): HealthDimension["status"] => (s >= 4 ? "strong" : s >= 2.5 ? "ok" : "weak");

export function computeHealth(
  experiences: Experience[],
  opts: { contactLine?: string; headline?: string; stage?: CareerStage } = {},
): HealthReport {
  const stage = opts.stage ?? careerStage(experiences);
  const early = stage === "early";
  const allBullets: { exp: string; raw: string; text: string }[] = [];
  let rTags = 0, cTags = 0, fTags = 0;
  for (const e of experiences) {
    for (const raw of getBullets(e.body)) allBullets.push({ exp: e.frontmatter.company, raw, text: clean(raw) });
    rTags += (e.body.match(/\[R\]/g) ?? []).length;
    cTags += (e.body.match(/\[C\]/g) ?? []).length;
    fTags += (e.body.match(/\[F\]/g) ?? []).length;
  }
  const total = allBullets.length || 1;
  const quantified = allBullets.filter((b) => hasMetric(b.text)).length;

  const dims: HealthDimension[] = [];

  // --- Mechanics: contact completeness ---
  const c = opts.contactLine ?? "";
  const contactBits = [/@/.test(c), /\+?\d[\d\s().-]{6,}/.test(c), /linkedin/i.test(c), /,|\b[A-Z]{2}\b|France|United|US\b/.test(c)];
  const contactN = contactBits.filter(Boolean).length;
  dims.push({
    key: "contact", label: "Contact completeness", group: "Mechanics",
    score: Math.round((contactN / 4) * 5), status: band((contactN / 4) * 5),
    detail: `${contactN} of 4 present (email, phone, LinkedIn, location).`,
    evidence: c || undefined,
    fix: contactN < 4 ? "Add the missing contact fields in your profile." : undefined,
  });

  // --- Mechanics: headline ---
  const h = (opts.headline ?? "").trim();
  const hScore = !h ? (early ? 2 : 1) : h.split(/\s+/).length >= 2 ? 5 : 3;
  dims.push({
    key: "headline", label: "Headline / positioning", group: "Mechanics",
    score: hScore, status: band(hScore),
    detail: h ? "A positioning headline is set." : "No headline set.",
    evidence: h || undefined,
    fix: !h
      ? early
        ? "Add a one-line headline saying what you study and build (e.g. 'CS senior · ML projects & internship at a fintech')."
        : "Add a headline (e.g. 'Data Platform Product Lead')."
      : undefined,
  });

  // --- Mechanics: recency / detail gradient ---
  const bulletCounts = experiences.map((e) => getBullets(e.body).length);
  const gradientOk = bulletCounts.length < 2 || bulletCounts[0] >= bulletCounts[bulletCounts.length - 1];
  dims.push({
    key: "structure", label: "Structure & recency", group: "Mechanics",
    score: gradientOk ? 5 : 3, status: gradientOk ? "strong" : "ok",
    detail: gradientOk ? "Reverse-chronological, with recent roles carrying more detail." : "Older roles carry as much detail as recent ones.",
    fix: gradientOk ? undefined : "Trim older roles to 1–2 lines; keep detail on recent, relevant roles.",
  });

  // --- Content: quantification density ---
  // Early careers legitimately have fewer hard business metrics; the curve
  // expects less and the fix points at the numbers students actually have.
  const qPct = Math.round((quantified / total) * 100);
  const qScore = early
    ? qPct >= 40 ? 5 : qPct >= 28 ? 4 : qPct >= 18 ? 3 : qPct >= 8 ? 2 : 1
    : qPct >= 60 ? 5 : qPct >= 45 ? 4 : qPct >= 30 ? 3 : qPct >= 15 ? 2 : 1;
  dims.push({
    key: "quantification", label: "Quantified impact", group: "Content",
    score: qScore, status: band(qScore),
    detail: `${qPct}% of bullets carry a number or measurable outcome.`,
    evidence: `${quantified} of ${total} bullets`,
    fix: qScore < 4
      ? early
        ? "Add the numbers you do have: users or downloads, dataset sizes, team size, time saved, grade or award, lines of code replaced."
        : "Add a metric to bullets that state an activity but no result."
      : undefined,
  });

  // --- Content: weak/vapor bullets ---
  const flaggedBullets: FlaggedBullet[] = [];
  for (const b of allBullets) {
    const lower = b.text.toLowerCase();
    const abstractHits = ABSTRACT.filter((a) => lower.includes(a)).length;
    const weakOpener = WEAK_OPENER.test(b.text);
    if (weakOpener) flaggedBullets.push({ experience: b.exp, bullet: b.text, why: "weak opener (states duty, not impact)" });
    else if (!hasMetric(b.text) && abstractHits >= 2 && b.text.split(/\s+/).length >= 8)
      flaggedBullets.push({ experience: b.exp, bullet: b.text, why: "abstract language, no measurable outcome" });
  }
  const vaporPct = flaggedBullets.length / total;
  const vScore = vaporPct === 0 ? 5 : vaporPct < 0.08 ? 4 : vaporPct < 0.15 ? 3 : vaporPct < 0.25 ? 2 : 1;
  dims.push({
    key: "vapor", label: "Bullet impact (no vapor)", group: "Content",
    score: vScore, status: band(vScore),
    detail: flaggedBullets.length === 0 ? "No vague, outcome-free bullets detected." : `${flaggedBullets.length} vague bullet(s) with no concrete outcome.`,
    fix: flaggedBullets.length ? "Rewrite the flagged bullets with a concrete result, or enrich the role to get the real detail." : undefined,
  });

  // --- Content: verbs ---
  const weakVerbs = allBullets.filter((b) => WEAK_OPENER.test(b.text)).length;
  const powerUses = allBullets.reduce((n, b) => n + POWER_VERBS.filter((v) => b.text.toLowerCase().includes(v)).length, 0);
  const verbScore = weakVerbs === 0 && powerUses <= 3 ? 5 : weakVerbs === 0 ? 4 : 3;
  dims.push({
    key: "verbs", label: "Action verbs", group: "Content",
    score: verbScore, status: band(verbScore),
    detail: `${weakVerbs} weak opener(s); ${powerUses} clustered power-verb use(s).`,
    fix: verbScore < 5 ? "Vary action verbs; avoid 'responsible for' and stacked Orchestrated/Spearheaded/Pioneered." : undefined,
  });

  // --- Authenticity: AI tells / house style ---
  const emDashes = experiences.reduce((n, e) => n + (e.body.match(/—/g) ?? []).length, 0);
  const buzz = experiences.reduce(
    (n, e) => n + BUZZWORDS.filter((w) => e.body.toLowerCase().includes(w)).length + genericOrchestrations(e.body),
    0,
  );
  const aScore = emDashes === 0 && buzz === 0 ? 5 : emDashes + buzz <= 3 ? 4 : emDashes + buzz <= 6 ? 3 : 2;
  dims.push({
    key: "tells", label: "Authentic voice (no AI tells)", group: "Authenticity",
    score: aScore, status: band(aScore),
    detail: `${emDashes} em dash(es), ${buzz} buzzword(s) across the knowledge base.`,
    fix: aScore < 5 ? "Cut em dashes and buzzwords (leverage, robust, spearheaded, …)." : undefined,
  });

  // --- Depth: provenance mix ---
  // Early: ONE genuinely enriched entry is a strong start (there may only be
  // one or two entries at all); the senior curve expects breadth.
  const enrichedRoles = experiences.filter((e) => /\[C\]|\[F\]/.test(e.body)).length;
  const dScore = experiences.length === 0
    ? 1
    : early
      ? enrichedRoles === 0 ? 2 : enrichedRoles >= Math.min(2, experiences.length) ? 5 : 4
      : enrichedRoles === 0 ? 1 : enrichedRoles < experiences.length / 2 ? 3 : 5;
  dims.push({
    key: "depth", label: "Depth beyond the résumé", group: "Depth",
    score: dScore, status: band(dScore),
    detail: `${cTags + fTags} confirmed fact(s) beyond the résumé, across ${enrichedRoles}/${experiences.length} entries. ${rTags} résumé facts.`,
    fix: dScore < 5
      ? early
        ? "Go deeper on your best project or internship: what you built, the tools, what broke, your part versus the team's, and any numbers. That detail is what tailoring draws from."
        : "Enrich thin roles: add real context, stories, and metrics beyond the résumé, recorded as confirmed [C] facts."
      : undefined,
  });

  const overall = Math.round((dims.reduce((s, d) => s + d.score, 0) / (dims.length * 5)) * 100);
  const verdict = early
    ? overall >= 85 ? "Genuinely strong for where you are. Go deeper on your best entry and it will stand out." :
      overall >= 70 ? "A solid start. The fixes below are exactly the ones that make early-career résumés land." :
      overall >= 50 ? "Normal for a first pass. Work the fixes below; each one moves the needle." :
      "Every résumé starts here. The fixes below are concrete and quick; do the top one first."
    : overall >= 85 ? "Strong foundation. Enrich a couple of roles and it's excellent." :
      overall >= 70 ? "Solid base with clear, fixable gaps." :
      overall >= 50 ? "A workable start; several high-impact fixes available." :
      "The fixes below will move it quickly.";

  const topFixes = [...dims]
    .filter((d) => d.fix)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((d) => d.fix!) as string[];

  return {
    overall,
    verdict,
    stage,
    dimensions: dims,
    topFixes,
    flaggedBullets: flaggedBullets.slice(0, 12),
    counts: { experiences: experiences.length, bullets: total, quantified, confirmed: cTags + fTags },
  };
}
