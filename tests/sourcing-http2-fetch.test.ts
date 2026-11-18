import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { http2Fetch } from "@kairos/engine/sourcing/http2-fetch";

/**
 * Workday is asked over HTTP/2 because the CDN in front of Workday challenged Node's HTTP/1.1 fetch
 * on many tenants (2026-11-16). The client must behave like fetch for getJson:
 * status, headers, JSON body, POST bodies, and a timeout that ends the request.
 */
describe("http2Fetch", () => {
  let server: http2.Http2Server;
  let origin = "";
  const open = new Set<http2.ServerHttp2Session>();
  beforeAll(async () => {
    server = http2.createServer((req, res) => {
      if (req.url === "/slow") return; // never answers
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const status = req.url === "/throttled" ? 429 : 200;
        res.writeHead(status, { "content-type": "application/json", "cf-mitigated": status === 429 ? "challenge" : "" });
        res.end(JSON.stringify({ method: req.method, ua: req.headers["user-agent"], body }));
      });
    });
    server.on("session", (s) => {
      open.add(s);
      s.on("close", () => open.delete(s));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    for (const s of open) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("posts a body and returns status, headers and JSON", async () => {
    const res = await http2Fetch(`${origin}/jobs`, { method: "POST", headers: { "user-agent": "kairos-sourcing/1.0", "content-type": "application/json" }, body: '{"limit":20}' });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ method: "POST", ua: "kairos-sourcing/1.0", body: '{"limit":20}' });
  });

  it("passes a 429 through with its headers", async () => {
    const res = await http2Fetch(`${origin}/throttled`);
    expect(res.status).toBe(429);
    expect(res.headers.get("cf-mitigated")).toBe("challenge");
  });

  it("reuses one session for several requests to the same origin", async () => {
    const all = await Promise.all([1, 2, 3].map(() => http2Fetch(`${origin}/jobs`)));
    expect(all.map((r) => r.status)).toEqual([200, 200, 200]);
  });

  it("ends a request on timeout with a TimeoutError", async () => {
    await expect(http2Fetch(`${origin}/slow`, { signal: AbortSignal.timeout(50) })).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("http2Fetch keeps the process alive while a request is in flight", () => {
  it("lets a script that only awaits a slow answer finish", async () => {
    const { execFileSync } = await import("node:child_process");
    // A child process whose only pending work is one HTTP/2 request answered after 300 ms.
    // The file is loaded as CommonJS (no "type": "module"): Node 25 sees its named export, Node 22 (the Kit's CI)
    // gives it only as the default object, so the script takes it from either.
    const script = `
      import http2 from "node:http2";
      const m = await import("./packages/engine/sourcing/http2-fetch.ts");
      const http2Fetch = m.http2Fetch ?? m.default.http2Fetch;
      const server = http2.createServer((req, res) => setTimeout(() => { res.writeHead(200); res.end("ok"); }, 300));
      server.listen(0, "127.0.0.1", () => { server.unref(); const port = server.address().port;
        http2Fetch("http://127.0.0.1:" + port + "/").then(async (r) => { console.log("status", r.status, await r.text()); });
      });`;
    // This Node with tsx loaded, not `npx tsx`: npx is a .cmd file on Windows, which cannot be started directly.
    const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
    expect(out).toContain("status 200 ok");
  }, 40_000);
});
