#!/usr/bin/env node
// Kairos Kit installer for Windows. On a Mac, use ./install.sh.
//
//   node install.mjs                     interactive
//   node install.mjs --yes               accept the defaults, nothing in the background
//   node install.mjs --home D:\MyKairos  data folder somewhere else (default: Kairos in your user folder)
//   node install.mjs --use-existing      accept a data folder that already holds a
//                                        knowledge base this kit did not create
//   node install.mjs --demo              start the data folder from the demo knowledge base
//   node install.mjs --dashboard         start the dashboard each time you sign in
//   node install.mjs --daily 08:15       run the daily job search at that time
//   node install.mjs --schedule-only --daily 08:00
//                                        only (re)install the daily search; /setup uses this
//   node install.mjs --schedule-only --no-daily
//                                        only remove the daily search
//
// Other flags: --skip-npm (packages already installed), --port <n> (dashboard
//              port, default 3000), --tasks-dir <dir> (write the task files
//              there and register nothing; for testing).
//
// It never changes an existing data folder. A folder that already holds a
// knowledge base (profile.md, knowledge-base\ or applications\) that this kit
// did not create is refused unless --use-existing is given.
//
// The data folder is recorded in .kairos-home at the kit root (not tracked by
// git). The MCP server, the dashboard, the scripts and /find all read it.
//
// In the background, on Windows:
//   - the daily search is a task in Task Scheduler, "Kairos Kit daily search",
//     which runs scripts\daily.mjs while you are signed in;
//   - the dashboard is a file in your Startup folder, "Kairos Kit dashboard.cmd",
//     which starts scripts\dashboard.mjs in a minimized window when you sign in.
// On macOS and Linux this script installs the packages and the data folder
// only; the Mac's background services are set up by ./install.sh.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const KIT = dirname(fileURLToPath(import.meta.url));
const WINDOWS = process.platform === "win32";
export const DAILY_TASK = "Kairos Kit daily search";
export const DASHBOARD_FILE = "Kairos Kit dashboard.cmd";

// ---- output -----------------------------------------------------------------------
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
const ok = (msg) => console.log(`${paint(32, "✓")} ${msg}`);
const warn = (msg) => console.log(`${paint(33, "!")} ${msg}`);
class Stop extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
const fail = (msg) => {
  throw new Stop(msg);
};

// ---- arguments --------------------------------------------------------------------
function parseArgs(argv) {
  const o = { yes: false, home: null, demo: false, useExisting: false, dashboard: false, askedDashboard: false, daily: "", askedDaily: false, skipNpm: false, scheduleOnly: false, port: 3000, tasksDir: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) throw new Stop(`${a} needs a value (see --help)`, 2);
      return argv[++i];
    };
    if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--home") o.home = value();
    else if (a === "--demo") o.demo = true;
    else if (a === "--use-existing") o.useExisting = true;
    else if (a === "--dashboard") (o.dashboard = true), (o.askedDashboard = true);
    else if (a === "--no-dashboard") (o.dashboard = false), (o.askedDashboard = true);
    else if (a === "--daily") (o.daily = value()), (o.askedDaily = true);
    else if (a === "--no-daily") (o.daily = ""), (o.askedDaily = true);
    else if (a === "--skip-npm") o.skipNpm = true;
    else if (a === "--schedule-only") o.scheduleOnly = true;
    else if (a === "--port") {
      o.port = Number(value());
      if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65535) throw new Stop("--port takes a number from 1024 to 65535.", 1);
    } else if (a === "--tasks-dir") o.tasksDir = resolve(value());
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Stop(`Unknown option: ${a} (see --help)`, 2);
  }
  return o;
}

const expandTilde = (p) => (p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p);
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** A program on PATH, with the endings Windows runs; null when it is not there. */
function onPath(name) {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH");
  const endings = WINDOWS ? [".exe", ".cmd", ".com"] : [""];
  for (const dir of (key ? process.env[key] : "").split(delimiter).filter(Boolean)) {
    for (const ending of endings) if (isFile(join(dir, name + ending))) return join(dir, name + ending);
  }
  return null;
}

