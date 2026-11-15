import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The MCP SDK had security advisories in 2026 whose fixes end at 1.32.0
 * (GHSA-f897-62hf-6gxq fixed in 1.30.1; GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq
 * and GHSA-22jm-h49p-29qw fixed in 1.32.0). The version a package declares is
 * the lowest one an install may choose: it must not be inside those ranges,
 * and the lock must hold a version at or above it.
 */
describe("the MCP SDK's declared floor", () => {
  const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  const parts = (v: string) => v.replace(/^[\^~]/, "").split(".").map(Number);
  const atLeast = (v: string, floor: [number, number, number]) => {
    const [a, b, c] = parts(v);
    return a > floor[0] || (a === floor[0] && (b > floor[1] || (b === floor[1] && c >= floor[2])));
  };

  it("apps/connector and apps/local declare 1.32.0 or later, and the lock holds what they declare", () => {
    const locked: string = json("package-lock.json").packages["node_modules/@modelcontextprotocol/sdk"].version;
    expect(atLeast(locked, [1, 32, 0]), locked).toBe(true);
    // The Kit ships apps/local only.
    const packages = ["apps/connector/package.json", "apps/local/package.json"].filter((pkg) => existsSync(pkg));
    expect(packages).toContain("apps/local/package.json");
    for (const pkg of packages) {
      const declared: string = json(pkg).dependencies["@modelcontextprotocol/sdk"];
      expect(declared, pkg).toMatch(/^\^1\.\d+\.\d+$/);
      expect(atLeast(declared, [1, 32, 0]), `${pkg} declares ${declared}`).toBe(true);
      expect(atLeast(locked, parts(declared) as [number, number, number]), `${pkg} declares ${declared}, the lock has ${locked}`).toBe(true);
    }
  });

  it("the build checks the installed packages against known advisories, before the tests", () => {
    // The Kit has its own build file, or none.
    const file = ".github/workflows/ci.yml";
    if (!existsSync(file)) return;
    const steps = readFileSync(file, "utf8");
    expect(steps).toMatch(/^\s+run: npm audit --omit=dev --audit-level=high$/m);
    expect(steps.indexOf("npm audit")).toBeGreaterThan(steps.indexOf("npm ci"));
    expect(steps.indexOf("npm audit")).toBeLessThan(steps.indexOf("vitest run"));
  });
});
