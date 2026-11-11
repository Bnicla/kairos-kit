/**
 * Tracks: several profiles per user, one record.
 *
 * A track is one direction the user is applying in ("Product management",
 * "Consulting"). It holds positioning only: headline, target titles, search
 * terms, the bridge story, the evidence map, the base résumé, the cover-letter
 * angle. It never holds or edits facts: dates, titles, employers and numbers
 * always come from the record, so every track tells the same true story.
 *
 * Storage: `tracks/<id>.json` in the data folder. A user with no track files
 * has one virtual track, "main", read from profile.md, so nothing changes for
 * users who never create a track. Applications point to a track through
 * `meta.track`; none means "main".
 *
 * Spec: docs/career-advisor-spec.md §7.
 */
import matter from "gray-matter";
import { z } from "zod";
import type { Store } from "@kairos/engine/store/types";
import { slugify } from "@kairos/engine/applications";

export const TRACKS_DIR = "tracks";
export const MAIN_TRACK_ID = "main";
/** More active tracks spread a short search thin (spec §13, question 5). */
export const MAX_ACTIVE_TRACKS = 3;

export const TrackStatus = z.enum(["active", "paused", "dropped"]);

export const EvidenceMapItem = z.object({
  /** KB experience id (file name without .md) the evidence lives in. */
  experience_id: z.string().min(1),
  /** The fact as the record states it. */
  fact: z.string().min(1),
  /** The target field's own words for it, used only where the fact supports them. */
  field_terms: z.array(z.string()).optional(),
  /** The target-role skill this fact proves. */
  proves: z.string().optional(),
});

export const TrackSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/, "lowercase letters, digits and dashes"),
  name: z.string().min(1),
  status: TrackStatus.default("active"),
  headline: z.string().optional(),
  target_roles: z.array(z.string()).default([]),
  target_seniority: z.string().optional(),
  /** Search terms this track adds to the daily search (function terms, boosts, exclusions). */
  search: z
    .object({
      function_terms: z.array(z.string()).optional(),
      boost_terms: z.array(z.string()).optional(),
      exclude_terms: z.array(z.string()).optional(),
    })
    .optional(),
  /** Two or three approved sentences on why the move makes sense. */
  bridge_story: z.string().optional(),
  /** True when the track is a change of field (the Assessor's switcher view applies). */
  switch: z.boolean().default(false),
  evidence_map: z.array(EvidenceMapItem).default([]),
  /** appId of this track's standing base résumé. */
  base_app: z.string().optional(),
  /** Which bridge-story points a letter opens with, and which gap it addresses. */
  letter_angle: z.string().optional(),
  /** Where the track came from. */
  source: z.enum(["profile", "advisor", "user"]).default("user"),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Track = z.infer<typeof TrackSchema>;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

/** The virtual "main" track built from profile.md, for users with no track files. */
export function mainTrackFromProfile(profileRaw: string | null | undefined, now = new Date().toISOString()): Track {
  let fm: Record<string, unknown> = {};
  try {
    fm = profileRaw ? ((matter(profileRaw).data ?? {}) as Record<string, unknown>) : {};
  } catch {
    fm = {};
  }
  const headline = str(fm.headline);
  return {
    id: MAIN_TRACK_ID,
    name: headline ?? "Main",
    status: "active",
    ...(headline ? { headline } : {}),
    target_roles: strList(fm.target_roles),
    ...(str(fm.target_seniority) ? { target_seniority: str(fm.target_seniority) } : {}),
    switch: false,
    evidence_map: [],
    ...(str(fm.standing_base_app) ? { base_app: str(fm.standing_base_app) } : {}),
    source: "profile",
    created_at: now,
    updated_at: now,
  };
}

/** Every saved track; with none saved, the virtual main track. Invalid files are skipped and named. */
export async function listTracks(
  store: Store,
  profileRaw: string | null | undefined,
): Promise<{ tracks: Track[]; virtual: boolean; invalid: string[] }> {
  const names = (await store.listFiles([TRACKS_DIR]).catch(() => []))
    .map((f) => f.name)
    .filter((n) => n.endsWith(".json"));
  const tracks: Track[] = [];
  const invalid: string[] = [];
  for (const n of names.sort()) {
    const raw = await store.readJson<unknown>([TRACKS_DIR, n]).catch(() => null);
    const parsed = TrackSchema.safeParse(raw);
    if (parsed.success) tracks.push(parsed.data);
    else invalid.push(n);
  }
  if (!tracks.length) return { tracks: [mainTrackFromProfile(profileRaw)], virtual: true, invalid };
  return { tracks, virtual: false, invalid };
}

