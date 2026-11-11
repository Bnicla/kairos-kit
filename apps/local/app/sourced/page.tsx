import Link from "next/link";
import { getDeepScan, getSourcedRun, type SourcedPosting } from "@/lib/dashboard";
import { trackSourcedAction, dismissSourcedAction } from "@/app/actions";

export const dynamic = "force-dynamic";

const BAND_TONE: Record<string, string> = {
  STRONG: "badge-success",
  COMPETITIVE: "badge-info",
  DEVELOPING: "badge-warn",
  WEAK: "badge-neutral",
};

const DROP_LABEL: Record<NonNullable<SourcedPosting["drop_reason"]>, { label: string; tone: string; hint: string }> = {
  over_cap: { label: "not reviewed", tone: "badge-neutral", hint: "Ranked below what the triage step looks at (the top 120, plus senior titles up to 640 in all), so it was never assessed." },
  triage_cut: { label: "triage passed over", tone: "badge-warn", hint: "The triage step did not shortlist this role." },
  same_company: { label: "company already shown", tone: "badge-neutral", hint: "Another role from this company held the company's single board slot." },
  below_cut: { label: "below the cut", tone: "badge-neutral", hint: "Shortlisted, but ranked below the final size cap." },
};

function Card({ s, dropped }: { s: SourcedPosting; dropped?: boolean }) {
  const drop = s.drop_reason ? DROP_LABEL[s.drop_reason] : null;
  return (
    <div className="card block p-3" style={{ borderStyle: "dashed" }}>
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
          <span className={`badge ${BAND_TONE[s.guess_band] ?? "badge-neutral"} text-[10px] opacity-80`} title="Triage guess, not a real score">
            {s.guess_band.toLowerCase()}?
          </span>
        )}
        {s.location_fit === "stretch" && <span className="badge badge-warn text-[10px]">stretch</span>}
        {drop && (
          <span className={`badge ${drop.tone} text-[10px]`} title={drop.hint}>
            {drop.label}
          </span>
        )}
      </div>
      {s.one_liner && <div className="text-muted mt-1.5 text-[11px]">{s.one_liner}</div>}
      <div className="text-muted mt-1 truncate text-[11px]">{s.location || "—"}</div>
      <div className="mt-2 flex items-center gap-1.5">
        <form action={trackSourcedAction} className="flex-1">
          <input type="hidden" name="url" value={s.url} />
          <input type="hidden" name="company" value={s.company} />
          <input type="hidden" name="title" value={s.title} />
          <button className="btn-secondary w-full text-xs" title="Capture this role into the pipeline (snapshot + form). Score it afterwards.">
            {dropped ? "+ Save" : "+ Track"}
          </button>
        </form>
        <form action={dismissSourcedAction}>
          <input type="hidden" name="url" value={s.url} />
          <button
            className="text-muted rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:text-[var(--danger-fg)]"
            title="Not interested: hide this card and never surface this posting again."
          >
            ✕
          </button>
        </form>
      </div>
    </div>
  );
}

