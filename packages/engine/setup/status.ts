/**
 * Where the first-run interview stands: which settings are set, which sections
 * are done, and which still need answers. Pure: the MCP tool reads the files
 * and passes them in.
 *
 * A section counts as done when the user went through it (setup-state.json
 * says so) or when every setting it fills is set. A section the user went
 * through may leave settings unset on purpose ("no dream companies"); those
 * take their stated default.
 */
import { SETTINGS, SETUP_SECTIONS } from "./sections";

export const SETUP_STATE_PATH = ["setup-state.json"];

export interface SetupState {
  version: 1;
  /** Which way in the user chose: A documents folder, B one résumé, C interview. */
  path?: "A" | "B" | "C";
  sections: Record<string, { status: "done" | "skipped"; at: string; note?: string }>;
  /** Every document read during setup, with the date it was read. */
  sources: { file: string; kind: string; read_at: string }[];
}

export const emptySetupState = (): SetupState => ({ version: 1, sections: {}, sources: [] });

export interface SetupData {
  profile: Record<string, unknown>;
  search_profile: Record<string, unknown> | null;
  autofill: Record<string, unknown> | null;
  kb: {
    experiences: number;
    education: number;
    skills: number;
    voice_profile: boolean;
    writing_samples: boolean;
    metrics_register: boolean;
    star_stories: boolean;
  };
}

function get(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** A value counts as set when present: an empty list the user chose counts too. */
function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

export function isSettingSet(data: SetupData, key: string): boolean {
  const [file, ...path] = key.split(".");
  switch (file) {
    case "profile":
      return present(get(data.profile, path));
    case "search_profile":
      // A derived profile is a guess, not an answer.
      return data.search_profile?.source === "confirmed" && present(get(data.search_profile, path));
    case "autofill":
      return present(get(data.autofill, path));
    case "kb": {
      const k = path[0] as keyof SetupData["kb"];
      const v = data.kb[k];
      return typeof v === "number" ? v > 0 : Boolean(v);
    }
    default:
      return false;
  }
}

export interface SectionStatus {
  order: number;
  name: string;
  title: string;
  /** done: answered (all set, or the user went through it); partial: some set; todo: nothing yet. */
  status: "done" | "partial" | "todo" | "skipped";
  set: string[];
  unset: { key: string; default: string }[];
}

export function setupStatus(data: SetupData, state: SetupState | null): {
  sections: SectionStatus[];
  next: string | null;
  complete: boolean;
} {
  const sections = SETUP_SECTIONS.map((s): SectionStatus => {
    const set = s.fills.filter((k) => isSettingSet(data, k));
    const unset = s.fills.filter((k) => !set.includes(k)).map((k) => ({ key: k, default: SETTINGS[k]?.default ?? "" }));
    const mark = state?.sections[s.name]?.status;
    const status: SectionStatus["status"] =
      mark === "skipped" ? "skipped" : mark === "done" || unset.length === 0 ? "done" : set.length ? "partial" : "todo";
    return { order: s.order, name: s.name, title: s.title, status, set, unset };
  });
  const next = sections.find((s) => s.status === "todo" || s.status === "partial")?.name ?? null;
  return { sections, next, complete: next === null };
}
