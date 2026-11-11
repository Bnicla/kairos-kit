import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicUrl, BlockedAddressError, fetchPublic, isPrivateAddress } from "../packages/engine/safe-fetch";

describe("safe-fetch: links the user pastes reach public addresses only", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("knows the non-public ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "104.18.0.1", "2606:4700::1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses local hosts, private literals and other schemes", async () => {
    for (const u of ["http://localhost:3000/api/file/x/resume.pdf", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd", "http://router.local/"])
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
});
