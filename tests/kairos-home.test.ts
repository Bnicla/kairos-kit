import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_POINTER, kairosHome } from "../apps/local/store/local-fs";

// One resolver for the MCP server, the dashboard, the scripts and /find:
// KAIROS_HOME, then .kairos-home in the folder or a parent, then ~/Kairos.
describe("kairosHome()", () => {
  let root: string;
  let prev: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kairos-home-"));
    prev = process.env.KAIROS_HOME;
    delete process.env.KAIROS_HOME;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.KAIROS_HOME;
    else process.env.KAIROS_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  });

  it("reads .kairos-home from a parent folder (npm -w and Next run from apps/local)", () => {
    writeFileSync(join(root, HOME_POINTER), "/data/student-record\n");
    const sub = join(root, "apps", "local");
    mkdirSync(sub, { recursive: true });
    expect(kairosHome(sub)).toBe("/data/student-record");
    expect(kairosHome(root)).toBe("/data/student-record");
  });

  it("lets KAIROS_HOME win over the pointer", () => {
    writeFileSync(join(root, HOME_POINTER), "/data/student-record\n");
    process.env.KAIROS_HOME = "/data/override";
    expect(kairosHome(root)).toBe("/data/override");
  });

  it("expands ~ and falls back to ~/Kairos with no pointer", () => {
    writeFileSync(join(root, HOME_POINTER), "~/KairosKit\n");
    expect(kairosHome(root)).toBe(join(homedir(), "KairosKit"));
    const bare = mkdtempSync(join(tmpdir(), "kairos-bare-"));
    try {
      // tmpdir has no .kairos-home above it on a normal machine
      expect(kairosHome(bare)).toBe(join(homedir(), "Kairos"));
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// The installer refuses a data folder that holds a record it did not create.
const zsh = existsSync("/bin/zsh");
describe.skipIf(!zsh)("install.sh data folder", () => {
  let kit: string;
  let fakeHome: string;
  beforeEach(() => {
    kit = mkdtempSync(join(tmpdir(), "kit-"));
    fakeHome = mkdtempSync(join(tmpdir(), "home-"));
    // kit/files/install.sh in this repo, install.sh at the root of the exported kit
    const src = [join(__dirname, "..", "kit", "files", "install.sh"), join(__dirname, "..", "install.sh")].find(existsSync)!;
    cpSync(src, join(kit, "install.sh"));
  });
  afterEach(() => {
    rmSync(kit, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });
  const run = (...args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
    delete env.KAIROS_HOME;
    try {
      const out = execFileSync("/bin/zsh", [join(kit, "install.sh"), "--yes", "--skip-npm", "--launchd-dir", join(kit, "la"), ...args], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: err.stdout + err.stderr };
    }
  };

  it("refuses an existing record it did not create, and changes nothing", () => {
    const record = join(fakeHome, "Kairos");
    mkdirSync(join(record, "knowledge-base"), { recursive: true });
    writeFileSync(join(record, "profile.md"), "someone's record\n");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("did not create");
    expect(existsSync(join(kit, ".kairos-home"))).toBe(false);
    expect(existsSync(join(record, ".kairos-kit"))).toBe(false);
  });

  it("accepts it with --use-existing and records it without writing into it", () => {
    const record = join(fakeHome, "Kairos");
    mkdirSync(join(record, "applications"), { recursive: true });
    const r = run("--use-existing");
    expect(r.code).toBe(0);
    expect(readFileSync(join(kit, ".kairos-home"), "utf8").trim()).toBe(record);
    expect(existsSync(join(record, ".kairos-kit"))).toBe(false);
    // a re-run keeps the accepted folder without the flag
    expect(run().code).toBe(0);
  });

  it("creates a new folder with --home, marks it, records it, and keeps .mcp.json plain", () => {
    const target = join(fakeHome, "KairosKit");
    const r = run("--home", target);
    expect(r.code).toBe(0);
    expect(existsSync(join(target, ".kairos-kit"))).toBe(true);
    expect(readFileSync(join(kit, ".kairos-home"), "utf8").trim()).toBe(target);
    const mcp = readFileSync(join(kit, ".mcp.json"), "utf8");
    expect(mcp).not.toContain("KAIROS_HOME");
    expect(JSON.parse(mcp).mcpServers.kairos.args).toEqual(["tsx", "apps/local/mcp/server.ts"]);
    // the re-run reads .kairos-home back
    const again = run();
    expect(again.code).toBe(0);
    expect(again.out).toContain(target);
  });
});
