/**
 * Finding and starting other programs (npm, the Claude Code CLI, LibreOffice, poppler) the same
 * way on macOS, Linux and Windows.
 *
 * Two things differ on Windows. A program is found through PATH with one of the endings listed in
 * PATHEXT (claude.exe, npm.cmd). And a .cmd or .bat file is a script for cmd.exe: Node refuses to
 * start one directly, so it is started through cmd.exe with its arguments quoted here.
 *
 * NOT "server-only": the tool server and the scripts (raw tsx) import it as well as the Next app.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type Env = Record<string, string | undefined>;
export interface ProgramOptions {
  env?: Env;
  platform?: NodeJS.Platform;
}

/** True when the file is there and may be run (on Windows: when it is there). */
export function isRunnable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A variable by name, whatever its capitals: a copy of the environment on Windows holds "Path", not "PATH". */
function envValue(env: Env, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

/** The endings Windows tries for a program name, in its order, lower case. */
function windowsEndings(env: Env): string[] {
  return (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** With one of Windows's endings when the file exists with it; the path as given otherwise. */
function withWindowsEnding(file: string, env: Env): string {
  if (path.extname(file)) return file;
  for (const ending of windowsEndings(env)) if (isRunnable(file + ending)) return file + ending;
  return file;
}

/**
 * The full path of a program found through PATH, or null. On Windows the name is tried with each
 * ending in PATHEXT, so "npm" gives npm.cmd and "claude" gives claude.exe before claude.cmd.
 */
export function findProgram(name: string, opts: ProgramOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const win = (opts.platform ?? process.platform) === "win32";
  const dirs = (envValue(env, "PATH") ?? "").split(win ? ";" : ":").filter(Boolean);
  const endings = win && !path.extname(name) ? windowsEndings(env) : [""];
  for (const dir of dirs) {
    for (const ending of endings) {
      const candidate = path.join(dir, name + ending);
      if (isRunnable(candidate)) return candidate;
    }
  }
  return null;
}

/** One argument on a cmd.exe command line: quoted unless it is plainly safe as it is. */
function quoteForCmd(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_\-.:\\/=@+,]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface StartCommand {
  file: string;
  args: string[];
  /** Spread into the options of spawn or execFile. */
  options: { windowsVerbatimArguments?: boolean };
}

/**
 * What to give spawn or execFile to start `program` with `args`. Unchanged on macOS and Linux. On
 * Windows a bare name is looked up through PATH, and a .cmd or .bat file is started through cmd.exe.
 * The arguments are flags and paths written in the code; text from a user or a posting never goes
 * on a command line (prompts go in on standard input).
 */
export function startCommand(program: string, args: string[] = [], opts: ProgramOptions = {}): StartCommand {
  const env = opts.env ?? process.env;
  if ((opts.platform ?? process.platform) !== "win32") return { file: program, args, options: {} };
  const resolved = /[\\/]/.test(program) ? withWindowsEnding(program, env) : (findProgram(program, opts) ?? program);
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return { file: resolved, args, options: {} };
  const line = [resolved, ...args].map(quoteForCmd).join(" ");
  // /d: no AutoRun commands; /s with the outer quotes: the line inside is run exactly as written.
  return { file: envValue(env, "ComSpec") || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], options: { windowsVerbatimArguments: true } };
}

/**
 * The Claude Code CLI: CLAUDE_CLI_PATH when set; else where its installer puts it (~/.local/bin),
 * when it is there; else `claude` on PATH (an install through npm); else the installer's path, so
 * that the error names it.
 */
export function claudeProgram(opts: ProgramOptions = {}): string {
  const env = opts.env ?? process.env;
  const set = envValue(env, "CLAUDE_CLI_PATH")?.trim();
  if (set) return set;
  const win = (opts.platform ?? process.platform) === "win32";
  const installed = path.join(homedir(), ".local", "bin", win ? "claude.exe" : "claude");
  if (isRunnable(installed)) return installed;
  return findProgram("claude", opts) ?? installed;
}

/**
 * The folders Windows installs programs into: Program Files, Program Files (x86), and the user's
 * own Programs folder. Empty on macOS and Linux.
 */
export function windowsProgramFolders(opts: ProgramOptions = {}): string[] {
  if ((opts.platform ?? process.platform) !== "win32") return [];
  const env = opts.env ?? process.env;
  const local = envValue(env, "LOCALAPPDATA");
  return [envValue(env, "ProgramFiles"), envValue(env, "ProgramFiles(x86)"), local ? path.join(local, "Programs") : undefined, local].filter(
    (d): d is string => !!d,
  );
}
