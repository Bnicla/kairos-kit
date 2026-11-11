import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "@/store/local-fs";
import { createApplication, loadIndex, readMeta, updateMeta } from "@kairos/engine/applications";
import {
  listTracks,
  mainTrackFromProfile,
  resolveTrack,
  saveTrack,
  trackGuidance,
  MAIN_TRACK_ID,
  MAX_ACTIVE_TRACKS,
} from "@kairos/engine/tracks";
import { buildGenerationUserMessage } from "@kairos/engine/prompts/generation";
import { buildScoringUserMessage } from "@kairos/engine/prompts/scoring";
import { buildCoverLetterUserMessage } from "@kairos/engine/prompts/cover-letter";

/** Tracks: several profiles per user over one record (docs/career-advisor-spec.md §7). */

const PROFILE = `---
name: Alex Example
headline: Strategy Consultant
target_roles:
  - Engagement Manager
target_seniority: Manager
standing_base_app: 2026-01-01_base_consultant
---
`;

let store: LocalStore;
beforeEach(() => {
  store = new LocalStore(mkdtempSync(join(tmpdir(), "kairos-tracks-")));
});

const pm = {
  name: "Product management",
  headline: "Product Manager, B2B software",
  target_roles: ["Product Manager", "Senior Product Manager"],
  switch: true,
  bridge_story: "Five years turning client problems into shipped operating changes.",
  evidence_map: [{ experience_id: "01-acme-consulting", fact: "Led a pricing redesign adopted by 3 business units", field_terms: ["launch"], proves: "prioritization" }],
};

describe("tracks", () => {
  it("gives a user with no track files one virtual main track read from profile.md", async () => {
    const { tracks, virtual } = await listTracks(store, PROFILE);
    expect(virtual).toBe(true);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      id: MAIN_TRACK_ID,
      name: "Strategy Consultant",
      headline: "Strategy Consultant",
      target_roles: ["Engagement Manager"],
      base_app: "2026-01-01_base_consultant",
      source: "profile",
    });
  });

  it("works with no profile at all", () => {
    expect(mainTrackFromProfile(null)).toMatchObject({ id: MAIN_TRACK_ID, name: "Main", target_roles: [] });
  });

  it("writes the main track to disk when the first other track is saved", async () => {
    const r = await saveTrack(store, PROFILE, pm, { experienceIds: ["01-acme-consulting"] });
    expect(r).toMatchObject({ created: true, wrote_main: true });
    expect(r.track.id).toBe("product-management");
    const { tracks, virtual } = await listTracks(store, PROFILE);
    expect(virtual).toBe(false);
    expect(tracks.map((t) => t.id).sort()).toEqual(["main", "product-management"]);
  });

  it("updates keep the fields that were not passed", async () => {
    await saveTrack(store, PROFILE, pm, { experienceIds: ["01-acme-consulting"] });
    const r = await saveTrack(store, PROFILE, { id: "product-management", name: "Product management", headline: "Product Manager" });
    expect(r.created).toBe(false);
    expect(r.track.headline).toBe("Product Manager");
    expect(r.track.bridge_story).toBe(pm.bridge_story);
    expect(r.track.evidence_map).toHaveLength(1);
  });

  it("refuses an evidence map that cites an experience the record does not hold", async () => {
    await expect(saveTrack(store, PROFILE, pm, { experienceIds: ["02-other"] })).rejects.toThrow(/not in the record: 01-acme-consulting/);
  });

  it(`refuses more than ${MAX_ACTIVE_TRACKS} active tracks, and accepts a paused one`, async () => {
    await saveTrack(store, PROFILE, { name: "Product management" });
    await saveTrack(store, PROFILE, { name: "Corporate strategy" });
    await expect(saveTrack(store, PROFILE, { name: "Venture capital" })).rejects.toThrow(/already active/);
    const paused = await saveTrack(store, PROFILE, { name: "Venture capital", status: "paused" });
    expect(paused.track.status).toBe("paused");
  });

  it("resolves an application's track, defaulting to main", async () => {
    await saveTrack(store, PROFILE, pm, { experienceIds: ["01-acme-consulting"] });
    const { tracks } = await listTracks(store, PROFILE);
    expect(resolveTrack(tracks, undefined)?.id).toBe(MAIN_TRACK_ID);
    expect(resolveTrack(tracks, "product-management")?.id).toBe("product-management");
    expect(resolveTrack(tracks, "gone")).toBeNull();
  });

  it("stores the track on the application and in the board index", async () => {
    const app = await createApplication(store, { company: "Acme", role: "PM", snapshotMarkdown: "ad", source_url: "https://example.com/job" });
    await updateMeta(store, app.id, { track: "product-management" });
    expect((await readMeta(store, app.id))?.track).toBe("product-management");
    expect((await loadIndex(store)).applications[0].track).toBe("product-management");
  });
});

describe("track guidance in the payloads", () => {
  it("adds nothing for the plain main track, so single-track users see no change", async () => {
    const { tracks } = await listTracks(store, PROFILE);
    expect(trackGuidance(tracks[0])).toBeNull();
  });

  it("carries positioning and the never-change-facts rules, plus the switch rules for a change of field", async () => {
    const { track } = await saveTrack(store, PROFILE, pm, { experienceIds: ["01-acme-consulting"] });
    const g = trackGuidance(track)!;
    expect(g).toMatchObject({ id: "product-management", headline: pm.headline, switch: true, bridge_story: pm.bridge_story });
    expect(g.rules.join(" ")).toMatch(/never add a title, responsibility or result/);
    expect(g.rules.join(" ")).toMatch(/do not raise the band/);
    const plain = trackGuidance({ ...track, switch: false })!;
    expect(plain.rules.join(" ")).not.toMatch(/raise the band/);
  });

  it("reaches the scoring, résumé and letter payloads only when present", async () => {
    const { track } = await saveTrack(store, PROFILE, pm, { experienceIds: ["01-acme-consulting"] });
    const g = trackGuidance(track);
    const base = { jobText: "ad", experiences: [], voiceProfile: null };
    const scoring = (t: typeof g) =>
      buildScoringUserMessage({ ...base, detectedAts: "x", educationRaw: [], recruiterFeedback: null, mode: "audit", track: t });
    const gen = (t: typeof g) =>
      buildGenerationUserMessage({
        ...base, detectedAts: "x", company: "Acme", title: "PM", scoreReport: {} as never, educationRaw: [], summaryBlocks: null, recruiterFeedback: null, track: t,
      });
    const letter = (t: typeof g) => buildCoverLetterUserMessage({ ...base, company: "Acme", title: "PM", date: "2026-11-06", track: t });
    for (const build of [scoring, gen, letter]) {
      expect(build(g)).toContain('"track_guidance"');
      expect(build(g)).toContain(pm.bridge_story);
      expect(build(null)).not.toContain("track_guidance");
    }
  });
});
