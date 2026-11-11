import { NextResponse } from "next/server";
import matter from "gray-matter";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getStore } from "@/store";
import { loadExperiences } from "@kairos/engine/kb/store";
import { parseExperience } from "@kairos/engine/kb/experience";
import { computeHealth } from "@kairos/engine/health";
import { careerStage } from "@kairos/engine/length-policy";
import { extractResumeText } from "@kairos/engine/extract-text";
import { parseResumeText } from "@kairos/engine/resume-grade";
import type { Experience } from "@kairos/engine/kb/types";

/**
 * Health Lab backend: grade a set of experiences on every curve at once, so
 * threshold tuning is visual instead of CLI-only. Sources: the live local KB,
 * the student fixture in the repo, or files posted from the page.
 */

const FIXTURE_DIR = join(process.cwd(), "..", "..", "tests", "fixtures", "student-kb");

function grade(experiences: Experience[], contactLine?: string, headline?: string) {
  return {
    entries: experiences.map((e) => ({
      fileName: e.fileName,
      company: e.frontmatter.company,
      title: e.frontmatter.title,
      dates: `${e.frontmatter.start}–${e.frontmatter.end}`,
    })),
    derivedStage: careerStage(experiences),
    derived: computeHealth(experiences, { contactLine, headline }),
    early: computeHealth(experiences, { contactLine, headline, stage: "early" }),
    mid: computeHealth(experiences, { contactLine, headline, stage: "mid" }),
    senior: computeHealth(experiences, { contactLine, headline, stage: "senior" }),
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const source = url.searchParams.get("source") ?? "live";
  try {
    if (source === "fixture") {
      const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".md"));
      const experiences = files
        .sort()
        .map((f) => parseExperience(f, readFileSync(join(FIXTURE_DIR, f), "utf8")));
      return NextResponse.json(grade(experiences));
    }
    const store = getStore();
    const experiences = await loadExperiences(store);
    // The user's own contact line and headline, from profile.md.
    const fm = matter((await store.readFile(["profile.md"])) ?? "").data as { contact_line?: unknown; headline?: unknown };
    const contact = typeof fm.contact_line === "string" ? fm.contact_line : undefined;
    const headline = typeof fm.headline === "string" ? fm.headline : undefined;
    return NextResponse.json(grade(experiences, contact, headline));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load." },
      { status: 500 },
    );
  }
}

/** Grade an uploaded résumé file directly (PDF/DOCX/TXT, no AI call). */
export async function POST(req: Request): Promise<NextResponse> {
  try {
    // Refused before the body is read: a declared size over the limit, or none at all.
    const declared = Number(req.headers.get("content-length") ?? NaN);
    if (!Number.isFinite(declared) || declared > 11 * 1024 * 1024) {
      return NextResponse.json({ error: "File too large (10MB max)." }, { status: 413 });
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: "Attach a résumé file." }, { status: 400 });
    }
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "File too large (10MB max)." }, { status: 400 });
    }
    const text = await extractResumeText(file);
    if (text.length < 200) {
      return NextResponse.json(
        { error: "Couldn't read enough text. Scanned-image PDFs need a text-based export." },
        { status: 400 },
      );
    }
    const parsed = parseResumeText(text);
    return NextResponse.json({
      ...grade(parsed.experiences, parsed.contactLine, parsed.headline),
      parseInfo: {
        fileName: file.name,
        bullets: parsed.bulletsFound,
        span: `${parsed.yearSpan.start}–${parsed.yearSpan.end}`,
        headline: parsed.headline ?? null,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to parse." },
      { status: 500 },
    );
  }
}
