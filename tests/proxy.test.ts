import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { hostIsLocal, localOnly, originAllowed, proxy } from "../apps/local/proxy";

describe("dashboard access check", () => {
  it("knows this computer's host names", () => {
    expect(hostIsLocal("localhost:3000")).toBe(true);
    expect(hostIsLocal("127.0.0.1:3000")).toBe(true);
    expect(hostIsLocal("attacker.example:3000")).toBe(false);
  });
  it("a change must come from the dashboard's own origin", () => {
    expect(originAllowed("http://localhost:3000", "/applications", "localhost:3000")).toBe(true);
    expect(originAllowed("http://localhost:4555", "/applications", "localhost:3000")).toBe(false);
    expect(originAllowed("https://attacker.example", "/applications", "localhost:3000")).toBe(false);
    expect(originAllowed(null, "/applications", "localhost:3000")).toBe(true);
    expect(originAllowed("chrome-extension://abc", "/api/autofill-map", "localhost:3000")).toBe(true);
    expect(originAllowed("chrome-extension://abc", "/applications", "localhost:3000")).toBe(false);
  });

  describe("is on by default, and off only by the explicit setting", () => {
    const before = process.env.KAIROS_LOCAL_ONLY;
    afterEach(() => {
      if (before === undefined) delete process.env.KAIROS_LOCAL_ONLY;
      else process.env.KAIROS_LOCAL_ONLY = before;
    });
    /** One request as the dashboard receives it: the address it was sent to, with the Host header a browser writes. */
    const ask = (host: string, init: { method?: string; origin?: string } = {}) =>
      proxy(new NextRequest(`http://${host}/applications`, { method: init.method ?? "GET", headers: { host, ...(init.origin ? { origin: init.origin } : {}) } }));

    it("only KAIROS_LOCAL_ONLY=0 turns it off", () => {
      for (const value of [undefined, "", "1", "true", "no", "off", "false"]) expect(localOnly({ KAIROS_LOCAL_ONLY: value }), String(value)).toBe(true);
      expect(localOnly({ KAIROS_LOCAL_ONLY: "0" })).toBe(false);
      expect(localOnly({})).toBe(true);
    });

    it("with no setting at all: another site's name is refused, and so is a change from another site", () => {
      delete process.env.KAIROS_LOCAL_ONLY;
      // A page that points its own name at 127.0.0.1 sends its own name.
      expect(ask("attacker.example:3000").status).toBe(403);
      // Another site's page posts a form to the dashboard.
      expect(ask("localhost:3000", { method: "POST", origin: "https://attacker.example" }).status).toBe(403);
      expect(ask("localhost:3000", { method: "POST", origin: "http://localhost:4555" }).status).toBe(403);
      // The dashboard itself, and a program with no Origin, go through.
      expect(ask("localhost:3000").status).toBe(200);
      expect(ask("127.0.0.1:3000", { method: "POST", origin: "http://127.0.0.1:3000" }).status).toBe(200);
      expect(ask("localhost:3000", { method: "POST" }).status).toBe(200);
    });

    it("the setting of the Kit's scripts (1) keeps it on; 0 lets every request through", () => {
      process.env.KAIROS_LOCAL_ONLY = "1";
      expect(ask("attacker.example:3000").status).toBe(403);
      process.env.KAIROS_LOCAL_ONLY = "0";
      expect(ask("attacker.example:3000").status).toBe(200);
      expect(ask("localhost:3000", { method: "POST", origin: "https://attacker.example" }).status).toBe(200);
    });
  });
});

/**
 * The second half of the protection: the dashboard listens on this computer's own address only, so that no
 * other computer of the network can reach it, whatever Host header it writes. The address is given by the
 * commands that start the dashboard; these are all of them.
 */
describe("the dashboard listens on 127.0.0.1 only", () => {
  const read = (file: string) => readFileSync(file, "utf8");

  it("npm run dev and npm run start give the address, in the repository and in the Kit", () => {
    const scripts = JSON.parse(read("apps/local/package.json")).scripts as Record<string, string>;
    for (const name of ["dev", "start"]) {
      expect(scripts[name], name).toMatch(new RegExp(`\\bnext ${name} -H 127\\.0\\.0\\.1$`));
      expect(scripts[name], name).not.toMatch(/0\.0\.0\.0|::/);
    }
    // The root's scripts hand over to these two and add no address of their own.
    const root = JSON.parse(read("package.json")).scripts as Record<string, string>;
    for (const name of ["dev", "start"]) if (root[name]) expect(root[name], `root ${name}`).not.toMatch(/-H\b|--hostname|0\.0\.0\.0/);
  });

  it("every script that starts the dashboard as a service starts it on that address", () => {
    // The owner's login service starts it through npm run dev, and sets no address itself.
    if (existsSync("apps/local/dashboard-service.sh")) {
      // Its commands, without its comments.
      const service = read("apps/local/dashboard-service.sh").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
      expect(service).toMatch(/^exec npm run dev$/m);
      expect(service).not.toMatch(/next (?:dev|start)|-H\b|--hostname|0\.0\.0\.0/);
    }
    // The Kit's own script, where it is in this repository and where it is in an exported Kit.
    const kit = ["kit/files/scripts/dashboard.sh", "scripts/dashboard.sh"].filter((f) => existsSync(f));
    for (const file of kit) {
      const starts = read(file).split("\n").filter((l) => /\bnext (?:dev|start)\b/.test(l) && !l.trim().startsWith("#"));
      expect(starts.length, file).toBeGreaterThan(0);
      for (const line of starts) expect(line, file).toMatch(/-H 127\.0\.0\.1\b/);
    }
    // The export gives the Kit's package the same address.
    if (existsSync("scripts/export-kit.mts")) {
      const lines = read("scripts/export-kit.mts").split("\n").filter((l) => /localPkg\.scripts\.(?:dev|start) =/.test(l));
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line).toContain("-H 127.0.0.1");
    }
  });
});
