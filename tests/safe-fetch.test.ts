import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchJobAd } from "../packages/engine/ingest";
import { assertPublicUrl, BlockedAddressError, fetchPublic, isPrivateAddress, MAX_PAGE_BYTES, readBodyCapped, readTextCapped, ResponseTooLargeError } from "../packages/engine/safe-fetch";

describe("safe-fetch: links the user pastes reach public addresses only", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("knows the non-public ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:0:7f00:1", "::7f00:1", "64:ff9b::7f00:1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "104.18.0.1", "2606:4700::1", "::ffff:808:808"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses local hosts, private literals and other schemes", async () => {
    for (const u of ["http://localhost:3000/api/file/x/resume.pdf", "http://127.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]:3000/", "http://[::ffff:7f00:1]/", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd", "http://router.local/"])
      await expect(assertPublicUrl(u), u).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(assertPublicUrl("https://8.8.8.8/")).resolves.toBeInstanceOf(URL);
  });

  it("checks every redirect before following it", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3000/api/autofill-profile" } });
    });
    await expect(fetchPublic("https://8.8.8.8/job")).rejects.toBeInstanceOf(BlockedAddressError);
    expect(seen).toEqual(["https://8.8.8.8/job"]);
  });

  it("follows a public redirect", async () => {
    vi.stubGlobal("fetch", async (url: string) => (url.endsWith("/a") ? new Response(null, { status: 301, headers: { location: "/b" } }) : new Response("ok")));
    const res = await fetchPublic("https://8.8.8.8/a");
    expect(await res.text()).toBe("ok");
  });

  it("refuses the cloud metadata name, which resolves to a link-local address", async () => {
    vi.doMock("node:dns/promises", () => ({ lookup: async () => [{ address: "169.254.169.254", family: 4 }] }));
    vi.resetModules();
    const fresh = await import("../packages/engine/safe-fetch");
    await expect(fresh.assertPublicUrl("http://metadata.google.internal/computeMetadata/v1/")).rejects.toBeInstanceOf(fresh.BlockedAddressError);
    vi.doUnmock("node:dns/promises");
    vi.resetModules();
  });

  it("stops after five redirects", async () => {
    let hops = 0;
    vi.stubGlobal("fetch", async () => new Response(null, { status: 302, headers: { location: `/hop-${++hops}` } }));
    await expect(fetchPublic("https://8.8.8.8/start")).rejects.toThrow("Too many redirects");
    expect(hops).toBe(6);
  });
});

