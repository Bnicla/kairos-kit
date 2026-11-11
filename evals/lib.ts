/**
 * Shared plumbing for the tier-2 (model-judged) eval runners.
 *
 * Providers:
 *  - "cli": headless Claude Code CLI (`claude -p`) — Max-billed, the default
 *    locally; injects the long-lived token from ~/.config/kairos/claude-oauth-token.
 *  - "api": direct Anthropic Messages API with ANTHROPIC_API_KEY.
 *
 * Runners cost real money/quota by design; they are NOT part of CI.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../apps/local/store/local-fs";
import { loadExperiences } from "@kairos/engine/kb/store";
import type { Experience } from "@kairos/engine/types";
import { TASK_MODELS } from "../apps/cloud/lib/models";

const execFileAsync = promisify(execFile);

export type Provider = "cli" | "api";

export function pickProvider(argv: string[]): Provider {
  if (argv.includes("--api")) return "api";
  if (argv.includes("--cli")) return "cli";
  return process.env.ANTHROPIC_API_KEY ? "api" : "cli";
}

export async function callModel(provider: Provider, prompt: string): Promise<string> {
  if (provider === "api") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY not set (or run with --cli)");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: TASK_MODELS.scoring.id,
        max_tokens: TASK_MODELS.scoring.maxTokens,
        ...(TASK_MODELS.scoring.adaptiveThinking ? { thinking: { type: "adaptive" } } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    return data.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  }
  // CLI provider (Max-billed)
  const claude = process.env.CLAUDE_CLI_PATH ?? join(homedir(), ".local/bin/claude");
  const env = { ...process.env };
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    try {
      env.CLAUDE_CODE_OAUTH_TOKEN = readFileSync(join(homedir(), ".config/kairos/claude-oauth-token"), "utf8").replace(/\s+/g, "");
    } catch { /* ambient auth */ }
  }
  const { stdout } = await execFileAsync(claude, ["-p", prompt], {
    timeout: 10 * 60_000,
    maxBuffer: 20 * 1024 * 1024,
    env,
  });
  return stdout;
}

export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(text.slice(start, end + 1));
}

/** Temp LocalStore seeded with the student-persona fixture KB. */
export async function fixtureStore(): Promise<{ store: LocalStore; experiences: Experience[] }> {
  const root = mkdtempSync(join(tmpdir(), "kairos-eval-"));
  const store = new LocalStore(root);
  const kbDir = join(process.cwd(), "tests", "fixtures", "student-kb");
  for (const f of readdirSync(kbDir).filter((f) => f.endsWith(".md"))) {
    await store.writeFile(["knowledge-base", "experiences", f], readFileSync(join(kbDir, f), "utf8"));
  }
  return { store, experiences: await loadExperiences(store) };
}

export const FIXTURE_EDUCATION = ["BS Computer Science, State University, 2025. [R]"];
