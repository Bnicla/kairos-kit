/**
 * A small fetch over HTTP/2, for Workday.
 *
 * Measured 2026-11-16 from a home connection that had run two full sweeps that
 * morning: on the same Workday tenants, at the same moment, with the same headers,
 * Node's fetch (HTTP/1.1) drew the bot challenge of the CDN in front of Workday (429, `cf-mitigated:
 * challenge`) on 7 to 9 tenants out of 12, while curl and node:http2 (both HTTP/2)
 * drew none. The sweep had counted those challenges as rate limits (3,146 boards),
 * and slowing down did not help: 2 requests a second were still challenged.
 *
 * One session per origin is kept open while requests come, and closed after a few
 * idle seconds. A session holds the process alive only while it has a request in
 * flight (an idle one is unref'd, so it never keeps a finished process running). The
 * module loads node:http2 on first use, so importing it costs nothing elsewhere.
 */

type Session = import("node:http2").ClientHttp2Session;

const IDLE_MS = 5_000;
const sessions = new Map<string, Session>();
/** Requests in flight per session: the session is ref'd while this is above zero. */
const inFlight = new WeakMap<Session, number>();
const begin = (s: Session) => {
  const n = (inFlight.get(s) ?? 0) + 1;
  inFlight.set(s, n);
  if (n === 1) s.ref();
};
const finish = (s: Session) => {
  const n = Math.max(0, (inFlight.get(s) ?? 1) - 1);
  inFlight.set(s, n);
  if (n === 0 && !s.destroyed) s.unref();
};

async function sessionFor(origin: string): Promise<Session> {
  const open = sessions.get(origin);
  if (open && !open.closed && !open.destroyed) return open;
  const http2 = await import("node:http2");
  const s = http2.connect(origin);
  s.unref();
  s.setTimeout(IDLE_MS, () => s.close());
  const forget = () => {
    if (sessions.get(origin) === s) sessions.delete(origin);
  };
  s.on("close", forget);
  s.on("goaway", forget);
  s.on("error", forget);
  sessions.set(origin, s);
  return s;
}

/** fetch(url, init) over HTTP/2: method, headers, a string body and an abort signal; no redirects are followed. */
export async function http2Fetch(url: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(url);
  const session = await sessionFor(u.origin);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => {
    headers[k] = v;
  });
  return new Promise<Response>((resolve, reject) => {
    // One outcome only: a stream closed on timeout still emits "end" afterwards, with no status.
    let settled = false;
    begin(session);
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      finish(session);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    let req: import("node:http2").ClientHttp2Stream;
    try {
      req = session.request({ ":method": (init.method ?? "GET").toUpperCase(), ":path": u.pathname + u.search, ...headers });
    } catch (err) {
      fail(err);
      return;
    }
    const signal = init.signal ?? undefined;
    const onAbort = () => {
      req.close();
      const e = new Error("The operation was aborted");
      e.name = signal?.reason instanceof Error && signal.reason.name === "TimeoutError" ? "TimeoutError" : "AbortError";
      fail(e);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let status = 0;
    const outHeaders = new Headers();
    const chunks: Buffer[] = [];
    req.on("response", (h) => {
      status = Number(h[":status"]);
      for (const [k, v] of Object.entries(h)) {
        if (k.startsWith(":") || v === undefined) continue;
        outHeaders.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      }
    });
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      if (status < 200 || status > 599) return fail(new Error(`http2: no usable status (${status})`));
      settled = true;
      finish(session);
      const noBody = status === 204 || status === 304;
      resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, headers: outHeaders }));
    });
    req.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      fail(err);
    });
    if (typeof init.body === "string") req.end(init.body);
    else req.end();
  });
}
