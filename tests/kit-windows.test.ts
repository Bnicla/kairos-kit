import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The parts of the Kit that a Windows PC uses in place of the Mac's zsh
 * scripts: install.mjs (the installer), scripts/daily.mjs (the daily routine),
 * scripts/dashboard.mjs (the dashboard's start), and the line in .mcp.json
 * that starts the tool server. They are plain Node, so these tests run them on
 * every system; the Kit's CI runs them on Windows.
 *
 * Each file is at kit/files/ in the source repository and at the root of an
 * exported Kit.
 */
const ROOT = join(__dirname, "..");
const kitFile = (...parts: string[]) => [join(ROOT, "kit", "files", ...parts), join(ROOT, ...parts)].find(existsSync);
const INSTALL = kitFile("install.mjs");
const DAILY = kitFile("scripts", "daily.mjs");
const DAILY_SH = kitFile("scripts", "daily.sh");
const DASHBOARD = kitFile("scripts", "dashboard.mjs");
// In the source repository the root .mcp.json is the owner's own; the Kit's is under kit/files.
const MCP_JSON = [join(ROOT, "kit", "files", ".mcp.json"), join(ROOT, ".mcp.json")].find(existsSync)!;

describe.skipIf(!INSTALL)("install.mjs (the Windows installer)", () => {
  let kit: string;
  let fakeHome: string;
  beforeEach(() => {
    kit = mkdtempSync(join(tmpdir(), "kit-win-"));
    fakeHome = mkdtempSync(join(tmpdir(), "home-win-"));
    cpSync(INSTALL!, join(kit, "install.mjs"));
  });
  afterEach(() => {
    rmSync(kit, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });
  const run = (...args: string[]) => {
    // os.homedir() reads HOME on macOS and Linux, USERPROFILE on Windows.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, NO_COLOR: "1" };
    delete env.KAIROS_HOME;
    try {
      const out = execFileSync(process.execPath, [join(kit, "install.mjs"), "--yes", "--skip-npm", "--tasks-dir", join(kit, "tasks"), ...args], {
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
  const pointer = () => readFileSync(join(kit, ".kairos-home"), "utf8").trim();

  it("refuses an existing knowledge base it did not create, and changes nothing", () => {
    const existing = join(fakeHome, "Kairos");
    mkdirSync(join(existing, "knowledge-base"), { recursive: true });
    writeFileSync(join(existing, "profile.md"), "someone's knowledge base\n");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("did not create");
    expect(existsSync(join(kit, ".kairos-home"))).toBe(false);
    expect(existsSync(join(existing, ".kairos-kit"))).toBe(false);
  });

  it("accepts it with --use-existing and records it without writing into it", () => {
    const existing = join(fakeHome, "Kairos");
    mkdirSync(join(existing, "applications"), { recursive: true });
    expect(run("--use-existing").code).toBe(0);
    expect(pointer()).toBe(existing);
    expect(existsSync(join(existing, ".kairos-kit"))).toBe(false);
    // a re-run keeps the accepted folder without the flag
    expect(run().code).toBe(0);
  });

  it("creates a new folder with --home, marks it, records it, and writes the tool server's start line", () => {
    const target = join(fakeHome, "Kairos Kit data"); // a space, as in many Windows user folders
    const r = run("--home", target);
    expect(r.code, r.out).toBe(0);
    for (const d of ["knowledge-base/experiences", "knowledge-base/education", "applications", "sourcing", "logs", ".kairos-kit"]) {
      expect(existsSync(join(target, d)), d).toBe(true);
    }
    expect(pointer()).toBe(target);
    // The file the Kit ships, letter for letter, so git sees no change after an install.
    expect(readFileSync(join(kit, ".mcp.json"), "utf8")).toBe(readFileSync(MCP_JSON, "utf8").replace(/\r\n/g, "\n"));
    // nothing in the background unless asked
    expect(existsSync(join(kit, "tasks"))).toBe(false);
    const again = run();
    expect(again.code).toBe(0);
    expect(again.out).toContain(target);
  });

  it("starts the data folder from the demo knowledge base with --demo", () => {
    mkdirSync(join(kit, "demo", "knowledge-base", "experiences"), { recursive: true });
    mkdirSync(join(kit, "demo", "applications"), { recursive: true });
    writeFileSync(join(kit, "demo", "profile.md"), "---\nname: Dana Okafor\n---\n");
    writeFileSync(join(kit, "demo", "applications", ".gitkeep"), "");
    const target = join(fakeHome, "Demo");
    expect(run("--home", target, "--demo").code).toBe(0);
    expect(readFileSync(join(target, "profile.md"), "utf8")).toContain("Dana Okafor");
    expect(existsSync(join(target, "applications"))).toBe(true);
    expect(existsSync(join(target, "applications", ".gitkeep"))).toBe(false);
    expect(existsSync(join(target, ".kairos-kit"))).toBe(true);
  });

  it("writes the daily task and the dashboard's start file, and removes the task again", () => {
    const target = join(fakeHome, "Kairos");
    const r = run("--home", target, "--daily", "7:30", "--dashboard", "--port", "3111");
    expect(r.code, r.out).toBe(0);
    // Task Scheduler's file: UTF-16 with a byte-order mark.
    const raw = readFileSync(join(kit, "tasks", "Kairos Kit daily search.xml"));
    expect([raw[0], raw[1]]).toEqual([0xff, 0xfe]);
    const task = raw.subarray(2).toString("utf16le");
    expect(task).toContain("<StartBoundary>2026-01-01T07:30:00</StartBoundary>");
    expect(task).toContain("<DaysInterval>1</DaysInterval>");
    // also on battery, and at the next chance after a missed start
    expect(task).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(task).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(task).toContain(`<Command>${process.execPath.replace(/&/g, "&amp;")}</Command>`);
    expect(task).toContain(`scripts${sep}daily.mjs"</Arguments>`);
    const start = readFileSync(join(kit, "tasks", "Kairos Kit dashboard.cmd"), "utf8");
    expect(start).toContain(`scripts${sep}dashboard.mjs" dev -H 127.0.0.1 -p 3111`);
    expect(start.split("\r\n").length).toBeGreaterThan(4);

    expect(run("--schedule-only", "--no-daily").code).toBe(0);
    expect(existsSync(join(kit, "tasks", "Kairos Kit daily search.xml"))).toBe(false);
  });

  it("refuses a time that is not HH:MM, and --schedule-only without a choice", () => {
    expect(run("--home", join(fakeHome, "Kairos"), "--daily", "25:00").code).toBe(1);
    expect(run("--schedule-only").code).toBe(2);
    expect(run("--no-such-flag").code).toBe(2);
  });
});

describe.skipIf(!DAILY)("scripts/daily.mjs (the daily routine on Windows)", () => {
  let kit: string;
  let home: string;
  beforeEach(() => {
    kit = mkdtempSync(join(tmpdir(), "kit-daily-win-"));
    home = mkdtempSync(join(tmpdir(), "kairos-daily-win-"));
    mkdirSync(join(kit, "apps", "local", "scripts"), { recursive: true });
    mkdirSync(join(home, "sourcing"), { recursive: true });
  });
  afterEach(() => {
    rmSync(kit, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  type Step = { name: string; script: string; args: string[] };
  const load = async () => (await import(/* @vite-ignore */ pathToFileURL(DAILY!).href)) as {
    STEPS: Step[];
    runDaily: (o: { kit: string; home: string; runStep: (s: Step) => boolean; write: (l: string) => void; now?: () => Date }) => string;
    dataFolder: (kit: string, env?: Record<string, string | undefined>) => string;
  };
  const heartbeat = () => JSON.parse(readFileSync(join(home, "sourcing", "daily-heartbeat.json"), "utf8")) as { last_run: string; status: string };
  const tuesday = () => new Date(2026, 10, 17, 8, 15, 0);
  const monday = () => new Date(2026, 10, 16, 8, 15, 0);

  it.skipIf(!DAILY_SH)("runs the steps daily.sh runs, in the same order", async () => {
    const { STEPS } = await load();
    const sh = readFileSync(DAILY_SH!, "utf8");
    const inShell = [...sh.matchAll(/^\s*npm -w kairos-local run (\S+)((?: -- \S+)?)/gm)].map((m) => m[1] + m[2].replace(" -- ", " "));
    expect(STEPS.map((s) => [s.name, ...s.args].join(" "))).toEqual(inShell);
  });

  it("runs every step, harvest before the search, and writes the log lines and the heartbeat", async () => {
    const { runDaily } = await load();
    writeFileSync(join(kit, "apps", "local", "scripts", "dream-watch.mts"), "");
    const ran: string[] = [];
    const lines: string[] = [];
    const status = runDaily({ kit, home, runStep: (s) => (ran.push([s.script, ...s.args].join(" ")), true), write: (l) => lines.push(l), now: tuesday });
    expect(status).toBe("ok");
    expect(ran).toEqual(["prune-closed-listings.mts", "harvest-registry.mts", "sourcing-run.mts", "dream-watch.mts"]);
    expect(lines[0]).toBe("=== Kairos daily routine: 2026-11-17 08:15:00 ===");
    expect(lines.at(-1)).toBe("=== done: 08:15:00 ===");
    expect(heartbeat().status).toBe("ok");
    expect(heartbeat().last_run).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it("adds the deep scan on Mondays, and leaves out a step the Kit does not ship", async () => {
    const { runDaily } = await load();
    const ran: string[] = [];
    runDaily({ kit, home, runStep: (s) => (ran.push([s.script, ...s.args].join(" ")), true), write: () => {}, now: monday });
    expect(ran).toEqual(["prune-closed-listings.mts", "harvest-registry.mts", "sourcing-run.mts", "sourcing-run.mts --deep"]);
  });

  it("a failed search is a failed run, a failed harvest is not, and a later smaller failure does not hide it", async () => {
    const { runDaily } = await load();
    writeFileSync(join(kit, "apps", "local", "scripts", "dream-watch.mts"), "");
    const lines: string[] = [];
    expect(runDaily({ kit, home, runStep: (s) => s.script !== "harvest-registry.mts", write: (l) => lines.push(l), now: tuesday })).toBe("ok");
    expect(lines).toContain("harvest failed; sweeping with the current job-board list");
    expect(runDaily({ kit, home, runStep: (s) => s.script === "harvest-registry.mts", write: () => {}, now: tuesday })).toBe("failed");
    expect(heartbeat().status).toBe("failed");
    expect(runDaily({ kit, home, runStep: (s) => s.script !== "prune-closed-listings.mts", write: () => {}, now: tuesday })).toBe("degraded");
  });

  it("does nothing when the daily run is turned off in the search profile", async () => {
    const { runDaily } = await load();
    writeFileSync(join(home, "sourcing", "search-profile.json"), JSON.stringify({ daily_run: { enabled: false } }));
    const ran: string[] = [];
    expect(runDaily({ kit, home, runStep: (s) => (ran.push(s.script), true), write: () => {}, now: tuesday })).toBe("off");
    expect(ran).toEqual([]);
    expect(existsSync(join(home, "sourcing", "daily-heartbeat.json"))).toBe(false);
  });

  it("finds the data folder the way the tool server does", async () => {
    const { dataFolder } = await load();
    expect(dataFolder(kit, { KAIROS_HOME: home })).toBe(home);
    writeFileSync(join(kit, ".kairos-home"), home + "\r\n");
    expect(dataFolder(kit, {})).toBe(home);
  });
});

describe.skipIf(!DASHBOARD)("scripts/dashboard.mjs (the dashboard's start)", () => {
  it("turns the access check on and takes dev or start only", () => {
    const text = readFileSync(DASHBOARD!, "utf8");
    expect(text).toMatch(/KAIROS_LOCAL_ONLY: "1"/);
    let code = 0;
    try {
      execFileSync(process.execPath, [DASHBOARD!, "build"], { stdio: "ignore" });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(2);
  });

  // Only where the Kit is laid out as shipped (scripts/ beside apps/): it finds Next and hands it the arguments.
  it.skipIf(join(ROOT, "scripts", "dashboard.mjs") !== DASHBOARD)("finds Next and passes the arguments on, without starting a server", () => {
    const out = execFileSync(process.execPath, [DASHBOARD!, "dev", "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(out).toMatch(/next dev/i);
  });

  it("is what the Kit's dev and start scripts run, bound to this computer", () => {
    // In an exported Kit: the package's own scripts. In the source repository: the lines of the export that write them.
    const exported = join(ROOT, "scripts", "dashboard.mjs") === DASHBOARD;
    const lines = exported
      ? Object.values((JSON.parse(readFileSync(join(ROOT, "apps", "local", "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts).filter((s) => /dashboard\.mjs/.test(s))
      : readFileSync(join(ROOT, "scripts", "export-kit.mts"), "utf8").split("\n").filter((l) => /localPkg\.scripts\.(?:dev|start) =/.test(l));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/node \.\.\/\.\.\/scripts\/dashboard\.mjs (?:dev|start) -H 127\.0\.0\.1/);
      // "NAME=value command" is a form cmd.exe and PowerShell do not have.
      expect(line).not.toMatch(/\b[A-Z_]+=\S+ /);
    }
  });
});

describe("the Kit's .mcp.json", () => {
  const home = mkdtempSync(join(tmpdir(), "kairos-mcp-line-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("starts the tool server with a program Windows can start directly", async () => {
    const { command, args } = (JSON.parse(readFileSync(MCP_JSON, "utf8")) as { mcpServers: { kairos: { command: string; args: string[] } } }).mcpServers.kairos;
    // node is node.exe; npx and tsx are .cmd files, which Claude Code on Windows cannot start without `cmd /c`.
    expect(command).toBe("node");
    const client = new Client({ name: "kit-windows-test", version: "0" });
    await client.connect(new StdioClientTransport({ command, args, cwd: ROOT, env: { ...process.env, KAIROS_HOME: home } as Record<string, string>, stderr: "ignore" }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("list_applications");
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe("line endings", () => {
  it("the Kit asks git for Unix line endings on every system", () => {
    const file = [join(ROOT, "kit", "files", ".gitattributes"), join(ROOT, ".gitattributes")].find(existsSync);
    // The source repository has no such file of its own; the Kit's is under kit/files.
    expect(file).toBeDefined();
    expect(readFileSync(file!, "utf8")).toMatch(/^\* text=auto eol=lf$/m);
  });
});
