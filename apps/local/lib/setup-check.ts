/**
 * Step 0 of `/setup`: the data folder and the install.
 *
 *   - ensureDataFolder creates the folders Kairos writes to, and never touches
 *     a file that already exists.
 *   - checkInstall reports Node, the Claude Code CLI, LibreOffice (optional)
 *     and whether the kit's git origin is a public GitHub repository.
 */
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { emptySetupState } from "@kairos/engine/setup/status";

export const DATA_FOLDERS = [
  "knowledge-base/experiences",
  "knowledge-base/education",
  "applications",
  "sourcing",
  "logs",
];

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/** Create what is missing; report what was there. Existing files are never written. */
export async function ensureDataFolder(home: string): Promise<{ home: string; existed: boolean; created: string[]; has_data: boolean }> {
  const existed = await exists(home);
  const created: string[] = [];
  if (!existed) {
    await fs.mkdir(home, { recursive: true });
    created.push(home);
  }
  for (const d of DATA_FOLDERS) {
    const p = path.join(home, d);
    if (!(await exists(p))) {
      await fs.mkdir(p, { recursive: true });
      created.push(d + "/");
    }
  }
  const state = path.join(home, "setup-state.json");
  if (!(await exists(state))) {
    // "wx": fail rather than overwrite if something appeared in between.
    await fs.writeFile(state, JSON.stringify(emptySetupState(), null, 2) + "\n", { flag: "wx" }).catch(() => {});
    created.push("setup-state.json");
  }
  const exps = await fs.readdir(path.join(home, "knowledge-base/experiences")).catch(() => []);
  const has_data = exps.some((f) => f.endsWith(".md")) || (await exists(path.join(home, "profile.md")));
  return { home, existed, created, has_data };
}

function run(cmd: string, args: string[], cwd?: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

/** owner/repo from a GitHub remote URL (https or ssh), else null. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export interface InstallReport {
  node: { version: string; ok: boolean; note?: string };
  claude_cli: { found: boolean; version?: string };
  libreoffice: { found: boolean; note: string };
  repo: {
    root: string;
    origin: string | null;
    github?: { owner: string; repo: string; visibility: "public" | "private-or-missing" | "unknown"; fork?: boolean };
    warning?: string;
  };
  warnings: string[];
}

/** The kit checkout: KAIROS_REPO, else the nearest folder above the working directory that holds the MCP server. */
export async function repoRoot(start = process.cwd()): Promise<string> {
  const env = process.env.KAIROS_REPO?.trim();
  if (env) return env;
  let dir = path.resolve(start);
  for (;;) {
    if (await exists(path.join(dir, "apps/local/mcp/server.ts"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

export async function checkInstall(opts: { root?: string; fetchImpl?: typeof fetch } = {}): Promise<InstallReport> {
  const root = opts.root ?? (await repoRoot());
  const warnings: string[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  const node = { version: process.versions.node, ok: major >= 22, ...(major < 22 ? { note: "Kairos Kit needs Node 22 or newer." } : {}) };
  if (!node.ok) warnings.push(`Node ${process.versions.node} is too old: install Node 22 or newer.`);

  const claudeVersion = await run("sh", ["-lc", "command -v claude >/dev/null && claude --version"]);
  const claude_cli = claudeVersion ? { found: true, version: claudeVersion.split("\n")[0] } : { found: false };
  if (!claude_cli.found) warnings.push("The claude command was not found on PATH. The daily search needs it.");

  const soffice =
    (await run("sh", ["-lc", "command -v soffice"])) ??
    ((await exists("/Applications/LibreOffice.app/Contents/MacOS/soffice")) ? "/Applications/LibreOffice.app" : null);
  const libreoffice = soffice
    ? { found: true, note: "PDF export and the page-layout check will use it." }
    : { found: false, note: "Optional. Without it, résumés export as Word files and page fit is estimated from word counts." };

  const origin = await run("git", ["-C", root, "remote", "get-url", "origin"]);
  const repo: InstallReport["repo"] = { root, origin };
  const gh = origin ? parseGitHubRemote(origin) : null;
  if (gh) {
    let visibility: "public" | "private-or-missing" | "unknown" = "unknown";
    let fork: boolean | undefined;
    try {
      // Unauthenticated: a private repository answers 404, a public one 200.
      const res = await (opts.fetchImpl ?? fetch)(`https://api.github.com/repos/${gh.owner}/${gh.repo}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "kairos-kit-setup" },
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 200) {
        visibility = "public";
        fork = Boolean(((await res.json()) as { fork?: boolean }).fork);
      } else if (res.status === 404) visibility = "private-or-missing";
    } catch {
      /* offline: unknown */
    }
    repo.github = { ...gh, visibility, ...(fork !== undefined ? { fork } : {}) };
    if (visibility === "public" && fork) {
      repo.warning = `Your copy of the kit (github.com/${gh.owner}/${gh.repo}) is a public fork. Your data folder is outside the repository and is not published, but anything you commit to this repository is public. Make the fork private, or never commit personal files to it.`;
      warnings.push(repo.warning);
    }
  }
  return { node, claude_cli, libreoffice, repo, warnings };
}
