import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/store";
import { buildAutofillProfile, corsHeaders, rejectUnauthorized } from "@/lib/autofill";

export const dynamic = "force-dynamic";

/**
 * Local data bridge for the Kairos autofill browser extension.
 *
 * Serves a normalized "application profile" assembled from ~/Kairos (boilerplate
 * + EEO from autofill.json, work history from the knowledge base, and the list
 * of applications with a generated résumé to attach). Everything stays on the
 * machine; only a chrome-extension:// origin may read it.
 */

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export async function GET(req: NextRequest) {
  const store = getStore();
  const denied = await rejectUnauthorized(req, store);
  if (denied) {
    return NextResponse.json({ error: denied.message }, { status: denied.status, headers: corsHeaders(req) });
  }
  const profile = await buildAutofillProfile(store);
  return NextResponse.json(profile, { headers: corsHeaders(req) });
}
