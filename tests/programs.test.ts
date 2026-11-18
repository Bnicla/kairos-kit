import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { claudeProgram, findProgram, isRunnable, startCommand, windowsProgramFolders } from "../apps/local/lib/programs";

/**
 * Finding and starting other programs the same way on macOS, Linux and
 * Windows (apps/local/lib/programs.ts). The Windows rules are run here on any
 * system by passing platform "win32" with a made-up PATH.
 */
describe("finding and starting programs", () => {
  const dir = mkdtempSync(join(tmpdir(), "kairos-programs-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const other = join(dir, "other");
  mkdirSync(bin);
  mkdirSync(other);
  const program = (folder: string, name: string) => {
    const file = join(folder, name);
    writeFileSync(file, "");
    chmodSync(file, 0o755);
    return file;
  };
  const npmCmd = program(bin, "npm.cmd");
  program(bin, "npm"); // the shell script npm also ships on Windows
  const toolExe = program(other, "tool.exe");
  const toolCmd = program(bin, "tool.cmd");
  const plain = program(bin, "soffice");
  const windows = { platform: "win32" as const, env: { Path: `${bin};${other}`, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" } };
  const unix = { platform: "darwin" as const, env: { PATH: `${bin}:${other}` } };

  it("finds a program through PATH, with Windows's endings in Windows's order", () => {
    // The macOS and Linux rule splits PATH on ":", which a Windows path holds after its drive letter:
    // that rule is run where it applies.
    if (process.platform !== "win32") expect(findProgram("soffice", unix)).toBe(plain);
    expect(findProgram("no-such-program", unix)).toBeNull();
    // "npm" is npm.cmd on Windows, never the shell script beside it.
    expect(findProgram("npm", windows)).toBe(npmCmd);
    // The folder order of PATH comes first; within a folder, .exe before .cmd.
    expect(findProgram("tool", windows)).toBe(toolCmd);
    expect(findProgram("tool.exe", windows)).toBe(toolExe);
    expect(findProgram("no-such-program", windows)).toBeNull();
  });

  it("a folder of that name is not a program", () => {
    mkdirSync(join(other, "claude"));
    expect(isRunnable(join(other, "claude"))).toBe(false);
    expect(findProgram("claude", { platform: process.platform, env: { PATH: other } })).toBeNull();
  });

  it("starts a program unchanged on macOS and Linux", () => {
    expect(startCommand("npm", ["-w", "kairos-local", "run", "sourcing-run"], unix)).toEqual({ file: "npm", args: ["-w", "kairos-local", "run", "sourcing-run"], options: {} });
  });

  it("starts a .cmd file through cmd.exe on Windows, and an .exe directly", () => {
    const npm = startCommand("npm", ["-w", "kairos-local", "run", "sourcing-run"], windows);
    expect(npm.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(npm.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // The program's path is quoted when it holds a space or any character outside the plainly safe ones
    // (the "~" of a short Windows folder name, for one), and left as it is otherwise.
    const quoted = /^[A-Za-z0-9_\-.:\\/=@+,]+$/.test(npmCmd) ? npmCmd : `"${npmCmd}"`;
    expect(npm.args[3]).toBe(`"${quoted} -w kairos-local run sourcing-run"`);
    expect(npm.options).toEqual({ windowsVerbatimArguments: true });
    expect(startCommand(toolExe, ["--version"], windows)).toEqual({ file: toolExe, args: ["--version"], options: {} });
  });

  it("keeps an empty argument and quotes one with a space on a cmd.exe line", () => {
    const start = startCommand(toolCmd, ["-p", "--tools", "", "a b"], windows);
    expect(start.args[3].endsWith(` -p --tools "" "a b""`)).toBe(true);
  });

  it("a full path without an ending takes the one that exists on Windows", () => {
    expect(startCommand(join(other, "tool"), [], windows).file).toBe(toolExe);
  });

  it("uses CLAUDE_CLI_PATH when it is set", () => {
    expect(claudeProgram({ env: { CLAUDE_CLI_PATH: " /somewhere/claude " } })).toBe("/somewhere/claude");
  });

  it("names Windows's program folders on Windows only", () => {
    expect(windowsProgramFolders(unix)).toEqual([]);
    const folders = windowsProgramFolders({ platform: "win32", env: { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" } });
    expect(folders).toEqual(["C:\\Program Files", "C:\\Program Files (x86)"]);
  });
});
