import type { RegistryEntry } from "./types";

/**
 * Registry loading (REQ-15): the harvested board list is DATA, not source.
 * Callers load it from their data path (local: ~/Kairos/sourcing/registry.json;
 * cloud: the user's Drive) and fall back to the committed seed only when no
 * harvested copy exists. Harvested data goes stale silently — staleness is
 * surfaced, never assumed away.
 */

export interface RegistryFile {
  version?: number;
  harvested_at?: string;
  entries: RegistryEntry[];
}

/**
 * Dedupe key for a board. Two ATSes fold case: SmartRecruiters company ids
 * ("Canva" = "canva"), and Workday site names. Checked live 2026-11-05:
 * "External" and "external" return the same postings and both career pages
 * load, while the Workday tenant is case-sensitive in the API path ("3M"
 * for "3m" answers 502), so only the data-center and site parts fold. The
 * harvested registry listed 654 Workday sites twice in two spellings, which
 * doubled those boards' requests and postings. Other ATSes keep slugs exact.
 */
export function registryKey(e: Pick<RegistryEntry, "ats" | "slug">): string {
  if (e.ats === "smartrecruiters") return `${e.ats}:${e.slug.toLowerCase()}`;
  if (e.ats === "workday") {
    const [tenant, ...rest] = e.slug.split("@");
    return `${e.ats}:${[tenant, ...rest.map((p) => p.toLowerCase())].join("@")}`;
  }
  return `${e.ats}:${e.slug}`;
}

/**
 * A board that is not a public job board: an internal, private or test career
 * site that a web crawl happened to index (Workday "…_Private", "…internal…",
 * Greenhouse "…sandbox", "…test"). Matched on the site part only, so company
 * names that contain these words (SandboxAQ, Private AI, UserTesting) stay.
 */
export function isNonPublicBoard(e: { ats: string; slug: string }): boolean {
  const site = e.ats === "workday" ? e.slug.split("@").slice(2).join("@") : e.slug;
  if (e.ats === "workday") return /private|internal|^test$|sandbox/i.test(site);
  return /internal|sandbox$|(impl|board)?test$/i.test(site) && !/^(sandboxaq|learningsandbox)$/i.test(site);
}

/** Drop repeated boards (same registryKey), keeping the first spelling. */
export function dedupeRegistry<T extends Pick<RegistryEntry, "ats" | "slug">>(entries: T[]): { entries: T[]; removed: number } {
  const seen = new Set<string>();
  const out = entries.filter((e) => {
    const key = registryKey(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { entries: out, removed: entries.length - out.length };
}

/** Parse + minimally validate a registry payload; null when unusable. */
export function parseRegistry(data: unknown): RegistryFile | null {
  const d = data as RegistryFile | null;
  if (!d || !Array.isArray(d.entries) || d.entries.length === 0) return null;
  const entries = d.entries.filter(
    (e): e is RegistryEntry => !!e && typeof e.slug === "string" && typeof e.ats === "string",
  );
  return entries.length ? { version: d.version, harvested_at: d.harvested_at, entries } : null;
}

export const REGISTRY_STALE_DAYS = 30;

/** Human-readable staleness warning, or null when fresh/undated-unknowable. */
export function registryStalenessWarning(harvestedAt: string | undefined, now = Date.now()): string | null {
  if (!harvestedAt) return "registry has no harvested_at date — freshness unknown; consider re-harvesting";
  const ageDays = Math.floor((now - new Date(harvestedAt).getTime()) / 86_400_000);
  if (!Number.isFinite(ageDays)) return null;
  return ageDays > REGISTRY_STALE_DAYS
    ? `registry is ${ageDays} days old (harvested ${harvestedAt.slice(0, 10)}) — boards decay; re-run the harvest`
    : null;
}

/**
 * Resolve the registry: prefer the caller-supplied data copy, fall back to the
 * seed. Returns the chosen file (boards deduplicated, see registryKey) plus
 * which source won, how many repeated boards were dropped, and any staleness
 * note, so callers can log honestly.
 */
export function resolveRegistry(
  dataCopy: unknown,
  seed: RegistryFile,
  now = Date.now(),
): { registry: RegistryFile; source: "data" | "seed"; staleness: string | null; duplicates_removed: number } {
  const parsed = parseRegistry(dataCopy);
  const chosen = parsed ?? seed;
  const { entries, removed } = dedupeRegistry(chosen.entries);
  return {
    registry: { ...chosen, entries },
    source: parsed ? "data" : "seed",
    staleness: registryStalenessWarning(chosen.harvested_at, now),
    duplicates_removed: removed,
  };
}
