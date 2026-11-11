"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { APPLIED_QUIET_DAYS, STAGES, groupByStage, splitQuietApplied, staleSignal } from "@kairos/engine/pipeline";
import { fmtDate, daysBetween } from "@kairos/engine/format";
import { STATUS_META } from "@kairos/engine/applications";
import type { IndexEntry } from "@kairos/engine/applications";
import { archiveAction, dismissSourcedAction, generateDocAction, trackSourcedAction } from "@/app/actions";
import type { BoardEntry } from "@/lib/dashboard";

/** Generate button for a missing document on a Draft card (headless Claude, minutes). */
function GenerateButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      className="badge badge-neutral text-[10px] hover:border-accent disabled:opacity-60"
      disabled={pending}
      title="Generates through the anti-fabrication and house-style gates on your Max plan (takes a few minutes)"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
import SourceJobsButton from "@/components/SourceJobsButton";
import { useFormStatus } from "react-dom";

/** Submit button for tracking a sourced card; pending state covers the ad fetch. */
function TrackButton() {
  const { pending } = useFormStatus();
  return (
    <button
      className="btn-secondary w-full text-xs"
      disabled={pending}
      title="Capture this job into the pipeline (snapshot + application form). Score it afterwards in Claude Code."
    >
      {pending ? "Tracking…" : "+ Track"}
    </button>
  );
}

const BAND_TONE: Record<string, string> = {
  STRONG: "badge-success",
  COMPETITIVE: "badge-info",
  DEVELOPING: "badge-warn",
  WEAK: "badge-danger",
};
const badgeClass = (tone: string) => `badge-${tone === "neutral" ? "neutral" : tone}`;
const SIGNAL_COLOR: Record<string, string> = {
  info: "var(--accent)",
  warn: "var(--warn-fg)",
  danger: "var(--danger-fg)",
};

export interface SourcedCard {
  company: string;
  title: string;
  url: string;
  location: string;
  age_days: number | null;
  location_fit: "match" | "stretch";
  guess_band?: string;
  one_liner?: string;
  /** Harvested application-form info (Greenhouse boards only; null = not coverable). */
  form?: { writing_questions: number; needs_cover_letter: boolean } | null;
  /** Set once the card has been tracked into the pipeline (hidden from Sourced). */
  captured?: boolean;
  /** Set when the user dismissed the card (hidden; URL recorded in seen.json). */
  dismissed?: boolean;
}

