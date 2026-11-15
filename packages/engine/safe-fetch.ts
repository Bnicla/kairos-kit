/**
 * Fetch for links the user pastes (job postings): public web addresses only.
 *
 * A link could point at this computer or the local network (a router page,
 * the dashboard, a cloud metadata address), directly or through a redirect.
 * This refuses http(s) addresses whose host is, or resolves to, a loopback,
 * private, link-local or otherwise non-public address, and checks each
 * redirect again before following it (at most 5).
 *
 * The name is resolved once. The request then connects to the addresses that
 * were checked, and to no other: the connection is given those addresses in
 * place of a second lookup (requestPinned). A name that answers with a public
 * address for the check and with a private one a moment later (DNS rebinding)
 * therefore reaches the public address or nothing. The name itself is still
 * what the request names (the Host header, and the certificate over https).
 *
 * A name that does not resolve is not fetched.
 *
 * The answer's body is read with a size limit (readBodyCapped): a link can
 * point at a file of any size, and the whole of it would otherwise be held in
 * memory.
 */
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";

export class BlockedAddressError extends Error {}
/** The answer's body is longer than the limit. */
export class ResponseTooLargeError extends Error {}

/**
 * The most a fetched page or posting API answer may weigh. The limit is there
 * for memory: a link can point at a file of any size. It is not what bounds
 * the time to read a page; the posting guard does that itself (it stops after
 * a second). Real careers pages reach 1.8 MB, so the limit stays well above.
 */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;

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
    // An IPv4 address carried in IPv6 (mapped ::ffff:a.b.c.d, or the same in hex as
    // URL writes it, ::ffff:7f00:1; the old compatible form ::a.b.c.d; NAT64 64:ff9b::)
    // is judged as the IPv4 address it carries.
    const embedded = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (embedded) return isPrivateAddress(embedded[1]);
    const hex = /^(?:::ffff:(?:0:)?|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
  }
  return false;
}

/** An address a name resolved to, after the check. */
export interface CheckedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * The URL, and the addresses its host resolved to: asked once, every one of them public.
 * Refuses a URL that is not http(s), or whose host is or resolves to a non-public address.
 * A name that does not resolve gives no address.
 */
export async function resolvePublic(raw: string): Promise<{ url: URL; addresses: CheckedAddress[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedAddressError(`Not a web address: ${raw.slice(0, 80)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedAddressError("Only http and https links can be fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new BlockedAddressError("Links to this computer or the local network are not fetched.");
  const literal = isIP(host);
  const addresses: CheckedAddress[] = literal
    ? [{ address: host, family: literal as 4 | 6 }]
    : await lookup(host, { all: true }).then((r) => r.map((a) => ({ address: a.address, family: a.family as 4 | 6 })), () => []);
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new BlockedAddressError("Links to this computer or the local network are not fetched.");
  return { url, addresses };
}

/** Refuses a URL that is not http(s), or whose host is or resolves to a non-public address. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  return (await resolvePublic(raw)).url;
}

/** One request to `url`, connecting to `addresses` only. It follows no redirect. */
export type Transport = (url: URL, addresses: CheckedAddress[], init: RequestInit) => Promise<Response>;

const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * One http(s) request that connects to the given addresses and never resolves
 * the name itself. The request still carries the name: as its Host header, and
 * over https as the name the certificate must be for.
 */
export const requestPinned: Transport = (url, addresses, init) =>
  new Promise<Response>((resolve, reject) => {
    if (!addresses.length) return reject(new Error(`The address of ${url.hostname} could not be found.`));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => (headers[name] = value));
    // The headers Node's own fetch adds by itself, so that a site sees the request it saw before this function replaced it.
    const defaults: Record<string, string> = { accept: "*/*", "accept-language": "*", "sec-fetch-mode": "cors", "user-agent": "node", "accept-encoding": "gzip, deflate, br" };
    for (const [name, value] of Object.entries(defaults)) if (!(name in headers)) headers[name] = value;
    const body = init.body;
    if (body != null && typeof body !== "string" && !(body instanceof Uint8Array) && !(body instanceof URLSearchParams)) return reject(new Error("This request body cannot be sent."));
    // The connection asks for the name's addresses here. It is given the checked ones; DNS is not asked again.
    const pinned = (_host: string, options: unknown, callback: (...args: unknown[]) => void) => {
      const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
      if (all) callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
      else callback(null, addresses[0].address, addresses[0].family);
    };
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      { method: init.method ?? "GET", headers, agent: false, lookup: pinned as never, ...(init.signal ? { signal: init.signal } : {}) },
      (res) => {
        const status = res.statusCode ?? 502;
        const answer = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const v of value) answer.append(name, v);
          else if (value !== undefined) answer.set(name, value);
        }
        if (NO_BODY.has(status) || init.method === "HEAD") {
          res.resume();
          return resolve(new Response(null, { status, statusText: res.statusMessage, headers: answer }));
        }
        const encoding = (res.headers["content-encoding"] ?? "").toLowerCase().trim();
        const unpack = encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip() : encoding === "deflate" ? zlib.createInflate() : encoding === "br" ? zlib.createBrotliDecompress() : null;
        if (unpack) {
          // The body below is the unpacked one: the packed length and the encoding no longer describe it.
          answer.delete("content-encoding");
          answer.delete("content-length");
          res.on("error", (e) => unpack.destroy(e));
          unpack.on("close", () => res.destroy());
        }
        const stream = unpack ? res.pipe(unpack) : res;
        resolve(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, statusText: res.statusMessage, headers: answer }));
      },
    );
    req.on("error", reject);
    req.end(body == null ? undefined : body instanceof URLSearchParams ? body.toString() : body);
  });

let transport: Transport = requestPinned;
/**
 * Replace the request itself (tests answer the web with a stand-in). With no argument the real one is back.
 * The checks of the address and of every redirect stay in fetchPublic whatever is set here.
 */
export function setTransport(replacement?: Transport): void {
  transport = replacement ?? requestPinned;
}

/** fetch with the checks above on the first address and on every redirect; each request goes to the addresses that were checked. */
export async function fetchPublic(raw: string, init: RequestInit = {}): Promise<Response> {
  let target = await resolvePublic(raw);
  for (let hop = 0; ; hop++) {
    const res = await transport(target.url, target.addresses, init);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects.");
    target = await resolvePublic(new URL(location, target.url).toString());
  }
}

/**
 * The body of an answer as bytes, read up to `maxBytes`. A longer body stops
 * the download and throws ResponseTooLargeError; a Content-Length over the
 * limit does so before anything is read.
 */
export async function readBodyCapped(res: Response, maxBytes: number = MAX_PAGE_BYTES): Promise<Uint8Array> {
  const tooLarge = () => new ResponseTooLargeError(`The page is larger than ${Math.round(maxBytes / (1024 * 1024))} MB and was not read. Paste the text instead.`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The body of an answer as text (UTF-8, as Response.text reads it), with the size limit. */
export async function readTextCapped(res: Response, maxBytes: number = MAX_PAGE_BYTES): Promise<string> {
  return new TextDecoder().decode(await readBodyCapped(res, maxBytes));
}
