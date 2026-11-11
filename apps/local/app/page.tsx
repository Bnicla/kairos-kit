import Link from "next/link";
import { getDashboard, getHealth, getMaxSourcedCards, getSourcedRun } from "@/lib/dashboard";
import { topSourced } from "@kairos/engine/sourcing/backlog";
import { archiveAction } from "@/app/actions";
import { STATUS_META } from "@kairos/engine/applications";
import ThemeToggle from "@/components/ThemeToggle";
import PipelineBoard from "@/components/PipelineBoard";

export const dynamic = "force-dynamic"; // always read the latest files


export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const { archived: showArchived } = await searchParams;
  const [{ applications: allApplications, experiences, profile, insightsHtml, home }, sourcedRun, maxCards] =
    await Promise.all([getDashboard(), getSourcedRun(), getMaxSourcedCards()]);
  // The column shows only the best few; the rest stay on the All-sourced page.
  const allSourced = sourcedRun ? [...sourcedRun.survivors, ...sourcedRun.stretch] : [];
  const sourcedCards = topSourced(allSourced, maxCards);
  const applications = allApplications.filter((a) => !a.archived);
  const archivedApps = allApplications.filter((a) => a.archived);
  const health = await getHealth();
  const healthColor = health.overall >= 85 ? "var(--success-fg)" : health.overall >= 60 ? "var(--warn-fg)" : "var(--danger-fg)";

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--accent)]" />
            <h1 className="text-2xl font-semibold tracking-tight">Job Engine</h1>
          </div>
          <p className="text-muted mt-1 text-sm">
            {profile.name ? `${profile.name} · ` : ""}
            {profile.headline ?? "Your career, honestly represented"}
          </p>
        </div>
        <ThemeToggle />
      </header>

      {/* Knowledge base summary */}
      <section className="card mb-6 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Knowledge base</h2>
          <div className="flex items-center gap-3 text-xs">
            <Link href="/stories" className="text-accent hover:underline">
              STAR stories
            </Link>
            <Link href="/deep-dives" className="text-accent hover:underline">
              Deep dives
            </Link>
            <Link href="/metrics" className="text-accent hover:underline">
              Metrics register
            </Link>
            <Link href="/kb" className="text-accent hover:underline">
              View all →
            </Link>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {experiences.map((e) => (
            <Link
              key={e.fileName}
              href={`/kb?e=${encodeURIComponent(e.fileName)}`}
              className="badge badge-neutral hover:border-[var(--accent)] transition-colors"
              title={`${e.title} · ${e.dates}`}
            >
              {e.company}
            </Link>
          ))}
        </div>
        {profile.target_roles && profile.target_roles.length > 0 && (
          <p className="text-muted mt-3 text-xs">
            Targeting: {profile.target_roles.join(" · ")}
          </p>
        )}
        <Link
          href="/health"
          className="border-border mt-4 flex items-center justify-between border-t pt-3 text-sm hover:opacity-80"
        >
          <span>
            <span className="text-muted">Résumé health</span>{" "}
            <span className="font-semibold tabular-nums" style={{ color: healthColor }}>
              {health.overall}/100
            </span>
            {health.topFixes[0] && <span className="text-muted"> · top fix: {health.topFixes[0]}</span>}
          </span>
          <span className="text-accent shrink-0 text-xs">view →</span>
        </Link>
      </section>

      {/* What Kairos has learned — the memory/insights layer */}
      {insightsHtml && (
        <details className="card mb-6 p-5">
          <summary className="flex cursor-pointer items-center justify-between font-semibold">
            What Kairos has learned about you
            <span className="text-muted text-xs font-normal">memory · updates as you apply</span>
          </summary>
          <div
            className="prose-kairos text-muted mt-3 text-sm leading-relaxed [&_h1]:mt-0 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-[color:var(--foreground)] [&_h2]:mt-4 [&_h2]:text-xs [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-wide [&_h2]:text-[color:var(--foreground)] [&_li]:ml-4 [&_li]:list-disc [&_ul]:mt-1"
            dangerouslySetInnerHTML={{ __html: insightsHtml }}
          />
        </details>
      )}

      {/* Applications pipeline */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Applications</h2>
          <div className="flex items-center gap-3">
            <Link href="/funnel" className="text-accent text-xs hover:underline" title="Where every submitted application ended up">
              Funnel →
            </Link>
            {sourcedRun && (
              <Link href="/sourced" className="text-accent text-xs hover:underline" title="See every role the last sweep surfaced, including ones the triage dropped">
                View all sourced →
              </Link>
            )}
            <span className="text-muted text-xs">{applications.length} tracked</span>
          </div>
        </div>

        {applications.length === 0 ? (
          <div className="card text-muted p-8 text-center text-sm">
            No applications yet. In Claude Code, run <code>/kairos</code> and share a job to score it.
          </div>
        ) : (
          <PipelineBoard applications={applications} sourced={sourcedCards} sourcedTotal={allSourced.length} sourcedRanAt={sourcedRun?.ran_at} />
        )}

        {archivedApps.length > 0 &&
          (showArchived ? (
            <div className="card mt-6 p-5">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-muted text-xs font-medium uppercase tracking-wide">
                  Archived ({archivedApps.length})
                </h2>
                <Link href="/" className="text-muted text-xs hover:underline">
                  Hide
                </Link>
              </div>
              {archivedApps.map((a) => (
                <div
                  key={a.id}
                  className="border-border flex items-center justify-between border-t py-2 text-sm first:border-t-0"
                >
                  <span className="min-w-0 truncate">
                    <Link href={`/applications/${a.id}`} className="hover:underline">
                      {a.company}
                    </Link>{" "}
                    <span className="text-muted">· {a.role}</span>{" "}
                    <span className={`badge badge-${STATUS_META[a.status]?.tone ?? "neutral"} text-[10px]`}>
                      {STATUS_META[a.status]?.label ?? a.status}
                    </span>
                  </span>
                  <form action={archiveAction}>
                    <input type="hidden" name="id" value={a.id} />
                    <input type="hidden" name="archived" value="0" />
                    <button className="text-muted cursor-pointer text-xs underline hover:text-[color:var(--foreground)]">
                      Restore
                    </button>
                  </form>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3">
              <Link href="/?archived=1" className="text-muted text-xs hover:underline">
                Show archived ({archivedApps.length})
              </Link>
            </p>
          ))}
      </section>

      <footer className="text-muted mt-10 text-center text-xs">
        Reading from <code>{home}</code> · a read-only view of your local files
      </footer>
    </div>
  );
}
