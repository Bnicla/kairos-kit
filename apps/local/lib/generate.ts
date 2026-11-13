import "server-only";
import matter from "gray-matter";
import { runClaude } from "@/lib/claude-cli";
import { getStore } from "@/store";
import {
  readMeta,
  readScoreReport,
  readSnapshot,
} from "@kairos/engine/applications";
import {
  loadExperiences,
  loadEducation,
  loadVoiceProfile,
  loadSummaryBlocks,
  loadRecruiterFeedback,
} from "@kairos/engine/kb/store";
import { checkLetterNumbers, saveGeneratedResume, saveScoredReport } from "@kairos/engine/tools/ops";
import type { GeneratedResume } from "@kairos/engine/types";
import { GENERATION_SYSTEM_PROMPT, buildGenerationUserMessage } from "@kairos/engine/prompts/generation";
import { SCORING_SYSTEM_PROMPT, buildScoringUserMessage, profileFactsFrom } from "@kairos/engine/prompts/scoring";
import {
  COVER_LETTER_SYSTEM_PROMPT,
  buildCoverLetterUserMessage,
} from "@kairos/engine/prompts/cover-letter";
import { checkProse, hardProseViolations } from "@kairos/engine/tools/prose-checks";
import { loadResumePaper, readProfileSettings } from "@kairos/engine/settings";
import { markdownLetterToDocx } from "@kairos/engine/docx-render";
import type { ScoreReport } from "@kairos/engine/types";

/**
 * One-click generation from the board, powered by the same headless Claude
 * CLI channel the sourcing triage uses (Max-billed, no API key). The output
 * goes through the SAME guarded save path as the MCP flow: zod shape,
 * mechanical grounding against the [?]-stripped KB, and the house-style
 * hard gates. One automatic retry feeds gate findings back to the model.
 */

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object in model output.");
  return JSON.parse(text.slice(start, end + 1));
}

const snapshotText = (snap: string | null) => (snap ? matter(snap).content.trim() : "");

async function readProfileFm(): Promise<Record<string, unknown>> {
  const raw = await getStore().readFile(["profile.md"]);
  return raw ? (matter(raw).data as Record<string, unknown>) : {};
}

/** Score an unscored application headlessly so one-click generation just works. */
async function scoreHeadless(appId: string): Promise<ScoreReport | null> {
  const store = getStore();
  const meta = await readMeta(store, appId);
  if (!meta) return null;
  const [experiences, educationRaw, voiceProfile, recruiterFeedback, snapshot] = await Promise.all([
    loadExperiences(store),
    loadEducation(store),
    loadVoiceProfile(store),
    loadRecruiterFeedback(store),
    readSnapshot(store, appId),
  ]);
  if (experiences.length === 0) return null;
  const userMessage = buildScoringUserMessage({
    jobText: snapshotText(snapshot),
    detectedAts: meta.detected_ats ?? "unknown",
    sourceUrl: meta.source_url,
    experiences,
    educationRaw,
    voiceProfile,
    recruiterFeedback,
    mode: "audit",
    profileFacts: profileFactsFrom(await readProfileFm()),
  });
  let prompt = `${SCORING_SYSTEM_PROMPT}\n\n${userMessage}\n\nReturn ONLY the ScoreReport JSON object. No prose, no code fences. Every field in the contract must match its type exactly (e.g. authenticity.flags[].where is always a string; omit a flag rather than leaving fields null).`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const report = extractJson(await runClaude(prompt)) as ScoreReport;
    try {
      await saveScoredReport(store, appId, "Default résumé", report);
      return report;
    } catch (err) {
      if (attempt === 1) throw err;
      const findings = err instanceof Error ? err.message : String(err);
      prompt = `${prompt}\n\nYour previous attempt was REJECTED by validation:\n${findings}\n\nFix every finding and return the corrected ScoreReport JSON only.`;
    }
  }
  return null;
}

