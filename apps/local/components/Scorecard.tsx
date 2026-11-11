"use client";

import type { ScoreReport } from "@kairos/engine/types";

/** Three-axis scorecard (§7). Parse-safety authoritative, match banded, authenticity first-class. */
export default function Scorecard({
  report,
  onConfirmFact,
}: {
  report: ScoreReport;
  onConfirmFact?: (question: string) => void;
}) {
  return (
    <div className="space-y-5 text-sm">
      <Recommendation value={report.recommendation} />

      <Card title="Parse-safety" subtitle="Deterministic · authoritative">
        <div className="mb-2">
          <span className={`badge ${report.parse_safety.verdict === "PASS" ? "badge-success" : "badge-warn"}`}>
            {report.parse_safety.verdict === "PASS" ? "Parses cleanly" : "Issues found"}
          </span>
        </div>
        <ul className="space-y-1">
          {report.parse_safety.checks.map((c, i) => (
            <li key={i} className="flex gap-2">
              <CheckMark result={c.result} />
              <span>
                <span className="font-medium">{c.rule.replace(/_/g, " ")}</span>
                <span className="text-muted"> · {c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        {report.parse_safety.ats_specific_note && (
          <p className="text-muted border-border mt-2 border-l-2 pl-3 italic">
            {report.parse_safety.ats_specific_note}
          </p>
        )}
      </Card>

      <Card title="Match" subtitle={`Probabilistic · directional · ${report.match.detected_ats}`}>
        <div className="mb-3 flex items-center gap-3">
          <BandChip band={report.match.overall_band} />
          <span className="text-muted text-xs">confidence: {report.match.confidence}</span>
        </div>
        <div className="space-y-2">
          {report.match.dimensions.map((d, i) => (
            <div key={i}>
              <div className="flex items-center justify-between">
                <span className="font-medium">{d.name.replace(/_/g, " ")}</span>
                <span className="text-muted tabular-nums">{d.score}</span>
              </div>
              <div className="bg-surface-2 h-1.5 rounded">
                <div
                  className="bg-accent h-1.5 rounded"
                  style={{ width: `${Math.max(0, Math.min(100, d.score))}%` }}
                />
              </div>
              <p className="text-muted mt-0.5 text-xs">{d.justification}</p>
            </div>
          ))}
        </div>
        <p className="text-muted mt-3 text-xs italic">{report.match.pool_caveat}</p>
      </Card>

      <Card title="Authenticity" subtitle="Detector-aware · the differentiator">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">{report.authenticity.score}</span>
          <span className="text-muted text-xs">/ 100 · higher = reads as authentically human</span>
        </div>
        {report.authenticity.flags.length > 0 && (
          <div className="mb-2">
            <div className="mb-1 font-medium">Flags</div>
            <ul className="space-y-1">
              {report.authenticity.flags.map((f, i) => (
                <li key={i} className="text-[color:var(--warn-fg)]">
                  ⚑ <span className="font-medium">{f.issue.replace(/_/g, " ")}</span> · {f.detail}
                  {f.where ? <span className="text-muted"> ({f.where})</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.authenticity.strengths.length > 0 && (
          <div>
            <div className="mb-1 font-medium">Strengths</div>
            <ul className="text-muted list-disc space-y-0.5 pl-5">
              {report.authenticity.strengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {report.gaps.length > 0 && (
        <Card title="Gaps" subtitle="Honest · never fabricated to close">
          <ul className="space-y-2">
            {report.gaps.map((g, i) => (
              <li key={i} className="border-border rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <SeverityChip s={g.severity} />
                  <span className="font-medium">{g.requirement}</span>
                </div>
                <div className="text-muted mt-1 text-xs">
                  {g.type === "possibly_uncaptured"
                    ? "Possibly in your experience but not captured yet"
                    : "Genuine gap"}
                </div>
                {g.clarifying_question && (
                  <div className="mt-2">
                    <p className="text-xs">{g.clarifying_question}</p>
                    {onConfirmFact && (
                      <button
                        onClick={() => onConfirmFact(g.clarifying_question!)}
                        className="text-accent mt-1 text-xs underline"
                      >
                        Answer this in chat →
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Reachable after tailoring" subtitle="Honestly bounded">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-muted text-xs">could reach</span>
          <BandChip band={report.reachable.band_if_tailored} />
        </div>
        {report.reachable.from_reframing.length > 0 && (
          <Sub title="By reframing existing evidence" items={report.reachable.from_reframing} />
        )}
        {report.reachable.needs_user_confirmation.length > 0 && (
          <Sub title="Needs you to confirm new facts" items={report.reachable.needs_user_confirmation} />
        )}
        <p className="text-muted mt-2 text-xs italic">{report.reachable.honest_ceiling_note}</p>
      </Card>
    </div>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-4">
      <div className="mb-3">
        <h3 className="font-semibold">{title}</h3>
        {subtitle && <p className="text-muted text-xs">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Sub({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mb-2">
      <div className="mb-1 text-xs font-medium">{title}</div>
      <ul className="text-muted list-disc space-y-0.5 pl-5 text-xs">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

function Recommendation({ value }: { value: ScoreReport["recommendation"] }) {
  const map: Record<string, { label: string; cls: string }> = {
    APPLY: { label: "Apply", cls: "note-success" },
    APPLY_AFTER_TAILORING: { label: "Apply after tailoring", cls: "note-info" },
    STRETCH: { label: "Stretch", cls: "note-warn" },
    NOT_RECOMMENDED: { label: "Not recommended", cls: "note-danger" },
  };
  const r = map[value] ?? { label: value, cls: "note-info" };
  return <div className={`note ${r.cls} text-center font-medium`}>Recommendation: {r.label}</div>;
}

function BandChip({ band }: { band: string }) {
  const tone =
    band === "STRONG"
      ? "badge-success"
      : band === "COMPETITIVE"
        ? "badge-info"
        : band === "DEVELOPING"
          ? "badge-warn"
          : "badge-danger";
  return <span className={`badge ${tone}`}>{band}</span>;
}

function SeverityChip({ s }: { s: string }) {
  const tone = s === "DEAL-BREAKER" ? "badge-danger" : s === "IMPORTANT" ? "badge-warn" : "badge-neutral";
  return <span className={`badge ${tone}`}>{s}</span>;
}

function CheckMark({ result }: { result: string }) {
  if (result === "PASS") return <span className="text-[color:var(--success-fg)]">✓</span>;
  if (result === "FAIL") return <span className="text-[color:var(--danger-fg)]">✗</span>;
  return <span className="text-muted">?</span>;
}
