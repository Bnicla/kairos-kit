"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getStore } from "@/store";
import { removeIndexEntry, updateMeta, type ApplicationStatus, type ApplicationMeta } from "@kairos/engine/applications";

/** Change an application's status (the pipeline action). */
export async function setStatusAction(formData: FormData) {
  const id = String(formData.get("id"));
  const status = String(formData.get("status")) as ApplicationStatus;
  const note = String(formData.get("note") ?? "").trim();
  if (!id || !status) return;
  await updateMeta(getStore(), id, { status }, note ? { statusNote: note } : undefined);
  revalidatePath(`/applications/${id}`);
  revalidatePath("/");
}

/** Archive (or restore) an application: hidden from the default board view. */
export async function archiveAction(formData: FormData) {
  const id = String(formData.get("id"));
  const archive = String(formData.get("archived") ?? "1") === "1";
  if (!id) return;
  await updateMeta(getStore(), id, { archived: archive });
  revalidatePath(`/applications/${id}`);
  revalidatePath("/");
}

/**
 * Purge an application entirely: the folder (snapshot, scores, résumés) and
 * its index entry. For jobs the user decided not to pursue.
 */
export async function deleteApplicationAction(formData: FormData) {
  const id = String(formData.get("id"));
  if (!id) return;
  const store = getStore();
  await store.deleteFolder(["applications", id]);
  await removeIndexEntry(store, id);
  revalidatePath("/");
  redirect("/");
}

/**
 * Launch a sourcing run (sweep → prefilter → triage → last-run.json). Long:
 * several minutes of board fetches plus a headless Claude CLI triage call.
 * The button's pending state covers the wait; the action resolves when the
 * shortlist is written.
 */
export type SourceJobsResult = { ok: boolean; message: string } | null;

export async function sourceJobsAction(_prev: SourceJobsResult): Promise<SourceJobsResult> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const { readFileSync } = await import("node:fs");
  const repoRoot = join(process.cwd(), "..", "..");
  const env = {
    ...process.env,
    CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH ?? join(homedir(), ".local/bin/claude"),
  };
  // The sourcing script lives in this app in the kit and in the Cloud app in
  // the full repo: run it from whichever workspace declares it.
  let workspace = "kairos-cloud";
  try {
    const local = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    if (local?.scripts?.["sourcing-run"]) workspace = local.name ?? "kairos-local";
  } catch {
    // keep the default
  }
  try {
    await promisify(execFile)("npm", ["-w", workspace, "run", "sourcing-run"], {
      cwd: repoRoot,
      env,
      timeout: 20 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    console.error("sourcing run failed:", err);
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || String(err)).trim().split("\n").filter(Boolean).slice(-3).join(" ");
    revalidatePath("/");
    return { ok: false, message: `The job search failed: ${detail.slice(0, 400)}` };
  }
  revalidatePath("/");
  return { ok: true, message: "Job search finished." };
}

/**
 * Track a sourced card: capture the job into the pipeline right from the board.
 * Deterministic only — fetch the ad (fallback: the card's own info), snapshot,
 * harvest the application form (Greenhouse). Scoring stays in Claude Code.
 */
export async function trackSourcedAction(formData: FormData) {
  const url = String(formData.get("url") ?? "");
  const company = String(formData.get("company") ?? "");
  const title = String(formData.get("title") ?? "");
  if (!url || !company || !title) return;
  const { fetchJobAd } = await import("@kairos/engine/ingest");
  const { createApplication } = await import("@kairos/engine/applications");
  const { fetchGreenhouseForm, saveApplicationForm } = await import("@kairos/engine/forms");
  const store = getStore();

  let markdown = `# ${title} — ${company}\n\n(Snapshot fetch failed at track time; ad text lives at the source URL. Re-fetch during scoring.)\n\n${url}`;
  try {
    // fetchJobAd tries ATS JSON APIs (Ashby/Workday) before the HTML fetch.
    markdown = (await fetchJobAd(url)).markdown;
  } catch (err) {
    console.error("track: ad fetch failed, using card stub", err);
  }
  const meta = await createApplication(store, { company, role: title, snapshotMarkdown: markdown, source_url: url });
  const form = await fetchGreenhouseForm(url);
  if (form) await saveApplicationForm(store, meta.id, form);

  // Hide the card from the Sourced column now that it lives on the board proper.
  type Flagged = { url: string; captured?: boolean };
  type FlaggedRun = { survivors?: Flagged[]; stretch?: Flagged[]; also_qualified?: Flagged[]; dropped?: Flagged[] };
  for (const file of ["last-run.json", "deep-scan.json"]) {
    const run = await store.readJson<FlaggedRun>(["sourcing", file]);
    if (!run) continue;
    for (const c of [...(run.survivors ?? []), ...(run.stretch ?? []), ...(run.also_qualified ?? []), ...(run.dropped ?? [])])
      if (c.url === url) c.captured = true;
    await store.writeJson(["sourcing", file], run);
  }
  revalidatePath("/");
  revalidatePath("/sourced");
  redirect(`/applications/${encodeURIComponent(meta.id)}`);
}

