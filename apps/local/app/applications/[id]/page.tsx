import Link from "next/link";
import { notFound } from "next/navigation";
import { getApplication } from "@/lib/dashboard";
import Scorecard from "@/components/Scorecard";
import ScoreCompare from "@/components/ScoreCompare";
import Timeline from "@/components/Timeline";
import { archiveAction, deleteApplicationAction, generateDocAction, setStatusAction, markSubmittedAction } from "@/app/actions";
import GenerateDocButton from "@/components/GenerateDocButton";
import LineOrigins from "@/components/LineOrigins";

export const dynamic = "force-dynamic";

import { ALL_STATUSES, STATUS_META } from "@kairos/engine/applications";
import { isWritingQuestion, type ApplicationForm } from "@kairos/engine/forms";
import type { ApplicationQuestion } from "@/lib/dashboard";
import type { RequirementCoverageRow } from "@kairos/engine/types";

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const app = await getApplication(id);
  if (!app) notFound();
  const { meta, report, scoreVersions, jobText, resumeHtml, coverLetterHtml, questions, form, generationError, downloads, requirementCoverage, lineOrigins } = app;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <Link href="/" className="text-muted text-xs hover:underline">
          ← Applications
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{meta.role}</h1>
            <p className="text-muted text-sm">
              {meta.company}
              {meta.source_url ? (
                <>
                  {" · "}
                  <a href={meta.source_url} target="_blank" rel="noreferrer" className="hover:underline">
                    job posting ↗
                  </a>
                </>
              ) : null}
              {meta.applied_at ? <> · applied {meta.applied_at.slice(0, 10)}</> : null}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <span className={`badge badge-${STATUS_META[meta.status]?.tone ?? "neutral"}`}>
              {STATUS_META[meta.status]?.label ?? meta.status}
            </span>
            {(STATUS_META[meta.status]?.stage === "closed" || STATUS_META[meta.status]?.stage === "draft" || meta.archived) && (
              <form action={archiveAction}>
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="archived" value={meta.archived ? "0" : "1"} />
                <button
                  className="text-muted cursor-pointer text-[11px] underline hover:text-[color:var(--foreground)]"
                  title={meta.archived ? "Bring this application back onto the board" : "Not relevant: hide from the board (nothing is deleted; restore any time)"}
                >
                  {meta.archived ? "Restore from archive" : "Archive"}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      {/* Status & submission — everything that changes this application's state, in one place */}
      <section className="card mb-6 p-5">
        <h2 className="text-muted mb-4 text-xs font-medium uppercase tracking-wide">Status &amp; submission</h2>

        <form action={setStatusAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="id" value={id} />
          <label className="text-muted flex flex-col gap-1 text-xs">
            Stage
            <select name="status" defaultValue={meta.status} className="field !py-1.5 text-sm">
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-muted flex min-w-[12rem] flex-1 flex-col gap-1 text-xs">
            Note (optional)
            <input
              type="text"
              name="note"
              placeholder="e.g. recruiter call, rejection email"
              className="field !py-1.5 text-sm"
            />
          </label>
          <button className="btn-secondary text-sm">Update</button>
        </form>

        <div className="border-border my-4 border-t" />

        <form action={markSubmittedAction} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="id" value={id} />
          <span className="text-muted text-xs">
            {meta.applied_at ? "✓ Submitted. Replace the file you sent:" : "Applied off-platform? Attach the file you actually sent:"}
          </span>
          <input
            type="file"
            name="resume"
            accept=".docx,.pdf"
            className="text-muted text-xs file:mr-2 file:cursor-pointer file:rounded-md file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-2 file:py-1 file:text-[color:var(--foreground)]"
          />
          <button className="btn-primary text-sm">{meta.applied_at ? "Update submission" : "Mark submitted"}</button>
          {downloads.submitted && (
            <a className="text-accent text-xs underline" href={`/api/file/${id}/${downloads.submitted}`} download>
              download sent file
            </a>
          )}
        </form>

        <div className="border-border my-4 border-t" />

        <div className="flex flex-wrap items-center gap-4">
          <details>
            <summary className="text-muted cursor-pointer text-xs underline">Delete this application…</summary>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span className="text-muted max-w-md text-xs">
                Removes the whole folder from ~/Kairos: job ad, scores, résumé, cover letter. There's
                no undo. If you might come back to it, archive instead.
              </span>
              <form action={deleteApplicationAction}>
                <input type="hidden" name="id" value={id} />
                <button className="btn-secondary text-sm !text-[color:var(--danger-fg)]">Delete forever</button>
              </form>
            </div>
          </details>
        </div>
      </section>

      {/* Timeline — the history of the changes made above */}
      <section className="card mb-6 p-5">
        <h2 className="text-muted mb-3 text-xs font-medium uppercase tracking-wide">Timeline</h2>
        <Timeline meta={meta} />
      </section>

      {/* On the local lane, generation and tailoring run through Claude Code,
          not this viewer. Point there whenever the résumé doesn't exist yet. */}
      {!resumeHtml && (
        <section className="card mb-6 border-dashed p-5">
          <h2 className="text-muted mb-2 text-xs font-medium uppercase tracking-wide">Next step</h2>
          <p className="text-sm">
            This dashboard is a viewer; the conversation happens in <span className="font-medium">Claude Code</span>,
            where Kairos drafts on your Max plan. To tailor the résumé for this role, switch to your Kairos session and say:
          </p>
          <code className="bg-surface-2 mt-2 inline-block rounded-md px-2.5 py-1.5 text-sm">
            tailor {meta.company.toLowerCase()}
          </code>
          <p className="text-muted mt-2 text-xs">
            Kairos will work the scorecard&apos;s gaps with you, generate the résumé through the anti-fabrication gates,
            and the documents will appear here. Add &quot;and answer the extra questions&quot; if the application has them.
          </p>
        </section>
      )}

      {generationError && (
        <div className="card mb-3 border-[var(--danger-fg)] p-3 text-sm" role="alert">
          ⚠ {generationError}
        </div>
      )}
      {/* Documents — compact cards: open in a new tab, or download */}
      <section className="mb-6 grid gap-3 sm:grid-cols-2">
        <DocCard
          label="Résumé"
          present={!!resumeHtml}
          openHref={`/applications/${id}/preview/resume`}
          downloadHref={downloads.resumeDocx ? `/api/file/${id}/resume.docx` : null}
          hint="Tailored, ATS-safe .docx"
          generate={{ appId: id, kind: "resume" }}
        />
        <DocCard
          label="Cover letter"
          present={!!coverLetterHtml}
          openHref={`/applications/${id}/preview/cover-letter`}
          downloadHref={downloads.coverLetterDocx ? `/api/file/${id}/cover-letter.docx` : null}
          hint="Human-voice draft"
          generate={{ appId: id, kind: "cover-letter" }}
        />
      </section>

      {/* Requirements coverage: each requirement in the ad, matched to résumé evidence or marked as a gap */}
      {requirementCoverage && <CoverageTable rows={requirementCoverage} />}

      {/* Line origins: each résumé line beside the fact of the record it comes from (collapsed) */}
      {lineOrigins && <LineOrigins view={lineOrigins} />}

      {/* Prep notes — briefs and reconstructions kept in the application folder */}
      {app.prepNotes.length > 0 && (
        <section className="card mb-6 p-5">
          <h2 className="text-muted mb-2 text-xs font-medium uppercase tracking-wide">Prep notes</h2>
          <ul className="space-y-1 text-sm">
            {app.prepNotes.map((n) => (
              <li key={n}>
                {n.endsWith(".html") ? (
                  <a href={`/api/note/${id}/${encodeURIComponent(n)}`} target="_blank" rel="noreferrer" className="hover:underline">
                    {n.replace(/\.html$/, "").replace(/-/g, " ")} <span className="badge badge-info">glance</span>
                  </a>
                ) : (
                  <Link href={`/applications/${id}/notes/${encodeURIComponent(n)}`} className="hover:underline">
                    {n.replace(/\.md$/, "").replace(/-/g, " ")}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Score comparison (hero) */}
      {scoreVersions.length >= 2 && (
        <div className="mb-6">
          <ScoreCompare versions={scoreVersions} />
        </div>
      )}

      {/* Full assessment (collapsible so it doesn't dominate) */}
      {report && (
        <details className="mb-6" open={scoreVersions.length < 2}>
          <summary className="text-muted mb-3 cursor-pointer text-xs font-medium uppercase tracking-wide">
            Full assessment (three axes)
          </summary>
          <Scorecard report={report} />
        </details>
      )}

      {/* Application form — what the real form will ask (harvested at capture) */}
      {form && <FormChecklist form={form} questions={questions} />}

      {/* Application questions */}
      {questions.length > 0 && (
        <section className="mb-6">
          <h2 className="text-muted mb-2 text-xs font-medium uppercase tracking-wide">Application questions</h2>
          <div className="space-y-3">
            {questions.map((q, i) => (
              <div key={i} className="card p-4">
                <div className="text-sm font-medium">{q.question}</div>
                <div className="text-muted mt-1 whitespace-pre-wrap text-sm">{q.answer}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Job ad (collapsible, secondary) */}
      <details className="card p-4">
        <summary className="text-muted cursor-pointer text-xs font-medium uppercase tracking-wide">Job ad snapshot</summary>
        <pre className="text-muted mt-3 whitespace-pre-wrap font-sans text-xs leading-relaxed">{jobText ?? "—"}</pre>
      </details>
    </div>
  );
}

const COVERAGE_CHIP: Record<RequirementCoverageRow["status"], { tone: string; label: string }> = {
  covered: { tone: "success", label: "Covered" },
  partial: { tone: "info", label: "Partial" },
  gap: { tone: "warn", label: "Gap" },
};

/** The tailoring decision, requirement by requirement (resume.json requirement_coverage). */
function CoverageTable({ rows }: { rows: RequirementCoverageRow[] }) {
  const count = (s: RequirementCoverageRow["status"]) => rows.filter((r) => r.status === s).length;
  const plain = (s?: string | null) => (s ?? "").replace(/\*\*/g, "").trim();
  const gaps = count("gap");
  return (
    <details className="card mb-6 p-4">
      <summary className="text-muted cursor-pointer text-xs font-medium uppercase tracking-wide">
        Requirements coverage
        <span className="ml-2 font-normal normal-case tracking-normal">
          {count("covered")} covered · {count("partial")} partial · {gaps} gap{gaps === 1 ? "" : "s"}
        </span>
      </summary>
      <table className="mt-3 w-full table-fixed text-sm">
        <thead>
          <tr className="text-muted text-left text-[11px] uppercase tracking-wide">
            <th className="w-[38%] pb-1.5 pr-3 font-medium">Requirement</th>
            <th className="hidden w-[5.5rem] pb-1.5 pr-3 font-medium sm:table-cell">Priority</th>
            <th className="w-[5.5rem] pb-1.5 pr-3 font-medium">Status</th>
            <th className="pb-1.5 font-medium">Evidence / note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const evidence = plain(r.evidence);
            const note = plain(r.note);
            const shown = r.status === "covered" ? evidence || note : note || evidence;
            const tip = [evidence && `Evidence: ${evidence}`, note && `Note: ${note}`].filter(Boolean).join("\n");
            const chip = COVERAGE_CHIP[r.status];
            return (
              <tr key={i} className="border-border border-t align-top">
                <td className="py-1.5 pr-3">
                  {r.requirement}
                  <span className="text-muted text-xs sm:hidden"> · {r.priority}</span>
                </td>
                <td className="text-muted hidden py-1.5 pr-3 text-xs sm:table-cell">{r.priority}</td>
                <td className="py-1.5 pr-3">
                  <span className={`badge badge-${chip.tone}`}>{chip.label}</span>
                </td>
                <td className="text-muted truncate py-1.5 text-xs" title={tip || undefined}>
                  {shown || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

/** Loose label match so a drafted answer in questions.json checks off its form field. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

function FormChecklist({ form, questions }: { form: ApplicationForm; questions: ApplicationQuestion[] }) {
  const drafted = new Set(questions.map((q) => norm(q.question)));
  const custom = form.questions.filter((q) => q.custom);
  const writing = custom.filter(isWritingQuestion);
  const housekeeping = custom.length - writing.length;
  return (
    <section className="card mb-6 p-5">
      <h2 className="text-muted mb-1 text-xs font-medium uppercase tracking-wide">Application form</h2>
      <p className="text-muted mb-3 text-xs">
        Harvested from the live {form.source} form, so nothing ambushes you mid-application.
        {housekeeping > 0 && ` ${housekeeping} housekeeping field${housekeeping === 1 ? "" : "s"} (selects, links) not shown.`}
        {form.has_demographic_section && " Includes a demographic section (always yours to answer)."}
      </p>
      {writing.length === 0 ? (
        <p className="text-sm">No written questions beyond the standard fields. Résumé and letter carry this one.</p>
      ) : (
        <ul className="space-y-2">
          {writing.map((q) => {
            const done = drafted.has(norm(q.label));
            return (
              <li key={q.label} className="flex items-start gap-2 text-sm">
                <span className={done ? "text-emerald-600" : "text-muted"}>{done ? "✓" : "○"}</span>
                <span>
                  {q.label}
                  {q.required && <span className="text-muted"> *</span>}
                  {q.kind === "essay" && (
                    <span className="bg-surface-2 text-muted ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase">essay</span>
                  )}
                  {!done && <span className="text-muted"> — no draft yet</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DocCard({
  label,
  present,
  openHref,
  downloadHref,
  hint,
  generate,
}: {
  label: string;
  present: boolean;
  openHref: string;
  downloadHref: string | null;
  hint: string;
  /** When absent and generatable: {appId, kind} renders a one-click generate button. */
  generate?: { appId: string; kind: "resume" | "cover-letter" } | null;
}) {
  return (
    <div className="card flex items-center justify-between p-4">
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <div className="text-muted text-xs">{present ? hint : "Not generated yet"}</div>
      </div>
      {present ? (
        <div className="flex shrink-0 items-center gap-3 text-sm">
          <a href={openHref} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            Open ↗
          </a>
          {downloadHref && (
            <a href={downloadHref} download className="btn-secondary text-sm">
              ↓ .docx
            </a>
          )}
        </div>
      ) : generate ? (
        <form action={generateDocAction} className="shrink-0">
          <input type="hidden" name="appId" value={generate.appId} />
          <input type="hidden" name="kind" value={generate.kind} />
          <GenerateDocButton kind={generate.kind} />
        </form>
      ) : (
        <span className="text-muted text-xs">—</span>
      )}
    </div>
  );
}
