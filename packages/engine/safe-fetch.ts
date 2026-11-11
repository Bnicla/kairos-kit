/**
 * Fetch for links the user pastes (job postings): public web addresses only.
 *
 * A link could point at this computer or the local network (a router page,
 * the dashboard, a cloud metadata address), directly or through a redirect.
 * This refuses http(s) addresses whose host is, or resolves to, a loopback,
 * private, link-local or otherwise non-public address, and checks each
 * redirect again before following it (at most 5).
 *
 * A name that does not resolve is left to fetch, which fails on its own.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class BlockedAddressError extends Error {}

const MAX_REDIRECTS = 5;

/** True for addresses that are not on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast, reserved, broadcast
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]);
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
  }
  return false;
}

/** Refuses a URL that is not http(s), or whose host is or resolves to a non-public address. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedAddressError(`Not a web address: ${raw.slice(0, 80)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedAddressError("Only http and https links can be fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new BlockedAddressError("Links to this computer or the local network are not fetched.");
  const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then((r) => r.map((a) => a.address), () => []);
  if (addresses.some(isPrivateAddress)) throw new BlockedAddressError("Links to this computer or the local network are not fetched.");
  return url;
}

/** fetch with the checks above on the first address and on every redirect. */
export async function fetchPublic(raw: string, init: RequestInit = {}): Promise<Response> {
  let url = (await assertPublicUrl(raw)).toString();
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { ...init, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects.");
    url = (await assertPublicUrl(new URL(location, url).toString())).toString();
  }
}
