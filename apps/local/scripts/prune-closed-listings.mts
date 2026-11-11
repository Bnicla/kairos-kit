/**
 * Prune dead listings: for every non-closed application whose source_url is on
 * a checkable public ATS (Greenhouse, Ashby, Rippling), verify the posting is
 * still live. Gone → status "expired" (Closed column), never deleted. ATSes we
 * can't probe (enterprise boards, aggregators) are reported, not touched.
 * Usage: npm -w kairos-local run prune-closed
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { rebuildApplicationsIndex, listApplicationFolders } from "@kairos/engine/applications";
import type { Store } from "@kairos/engine/store/types";

import { kairosHome } from "../../local/store/local-fs";
const APPS = join(kairosHome(), "applications");
const NOW = new Date().toISOString();
const OPEN = new Set(["captured", "scored", "drafted", "applied", "interviewing"]);

async function getJson(u: string): Promise<{ ok: boolean; body: unknown } | null> {
  try {
    const r = await fetch(u, {
      signal: AbortSignal.timeout(12_000),
      headers: { "user-agent": "kairos-sourcing/1.0", accept: "application/json" },
    });
    return { ok: r.ok, body: r.ok ? await r.json() : null };
  } catch {
    return null;
  }
}

/** live | gone | unknown for a job-ad URL, via the ATS's own public API. */
async function liveness(url: string | undefined): Promise<"live" | "gone" | "unknown"> {
  if (!url) return "unknown";
  // gh_jid-only embed URLs (company-site pages) lack the board token; those stay unknown.
  const gh = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (gh) {
    const r = await getJson(`https://boards-api.greenhouse.io/v1/boards/${gh[1]}/jobs/${gh[2]}`);
    return r === null ? "unknown" : r.ok ? "live" : "gone";
  }
  const ashby = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/i);
  if (ashby) {
    const r = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${ashby[1]}`);
    if (!r?.ok) return "unknown";
    const jobs = (r.body as { jobs?: { id?: string }[] }).jobs ?? [];
    return jobs.some((j) => j.id === ashby[2]) ? "live" : "gone";
  }
  const rippling = url.match(/ats\.rippling\.com\/([^/]+)\/jobs\/([0-9a-f-]+)/);
  if (rippling) {
    const r = await getJson(`https://api.rippling.com/platform/api/ats/v1/board/${rippling[1]}/jobs`);
    if (!r?.ok) return "unknown";
    const jobs = r.body as { uuid?: string; url?: string }[];
    return Array.isArray(jobs) &&
      jobs.some((j) => (j.uuid ?? "").includes(rippling[2]) || (j.url ?? "").includes(rippling[2]))
      ? "live"
      : "gone";
  }
  return "unknown";
}

let expired = 0, unknown = 0, live = 0;
for (const id of readdirSync(APPS)) {
  const p = join(APPS, id, "application-meta.json");
  if (!existsSync(p)) continue;
  const meta = JSON.parse(readFileSync(p, "utf8"));
  if (!OPEN.has(meta.status) || meta.archived) continue;
  const state = await liveness(meta.source_url);
  if (state === "gone") {
    // Applied/interviewing apps stay where they are — a pulled listing does not
    // close a process already in flight; only pre-application drafts expire.
    const draft = ["captured", "scored", "drafted"].includes(meta.status);
    if (draft) {
      meta.status = "expired";
      meta.updated_at = NOW;
      meta.status_history = [
        ...(meta.status_history ?? []),
        { status: "expired", at: NOW, note: "Listing no longer live on the company board; moved to Closed automatically." },
      ];
      writeFileSync(p, JSON.stringify(meta, null, 2));
      expired++;
      console.log(`✗ EXPIRED  ${id}`);
    } else {
      console.log(`! GONE (kept — already ${meta.status})  ${id}`);
    }
  } else if (state === "unknown") {
    unknown++;
  } else {
    live++;
  }
}
console.log(`\n${live} live · ${expired} expired · ${unknown} not checkable (enterprise ATS).`);

if (expired > 0) {
  // Status changed on disk without going through updateMeta — rebuild the index
  // so the board reflects the new Closed entries.
  const ROOT = dirname(APPS);
  const fsStore = {
    readJson: async <T,>(p: string[]) => {
      const f = join(ROOT, ...p);
      return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : null;
    },
    writeJson: async (p: string[], data: unknown) => {
      const f = join(ROOT, ...p);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(data, null, 2));
      return f;
    },
    listFolders: async (p: string[]) =>
      readdirSync(join(ROOT, ...p), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name })),
  } as unknown as Store;
  const folders = await listApplicationFolders(fsStore);
  await rebuildApplicationsIndex(fsStore, folders);
  console.log("applications index rebuilt.");
}