/** The track an application belongs to: its own, else main, else the first active one. */
export function resolveTrack(tracks: Track[], trackId?: string | null): Track | null {
  if (trackId) return tracks.find((t) => t.id === trackId) ?? null;
  return tracks.find((t) => t.id === MAIN_TRACK_ID) ?? tracks.find((t) => t.status === "active") ?? tracks[0] ?? null;
}

export function trackIdFor(name: string): string {
  return slugify(name) || "track";
}

export interface SaveTrackInput {
  id?: string;
  name: string;
  status?: z.infer<typeof TrackStatus>;
  headline?: string;
  target_roles?: string[];
  target_seniority?: string;
  search?: Track["search"];
  bridge_story?: string;
  switch?: boolean;
  evidence_map?: z.infer<typeof EvidenceMapItem>[];
  base_app?: string;
  letter_angle?: string;
  source?: Track["source"];
}

/**
 * Create or update a track. Fields passed replace the stored ones; fields
 * omitted are kept. The first save when only the virtual main track exists
 * also writes main to disk, so the user's current profile stays a track.
 * Refuses a fourth active track, and an evidence map that cites an experience
 * the record does not hold.
 */
export async function saveTrack(
  store: Store,
  profileRaw: string | null | undefined,
  input: SaveTrackInput,
  opts: { experienceIds?: string[]; now?: string } = {},
): Promise<{ track: Track; created: boolean; wrote_main: boolean }> {
  const now = opts.now ?? new Date().toISOString();
  const { tracks, virtual } = await listTracks(store, profileRaw);
  const id = input.id ?? trackIdFor(input.name);
  const existing = virtual ? (id === MAIN_TRACK_ID ? tracks[0] : undefined) : tracks.find((t) => t.id === id);

  if (input.evidence_map && opts.experienceIds) {
    const known = new Set(opts.experienceIds);
    const unknown = input.evidence_map.filter((e) => !known.has(e.experience_id)).map((e) => e.experience_id);
    if (unknown.length) throw new Error(`evidence_map cites experiences that are not in the record: ${[...new Set(unknown)].join(", ")}`);
  }

  const merged = TrackSchema.parse({
    ...(existing ?? { source: input.source ?? "user", created_at: now }),
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    id,
    updated_at: now,
  });

  const others = (virtual ? tracks.filter((t) => t.id !== id) : tracks.filter((t) => t.id !== id)).filter((t) => t.status === "active");
  if (merged.status === "active" && others.length >= MAX_ACTIVE_TRACKS) {
    throw new Error(
      `${MAX_ACTIVE_TRACKS} tracks are already active (${others.map((t) => t.name).join(", ")}). Pause or drop one first.`,
    );
  }

  let wrote_main = false;
  if (virtual && id !== MAIN_TRACK_ID) {
    await store.writeJson([TRACKS_DIR, `${MAIN_TRACK_ID}.json`], tracks[0]);
    wrote_main = true;
  }
  await store.writeJson([TRACKS_DIR, `${id}.json`], merged);
  return { track: merged, created: !existing, wrote_main };
}

/**
 * What the scorer, the Writer and the letter writer receive about the track.
 * Positioning only: it can change selection, order and wording, never facts.
 */
export interface TrackGuidance {
  id: string;
  name: string;
  headline?: string;
  target_roles: string[];
  target_seniority?: string;
  switch: boolean;
  bridge_story?: string;
  evidence_map: z.infer<typeof EvidenceMapItem>[];
  letter_angle?: string;
  rules: string[];
}

export const TRACK_RULES = [
  "The track is positioning only. Every fact (employer, title, dates, numbers, scope) comes from candidate.experiences, unchanged.",
  "Use the track's headline, target roles and evidence map to choose, order and word what goes on the page.",
  "field_terms may replace the record's wording only where the fact itself supports them; never add a title, responsibility or result the record does not hold.",
];

export const SWITCH_TRACK_RULES = [
  "This is a change of field. Score the posting as written: do not raise the band to make up for a missing title or domain.",
  "In the justifications, name the transferable evidence (record facts that prove the posting's needs under a different title) and list the gaps plainly.",
];

export function trackGuidance(track: Track | null | undefined): TrackGuidance | null {
  if (!track) return null;
  // The virtual main track carries nothing beyond the profile the payload already has.
  if (track.source === "profile" && !track.bridge_story && !track.evidence_map.length && !track.switch) return null;
  return {
    id: track.id,
    name: track.name,
    ...(track.headline ? { headline: track.headline } : {}),
    target_roles: track.target_roles,
    ...(track.target_seniority ? { target_seniority: track.target_seniority } : {}),
    switch: track.switch,
    ...(track.bridge_story ? { bridge_story: track.bridge_story } : {}),
    evidence_map: track.evidence_map,
    ...(track.letter_angle ? { letter_angle: track.letter_angle } : {}),
    rules: track.switch ? [...TRACK_RULES, ...SWITCH_TRACK_RULES] : TRACK_RULES,
  };
}