function findLibreOffice() {
  const env = process.env;
  const spots = [
    env.SOFFICE_PATH,
    ...[env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")].filter(Boolean).map((d) => join(d, "LibreOffice", "program", "soffice.exe")),
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ];
  return spots.find((p) => p && isFile(p)) ?? onPath("soffice");
}

// ---- the two background pieces on Windows -------------------------------------------
const xml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The signed-in account as Task Scheduler names it: its SID when Windows gives it, else DOMAIN\name. */
function windowsAccount() {
  try {
    const out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const sid = out.match(/S-1-[0-9-]+/)?.[0];
    if (sid) return sid;
  } catch {
    // fall through to the name
  }
  const name = process.env.USERNAME || process.env.USER || "";
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
}

/**
 * The daily search as a Task Scheduler task: every day at the given time, in
 * the signed-in user's own session, also on battery, and at the next chance
 * when the computer was off or asleep at that time.
 */
export function dailyTaskXml({ kit, node, hour, minute, account }) {
  const pad = (n) => String(n).padStart(2, "0");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Kairos Kit: the daily job search (scripts\\daily.mjs). Set up by install.mjs; remove it with: node install.mjs --schedule-only --no-daily</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T${pad(hour)}:${pad(minute)}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(account)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT3H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(node)}</Command>
      <Arguments>"${xml(join(kit, "scripts", "daily.mjs"))}"</Arguments>
      <WorkingDirectory>${xml(kit)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** The file in the Startup folder that starts the dashboard, minimized, at sign-in. */
export function dashboardStartupFile({ kit, node, port }) {
  // In a .cmd file a % is written twice; the code page line lets a folder name with accents through.
  const q = (p) => `"${String(p).replace(/%/g, "%%")}"`;
  return [
    "@echo off",
    "rem Kairos Kit dashboard, started when you sign in. Written by install.mjs.",
    "rem Delete this file to stop that. Closing the dashboard's window stops the dashboard.",
    "chcp 65001 >nul",
    `cd /d ${q(kit)}`,
    `start "Kairos Kit dashboard" /min ${q(node)} ${q(join(kit, "scripts", "dashboard.mjs"))} dev -H 127.0.0.1 -p ${port}`,
    "",
  ].join("\r\n");
}

const schtasks = (...args) => spawnSync("schtasks", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const startupFolder = () => join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");

function installDaily(o, daily) {
  const m = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/.exec(daily);
  if (!m) fail(`--daily needs HH:MM, got '${daily}'`);
  const text = dailyTaskXml({ kit: KIT, node: process.execPath, hour: Number(m[1]), minute: Number(m[2]), account: WINDOWS ? windowsAccount() : "the signed-in user" });
  // Task Scheduler reads the file as UTF-16 with a byte-order mark.
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\n/g, "\r\n"), "utf16le")]);
  if (o.tasksDir) {
    mkdirSync(o.tasksDir, { recursive: true });
    const file = join(o.tasksDir, `${DAILY_TASK}.xml`);
    writeFileSync(file, bytes);
    ok(`Task file written (not registered): ${file}`);
    return;
  }
  const file = join(tmpdir(), `kairos-kit-daily-${process.pid}.xml`);
  writeFileSync(file, bytes);
  try {
    const made = schtasks("/Create", "/TN", DAILY_TASK, "/XML", file, "/F");
    if (made.status !== 0) fail(`Task Scheduler refused the task "${DAILY_TASK}": ${(made.stderr || made.stdout || String(made.error ?? "")).trim()}`);
    if (schtasks("/Query", "/TN", DAILY_TASK).status !== 0) fail(`The task "${DAILY_TASK}" did not register with Task Scheduler.`);
  } finally {
    rmSync(file, { force: true });
  }
  ok(`Task registered: ${DAILY_TASK}`);
}

function removeDaily(o) {
  if (o.tasksDir) {
    const file = join(o.tasksDir, `${DAILY_TASK}.xml`);
    if (existsSync(file)) (rmSync(file), ok("Daily job search removed"));
    else ok("Daily job search: not installed");
    return;
  }
  if (schtasks("/Query", "/TN", DAILY_TASK).status !== 0) return ok("Daily job search: not installed");
  const gone = schtasks("/Delete", "/TN", DAILY_TASK, "/F");
  if (gone.status !== 0) fail(`Could not remove the task "${DAILY_TASK}": ${(gone.stderr || gone.stdout).trim()}`);
  ok("Daily job search removed");
}