/**
 * Dismiss a sourced card: hide it from the Sourced column and record the URL
 * in sourcing/seen.json so no future sweep resurfaces it. The company's
 * runner-up posting (dropped by the one-per-company rule at triage time)
 * appears naturally on the next sweep.
 */
export async function dismissSourcedAction(formData: FormData) {
  const url = String(formData.get("url") ?? "");
  if (!url) return;
  const store = getStore();

  const seen = (await store.readJson<Record<string, string>>(["sourcing", "seen.json"])) ?? {};
  seen[url.split("?")[0]] = new Date().toISOString();
  await store.writeJson(["sourcing", "seen.json"], seen);

  type Flagged = { url: string; dismissed?: boolean };
  type FlaggedRun = { survivors?: Flagged[]; stretch?: Flagged[]; also_qualified?: Flagged[]; dropped?: Flagged[] };
  for (const file of ["last-run.json", "deep-scan.json"]) {
    const run = await store.readJson<FlaggedRun>(["sourcing", file]);
    if (!run) continue;
    for (const c of [...(run.survivors ?? []), ...(run.stretch ?? []), ...(run.also_qualified ?? []), ...(run.dropped ?? [])])
      if (c.url === url) c.dismissed = true;
    await store.writeJson(["sourcing", file], run);
  }
  revalidatePath("/");
  revalidatePath("/sourced");
}

/**
 * One-click generation from a Draft card, via the headless Claude CLI
 * (Max-billed, same channel as sourcing triage). Long: minutes per document;
 * the button's pending state covers it. Cover letters stay opt-in — this
 * only ever runs when the user clicks.
 */
export async function generateDocAction(formData: FormData) {
  const appId = String(formData.get("appId") ?? "");
  const kind = String(formData.get("kind") ?? "");
  if (!appId || !["resume", "cover-letter"].includes(kind)) return;
  const { generateResumeHeadless, generateCoverLetterHeadless } = await import("@/lib/generate");
  const result =
    kind === "resume" ? await generateResumeHeadless(appId) : await generateCoverLetterHeadless(appId);
  // Surface failures on the detail page (a silent no-op button is worse than an error).
  const store = getStore();
  if (!result.ok) {
    console.error(`generate ${kind} failed for ${appId}:`, result.error);
    await store.writeFile(
      ["applications", appId, "generation-error.txt"],
      `${kind === "resume" ? "Résumé" : "Cover letter"} generation failed: ${result.error}`,
    );
  } else {
    await store.writeFile(["applications", appId, "generation-error.txt"], "");
  }
  revalidatePath("/");
  revalidatePath(`/applications/${appId}`);
}

/** Validate a submission: mark applied, record the date, and store the file
 *  actually sent off-platform (which may differ from the generated one). */
export async function markSubmittedAction(formData: FormData) {
  const id = String(formData.get("id"));
  if (!id) return;
  const store = getStore();
  const patch: Partial<ApplicationMeta> = { status: "applied", applied_at: new Date().toISOString() };

  const file = formData.get("resume");
  if (file && typeof file !== "string" && file.size > 0) {
    // A PDF or DOCX of at most 10 MB, checked by its first bytes as well as its name.
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if ((ext !== "pdf" && ext !== "docx") || file.size > 10 * 1024 * 1024) throw new Error("The submitted résumé must be a PDF or DOCX file of at most 10 MB.");
    const buf = Buffer.from(await file.arrayBuffer());
    const magic = buf.subarray(0, 4).toString("latin1");
    if ((ext === "pdf" && magic !== "%PDF") || (ext === "docx" && magic !== "PK\x03\x04")) throw new Error(`That file is not a real ${ext.toUpperCase()}.`);
    const fname = `submitted-resume.${ext}`;
    await store.writeBinary(["applications", id, fname], buf, file.type || "application/octet-stream");
    patch.submitted_file = fname;
    patch.docs_sent = [fname];
  }

  await updateMeta(store, id, patch);
  revalidatePath(`/applications/${id}`);
  revalidatePath("/");
}
