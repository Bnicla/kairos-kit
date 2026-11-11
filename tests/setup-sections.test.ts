import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SETUP_SECTIONS,
  SETTINGS,
  SEARCH_PROFILE_FIELDS,
  PROFILE_SETTINGS_FIELDS,
  renderChecklist,
  sectionByName,
  sectionFor,
} from "@kairos/engine/setup/sections";
import { setupStatus, isSettingSet, type SetupData } from "@kairos/engine/setup/status";
import { saveProfileShape, saveSearchProfileShape, saveAutofillShape } from "@/mcp/schemas";
import { AUTOFILL_FIELDS } from "@/lib/autofill";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

/**
 * Keys of a zod shape, as setting keys. Recurses into an object field only
 * when SETTINGS lists children for it (preferences, voice, board, daily_run),
 * so a new child there needs its own line too.
 */
function shapeKeys(prefix: string, shape: Record<string, z.ZodType>): string[] {
  const out: string[] = [];
  for (const [k, raw] of Object.entries(shape)) {
    const key = `${prefix}.${k}`;
    out.push(key);
    let t: z.ZodType = raw;
    while (t instanceof z.ZodOptional) t = t.unwrap() as z.ZodType;
    const hasChildren = Object.keys(SETTINGS).some((s) => s.startsWith(`${key}.`));
    if (hasChildren && t instanceof z.ZodObject) out.push(...shapeKeys(key, t.shape as Record<string, z.ZodType>));
  }
  return out;
}

const covered = (key: string) =>
  key in SETTINGS &&
  (SETTINGS[key].asked === false ||
    sectionFor(key) !== null ||
    // a container: covered when all its children are
    Object.keys(SETTINGS).some((s) => s.startsWith(`${key}.`)));

describe("/setup sections", () => {
  it("are the 14 sections of the plan, in order, with unique names", () => {
    expect(SETUP_SECTIONS.map((s) => s.order)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(new Set(SETUP_SECTIONS.map((s) => s.name)).size).toBe(14);
    expect(SETUP_SECTIONS.map((s) => s.name)).toEqual([
      "identity", "education", "experience", "skills", "goals", "level", "dealbreakers",
      "places", "pay", "companies", "voice", "resume", "forms", "daily",
    ]);
  });

  it("only fill settings that exist", () => {
    for (const s of SETUP_SECTIONS) for (const k of s.fills) expect(SETTINGS[k], `${s.name}: ${k}`).toBeDefined();
  });

  it("every setting is filled by a section, a container of filled settings, or marked not asked with a default", () => {
    for (const [key, info] of Object.entries(SETTINGS)) {
      expect(covered(key), key).toBe(true);
      expect(info.default.length, `${key} default`).toBeGreaterThan(0);
    }
  });

  it("cover every save_profile field", () => {
    const missing = shapeKeys("profile", saveProfileShape as never).filter((k) => !covered(k));
    expect(missing).toEqual([]);
  });

  it("cover every save_search_profile field", () => {
    const missing = shapeKeys("search_profile", saveSearchProfileShape as never).filter((k) => !covered(k));
    expect(missing).toEqual([]);
  });

  it("cover every stored search-profile field (the TS type)", () => {
    const missing = Object.keys(SEARCH_PROFILE_FIELDS)
      .map((k) => `search_profile.${k}`)
      .filter((k) => !covered(k));
    expect(missing).toEqual([]);
  });

  it("cover every profile.md setting the engine reads", () => {
    const missing = Object.keys(PROFILE_SETTINGS_FIELDS)
      .map((k) => `profile.${k}`)
      .filter((k) => !covered(k));
    expect(missing).toEqual([]);
    // Read by scoring (profileFactsFrom) and search-profile derivation.
    for (const k of ["profile.languages", "profile.preferences.work_authorization", "profile.preferences.location", "profile.preferences.relocation", "profile.role_shape_preference", "profile.target_roles", "profile.target_seniority", "profile.domains"]) {
      expect(covered(k), k).toBe(true);
    }
  });

  it("cover every autofill.json field and every save_autofill field", () => {
    const fromType = Object.keys(AUTOFILL_FIELDS).map((k) => `autofill.${k}`);
    const fromTool = Object.keys(saveAutofillShape).filter((k) => k !== "mode").map((k) => `autofill.${k}`);
    expect([...fromType, ...fromTool].filter((k) => !covered(k))).toEqual([]);
  });

  it("finds sections by name or number", () => {
    expect(sectionByName("places")?.order).toBe(8);
    expect(sectionByName("9")?.name).toBe("pay");
    expect(sectionByName("nope")).toBeUndefined();
  });
});

describe("checklist and command files stay in sync with the code", () => {
  it("docs/kit-setup-checklist.md is the rendered checklist", () => {
    expect(read("docs/kit-setup-checklist.md")).toBe(renderChecklist());
  });

  it("/setup names every section and the --section flag", () => {
    const cmd = read(".claude/commands/setup.md");
    expect(cmd).toContain("--section");
    for (const s of SETUP_SECTIONS) expect(cmd, s.name).toContain(`\`${s.name}\``);
    for (const tool of ["setup_status", "reconcile_sources", "mark_setup_section", "resume_health_check", "save_autofill"]) {
      expect(cmd, tool).toContain(tool);
    }
  });

  it("the starter commands exist and the skill points to them", () => {
    const skill = read(".claude/skills/kairos/SKILL.md");
    for (const c of ["setup", "find", "score", "tailor", "letter", "prep", "apply", "status", "update"]) {
      expect(read(`.claude/commands/${c}.md`).length, c).toBeGreaterThan(100);
      expect(skill, c).toContain(`/${c}`);
    }
  });
});

describe("setup status", () => {
  const empty: SetupData = {
    profile: {},
    search_profile: null,
    autofill: null,
    kb: { experiences: 0, education: 0, skills: 0, voice_profile: false, writing_samples: false, metrics_register: false, star_stories: false },
  };

  it("starts with everything to do", () => {
    const s = setupStatus(empty, null);
    expect(s.next).toBe("identity");
    expect(s.complete).toBe(false);
    expect(s.sections.every((x) => x.status === "todo")).toBe(true);
  });

  it("a derived search profile is not an answer; a confirmed one is", () => {
    const sp = { function_terms: ["analyst"], source: "derived" };
    expect(isSettingSet({ ...empty, search_profile: sp }, "search_profile.function_terms")).toBe(false);
    expect(isSettingSet({ ...empty, search_profile: { ...sp, source: "confirmed" } }, "search_profile.function_terms")).toBe(true);
  });

  it("a section the user went through is done even with settings left to defaults", () => {
    const s = setupStatus(
      { ...empty, profile: { name: "Jordan Lee" } },
      { version: 1, sections: { identity: { status: "done", at: "2026-11-05" }, education: { status: "skipped", at: "2026-11-05" } }, sources: [] },
    );
    const identity = s.sections.find((x) => x.name === "identity")!;
    expect(identity.status).toBe("done");
    expect(identity.set).toEqual(["profile.name"]);
    expect(identity.unset.find((u) => u.key === "profile.headline")?.default).toBe("No tagline.");
    expect(s.sections.find((x) => x.name === "education")!.status).toBe("skipped");
    expect(s.next).toBe("experience");
  });
});
