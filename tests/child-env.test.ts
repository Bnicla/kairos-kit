import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "../apps/local/lib/child-env";

/**
 * A helper program (LibreOffice, poppler, a version check) is started with a
 * short environment of its own, never with a copy of the server's, which
 * under the hosted connector holds the sealing key and Google's client secret.
 */
describe("the environment of a helper program", () => {
  const names = ["KAIROS_CONNECTOR_AUTH_KEY", "GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "ANTHROPIC_API_KEY", "KAIROS_HOME"];
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const n of names) {
      if (before[n] === undefined) delete process.env[n];
      else process.env[n] = before[n];
    }
  });

  it("keeps what a program needs to run and nothing of the server's settings", () => {
    for (const n of names) process.env[n] = "a-secret-value";
    const env = childEnv({ SAL_USE_VCLPLUGIN: "svp" });
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.SAL_USE_VCLPLUGIN).toBe("svp");
    for (const n of names) expect(env[n], n).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("a-secret-value");
    expect(Object.keys(env).length).toBeLessThanOrEqual(12);
  });

  it("every program the local library and the tool server start gets that environment", () => {
    const dirs = [join("apps", "local", "lib"), join("apps", "local", "mcp")];
    // The two files that start Claude Code or the tool server itself on the user's own machine pass their own environment on purpose.
    const own = new Set(["claude-cli.ts", "dev-proxy.ts"]);
    const without: string[] = [];
    let calls = 0;
    for (const dir of dirs) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".ts") || own.has(name)) continue;
        const text = readFileSync(join(dir, name), "utf8");
        // Each call of execFile or execFileAsync, up to the end of its statement.
        for (const m of text.matchAll(/\bexecFile(?:Async)?\(([\s\S]*?)\);/g)) {
          calls++;
          if (!/\benv\b/.test(m[1])) without.push(`${name}: ${m[1].slice(0, 60).replace(/\s+/g, " ")}`);
        }
        // A call of the function itself; a method of that name (a regular expression's .exec) is something else.
        expect(/(?<![.\w])(?:spawn|exec|fork|execSync|spawnSync)\(/.test(text), `${name} starts a program another way`).toBe(false);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(8);
    expect(without).toEqual([]);
  });
});
