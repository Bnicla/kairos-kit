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
