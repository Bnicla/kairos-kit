import Link from "next/link";
import { getHealth } from "@/lib/dashboard";
import type { HealthDimension } from "@kairos/engine/health";

export const dynamic = "force-dynamic";

const GROUPS: HealthDimension["group"][] = ["Mechanics", "Content", "Authenticity", "Depth"];
const STATUS_TONE: Record<string, string> = { strong: "badge-success", ok: "badge-warn", weak: "badge-danger" };

function scoreColor(overall: number): string {
  return overall >= 85 ? "var(--success-fg)" : overall >= 60 ? "var(--warn-fg)" : "var(--danger-fg)";
}

export default async function HealthPage() {
  const h = await getHealth();

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6">
        <Link href="/" className="text-muted text-xs hover:underline">
          ← Dashboard
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Résumé health check</h1>
        <p className="text-muted text-sm">
          A job-agnostic quality report on your knowledge base. Every fix is a Kairos action, never an upsell.
        </p>
      </div>

      {/* Overall + top fixes */}
      <div className="mb-6 grid gap-4 sm:grid-cols-[200px_1fr]">
        <div className="card flex flex-col items-center justify-center p-6">
          <div className="text-5xl font-semibold tabular-nums" style={{ color: scoreColor(h.overall) }}>
            {h.overall}
          </div>
          <div className="text-muted text-xs">/ 100</div>
          <div className="text-muted mt-2 text-center text-xs">
            {h.counts.experiences} roles · {h.counts.bullets} bullets · {h.counts.confirmed} enriched
          </div>
        </div>
        <div className="card p-5">
          <div className="font-medium">{h.verdict}</div>
          {h.topFixes.length > 0 && (
            <>
              <div className="text-muted mt-3 mb-1 text-[10px] font-semibold uppercase tracking-wider">Top fixes</div>
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {h.topFixes.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>

      {/* Dimensions by group */}
      <div className="space-y-6">
        {GROUPS.map((g) => {
          const dims = h.dimensions.filter((d) => d.group === g);
          if (!dims.length) return null;
          return (
            <section key={g}>
              <h2 className="text-muted mb-2 text-xs font-medium uppercase tracking-wide">{g}</h2>
              <div className="space-y-2">
                {dims.map((d) => (
                  <div key={d.key} className="card p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className={`badge ${STATUS_TONE[d.status]} text-[10px]`}>{d.score}/5</span>
                        <span className="font-medium">{d.label}</span>
                      </div>
                      <Bars score={d.score} />
                    </div>
                    <p className="text-muted mt-1.5 text-sm">{d.detail}</p>
                    {d.evidence && (
                      <p className="text-muted mt-1 border-l-2 border-[var(--border)] pl-2 text-xs italic">{d.evidence}</p>
                    )}
                    {d.fix && <p className="mt-1.5 text-xs text-[color:var(--accent)]">→ {d.fix}</p>}
                  </div>
                ))}
              </div>
            </section>
          );
        })}

        {/* Flagged bullets */}
        {h.flaggedBullets.length > 0 && (
          <section>
            <h2 className="text-muted mb-2 text-xs font-medium uppercase tracking-wide">
              Weak bullets to fix ({h.flaggedBullets.length})
            </h2>
            <div className="space-y-2">
              {h.flaggedBullets.map((b, i) => (
                <div key={i} className="card p-3">
                  <div className="text-muted mb-1 flex items-center gap-2 text-xs">
                    <span className="badge badge-warn text-[10px]">{b.experience}</span>
                    <span>{b.why}</span>
                  </div>
                  <p className="text-sm">{b.bullet}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Bars({ score }: { score: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className="h-1.5 w-4 rounded"
          style={{ background: n <= score ? "var(--accent)" : "var(--surface-2)" }}
        />
      ))}
    </div>
  );
}