export default async function SourcedPage() {
  const [run, deep] = await Promise.all([getSourcedRun(), getDeepScan()]);
  const live = (list?: SourcedPosting[]) => (list ?? []).filter((s) => !s.captured && !s.dismissed);
  const shortlisted = [...live(run?.survivors), ...live(run?.stretch)];
  const alsoQualified = live(run?.also_qualified);
  const dropped = live(run?.dropped);
  const vanished = run?.vanished_shortlisted ?? [];
  const deepCards = [...live(deep?.survivors), ...live(deep?.stretch), ...live(deep?.also_qualified)];

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">All sourced roles</h1>
          <p className="text-muted text-xs">
            Everything the last sweep surfaced, including roles the triage dropped before the board.
            {run?.ran_at && <> Run {run.ran_at.slice(0, 16).replace("T", " ")}.</>}
            {(run?.new_since_last_run?.length ?? 0) > 0 && (
              <> <span className="font-medium">★ {run!.new_since_last_run!.length} never seen before.</span></>
            )}
          </p>
        </div>
        <Link href="/" className="text-accent text-sm hover:underline">
          ← Back to board
        </Link>
      </div>

      {!run && <div className="text-muted rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-sm">No sweep has run yet.</div>}

      {(() => {
        const s = run?.fetch_stats;
        if (!s) return null;
        const total = s.boards_ok + s.boards_gone + s.boards_failed + s.rate_limited;
        const hard = s.boards_failed + s.rate_limited;
        if (!total || hard / total <= 0.05) return null;
        return (
          <div className="mb-4 rounded-lg border p-3 text-xs" style={{ borderColor: "var(--warning-fg, #b45309)" }}>
            <div className="font-semibold" style={{ color: "var(--warning-fg, #b45309)" }}>
              ⚠ Sweep fetch was degraded — results may be incomplete
            </div>
            <p className="text-muted mt-1">
              {hard} of {total} boards failed ({s.rate_limited} rate-limited
              {Object.keys(s.failures_by_ats).length
                ? `; by ATS: ${Object.entries(s.failures_by_ats).map(([k, v]) => `${k} ${v}`).join(", ")}`
                : ""}
              ). A throttled sweep can look like a quiet market — treat gaps with suspicion and re-run later.
            </p>
          </div>
        );
      })()}

      {vanished.length > 0 && (
        <div className="mb-4 rounded-lg border p-3 text-xs" style={{ borderColor: "var(--danger-fg)" }}>
          <div className="font-semibold" style={{ color: "var(--danger-fg)" }}>
            🚨 {vanished.length} previously shortlisted role{vanished.length > 1 ? "s" : ""} vanished un-actioned
          </div>
          <p className="text-muted mt-1">
            These made the shortlist earlier but left the board without being tracked or dismissed — the posting has likely
            closed. If one still matters, act now.
          </p>
          <ul className="mt-2 space-y-1">
            {vanished.map((v) => (
              <li key={v.url}>
                <a href={v.url} target="_blank" rel="noreferrer" className="hover:underline">
                  <span className="font-medium">{v.company}</span> — {v.title}
                  {v.last_seen && <span className="text-muted"> · last seen {v.last_seen.slice(0, 10)}</span>}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {run?.triage_error && (
        <div className="mb-4 rounded-lg border border-[var(--danger-fg)] bg-[var(--danger-bg,transparent)] p-3 text-xs" style={{ borderColor: "var(--danger-fg)" }}>
          <div className="font-semibold" style={{ color: "var(--danger-fg)" }}>⚠ Triage didn’t run — this list is unranked</div>
          <p className="text-muted mt-1">
            The model triage step failed ({run.triage_error}), so roles are shown in mechanical rank order, not by fit —
            priority roles like Chief of Staff and Group PM may be buried in “Filtered out” below.
            {/oauth|auth|expired|authenticate/i.test(run.triage_error) && (
              <> Fix: run <code className="rounded bg-[var(--border)] px-1">claude setup-token</code> in a terminal, then re-run the sweep.</>
            )}
          </p>
        </div>
      )}

      {run && (
        <div className="space-y-8">
          <section>
            <h2 className="text-muted mb-2 text-xs font-medium uppercase tracking-wide">
              Shortlisted <span className="tabular-nums">({shortlisted.length})</span>
            </h2>
            {shortlisted.length ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {shortlisted.map((s) => (
                  <Card key={s.url} s={s} />
                ))}
              </div>
            ) : (
              <div className="text-muted text-xs">Nothing shortlisted (all tracked or dismissed).</div>
            )}
          </section>

          {alsoQualified.length > 0 && (
            <section>
              <h2 className="mb-1 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--warning-fg, #b45309)" }}>
                ⚠ Also qualified (capped) <span className="tabular-nums">({alsoQualified.length})</span>
              </h2>
              <p className="text-muted mb-2 text-[11px]">
                Priority shapes (head-of / director / principal at matched domains) the triage input cap squeezed out
                before ANY review. Nothing judged these — look them over yourself.
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {alsoQualified.map((s) => (
                  <Card key={s.url} s={s} dropped />
                ))}
              </div>
            </section>
          )}

          {deep && (
            <section>
              <h2 className="text-muted mb-1 text-xs font-medium uppercase tracking-wide">
                Deep scan — older strong matches <span className="tabular-nums">({deepCards.length})</span>
              </h2>
              <p className="text-muted mb-2 text-[11px]">
                Weekly pass with no freshness cap: priority titles at matched domains, age ranked instead of excluded, so a
                great role open for six weeks stays visible. Scan {deep.ran_at?.slice(0, 16).replace("T", " ")}.
              </p>
              {deepCards.length ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {deepCards.map((s) => (
                    <Card key={s.url} s={s} />
                  ))}
                </div>
              ) : (
                <div className="text-muted text-xs">Nothing live from the last deep scan (all tracked or dismissed).</div>
              )}
            </section>
          )}

          <section>
            <h2 className="text-muted mb-1 text-xs font-medium uppercase tracking-wide">
              Filtered out — rescue any <span className="tabular-nums">({dropped.length})</span>
            </h2>
            <p className="text-muted mb-2 text-[11px]">
              These cleared the mechanical filters (function, location, freshness) but were cut by the triage squeeze. Save any worth a look.
            </p>
            {dropped.length ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {dropped.map((s) => (
                  <Card key={s.url} s={s} dropped />
                ))}
              </div>
            ) : (
              <div className="text-muted text-xs">
                No dropped roles recorded. (Older sweeps predate this feature; the next sweep will populate it.)
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
