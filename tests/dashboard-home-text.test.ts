import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The dashboard home page tells the user which command to run and what the
// page does to the data folder. Both statements must match the product.
const ROOT = join(__dirname, "..");
const page = readFileSync(join(ROOT, "apps/local/app/page.tsx"), "utf8");

describe("dashboard home page text", () => {
  it("names only slash commands that exist in .claude/commands", () => {
    const named = [...page.matchAll(/<code>\/([a-z-]+)<\/code>/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(existsSync(join(ROOT, ".claude/commands", `${name}.md`)), `/${name}`).toBe(true);
  });

  it("does not call itself read-only (it can change a status, archive and delete)", () => {
    expect(page).toMatch(/archiveAction/);
    expect(page).not.toMatch(/read-only/i);
  });
});
