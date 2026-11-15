import { NextResponse, type NextRequest } from "next/server";

/**
 * Local-only access check for the dashboard (Next.js "proxy", formerly middleware). It is on by default, however the
 * dashboard was started. The one way to turn it off is to set KAIROS_LOCAL_ONLY=0 in the dashboard's environment:
 * a deliberate choice, for a person who serves the dashboard to another device on their own network and accepts
 * that every page of that network's devices can then read and change their data. Any other value, and no value,
 * leave the check on.
 *
 * - The Host header must name this computer. A web page that points its own
 *   domain at 127.0.0.1 (DNS rebinding) sends its own name, and is refused.
 * - A request that changes something (POST and the like) must come from the
 *   dashboard's own origin (same host and port), or carry no Origin at all
 *   (curl, the MCP server).
 *   Another site's page cannot post a form or call a server action here. The
 *   extension's routes check their own token (lib/autofill.ts).
 *
 * The check reads headers. It does not choose the address the dashboard listens on: that is the second half of
 * the protection, and it is in the commands that start the dashboard. `npm run dev` and `npm run start` (and with
 * them the login service, and the Kit's own script) start it on 127.0.0.1, so no other computer of the network can
 * reach it at all. `next dev` typed by hand without `-H 127.0.0.1` listens on every interface; there a program on
 * the same network that writes its own Host header is not stopped by this check.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function hostIsLocal(host: string | null): boolean {
  const h = (host ?? "").toLowerCase().replace(/:\d+$/, "");
  return LOCAL_HOSTS.has(h);
}

/**
 * A change from a browser must come from the dashboard's own origin: the same
 * host and port as the request (another app on localhost:4555 is refused). No
 * Origin at all is a non-browser client (curl, the MCP server). The
 * extension's routes take its origin; they check their own token.
 */
export function originAllowed(origin: string | null, path: string, host: string | null): boolean {
  if (!origin) return true;
  if (path.startsWith("/api/autofill-") && /^(chrome|moz)-extension:\/\//.test(origin)) return true;
  try {
    const o = new URL(origin);
    return o.protocol === "http:" && hostIsLocal(o.host) && o.host.toLowerCase() === (host ?? "").toLowerCase();
  } catch {
    return false;
  }
}

/** The check is on unless the environment says KAIROS_LOCAL_ONLY=0, exactly. */
export function localOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env.KAIROS_LOCAL_ONLY?.trim() !== "0";
}

export function proxy(req: NextRequest) {
  if (!localOnly()) return NextResponse.next();
  if (!hostIsLocal(req.headers.get("host"))) return new NextResponse("This dashboard answers only on this computer (localhost).", { status: 403 });
  const safe = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  if (!safe && !originAllowed(req.headers.get("origin"), req.nextUrl.pathname, req.headers.get("host"))) return new NextResponse("Refused: the request came from another site.", { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: "/:path*" };
