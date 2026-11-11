import { NextResponse, type NextRequest } from "next/server";

/**
 * Local-only access check for the dashboard, on when KAIROS_LOCAL_ONLY=1 (the
 * Kit's launch script sets it; without it nothing changes).
 *
 * - The Host header must name this computer. A web page that points its own
 *   domain at 127.0.0.1 (DNS rebinding) sends its own name, and is refused.
 * - A request that changes something (POST and the like) must come from the
 *   dashboard's own pages, or carry no Origin at all (curl, the MCP server).
 *   Another site's page cannot post a form or call a server action here. The
 *   extension's routes check their own token (lib/autofill.ts).
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function hostIsLocal(host: string | null): boolean {
  const h = (host ?? "").toLowerCase().replace(/:\d+$/, "");
  return LOCAL_HOSTS.has(h);
}

export function originAllowed(origin: string | null, path: string): boolean {
  if (!origin) return true;
  if (path.startsWith("/api/autofill-") && /^(chrome|moz)-extension:\/\//.test(origin)) return true;
  try {
    return hostIsLocal(new URL(origin).host);
  } catch {
    return false;
  }
}

export function middleware(req: NextRequest) {
  if (process.env.KAIROS_LOCAL_ONLY !== "1") return NextResponse.next();
  if (!hostIsLocal(req.headers.get("host"))) return new NextResponse("This dashboard answers only on this computer (localhost).", { status: 403 });
  const safe = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  if (!safe && !originAllowed(req.headers.get("origin"), req.nextUrl.pathname)) return new NextResponse("Refused: the request came from another site.", { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: "/:path*" };
