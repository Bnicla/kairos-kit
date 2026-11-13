import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The daily run refreshes the job-board list into the data folder
// ($KAIROS_HOME/sourcing/registry.json). The tracked list in the checkout is
// never rewritten, so the checkout stays unmodified and /update can pull.

const ROOT = join(__dirname, "..");
// apps/cloud/scripts in this repo, apps/local/scripts in the exported kit.
const SCRIPT = ["apps/cloud/scripts", "apps/local/scripts"].map((d) => join(ROOT, d, "harvest-registry.mts")).find(existsSync)!;
const TRACKED = join(ROOT, "packages/engine/sourcing/registry.json");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("harvest-registry writes to the data folder", () => {
  let home: string;
  let stub: string;
  let called: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kairos-harvest-"));
    called = join(home, "fetch-called");
    // Stands in for the Common Crawl index: one crawl, one index page per
    // pattern, one made-up board. No network.
    stub = join(home, "fetch-stub.mjs");
    writeFileSync(
      stub,
      `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url) => {
  appendFileSync(${JSON.stringify(called)}, String(url) + "\\n");
  const u = String(url);
  if (u.includes("collinfo.json")) return new Response(JSON.stringify([{ id: "CC-TEST" }]));
  if (u.includes("showNumPages")) return new Response(JSON.stringify({ pages: 1 }));
  return new Response(JSON.stringify({ url: "https://boards.greenhouse.io/madeupboardzz/jobs/1" }) + "\\n");
};
`,
    );
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const run = (...args: string[]) =>
    execFileSync(TSX, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, KAIROS_HOME: home, NODE_OPTIONS: `--import ${pathToFileURL(stub).href}` },
    });
  const dataCopy = () => join(home, "sourcing", "registry.json");
  const writeDataCopy = (harvested_at: string) => {
    mkdirSync(join(home, "sourcing"), { recursive: true });
    writeFileSync(dataCopy(), JSON.stringify({ version: 1, harvested_at, entries: [{ ats: "ashby", slug: "onlyinthedatacopy" }] }));
  };

  it("does nothing when the data-folder copy is under 30 days old", () => {
    writeDataCopy(new Date().toISOString());
    const before = sha(dataCopy());
    const trackedBefore = sha(TRACKED);
    expect(run()).toMatch(/nothing to do/);
    expect(existsSync(called)).toBe(false);
    expect(sha(dataCopy())).toBe(before);
    expect(sha(TRACKED)).toBe(trackedBefore);
  }, 60_000);

  it("refreshes a stale data-folder copy in place and leaves the tracked list untouched", () => {
    writeDataCopy("2020-01-01T00:00:00Z");
    const trackedBefore = sha(TRACKED);
    const seedCount = JSON.parse(readFileSync(TRACKED, "utf8")).entries.length;
    run();
    expect(sha(TRACKED)).toBe(trackedBefore);
    const out = JSON.parse(readFileSync(dataCopy(), "utf8"));
    expect(out.crawl).toBe("CC-TEST");
    expect(Date.now() - new Date(out.harvested_at).getTime()).toBeLessThan(5 * 60_000);
    const keys = new Set(out.entries.map((e: { ats: string; slug: string }) => `${e.ats}:${e.slug}`));
    expect(keys.has("greenhouse:madeupboardzz")).toBe(true); // found by the harvest
    expect(keys.has("ashby:onlyinthedatacopy")).toBe(true); // kept from the data copy
    expect(out.entries.length).toBeGreaterThanOrEqual(seedCount + 2); // and every board of the tracked list
  }, 60_000);

  it("creates the data-folder copy on a first forced run", () => {
    const trackedBefore = sha(TRACKED);
    run("--force");
    expect(sha(TRACKED)).toBe(trackedBefore);
    const out = JSON.parse(readFileSync(dataCopy(), "utf8"));
    expect(out.entries.some((e: { slug: string }) => e.slug === "madeupboardzz")).toBe(true);
  }, 60_000);
});

// The kit's daily script calls the harvest step and writes nothing into the kit folder.
const DAILY = [join(ROOT, "kit", "files", "scripts", "daily.sh"), join(ROOT, "scripts", "daily.sh")].find(existsSync);
describe.skipIf(!DAILY || !existsSync("/bin/zsh"))("daily.sh", () => {
  let kit: string;
  let home: string;
  beforeEach(() => {
    kit = mkdtempSync(join(tmpdir(), "kit-daily-"));
    home = mkdtempSync(join(tmpdir(), "kairos-daily-"));
    mkdirSync(join(kit, "scripts"));
    cpSync(DAILY!, join(kit, "scripts", "daily.sh"));
    // A stand-in npm, found first through KAIROS_NODE_DIR, that records each call.
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "npm"), `#!/bin/sh\necho "$*" >> "${join(home, "npm-calls")}"\n`, { mode: 0o755 });
  });
  afterEach(() => {
    rmSync(kit, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("runs the harvest step before the search and leaves the kit folder as it was", () => {
    execFileSync("/bin/zsh", [join(kit, "scripts", "daily.sh")], {
      env: { ...process.env, KAIROS_HOME: home, KAIROS_NODE_DIR: join(home, "bin"), KAIROS_TOKEN_FILE: join(home, "no-token") },
      stdio: "ignore",
    });
    const calls = readFileSync(join(home, "npm-calls"), "utf8").trim().split("\n");
    const harvest = calls.indexOf("-w kairos-local run harvest-registry");
    expect(harvest).toBeGreaterThan(-1);
    expect(calls.indexOf("-w kairos-local run sourcing-run")).toBeGreaterThan(harvest);
    expect(JSON.parse(readFileSync(join(home, "sourcing", "daily-heartbeat.json"), "utf8")).status).toBe("ok");
    expect(readdirSync(kit)).toEqual(["scripts"]);
    expect(readdirSync(join(kit, "scripts"))).toEqual(["daily.sh"]);
    expect(readFileSync(join(kit, "scripts", "daily.sh"), "utf8")).not.toMatch(/packages\/engine\/sourcing\/registry\.json/);
  });
});