export async function generateResumeHeadless(appId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = getStore();
  const meta = await readMeta(store, appId);
  if (!meta) return { ok: false, error: "Application not found." };
  let report = await readScoreReport<ScoreReport>(store, appId);
  if (!report) {
    // Tracked-but-unscored (fresh from the Sourced column): score first, same channel.
    try {
      report = await scoreHeadless(appId);
    } catch (err) {
      return { ok: false, error: `Scoring failed: ${err instanceof Error ? err.message : "bad output"}` };
    }
    if (!report) return { ok: false, error: "Could not score: knowledge base empty or application unreadable." };
  }

  const [experiences, educationRaw, voiceProfile, summaryBlocks, recruiterFeedback, snapshot, profile, referenceResume] =
    await Promise.all([
      loadExperiences(store),
      loadEducation(store),
      loadVoiceProfile(store),
      loadSummaryBlocks(store),
      loadRecruiterFeedback(store),
      readSnapshot(store, appId),
      readProfileFm(),
      store.readFile(["knowledge-base", "reference-resume.md"]),
    ]);

  const userMessage = buildGenerationUserMessage({
    referenceResume,
    jobText: snapshotText(snapshot),
    detectedAts: meta.detected_ats ?? "unknown",
    company: meta.company,
    title: meta.role,
    scoreReport: report,
    experiences,
    educationRaw,
    voiceProfile,
    summaryBlocks,
    recruiterFeedback,
    candidateName: typeof profile.name === "string" ? profile.name : undefined,
    contactLine: typeof profile.contact_line === "string" ? profile.contact_line : undefined,
  });
  const headline = typeof profile.headline === "string" ? profile.headline : undefined;

  const { probeResumeLayout } = await import("@/lib/layout-probe");
  const { renderDocxToPdf } = await import("@/lib/pdf-render");
  const { kairosHome } = await import("@/store");
  const docxPath = `${kairosHome()}/applications/${appId}/resume.docx`;

  let prompt = `${GENERATION_SYSTEM_PROMPT}\n\n${userMessage}\n\nReturn ONLY the GeneratedResume JSON object. No prose, no code fences.`;
  // Up to 3 passes: gate violations AND visual layout (page count / fill) both
  // feed structured findings back so generation converges automatically. The
  // engine's word-count gate remains the portable safety net when the visual
  // probe is unavailable.
  for (let attempt = 0; attempt < 3; attempt++) {
    let resume: GeneratedResume;
    try {
      resume = extractJson(await runClaude(prompt)) as GeneratedResume;
    } catch (err) {
      return { ok: false, error: `Generation failed: ${err instanceof Error ? err.message : "bad output"}` };
    }
    try {
      await saveGeneratedResume(store, appId, resume, { headline });
    } catch (err) {
      const findings = err instanceof Error ? err.message : String(err);
      if (attempt === 2) return { ok: false, error: `Rejected by the quality gates: ${findings.slice(0, 300)}` };
      prompt = `${prompt}\n\nYour previous attempt was REJECTED by validation with these findings:\n${findings}\n\nFix every finding and return the corrected GeneratedResume JSON only.`;
      continue;
    }
    // Saved and gate-clean; now measure the actual rendered pages (including
    // the page-2 anchor invariant when the profile configures one).
    const { readPage2Anchor } = await import("@kairos/engine/tools/ops");
    const layout = await probeResumeLayout(docxPath, {
      page2Anchor: readPage2Anchor(await store.readFile(["profile.md"])),
    });
    if (!layout || layout.verdict === "good" || attempt === 2) {
      // Keep a submit-ready PDF alongside the editable docx (best-effort).
      await renderDocxToPdf(docxPath);
      return { ok: true };
    }
    prompt = `${prompt}\n\nThe saved resume rendered with a layout problem: ${layout.guidance}\nReturn the corrected GeneratedResume JSON only, keeping all real facts.`;
  }
  return { ok: false, error: "unreachable" };
}

export async function generateCoverLetterHeadless(appId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = getStore();
  const meta = await readMeta(store, appId);
  if (!meta) return { ok: false, error: "Application not found." };
  const [experiences, voiceProfile, snapshot, report, profile] = await Promise.all([
    loadExperiences(store),
    loadVoiceProfile(store),
    readSnapshot(store, appId),
    readScoreReport<ScoreReport>(store, appId),
    readProfileFm(),
  ]);
  const honestGap = report?.gaps?.find((g) => g.type === "genuine_gap")?.requirement ?? null;
  const keyStrengths = report?.authenticity?.strengths ?? [];

  const userMessage = buildCoverLetterUserMessage({
    jobText: snapshotText(snapshot),
    company: meta.company,
    title: meta.role,
    experiences,
    voiceProfile,
    writingSamples: await store.readFile(["knowledge-base", "_writing-samples.md"]),
    candidateName: typeof profile.name === "string" ? profile.name : undefined,
    contactLine: typeof profile.contact_line === "string" ? profile.contact_line : undefined,
    keyStrengths,
    honestGap,
    date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
  });

  // Same gates as save_cover_letter: the prose gate, then the number check
  // (checkLetterNumbers, the function the MCP tool calls). Up to two rewrites
  // with the exact findings before giving up: a letter that fails is not saved.
  const { voice } = readProfileSettings(await store.readFile(["profile.md"]));
  let prompt = `${COVER_LETTER_SYSTEM_PROMPT}\n\n${userMessage}\n\nReturn ONLY the letter as plain markdown. No commentary before or after.`;
  let markdown = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      markdown = (await runClaude(prompt)).trim();
    } catch (err) {
      return { ok: false, error: `Generation failed: ${err instanceof Error ? err.message : "no output"}` };
    }
    if (markdown.length < 200) return { ok: false, error: "Model returned an implausibly short letter; try again." };
    const hard = hardProseViolations(checkProse(markdown, { jobText: snapshotText(snapshot), voice }));
    if (hard.length) {
      if (attempt === 2) {
        return { ok: false, error: `Letter failed the prose gate after 3 attempts: ${hard.map((v) => v.detail).join("; ")}` };
      }
      prompt = `${prompt}\n\nYour draft:\n${markdown}\n\nIt failed the prose gate. Rewrite it fixing every item below (keep the facts):\n${hard.map((v) => `- ${v.rule}: ${v.detail}`).join("\n")}\nReturn ONLY the letter.`;
      continue;
    }
    const numbers = await checkLetterNumbers(store, appId, markdown);
    if (!numbers.message) break;
    if (attempt === 2) return { ok: false, error: `Letter failed the number check after 3 attempts. ${numbers.message}` };
    prompt = `${prompt}\n\nYour draft:\n${markdown}\n\nIt failed the number check: ${numbers.message}\nRewrite it without those numbers (never replace one with another number that is not in the record). Return ONLY the letter.`;
  }

  await store.writeFile(["applications", appId, "cover-letter.md"], markdown);
  const docx = await markdownLetterToDocx(markdown, { template: { paper: await loadResumePaper(store) } });
  await store.writeBinary(
    ["applications", appId, "cover-letter.docx"],
    docx,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  const { renderDocxToPdf } = await import("@/lib/pdf-render");
  const { kairosHome } = await import("@/store");
  await renderDocxToPdf(`${kairosHome()}/applications/${appId}/cover-letter.docx`);
  return { ok: true };
}
