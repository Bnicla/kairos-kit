import type { Store } from "@kairos/engine/store/types";
import { parseExperience, serializeExperience } from "@kairos/engine/kb/experience";
import { buildIndexMap } from "@kairos/engine/kb/index-map";
import type { Experience } from "@kairos/engine/kb/types";

const KB = "knowledge-base";
const EXPERIENCES = [KB, "experiences"];

/** Load and parse every experience file from the knowledge base. */
export async function loadExperiences(store: Store): Promise<Experience[]> {
  const files = await store.listFiles(EXPERIENCES);
  const mdFiles = files.filter((f) => f.name.endsWith(".md"));
  // Concurrent reads: sequential Drive round-trips made every KB load O(n) slow.
  const loaded = await Promise.all(
    mdFiles.map(async (f) => {
      const raw = await store.readFile([...EXPERIENCES, f.name]);
      if (!raw) return null;
      const exp = parseExperience(f.name, raw);
      exp.fileId = f.id;
      return exp;
    }),
  );
  const experiences = loaded.filter((e): e is Experience => e !== null);
  // Numbered files preserve reverse-chronological order deterministically.
  return experiences.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export async function saveExperience(store: Store, exp: Experience): Promise<void> {
  await store.writeFile([...EXPERIENCES, exp.fileName], serializeExperience(exp));
}

/** Regenerate the derived `_index.md` routing map from all experiences. */
export async function regenerateIndexMap(store: Store): Promise<void> {
  const experiences = await loadExperiences(store);
  await store.writeFile([KB, "_index.md"], buildIndexMap(experiences));
}

// Shared KB documents ---------------------------------------------------------

export const loadVoiceProfile = (s: Store) => s.readFile([KB, "_voice-profile.md"]);
export const saveVoiceProfile = (s: Store, content: string) =>
  s.writeFile([KB, "_voice-profile.md"], content);

export const loadNarrative = (s: Store) => s.readFile([KB, "_narrative.md"]);
export const saveNarrative = (s: Store, content: string) =>
  s.writeFile([KB, "_narrative.md"], content);

export const loadSummaryBlocks = (s: Store) => s.readFile([KB, "_summary-blocks.md"]);

export const loadRecruiterFeedback = (s: Store) =>
  s.readFile([KB, "recruiter-feedback.md"]);

export async function appendRecruiterFeedback(
  store: Store,
  entry: string,
  meta?: { date?: string; role?: string },
): Promise<void> {
  const existing = (await loadRecruiterFeedback(store)) ?? "# Recruiter Feedback\n";
  const header = `\n## ${meta?.date ?? new Date().toISOString().slice(0, 10)}${
    meta?.role ? ` — ${meta.role}` : ""
  } [F]\n`;
  await store.writeFile(
    [KB, "recruiter-feedback.md"],
    `${existing.trimEnd()}\n${header}${entry.trim()}\n`,
  );
}

export const loadEducation = async (store: Store): Promise<string[]> => {
  const files = await store.listFiles([KB, "education"]);
  const raws = await Promise.all(
    files
      .filter((f) => f.name.endsWith(".md"))
      .map((f) => store.readFile([KB, "education", f.name])),
  );
  return raws.filter((r): r is string => !!r);
};
