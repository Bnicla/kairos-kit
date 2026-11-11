/**
 * Backfill application-form.json for existing applications whose source_url is
 * a public Greenhouse board posting. One-shot, idempotent (refetches always —
 * forms drift). Usage: npm -w kairos-local run fetch-forms [appId]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fetchGreenhouseForm, formSummary, parseGreenhouseUrl } from "@kairos/engine/forms";

import { kairosHome } from "../../local/store/local-fs";
const APPS = join(kairosHome(), "applications");
const only = process.argv[2];

const folders = readdirSync(APPS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (!only || d.name === only))
  .map((d) => d.name);

let harvested = 0;
for (const id of folders) {
  const metaPath = join(APPS, id, "application-meta.json");
  if (!existsSync(metaPath)) continue;
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (!parseGreenhouseUrl(meta.source_url)) continue;
  const form = await fetchGreenhouseForm(meta.source_url);
  if (!form) {
    console.log(`✗ ${id} (greenhouse URL but fetch failed — posting likely closed)`);
    continue;
  }
  writeFileSync(join(APPS, id, "application-form.json"), JSON.stringify(form, null, 2));
  const s = formSummary(form);
  console.log(`✓ ${id}: ${s.custom_questions} custom, ${s.writing_questions} need writing`);
  harvested++;
}
console.log(`\n${harvested} form${harvested === 1 ? "" : "s"} harvested of ${folders.length} folders scanned.`);
