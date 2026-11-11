// NOT "server-only": imported by both the Next app and any tsx context. Shells
// out to the Claude Code CLI in headless (-p) mode for Max-billed model calls.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE = () => process.env.CLAUDE_CLI_PATH ?? join(homedir(), ".local/bin/claude");
// Long-lived headless token minted via `claude setup-token`. The interactive
// OAuth session isn't visible to a dev-server or cron process, so we read the
// token from this 0600 file and inject it — the same file daily-routine.sh uses.
const TOKEN_FILE = process.env.KAIROS_TOKEN_FILE ?? join(homedir(), ".config/kairos/claude-oauth-token");

function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    try {
      const tok = readFileSync(TOKEN_FILE, "utf8").replace(/\s+/g, "");
      if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
    } catch {
      /* no token file: fall back to whatever ambient auth exists */
    }
  }
  return env;
}

/**
 * Run a headless Claude prompt and return stdout. Throws on non-zero exit.
 *
 * The prompt goes in on stdin, so it never shows in the process list. These
 * calls only write text, and their prompts carry job postings (untrusted
 * text): the model gets no tools and no MCP servers, and the run is not kept
 * as a session.
 */
export const CLAUDE_ARGS = ["-p", "--tools", "", "--strict-mcp-config", "--no-session-persistence"];

export async function runClaude(prompt: string, timeoutMs = 10 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE(), CLAUDE_ARGS, { env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > 20 * 1024 * 1024) child.kill("SIGTERM");
      else out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`claude -p exited with ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 500)}`));
    });
    child.stdin.end(prompt);
  });
}