/** Kanban-style pipeline: applications grouped by stage, with staleness nudges. */
export default function PipelineBoard({
  applications,
  sourced = [],
  sourcedTotal,
  sourcedRanAt,
}: {
  applications: BoardEntry[];
  sourced?: SourcedCard[];
  /** Live sourced cards before the column cap (the rest are on /sourced). */
  sourcedTotal?: number;
  sourcedRanAt?: string;
}) {
  const now = new Date().toISOString();
  const [query, setQuery] = useState("");
  const [showQuiet, setShowQuiet] = useState(false);
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? applications.filter((a) => `${a.company} ${a.role}`.toLowerCase().includes(q)) : applications),
    [applications, q],
  );
  const live = useMemo(() => sourced.filter((s) => !s.captured && !s.dismissed), [sourced]);
  const filteredSourced = useMemo(
    () => (q ? live.filter((s) => `${s.company} ${s.title}`.toLowerCase().includes(q)) : live),
    [live, q],
  );
  const grouped = groupByStage(filtered);
  const hasSourced = live.length > 0;

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
      <SourceJobsButton />
      <div className="relative flex-1">
        <span className="text-muted pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm">⌕</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          placeholder="Search company or role…"
          className="field w-full !py-1.5 !pl-8 text-sm"
          aria-label="Search applications"
        />
        {q && (
          <span className="text-muted absolute right-3 top-1/2 -translate-y-1/2 text-xs tabular-nums">
            {filtered.length} match{filtered.length === 1 ? "" : "es"}
          </span>
        )}
      </div>
      </div>
      <div className={`grid grid-cols-2 gap-3 ${hasSourced ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
        {hasSourced && (
          <div className="min-w-0">
            <div className="text-muted mb-2 flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide">
              <span>Sourced</span>
              <span className="bg-surface-2 rounded-full px-1.5 py-0.5 tabular-nums">{filteredSourced.length}</span>
            </div>
            <div className="space-y-2">
              {filteredSourced.map((s) => (
                <div
                  key={s.url}
                  className="card hover:border-accent block p-3 transition-colors"
                  style={{ borderStyle: "dashed" }}
                >
                  {/* Same hierarchy as every other column: company on top, role below. */}
                  <a href={s.url} target="_blank" rel="noreferrer" className="hover:underline" title="Open the job ad in a new tab">
                    <div className="truncate text-xs font-semibold" style={{ color: "var(--accent)" }}>
                      {s.company} <span className="text-muted">↗</span>
                    </div>
                  </a>
                  <div className="truncate text-sm font-medium">{s.title}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="badge badge-neutral text-[10px]">
                      {s.age_days === null ? "date n/a" : s.age_days === 0 ? "today" : `${s.age_days}d ago`}
                    </span>
                    {s.guess_band && (
                      <span
                        className={`badge ${BAND_TONE[s.guess_band] ?? "badge-neutral"} text-[10px] opacity-80`}
                        title="Triage guess, not a real score — click Score it for the honest three-axis assessment"
                      >
                        {s.guess_band.toLowerCase()}?
                      </span>
                    )}
                    {s.location_fit === "stretch" && <span className="badge badge-warn text-[10px]">stretch</span>}
                    {s.form && s.form.writing_questions > 0 && (
                      <span className="badge badge-neutral text-[10px]" title="Written questions on the application form (beyond standard fields)">
                        {s.form.writing_questions} written q
                      </span>
                    )}
                    {s.form?.needs_cover_letter && (
                      <span className="badge badge-warn text-[10px]" title="The form requires a cover letter">letter req.</span>
                    )}
                  </div>
                  {s.one_liner && <div className="text-muted mt-1.5 text-[11px]">{s.one_liner}</div>}
                  <div className="text-muted mt-1 truncate text-[11px]">{s.location || "—"}</div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <form action={trackSourcedAction} className="flex-1">
                      <input type="hidden" name="url" value={s.url} />
                      <input type="hidden" name="company" value={s.company} />
                      <input type="hidden" name="title" value={s.title} />
                      <TrackButton />
                    </form>
                    <form action={dismissSourcedAction}>
                      <input type="hidden" name="url" value={s.url} />
                      <button
                        className="text-muted rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:text-[var(--danger-fg)]"
                        title="Not interested: hide this card and never surface this posting again. The company's next-best role can still appear on future sweeps."
                      >
                        ✕
                      </button>
                    </form>
                  </div>
                </div>
              ))}
              {filteredSourced.length === 0 && (
                <div className="text-muted rounded-lg border border-dashed border-[var(--border)] p-3 text-center text-xs">—</div>
              )}
              {!q && sourcedTotal !== undefined && sourcedTotal > live.length && (
                <Link
                  href="/sourced"
                  className="text-muted block rounded-lg border border-dashed border-[var(--border)] p-2 text-center text-[11px] hover:text-[color:var(--foreground)]"
                  title="The column shows the best few; every other sourced role is on the All-sourced page"
                >
                  +{sourcedTotal - live.length} more on All sourced →
                </Link>
              )}
              {sourcedRanAt && (
                <div className="text-muted px-1 text-[10px]">run {sourcedRanAt.slice(0, 16).replace("T", " ")}</div>
              )}
            </div>
          </div>
        )}
      {STAGES.map((stage) => {
        // groupByStage is typed over IndexEntry; the board receives BoardEntry
        // (adds has_resume for the generate-résumé button).
        const all = grouped[stage.key] as BoardEntry[];
        // Applied cards with no answer after 3 weeks fold away (a search shows everything).
        const { recent, quiet } =
          stage.key === "applied" && !q ? splitQuietApplied(all, now) : { recent: all, quiet: [] as BoardEntry[] };
        const apps = showQuiet ? [...recent, ...quiet] : recent;
        const quietIds = new Set(quiet.map((a) => a.id));
        return (
          <div key={stage.key} className="min-w-0">
            <div className="text-muted mb-2 flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide">
              <span>{stage.label}</span>
              <span className="bg-surface-2 rounded-full px-1.5 py-0.5 tabular-nums">{recent.length}</span>
            </div>
            <div className="space-y-2">
              {apps.map((a) => {
                const isQuiet = quietIds.has(a.id);
                // A quiet card is already filed as "no answer"; its follow-up nudge is noise.
                const signal = isQuiet ? null : staleSignal(a, now);
                const when = a.applied_at
                  ? `Applied ${fmtDate(a.applied_at)} · ${daysBetween(a.applied_at, now)}d ago`
                  : `Started ${fmtDate(a.captured_at)} · ${daysBetween(a.captured_at, now)}d`;
                return (
                  <div key={a.id} className={isQuiet ? "opacity-60" : undefined}>
                    <Link
                      href={`/applications/${a.id}`}
                      className="card hover:border-accent block p-3 transition-colors"
                    >
                      <div className="truncate text-xs font-semibold" style={{ color: "var(--accent)" }}>
                        {a.company}
                      </div>
                      <div className="truncate text-sm font-medium">{a.role}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {(() => {
                          const s = STATUS_META[a.status] ?? { label: a.status, tone: "neutral" };
                          return <span className={`badge ${badgeClass(s.tone)} text-[10px]`}>{s.label}</span>;
                        })()}
                        {a.score_band && (
                          <span className={`badge ${BAND_TONE[a.score_band] ?? "badge-neutral"} text-[10px]`}>
                            {a.score_band}
                          </span>
                        )}
                      </div>
                      <div className="text-muted mt-1.5 text-[11px]">{when}</div>
                      {signal && (
                        <div className="mt-1.5 text-[11px] font-medium" style={{ color: SIGNAL_COLOR[signal.tone] }}>
                          ⚑ {signal.text}
                        </div>
                      )}
                    </Link>
                    {/* Resume only: cover letters are opt-in from the detail page. */}
                    {stage.key !== "closed" && a.has_resume === false && (
                      <div className="mt-1 flex gap-1.5 px-1">
                        <form action={generateDocAction}>
                          <input type="hidden" name="appId" value={a.id} />
                          <input type="hidden" name="kind" value="resume" />
                          <GenerateButton label="+ Generate résumé" pendingLabel="Generating…" />
                        </form>
                      </div>
                    )}
                    {(stage.key === "closed" || stage.key === "draft") && (
                      <form action={archiveAction} className="mt-0.5 text-right">
                        <input type="hidden" name="id" value={a.id} />
                        <input type="hidden" name="archived" value="1" />
                        <button
                          className="text-muted cursor-pointer text-[11px] underline hover:text-[color:var(--foreground)]"
                          title={
                            stage.key === "draft"
                              ? "Not relevant after all: move to the archive (nothing is deleted; restore any time)"
                              : "Move to the archive (nothing is deleted)"
                          }
                        >
                          Archive
                        </button>
                      </form>
                    )}
                  </div>
                );
              })}
              {apps.length === 0 && <div className="text-muted rounded-lg border border-dashed border-[var(--border)] p-3 text-center text-xs">—</div>}
              {quiet.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowQuiet((v) => !v)}
                  className="text-muted w-full rounded-lg border border-dashed border-[var(--border)] p-2 text-center text-[11px] hover:text-[color:var(--foreground)]"
                  title={`Still marked Applied, no answer after ${APPLIED_QUIET_DAYS} days. Nothing is closed; search finds them too.`}
                >
                  {showQuiet ? "Hide" : "Show"} {quiet.length} applied {APPLIED_QUIET_DAYS / 7}+ weeks ago
                </button>
              )}
            </div>
          </div>
        );
      })}
      </div>
    </>
  );
}
