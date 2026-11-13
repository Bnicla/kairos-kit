/**
 * Versioned resume tailoring command. Replaces the per-application scratchpad
 * scripts that were rebuilt by hand for every tailoring session.
 *
 *   npx tsx apps/local/scripts/tailor-resume.mts <spec.json>
 *
 * The spec carries everything application-specific; this script owns the
 * mechanics: clone the standing generic, apply the spec, run the engine's
 * grounding/style gates via saveGeneratedResume, render, and converge the
 * two-page layout with the spec's ordered fit hints instead of a human retry
 * loop.
 *
 * Spec shape:
 * {
 *   "appId": "2026-10-07_acme_head-of-product",
 *   "base": "<appId>",          // optional; else the application's track base_app, else profile.md standing_base_app
 *   "headline": "...",          // optional; else the track's headline (tracks other than main)
 *   "summary": ["- **Lead In:** ...", ...],            // replaces executive_summary
 *   "experiences": {
 *     "<title prefix>": {
 *       "swaps": { "<lead-in>": "**<lead-in>:** new bullet text" },
 *       "drops": ["<lead-in>", ...]                     // always removed
 *     }
 *   },
 *   "skills": ["...", ...],
 *   "provenance": [{"claim":"...","source_experience":"<kb id>","prov":"C"}],
 *   "tailoring_notes": "...",
 *   "honest_ceiling_note": "...",
 *   "dropped_for_relevance": ["..."],
 *   // this application's requirements coverage table (optional; never inherited from the base)
 *   "requirement_coverage": [{"requirement":"...","priority":"required","status":"covered","evidence":"<résumé text>"}],
 *   "fit": {
 *     // ordered, least-valuable first; dropped one at a time on overflow
 *     "drop_on_overflow": [["<title prefix>", "<lead-in>"], ...],
 *     // ordered, most-valuable first; restored one at a time when short
 *     "restore_on_short": [["<title prefix>", "<lead-in>"], ...]
 *   }
 * }
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { saveGeneratedResume, readPage2Anchor } from "../../../packages/engine/tools/ops";
import { summarizeOrigins, type LineOriginReport } from "../../../packages/engine/line-origin";
import { getStore } from "../store/index";
import { kairosHome } from "../store/local-fs";
import { readProfileSettings } from "../../../packages/engine/settings";
import { listTracks, resolveTrack, MAIN_TRACK_ID } from "../../../packages/engine/tracks";
import { renderDocxToPdf } from "../lib/pdf-render";
import { probeResumeLayout } from "../lib/layout-probe";

interface ExperienceSpec { swaps?: Record<string, string>; drops?: string[] }
interface TailorSpec {
  appId: string;
  base?: string;
  headline?: string;
  summary?: string[];
  experiences?: Record<string, ExperienceSpec>;
  skills?: string[];
  provenance?: { claim: string; source_experience: string; prov: string }[];
  tailoring_notes?: string;
  honest_ceiling_note?: string;
  dropped_for_relevance?: string[];
  requirement_coverage?: { requirement: string; priority: string; status: string; evidence?: string; note?: string }[];
  fit?: { drop_on_overflow?: [string, string][]; restore_on_short?: [string, string][] };
}

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: npx tsx apps/local/scripts/tailor-resume.mts <spec.json>");
  process.exit(1);
}
const spec = JSON.parse(readFileSync(resolve(specPath), "utf8")) as TailorSpec;
if (!spec.appId) throw new Error("spec.appId is required");

const HOME = kairosHome();
const profileRaw = existsSync(join(HOME, "profile.md")) ? readFileSync(join(HOME, "profile.md"), "utf8") : null;
const settings = readProfileSettings(profileRaw);
const store = getStore();
// The application's track (direction): its base résumé and headline, when it is not main.
const appMeta = existsSync(join(HOME, "applications", spec.appId, "application-meta.json"))
  ? (JSON.parse(readFileSync(join(HOME, "applications", spec.appId, "application-meta.json"), "utf8")) as { track?: string })
  : {};
const track = resolveTrack((await listTracks(store, profileRaw)).tracks, appMeta.track);
if (appMeta.track && !track) {
  console.error(`Application is on track '${appMeta.track}', which has no file in tracks/.`);
  process.exit(1);
}
const onSideTrack = track && track.id !== MAIN_TRACK_ID;
// The base résumé to clone: the spec's own, else the track's, else profile.md `standing_base_app`.
const BASE = spec.base ?? (onSideTrack ? track!.base_app : undefined) ?? settings.standing_base_app;
const HEADLINE = spec.headline ?? (onSideTrack ? track!.headline : undefined);
if (!BASE) {
  console.error(
    "No base résumé: set spec.base, the track's base_app (save_track), or `standing_base_app: <appId>` in profile.md (the application folder holding your standing generic resume.json).",
  );
  process.exit(1);
}
if (!existsSync(join(HOME, "applications", BASE, "resume.json"))) {
  console.error(`Base résumé not found: applications/${BASE}/resume.json under ${HOME}`);
  process.exit(1);
}
const anchor = readPage2Anchor(profileRaw) ?? undefined;

// Base lead-ins renamed after specs were written (profile.md
// `resume_leadin_aliases`, old name -> new name): older specs keep working.
const LEADIN_ALIASES: Record<string, string> = settings.resume_leadin_aliases ?? {};
const leadIn = (l: string) => LEADIN_ALIASES[l] ?? l;

function buildResume(extraDrops: [string, string][]): any {
  const g = JSON.parse(readFileSync(join(HOME, "applications", BASE, "resume.json"), "utf8"));
  // The base's coverage table describes the base's ad, not this one.
  delete g.requirement_coverage;
  if (spec.requirement_coverage) g.requirement_coverage = spec.requirement_coverage;
  const exp = (t: string) => {
    const e = g.resume.experience.find((x: any) => x.title.startsWith(t));
    if (!e) throw new Error("no experience titled: " + t);
    return e;
  };
  if (spec.summary) g.resume.executive_summary = spec.summary.join("\n");
  for (const [title, es] of Object.entries(spec.experiences ?? {})) {
    const e = exp(title);
    for (const [lead, text] of Object.entries(es.swaps ?? {})) {
      const i = e.bullets.findIndex((b: string) => b.startsWith(`**${leadIn(lead)}:**`));
      if (i < 0) throw new Error(`no bullet "${lead}" in ${title}`);
      e.bullets[i] = text;
    }
    for (const lead of es.drops ?? []) {
      e.bullets = e.bullets.filter((b: string) => !b.startsWith(`**${leadIn(lead)}:**`));
    }
  }
  for (const [title, lead] of extraDrops) {
    const e = exp(title);
    const before = e.bullets.length;
    e.bullets = e.bullets.filter((b: string) => !b.startsWith(`**${leadIn(lead)}:**`));
    if (e.bullets.length === before) console.warn(`fit drop found no bullet "${lead}" in ${title}`);
  }
  if (spec.skills) g.resume.skills = spec.skills;
  if (spec.provenance) g.provenance_audit.push(...spec.provenance);
  if (spec.tailoring_notes) g.tailoring_notes = spec.tailoring_notes;
  if (spec.honest_ceiling_note) g.honest_ceiling_note = spec.honest_ceiling_note;
  if (spec.dropped_for_relevance) {
    g.dropped_for_relevance = [
      ...spec.dropped_for_relevance,
      ...extraDrops.map(([t, l]) => `${l} bullet (${t}; dropped by the fit loop)`),
    ];
  }
  return g;
}

let stretch: { company: string; trigger: string; detail: string; bullet: string }[] = [];
// Paper the résumé was rendered on: profile.md `paper`, else by the search
// (settings.resumePaper). saveGeneratedResume resolves it and reports it.
let paper: string | undefined;
// The origin of each line, found in code by the save: counts, the lines with
// no verified fact, and the provenance entries that name the wrong source.
let origins: LineOriginReport | undefined;

async function renderAndProbe(g: any) {
  ({ stretch, paper, origins } = await saveGeneratedResume(store, spec.appId, g, HEADLINE ? { headline: HEADLINE } : {}));
  await renderDocxToPdf(join(HOME, "applications", spec.appId, "resume.docx"));
  return probeResumeLayout(join(HOME, "applications", spec.appId, "resume.docx"), { page2Anchor: anchor });
}

// Converge: start with every optional bullet included; drop on overflow in
// the spec's order; when short, pre-drop the restore list in reverse so the
// most valuable bullets come back first on the next pass.
const overflowQueue = [...(spec.fit?.drop_on_overflow ?? [])];
const applied: [string, string][] = [];
let probe = await renderAndProbe(buildResume(applied));
let rounds = 0;
while (rounds < 6) {
  console.log(`round ${rounds}: ${probe.verdict} (pages ${probe.pages}, last-page fill ${Math.round((probe.lastPageFill ?? 0) * 100)}%)`);
  if (probe.verdict === "good") break;
  if (probe.verdict === "overflow" && overflowQueue.length) {
    applied.push(overflowQueue.shift()!);
  } else if (probe.verdict === "short" && applied.length) {
    applied.pop(); // restore the most recently dropped optional bullet
    overflowQueue.length = 0; // avoid drop/restore oscillation
  } else {
    break; // no levers left; surface the guidance
  }
  rounds++;
  probe = await renderAndProbe(buildResume(applied));
}

console.log(JSON.stringify({ appId: spec.appId, paper, verdict: probe.verdict, pages: probe.pages, page2Start: probe.page2Start, fitDrops: applied, guidance: probe.guidance ?? null, stretch_check: stretch.map(({ company, trigger, detail, bullet }) => ({ company, trigger, why: detail, bullet })), line_origins: origins ? summarizeOrigins(origins) : null }, null, 1));
if (probe.verdict !== "good") process.exit(2);
