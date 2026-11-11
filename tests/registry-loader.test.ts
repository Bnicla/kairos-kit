import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dedupeRegistry,
  parseRegistry,
  registryKey,
  registryStalenessWarning,
  resolveRegistry,
} from "@kairos/engine/sourcing/registry-loader";

const seed = { harvested_at: "2026-08-01T00:00:00Z", entries: [{ ats: "greenhouse" as const, slug: "seedco" }] };

describe("registry loader (REQ-15)", () => {
  it("prefers a valid data copy over the seed", () => {
    const data = { harvested_at: "2026-08-28T00:00:00Z", entries: [{ ats: "ashby", slug: "fresh" }] };
    const r = resolveRegistry(data, seed, new Date("2026-08-30").getTime());
    expect(r.source).toBe("data");
    expect(r.registry.entries[0].slug).toBe("fresh");
    expect(r.staleness).toBeNull();
  });

  it("falls back to the seed on missing or malformed data", () => {
    for (const bad of [null, {}, { entries: [] }, { entries: "nope" }]) {
      const r = resolveRegistry(bad, seed, new Date("2026-08-10").getTime());
      expect(r.source).toBe("seed");
      expect(r.registry.entries[0].slug).toBe("seedco");
    }
  });

  it("warns when the chosen registry is older than 30 days", () => {
    const r = resolveRegistry(null, seed, new Date("2026-09-15").getTime());
    expect(r.staleness).toMatch(/45 days old/);
  });

  it("warns when harvested_at is missing entirely", () => {
    expect(registryStalenessWarning(undefined)).toMatch(/no harvested_at/);
  });

  it("parseRegistry drops entries missing slug or ats", () => {
    const p = parseRegistry({ entries: [{ ats: "ashby", slug: "ok" }, { ats: "ashby" }, { slug: "x" }, null] });
    expect(p?.entries).toHaveLength(1);
  });
});

describe("registry dedupe (a Workday site listed in two spellings was swept twice, 2026-11-05)", () => {
  it("folds the case of Workday sites and data centers and of SmartRecruiters ids, nothing else", () => {
    expect(registryKey({ ats: "workday", slug: "acme@wd5@External_Careers" })).toBe(registryKey({ ats: "workday", slug: "acme@WD5@external_careers" }));
    // The tenant is case-sensitive in the Workday API path.
    expect(registryKey({ ats: "workday", slug: "Acme@wd5@external" })).not.toBe(registryKey({ ats: "workday", slug: "acme@wd5@external" }));
    expect(registryKey({ ats: "smartrecruiters", slug: "AcmeCo" })).toBe(registryKey({ ats: "smartrecruiters", slug: "acmeco" }));
    expect(registryKey({ ats: "greenhouse", slug: "AcmeCo" })).not.toBe(registryKey({ ats: "greenhouse", slug: "acmeco" }));
    expect(registryKey({ ats: "workday", slug: "acme@wd5@external" })).not.toBe(registryKey({ ats: "smartrecruiters", slug: "acme@wd5@external" }));
  });

  it("keeps the first spelling and counts what it dropped", () => {
    const { entries, removed } = dedupeRegistry([
      { ats: "workday" as const, slug: "acme@wd5@external" },
      { ats: "greenhouse" as const, slug: "acme" },
      { ats: "workday" as const, slug: "acme@wd5@External" },
      { ats: "smartrecruiters" as const, slug: "Globex" },
      { ats: "smartrecruiters" as const, slug: "globex" },
    ]);
    expect(entries.map((e) => e.slug)).toEqual(["acme@wd5@external", "acme", "Globex"]);
    expect(removed).toBe(2);
  });

  it("resolveRegistry dedupes whichever source wins and reports the count", () => {
    const data = { harvested_at: "2026-08-28T00:00:00Z", entries: [{ ats: "workday", slug: "acme@wd1@Careers" }, { ats: "workday", slug: "acme@wd1@careers" }] };
    const r = resolveRegistry(data, seed, new Date("2026-08-30").getTime());
    expect(r.registry.entries).toEqual([{ ats: "workday", slug: "acme@wd1@Careers" }]);
    expect(r.duplicates_removed).toBe(1);
    expect(resolveRegistry(null, seed).duplicates_removed).toBe(0);
  });

  it("the committed seed has no repeated boards", () => {
    const file = JSON.parse(readFileSync(new URL("../packages/engine/sourcing/registry.json", import.meta.url), "utf8"));
    expect(file.entries.length).toBeGreaterThan(1000);
    expect(dedupeRegistry(file.entries).removed).toBe(0);
  });
});

describe("isNonPublicBoard", () => {
  it("drops internal, private and test career sites, keeps companies whose names hold those words", async () => {
    const { isNonPublicBoard } = await import("@kairos/engine/sourcing/registry-loader");
    for (const e of [
      { ats: "workday", slug: "acme@wd5@Careers_Acme_Private" },
      { ats: "workday", slug: "acme@wd3@acme_internal" },
      { ats: "workday", slug: "acme@wd1@Test" },
      { ats: "greenhouse", slug: "acmeinternal" },
      { ats: "greenhouse", slug: "acmesandbox" },
      { ats: "greenhouse", slug: "acmetest" },
    ]) expect(isNonPublicBoard(e), e.slug).toBe(true);
    for (const e of [
      { ats: "workday", slug: "usertesting@wd12@UserTesting" },
      { ats: "workday", slug: "acme@wd5@External" },
      { ats: "ashby", slug: "sandboxaq" },
      { ats: "bamboohr", slug: "privateai" },
      { ats: "ashby", slug: "testgorilla" },
    ]) expect(isNonPublicBoard(e), e.slug).toBe(false);
  });
});
