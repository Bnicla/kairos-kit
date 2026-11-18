#!/usr/bin/env node
// Kairos Kit daily routine in Node: what scripts/daily.sh does on a Mac, for
// Windows (Task Scheduler: "Kairos Kit daily search", set up by install.mjs).
// The same steps in the same order, the same log and the same heartbeat file.
//   1. prune-closed      move drafts whose listing closed to the Closed column
//   2. harvest-registry  refresh the job-board list when older than 30 days (kept in the data folder, sourcing/)
//   3. sourcing-run      fresh sweep + triage into the Sourced column
//   4. dream-watch       check your dream companies' career sites directly
// Writes logs/daily.log (last run) and sourcing/daily-heartbeat.json in the data folder.
//
// Each step is run with this Node and tsx (node --import tsx <script>), from
// apps/local: no npm and no shell, which on Windows are .cmd files.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The steps, in order. `name` is the package script daily.sh runs; `onFail` is the run's status when the step fails. */
export const STEPS = [
  { name: "prune-closed", script: "prune-closed-listings.mts", args: [], onFail: "degraded" },
  // A failed harvest is not a failed run: the search uses the job-board list it has.
  { name: "harvest-registry", script: "harvest-registry.mts", args: [], onFail: null },
  { name: "sourcing-run", script: "sourcing-run.mts", args: [], onFail: "failed" },
  { name: "sourcing-run", label: "deep scan (Mondays)", script: "sourcing-run.mts", args: ["--deep"], onFail: "degraded", when: "monday" },
  { name: "dream-watch", script: "dream-watch.mts", args: [], onFail: "degraded", when: "shipped" },
];

const expandTilde = (p) => (p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p);

/** The data folder, in the order of kairosHome(): KAIROS_HOME, then .kairos-home (written by the installer), then Kairos in the user's folder. */
export function dataFolder(kit, env = process.env) {
  const set = env.KAIROS_HOME?.trim();
  if (set) return expandTilde(set);
  try {
    const line = readFileSync(join(kit, ".kairos-home"), "utf8").split("\n")[0].trim();
    if (line) return expandTilde(line);
  } catch {
    // no pointer: the default
  }
  return join(homedir(), "Kairos");
}

/** The Claude Code CLI: CLAUDE_CLI_PATH, then where its installer puts it, then PATH. Null when it is not found. */
export function findClaude(env = process.env, platform = process.platform) {
  if (env.CLAUDE_CLI_PATH?.trim()) return env.CLAUDE_CLI_PATH.trim();
  const win = platform === "win32";
  const isFile = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const installed = join(homedir(), ".local", "bin", win ? "claude.exe" : "claude");
  if (isFile(installed)) return installed;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const endings = win ? [".exe", ".cmd"] : [""];
  for (const dir of (pathKey ? env[pathKey] : "").split(win ? ";" : delimiter).filter(Boolean)) {
    for (const ending of endings) if (isFile(join(dir, "claude" + ending))) return join(dir, "claude" + ending);
  }
  return null;
}

const pad = (n) => String(n).padStart(2, "0");
const localStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const WORSE = { ok: 0, degraded: 1, failed: 2 };

/**
 * Run the routine. `runStep(step)` runs one step and answers true when it
 * succeeded; `write(line)` adds a line to the log. Returns the status written
 * to the heartbeat, or "off" when the daily run is turned off in the search profile.
 */
export function runDaily({ kit, home, runStep, write, now = () => new Date() }) {
  // /setup part 14 can turn the daily run off; respected even when the task is installed.
  try {
    const profile = JSON.parse(readFileSync(join(home, "sourcing", "search-profile.json"), "utf8"));
    if (profile?.daily_run?.enabled === false) {
      write("daily run is off in search-profile.json (daily_run.enabled=false); nothing to do");
      return "off";
    }
  } catch {
    // no search profile yet, or unreadable: run
  }
  let status = "ok";
  write(`=== Kairos daily routine: ${localStamp(now())} ===`);
  for (const step of STEPS) {
    if (step.when === "monday" && now().getDay() !== 1) continue;
    if (step.when === "shipped" && !existsSync(join(kit, "apps", "local", "scripts", step.script))) continue;
    write(`--- ${step.label ?? step.name} ---`);
    if (runStep(step)) continue;
    if (step.onFail === null) write("harvest failed; sweeping with the current job-board list");
    else if (WORSE[step.onFail] > WORSE[status]) status = step.onFail;
  }
  write(`=== done: ${localStamp(now()).slice(11)} ===`);
  const heartbeat = { last_run: now().toISOString().replace(/\.\d{3}Z$/, "Z"), status };
  writeFileSync(join(home, "sourcing", "daily-heartbeat.json"), JSON.stringify(heartbeat) + "\n");
  return status;
}

function main() {
  const kit = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const env = { ...process.env };
  const home = dataFolder(kit, env);
  env.KAIROS_HOME = home;
  const claude = findClaude(env);
  if (claude) env.CLAUDE_CLI_PATH = claude;
  // A long-lived token (claude setup-token) saved here lets the triage step call
  // Claude when the task's session cannot use your sign-in; without either, the
  // search still runs but ships an unranked list.
  const tokenFile = env.KAIROS_TOKEN_FILE || join(homedir(), ".config", "kairos", "claude-oauth-token");
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && existsSync(tokenFile)) env.CLAUDE_CODE_OAUTH_TOKEN = readFileSync(tokenFile, "utf8").replace(/\s+/g, "");
  mkdirSync(join(home, "logs"), { recursive: true });
  mkdirSync(join(home, "sourcing"), { recursive: true });
  // The window Task Scheduler opens for the run carries this name.
  process.title = "Kairos Kit daily search (closes by itself when done)";

  const log = openSync(join(home, "logs", "daily.log"), "w");
  const write = (line) => writeSync(log, line + "\n");
  const runStep = (step) =>
    spawnSync(process.execPath, ["--import", "tsx", join("scripts", step.script), ...step.args], {
      cwd: join(kit, "apps", "local"),
      env,
      stdio: ["ignore", log, log],
      windowsHide: true,
    }).status === 0;
  try {
    runDaily({ kit, home, runStep, write });
  } finally {
    closeSync(log);
  }
}

// Run only when started as a program (the tests import runDaily).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
