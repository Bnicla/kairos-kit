import { describe, it, expect } from "vitest";
import {
  deriveSearchProfile,
  describeSearchProfile,
  mergeSearchProfile,
  updateSearchProfile,
  loadSearchProfile,
  saveSearchProfile,
  type StoredSearchProfile,
} from "@kairos/engine/sourcing/search-profile";
import type { Store } from "@kairos/engine/store/types";
import { boardFromUrl } from "@kairos/engine/sourcing/sweep";

describe("deriveSearchProfile", () => {
  const fm = {
    target_roles: ["Director of Product", "Head of Product / VP Product", "Principal Product Manager"],
    target_seniority: "Director / Executive / Principal",
    domains: ["Generative AI", "Enterprise SaaS"],
    preferences: { location: "Greater Chicago (IL)" },
    role_shape_preference: "Leaning toward people-management scope.",
  };
  const p = deriveSearchProfile(fm, () => "2026-08-04T00:00:00Z");

  it("derives discipline, seniority, locations and boosts from the candidate profile", () => {
    expect(p.function_terms).toContain("product");
    expect(p.seniority_terms).toEqual(expect.arrayContaining(["principal", "director", "head of", "vp"]));
    expect(p.locations).toContain("greater chicago (il)");
    expect(p.boost_terms).toContain("generative ai");
    expect(p.notes).toMatch(/people-management/);
    expect(p.source).toBe("derived");
  });

  it("assumes no discipline and no excludes when the candidate profile states none", () => {
    const empty = deriveSearchProfile({});
    expect(empty.function_terms).toEqual([]);
    expect(empty.exclude_terms).toEqual([]);
    expect(empty.max_age_days).toBe(7);
  });

  it("describes the profile in plain language", () => {
    expect(describeSearchProfile(p)).toMatch(/last 7 days/);
    expect(describeSearchProfile(p)).toMatch(/not yet confirmed/);
  });
});

describe("boardFromUrl", () => {
  it("maps public-ATS job URLs to registry entries", () => {
    expect(boardFromUrl("https://job-boards.greenhouse.io/examplecorp/jobs/1000000001")).toEqual({
      ats: "greenhouse",
      slug: "examplecorp",
    });
    expect(boardFromUrl("https://jobs.ashbyhq.com/samplelabs/00000000-0000-4000-8000-000000000001")).toEqual({
      ats: "ashby",
      slug: "samplelabs",
    });
    expect(boardFromUrl("https://ats.rippling.com/demoworks/jobs/0000abcd")).toEqual({
      ats: "rippling",
      slug: "demoworks",
    });
    expect(boardFromUrl("https://careers.example.com/en/jobs/1234567/")).toBeNull();
    expect(boardFromUrl(undefined)).toBeNull();
  });
});

/** Just enough Store for a JSON round trip. */
function jsonStore(): Store {
  const files = new Map<string, string>();
  const key = (p: string[]) => p.join("/");
  return {
    listFiles: async () => [],
    listFolders: async () => [],
    readFile: async (p) => files.get(key(p)) ?? null,
    readBinary: async () => null,
    writeFile: async (p, c) => (files.set(key(p), c), key(p)),
    writeBinary: async (p) => key(p),
    readJson: async <T,>(p: string[]) => {
      const raw = files.get(key(p));
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    writeJson: async (p, d) => (files.set(key(p), JSON.stringify(d)), key(p)),
  };
}

describe("search profile saves merge, never drop", () => {
  const stored: StoredSearchProfile = {
    function_terms: ["product"],
    exclude_terms: ["intern"],
    locations: ["denver", "remote"],
    secondary_locations: ["seattle"],
    excluded_locations: ["austin"],
    boost_terms: ["ai"],
    seniority_terms: ["director"],
    max_age_days: 7,
    watched_companies: ["acme", "globex"],
    triage_rules: ["Crypto companies are out of scope."],
    international_ok: false,
    notes: "Prefers player-coach roles.",
    updated_at: "2026-10-01T00:00:00Z",
    source: "confirmed",
  };
  const now = () => "2026-10-27T00:00:00Z";

  it("keeps fields the update does not mention", () => {
    const next = mergeSearchProfile(stored, { max_age_days: 3, source: "confirmed" }, now);
    expect(next.max_age_days).toBe(3);
    expect(next.watched_companies).toEqual(["acme", "globex"]);
    expect(next.triage_rules).toEqual(["Crypto companies are out of scope."]);
    expect(next.excluded_locations).toEqual(["austin"]);
    expect(next.secondary_locations).toEqual(["seattle"]);
    expect(next.notes).toBe("Prefers player-coach roles.");
    expect(next.updated_at).toBe("2026-10-27T00:00:00Z");
  });

  it("replaces a field the update sets, and an empty list clears it", () => {
    const next = mergeSearchProfile(stored, { watched_companies: ["initech"], triage_rules: [] }, now);
    expect(next.watched_companies).toEqual(["initech"]);
    expect(next.triage_rules).toEqual([]);
  });

  it("ignores undefined values instead of erasing the stored ones", () => {
    const next = mergeSearchProfile(stored, { locations: undefined, source: "confirmed" }, now);
    expect(next.locations).toEqual(["denver", "remote"]);
  });

  it("starts from a derived profile when nothing is stored yet", () => {
    const next = mergeSearchProfile(null, { locations: ["denver"] }, now);
    expect(next.locations).toEqual(["denver"]);
    expect(next.max_age_days).toBe(7);
    expect(next.source).toBe("derived");
  });

  it("round-trips through the store without losing fields", async () => {
    const store = jsonStore();
    await saveSearchProfile(store, stored);
    await updateSearchProfile(store, { boost_terms: ["health"], source: "confirmed" }, now);
    const reloaded = await loadSearchProfile(store);
    expect(reloaded?.boost_terms).toEqual(["health"]);
    expect(reloaded?.watched_companies).toEqual(["acme", "globex"]);
    expect(reloaded?.triage_rules).toEqual(["Crypto companies are out of scope."]);
    expect(reloaded?.excluded_locations).toEqual(["austin"]);
  });
});