function installDashboard(o) {
  const dir = o.tasksDir ?? startupFolder();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, DASHBOARD_FILE);
  writeFileSync(file, dashboardStartupFile({ kit: KIT, node: process.execPath, port: o.port }));
  if (o.tasksDir) ok(`Startup file written (not in the Startup folder): ${file}`);
  else {
    ok(`The dashboard starts at your next sign-in, in a minimized window (http://localhost:${o.port}).`);
    console.log(`  Its start file: ${file}`);
    console.log("  To start it now: npm run dev");
  }
}

// ---- main -------------------------------------------------------------------------
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    // The comment at the top of this file is the help text.
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
    const end = lines.findIndex((l) => !l.startsWith("//"));
    console.log(lines.slice(0, end).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }

  // A re-run keeps the data folder the first run recorded in .kairos-home,
  // unless --home or KAIROS_HOME says otherwise.
  const pointer = join(KIT, ".kairos-home");
  let prev = "";
  try {
    prev = expandTilde(readFileSync(pointer, "utf8").split("\n")[0].trim());
  } catch {
    // first run
  }
  const envHome = process.env.KAIROS_HOME?.trim();
  const homeDir = resolve(expandTilde(o.home ?? envHome ?? (prev || join(homedir(), "Kairos"))));
  if (o.scheduleOnly && !o.askedDaily) throw new Stop("--schedule-only needs --daily HH:MM or --no-daily", 2);

  console.log("Kairos Kit installer");
  console.log(`  kit:         ${KIT}`);
  console.log(`  data folder: ${homeDir}`);
  console.log();

  // --- 0. Whose data folder is this? ---
  // A folder this kit made carries .kairos-kit. A folder recorded by an earlier
  // run of this kit was already accepted. Anything else that holds a knowledge
  // base is refused without --use-existing.
  const holdsKnowledgeBase = ["profile.md", "knowledge-base", "applications"].some((n) => existsSync(join(homeDir, n)));
  if (holdsKnowledgeBase && !existsSync(join(homeDir, ".kairos-kit")) && homeDir !== (prev && resolve(prev)) && !o.useExisting) {
    console.log(`${paint(31, "✗")} ${homeDir} already holds a Kairos knowledge base that this kit did not create.`);
    console.log("  Nothing was changed. Choose one:");
    console.log(`    node install.mjs --home ${join(homedir(), "KairosKit")}    a new data folder for this kit`);
    console.log("    node install.mjs --use-existing            use this knowledge base (the kit will write into it)");
    process.exitCode = 1;
    return;
  }

  let { dashboard, daily } = o;
  if (o.scheduleOnly) {
    if (!existsSync(homeDir)) fail(`Data folder not found: ${homeDir} (run node install.mjs first)`);
  } else {
    // --- 1. Checks ---
    const [major, minor] = process.versions.node.split(".").map(Number);
    // 22.17 or newer within 22, or 24 and later (what the PDF renderer's Chromium package supports; 23 is not).
    if (!((major === 22 && minor >= 17) || major >= 24)) fail(`Node ${process.version} found; Kairos Kit needs Node 22.17 or newer, or Node 24 or newer (https://nodejs.org).`);
    ok(`Node ${process.version}`);

    const claude = [join(homedir(), ".local", "bin", WINDOWS ? "claude.exe" : "claude")].find(isFile) ?? onPath("claude");
    if (claude) ok(`Claude Code CLI: ${claude}`);
    else warn("Claude Code CLI not found. Install it (https://claude.com/claude-code) and sign in with a Claude Pro or Max plan; Kairos runs inside it.");

    if (!onPath("git")) warn("git not found. /update needs it (https://git-scm.com/download/win), and Claude Code on Windows uses the Git Bash that comes with it.");

    if (findLibreOffice()) ok("LibreOffice found (PDF copies of your résumés)");
    else warn("LibreOffice not found (optional). Without it you get the Word file only, and page fit is estimated instead of measured. The installer is at https://www.libreoffice.org.");

    if (/[\\/]OneDrive/i.test(KIT)) warn("The kit is inside a OneDrive folder. OneDrive tries to sync the thousands of package files and can lock them during an install; move the kit to a folder OneDrive does not sync (for example kairos-kit in your user folder).");

    // --- 2. Packages ---
    if (!o.skipNpm) {
      console.log("Installing packages (npm ci)…");
      // One command line through the system's shell: npm is npm.cmd on Windows.
      const npm = spawnSync("npm ci --no-audit --no-fund", { cwd: KIT, stdio: "inherit", shell: true });
      if (npm.status !== 0) fail("npm ci failed.");
      ok("Packages installed");
    } else ok("Packages: skipped (--skip-npm)");

    // --- 3. Data folder ---
    if (existsSync(homeDir)) {
      ok(`Data folder exists; using it as it is (nothing in it is changed): ${homeDir}`);
      if (o.demo) warn("--demo ignored: the data folder already exists.");
    } else {
      if (o.demo) {
        mkdirSync(dirname(homeDir), { recursive: true });
        cpSync(join(KIT, "demo"), homeDir, { recursive: true });
        const sweep = (dir) => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) sweep(join(dir, e.name));
            else if (e.name === ".gitkeep") rmSync(join(dir, e.name));
          }
        };
        sweep(homeDir);
        ok(`Data folder created from the demo knowledge base: ${homeDir}`);
      } else {
        for (const d of ["knowledge-base/experiences", "knowledge-base/education", "applications", "sourcing", "logs"]) mkdirSync(join(homeDir, d), { recursive: true });
        ok(`Data folder created: ${homeDir}`);
      }
      writeFileSync(join(homeDir, ".kairos-kit"), "");
      // On Windows a folder under your user folder is already yours alone; elsewhere, say so.
      if (!WINDOWS) chmodSync(homeDir, 0o700);
    }
    writeFileSync(pointer, homeDir + "\n");
    ok("Data folder recorded in .kairos-home (read by the server, the dashboard and /find)");

    // --- 4. .mcp.json ---
    // Claude Code starts project MCP servers from the kit folder, so the path
    // stays relative. `node --import tsx` and not `npx tsx`: npx is a .cmd file
    // on Windows, which Claude Code cannot start directly. The data folder
    // comes from .kairos-home, so this file is the same for everyone.
    // Written letter for letter as the kit ships it, so that git sees no change after an install.
    writeFileSync(
      join(KIT, ".mcp.json"),
      ["{", '  "mcpServers": {', '    "kairos": {', '      "command": "node",', '      "args": ["--import", "tsx", "apps/local/mcp/server.ts"]', "    }", "  }", "}", ""].join("\n"),
    );
    ok(".mcp.json written (MCP server 'kairos')");

    // --- 5. In the background ---
    if (WINDOWS && !o.yes && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const yes = async (q) => /^y/i.test((await rl.question(`${q} [y/N] `)).trim());
      if (!o.askedDashboard && (await yes(`Start the dashboard each time you sign in (http://localhost:${o.port})?`))) dashboard = true;
      if (!o.askedDaily && (await yes("Run the job search every morning?"))) {
        daily = (await rl.question("Time (HH:MM, default 08:15): ")).trim() || "08:15";
      }
      rl.close();
    }
  }

  const background = WINDOWS || o.tasksDir;
  if ((dashboard || daily) && !background) {
    warn("Nothing was set up in the background: this script does that on Windows only. On a Mac, ./install.sh sets up the dashboard service and the daily search.");
  } else {
    if (dashboard) installDashboard(o);
    if (daily) {
      installDaily(o, daily);
      ok(`Daily job search: every day at ${daily} while you are signed in (log: ${join(homeDir, "logs", "daily.log")})`);
    } else if (o.askedDaily && background) removeDaily(o); // --no-daily: remove a schedule installed earlier
  }
  if (o.scheduleOnly) return;

  // --- 6. Next steps ---
  console.log();
  ok("Done.");
  console.log("Next:");
  console.log(`  1. cd "${KIT}"   then   claude`);
  console.log("  2. Approve the 'kairos' MCP server when Claude Code asks.");
  console.log("  3. Type /setup. It asks for your documents or interviews you.");
  if (!dashboard) console.log("  Dashboard any time: npm run dev  (http://localhost:3000)");
  console.log("  Guide: docs/getting-started.md");
}

// Run only when started as a program (the tests import the two builders above).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    if (err instanceof Stop) {
      console.error(`${paint(31, "✗")} ${err.message}`);
      process.exit(err.code);
    }
    throw err;
  });
}
