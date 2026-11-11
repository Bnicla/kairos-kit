import { describe, expect, it } from "vitest";
import { hostIsLocal, originAllowed } from "../apps/local/proxy";

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
});