describe("safe-fetch: the request connects to the address that was checked, and to no other", () => {
  /** A listener on this computer: the private address a rebinding name would turn to. */
  let server: http.Server;
  let port = 0;
  const hits: { host: string | undefined; url: string | undefined }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push({ host: req.headers.host, url: req.url });
      if (req.url === "/packed") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        return res.end(zlib.gzipSync("a packed page"));
      }
      if (req.url === "/moved") {
        res.writeHead(302, { location: "/page" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("the private page");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((done) => server.close(done));
  });
  afterEach(() => {
    hits.length = 0;
    vi.doUnmock("node:dns/promises");
    vi.resetModules();
  });

  /** The module with a DNS that answers each question from `answers`, in turn (the last one again after that), and counts the questions. */
  async function withDns(answers: { address: string; family: number }[][]) {
    const asked: string[] = [];
    vi.doMock("node:dns/promises", () => ({
      lookup: async (host: string) => {
        asked.push(host);
        return answers[Math.min(asked.length - 1, answers.length - 1)];
      },
    }));
    vi.resetModules();
    const fresh = await import("../packages/engine/safe-fetch");
    return { fresh, asked };
  }

  it("the pinned request reaches the address it is given, under the name it was asked for, and never asks DNS", async () => {
    // A name that no DNS knows: only the address given can answer.
    const { fresh, asked } = await withDns([[]]);
    const res = await fresh.requestPinned(new URL(`http://no-such-name.invalid:${port}/page`), [{ address: "127.0.0.1", family: 4 }], {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("the private page");
    expect(hits).toEqual([{ host: `no-such-name.invalid:${port}`, url: "/page" }]);
    expect(asked).toEqual([]);
    // A packed answer comes back unpacked, as fetch gives it; a redirect is handed back, not followed.
    const packed = await fresh.requestPinned(new URL(`http://no-such-name.invalid:${port}/packed`), [{ address: "127.0.0.1", family: 4 }], {});
    expect(await packed.text()).toBe("a packed page");
    expect(packed.headers.get("content-encoding")).toBeNull();
    const moved = await fresh.requestPinned(new URL(`http://no-such-name.invalid:${port}/moved`), [{ address: "127.0.0.1", family: 4 }], {});
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("/page");
  });

  it("with no checked address there is no request", async () => {
    const { fresh, asked } = await withDns([[]]);
    await expect(fresh.fetchPublic(`http://no-such-name.invalid:${port}/page`)).rejects.toThrow(/could not be found/);
    expect(asked).toEqual(["no-such-name.invalid"]);
    expect(hits).toEqual([]);
  });

  it("a name that is public for the check and private a moment later (DNS rebinding) never reaches the private address", async () => {
    // First answer: a public address where nothing listens (203.0.113.0/24 is reserved for documentation). Every later answer: this computer.
    const { fresh, asked } = await withDns([[{ address: "203.0.113.7", family: 4 }], [{ address: "127.0.0.1", family: 4 }]]);
    const outcome = await fresh.fetchPublic(`http://rebinding.example:${port}/page`, { signal: AbortSignal.timeout(400) }).then(
      (r) => `answered ${r.status}`,
      (e: Error) => e.name,
    );
    // The request went to the checked address and got no answer there; the listener on this computer saw nothing.
    expect(outcome).not.toMatch(/^answered/);
    expect(hits).toEqual([]);
    // The check asked for the name once. The connection is handed the checked address and asks no DNS
    // (the test above: a name that does not exist is reached at the address given).
    expect(asked).toEqual(["rebinding.example"]);
  });

  it("a name that resolves to a private address at the check is refused before any request", async () => {
    const { fresh, asked } = await withDns([[{ address: "127.0.0.1", family: 4 }]]);
    await expect(fresh.fetchPublic(`http://rebinding.example:${port}/page`)).rejects.toBeInstanceOf(fresh.BlockedAddressError);
    expect(asked).toHaveLength(1);
    expect(hits).toEqual([]);
  });

  it("each redirect is resolved and checked once, and its request goes to its own checked addresses", async () => {
    const { fresh, asked } = await withDns([[{ address: "203.0.113.7", family: 4 }], [{ address: "203.0.113.8", family: 4 }]]);
    const sent: { url: string; addresses: string[] }[] = [];
    fresh.setTransport(async (url, addresses) => {
      sent.push({ url: url.toString(), addresses: addresses.map((a) => a.address) });
      return sent.length === 1 ? new Response(null, { status: 302, headers: { location: "https://second.example/b" } }) : new Response("ok");
    });
    expect(await (await fresh.fetchPublic("https://first.example/a")).text()).toBe("ok");
    expect(sent).toEqual([
      { url: "https://first.example/a", addresses: ["203.0.113.7"] },
      { url: "https://second.example/b", addresses: ["203.0.113.8"] },
    ]);
    expect(asked).toEqual(["first.example", "second.example"]);
  });
});

describe("safe-fetch: a fetched page is read up to a size limit", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A body of `chunks` pieces of 64 KB each, and how many of them were pulled. */
  function bigBody(chunks: number) {
    const state = { pulled: 0, cancelled: false };
    const piece = new Uint8Array(64 * 1024).fill(97);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulled >= chunks) return controller.close();
        state.pulled++;
        controller.enqueue(piece);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { body, state };
  }

  it("reads a body under the limit whole", async () => {
    expect(await readTextCapped(new Response("a posting"))).toBe("a posting");
    expect((await readBodyCapped(new Response(null, { status: 204 }))).length).toBe(0);
    const { body } = bigBody(3);
    expect((await readBodyCapped(new Response(body), 1024 * 1024)).length).toBe(3 * 64 * 1024);
  });

  it("stops the download when the body passes the limit, whatever its declared length", async () => {
    const { body, state } = bigBody(10_000);
    await expect(readBodyCapped(new Response(body), 1024 * 1024)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(state.cancelled).toBe(true);
    // 1 MB is 16 pieces; the stream may be read a few pieces ahead, never the 10,000.
    expect(state.pulled).toBeLessThan(40);
  });

  it("refuses a declared length over the limit before reading", async () => {
    const { body, state } = bigBody(10);
    const res = new Response(body, { headers: { "content-length": String(MAX_PAGE_BYTES + 1) } });
    await expect(readBodyCapped(res)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(state.pulled).toBeLessThan(3);
  });

  it("a posting link that answers with a very large page is refused, and the user is told to paste the text", async () => {
    const { body, state } = bigBody(10_000);
    vi.stubGlobal("fetch", async (url: string) => (String(url) === "https://8.8.8.8/jobs/1" ? new Response(body, { headers: { "content-type": "text/html" } }) : new Response(null, { status: 404 })));
    await expect(fetchJobAd("https://8.8.8.8/jobs/1")).rejects.toThrow(/larger than 5 MB.*Paste the text/);
    expect(state.pulled).toBeLessThan(120);
  });
});
