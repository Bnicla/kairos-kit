import { getStore } from "@/store";

/**
 * Serve an HTML prep note (a glance card) from an application folder, inline.
 * Plain *.html file names only, never a path.
 */
const ALLOWED = /^[\w.-]+\.html$/;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params;
  if (!ALLOWED.test(name)) return new Response("Not found", { status: 404 });

  const html = await getStore().readFile(["applications", id, name]);
  if (html === null) return new Response("Not found", { status: 404 });

  // The page is model-written HTML. Serve it sandboxed: no scripts, no forms,
  // no requests out, and a unique origin so it cannot reach the dashboard.
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
