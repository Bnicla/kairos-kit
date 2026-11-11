import type { ScoreReport } from "@kairos/engine/types";
import type { ScoreVersion } from "@kairos/engine/applications";

const BAND_TONE: Record<string, string> = {
  STRONG: "badge-success",
  COMPETITIVE: "badge-info",
  DEVELOPING: "badge-warn",
  WEAK: "badge-danger",
};
const REC_LABEL: Record<string, string> = {
  APPLY: "Apply",
  APPLY_AFTER_TAILORING: "Apply after tailoring",
  STRETCH: "Stretch",
  NOT_RECOMMENDED: "Not recommended",
};

/** Before/after: the default (untailored) résumé vs the optimized one. */
export default function ScoreCompare({ versions }: { versions: ScoreVersion<ScoreReport>[] }) {
  if (versions.length < 2) return null;
  const base = versions[0];
  const opt = versions[versions.length - 1];

  const dimsBase = new Map(base.report.match.dimensions.map((d) => [d.name, d.score]));
  const rows = opt.report.match.dimensions.map((d) => ({
    name: d.name.replace(/_/g, " "),
    before: dimsBase.get(d.name) ?? d.score,
    after: d.score,
  }));
  rows.push({
    name: "authenticity",
    before: base.report.authenticity.score,
    after: opt.report.authenticity.score,
  });

  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">Default → Optimized</h3>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">{base.label}</span>
          <span className={`badge ${BAND_TONE[base.report.match.overall_band] ?? "badge-neutral"}`}>
            {base.report.match.overall_band}
          </span>
          <span className="text-muted">→</span>
          <span className={`badge ${BAND_TONE[opt.report.match.overall_band] ?? "badge-neutral"}`}>
            {opt.report.match.overall_band}
          </span>
        </div>
      </div>

      <div className="space-y-2.5">
        {rows.map((r) => {
          const delta = r.after - r.before;
          return (
            <div key={r.name} className="grid grid-cols-[1fr_auto] items-center gap-3">
              <div>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-sm capitalize">{r.name}</span>
                  <span className="text-muted text-xs tabular-nums">
                    {r.before} <span className="text-foreground font-medium">→ {r.after}</span>
                  </span>
                </div>
                <div className="bg-surface-2 relative h-1.5 overflow-hidden rounded">
                  {/* baseline (muted) then optimized (accent) overlay */}
                  <div className="absolute inset-y-0 left-0 rounded bg-[var(--muted)] opacity-40" style={{ width: `${r.before}%` }} />
                  <div className="bg-accent absolute inset-y-0 left-0 rounded" style={{ width: `${r.after}%`, opacity: 0.85 }} />
                </div>
              </div>
              <span
                className={`badge shrink-0 text-xs ${delta > 0 ? "badge-success" : delta < 0 ? "badge-danger" : "badge-neutral"}`}
              >
                {delta > 0 ? `▲ +${delta}` : delta < 0 ? `▼ ${delta}` : "="}
              </span>
            </div>
          );
        })}
      </div>

      <div className="border-border text-muted mt-4 flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
        <span>Recommendation:</span>
        <span>{REC_LABEL[base.report.recommendation] ?? base.report.recommendation}</span>
        <span>→</span>
        <span className="text-foreground font-medium">{REC_LABEL[opt.report.recommendation] ?? opt.report.recommendation}</span>
      </div>
    </section>
  );
}
