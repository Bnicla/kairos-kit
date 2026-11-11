import EmptyState from "@/components/EmptyState";
import Link from "next/link";
import { getMetricsGlance, type MetricStatus } from "../../lib/dashboard";
import KbNav from "../../components/KbNav";

export const dynamic = "force-dynamic";

// Glance view for live calls: big number, short label, one-line caveat.
// The full register text lives at /metrics/full.
const STATUS_STYLE: Record<MetricStatus, string> = {
  DEFENDED: "bg-[var(--success-fg)]",
  PARTIAL: "bg-[var(--info-fg)]",
  SCOPE: "bg-[var(--muted)]",
  OPEN: "bg-[var(--warn-fg)]",
  RETIRED: "bg-[var(--danger-fg)]",
};

export default async function MetricsGlancePage() {
  const glance = await getMetricsGlance();

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-4">
      <KbNav active="/metrics" />
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Numbers</h1>
        <div className="text-muted flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1"><i className={`inline-block h-2 w-2 rounded-full ${STATUS_STYLE.DEFENDED}`} />defended</span>
          <span className="flex items-center gap-1"><i className={`inline-block h-2 w-2 rounded-full ${STATUS_STYLE.PARTIAL}`} />partial, frame it</span>
          <span className="flex items-center gap-1"><i className={`inline-block h-2 w-2 rounded-full ${STATUS_STYLE.SCOPE}`} />size, not result</span>
          <Link href="/metrics/full" className="underline">Full register →</Link>
        </div>
      </div>

      {!glance ? (
        <EmptyState
          title="No one-glance numbers yet"
          file="knowledge-base/metrics-glance.json"
          ask="The glance tiles are curated from the metrics register. Build the register first (Full register), then ask Kairos for the glance file."
        />
      ) : (
        <div className="space-y-4">
          {glance.groups.map((g) => (
            <section key={g.name}>
              <h2 className="text-muted mb-1.5 text-xs font-semibold uppercase tracking-wider">{g.name}</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
                {g.tiles.map((t) => (
                  <div key={t.label} className="card relative px-3 py-2.5">
                    <i className={`absolute top-3 right-3 h-2 w-2 rounded-full ${STATUS_STYLE[t.status]}`} title={t.status} />
                    <div className="text-2xl leading-tight font-bold tracking-tight">{t.number}</div>
                    <div className="text-sm leading-snug font-semibold">{t.label}</div>
                    {t.fromTo ? <div className="text-muted text-xs leading-snug">{t.fromTo}</div> : null}
                    {t.how ? <div className="text-muted text-xs leading-snug">↳ {t.how}</div> : null}
                    {t.caveat ? (
                      <div className="mt-1 text-xs leading-snug font-medium text-[var(--warn-fg)]">⚠ {t.caveat}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ))}

          {glance.dontSay.length > 0 ? (
            <section className="rounded-lg bg-[var(--danger-bg)] px-3 py-2">
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--danger-fg)]">Never say</h2>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--danger-fg)]">
                {glance.dontSay.map((d) => (
                  <span key={d}>✕ {d}</span>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
