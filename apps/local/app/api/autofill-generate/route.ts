import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/store";
import { createApplication, loadIndex } from "@kairos/engine/applications";
import { rejectUnauthorized } from "@/lib/autofill";

export const dynamic = "force-dynamic";

// Capture the current job into Kairos and kick off a tailored résumé for it.
// Capture is synchronous and reliable; generation is fired best-effort in the
// background (it takes minutes via the headless Claude channel), so the request
// returns immediately with the appId. The extension then points you at the
// Kairos board to watch it and attach when ready.

function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Kairos-Token",
      Vary: "Origin",
    };
  }
  return { Vary: "Origin" };
}

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export async function POST(req: NextRequest) {
  const store = getStore();
  const denied = await rejectUnauthorized(req, store);
  if (denied) {
    return NextResponse.json({ ok: false, error: denied.message }, { status: denied.status, headers: corsHeaders(req) });
  }
  const { url, company, title, text } = await req.json().catch(() => ({} as Record<string, string>));
  if (!company || !title) {
    return NextResponse.json({ ok: false, error: "missing company/title" }, { status: 400, headers: corsHeaders(req) });
  }
  const snapshot = text || `# ${title} — ${company}\n\n(Captured from ${url} by the autofill extension.)\n\n${url ?? ""}`;
  // Reuse an existing ACTIVE application for the same role instead of creating a
  // duplicate. The extension sends the URL slug as the company ("acmecorp"),
  // which differs from the tracked name ("Acme Corp"), so match with all
  // non-alphanumerics stripped.
  const key = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const index = await loadIndex(store).catch(() => ({ applications: [] as { id: string; company: string; role: string; status: string }[] }));
  const existing = index.applications.find(
    (a) => key(a.company) === key(company) && key(a.role) === key(title) && !["rejected", "withdrawn", "expired"].includes(a.status),
  );
  const appId = existing
    ? existing.id
    : (await createApplication(store, { company, role: title, snapshotMarkdown: snapshot, source_url: url, source_url_unavailable: !url })).id;

  // Best-effort background generation: don't block the response, and never let a
  // signature mismatch here break the capture (which already succeeded).
  (async () => {
    try {
      const mod = await import("@/lib/generate");
      const gen = (mod as Record<string, unknown>).generateResumeHeadless;
      if (typeof gen === "function") await (gen as (id: string) => Promise<unknown>)(appId);
    } catch (e) {
      console.error("[autofill-generate] background generation failed:", e);
    }
  })();

  return NextResponse.json(
    { ok: true, appId, reused: !!existing, board_url: "http://localhost:3000" },
    { headers: corsHeaders(req) },
  );
}
