import EmptyState from "@/components/EmptyState";
import { getMetricsRegister, type MetricStatus } from "../../../lib/dashboard";
import KbNav from "../../../components/KbNav";
import Link from "next/link";
import PrintButton from "../../../components/PrintButton";

export const dynamic = "force-dynamic";

const STATUS_META: Record<MetricStatus, { badge: string; hint: string }> = {
  DEFENDED: { badge: "badge-success", hint: "methodology confirmed; ships anywhere" },
  PARTIAL: { badge: "badge-info", hint: "mechanism known; ships with its honest frame" },
  OPEN: { badge: "badge-warn", hint: "no confirmed methodology; does NOT ship in new documents" },
  RETIRED: { badge: "badge-danger", hint: "do not use" },
  SCOPE: { badge: "badge-neutral", hint: "a size fact, not a result claim" },
};
const STATUS_ORDER: MetricStatus[] = ["DEFENDED", "PARTIAL", "OPEN", "RETIRED", "SCOPE"];

export default async function MetricsPage() {
  const reg = await getMetricsRegister();

  if (!reg) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <KbNav active="/metrics" />
        <h1 className="text-xl font-semibold tracking-tight">Metrics register</h1>
        <EmptyState
          title="No metrics register yet"
          file="knowledge-base/metrics-register.md"
          ask="Ask Kairos to go through the numbers in your knowledge base; each one is checked and saved with save_metric."
        />
      </div>
    );
  }

  const openEntries = reg.sections.flatMap((s) =>
    s.entries.filter((e) => e.status === "OPEN").map((e) => ({ ...e, section: s.section })),
  );

  return (
    <div className="print-page mx-auto max-w-5xl px-6 py-8">
      <KbNav active="/metrics" />
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Metrics register: full text</h1>
          <p className="text-muted text-sm">
            <Link href="/metrics" className="underline">← Glance view</Link> · Every number in the knowledge base, with its baseline, instrument, and status. A number
            ships only at DEFENDED or SCOPE, or PARTIAL with its honest frame attached.
          </p>
        </div>
        <PrintButton />
      </div>

      {/* Status summary */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {STATUS_ORDER.map((s) => (
          <span key={s} className={`badge ${STATUS_META[s].badge}`} title={STATUS_META[s].hint}>
            {s} {reg.counts[s]}
          </span>
        ))}
      </div>

      {/* OPEN queue, the working list */}
      {openEntries.length > 0 ? (
        <section className="card mb-6 border-l-4 border-[var(--warn-fg)] p-4">
          <h2 className="text-sm font-semibold">Adjudication queue ({openEntries.length} OPEN)</h2>
          <p className="text-muted mt-1 text-xs">
            Inherited numbers with no confirmed methodology. Barred from new resumes, stories, and
            briefings until adjudicated.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {openEntries.map((e) => (
              <li key={e.name}>
                <span className="font-medium">{e.name}</span>
                <span className="text-muted"> · {e.section.replace(/\s*\(.*$/, "")}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Register by experience */}
      <div className="space-y-6">
        {reg.sections.map((section) => (
          <section key={section.section} className="card p-5">
            <h2 className="mb-3 text-sm font-semibold">{section.section}</h2>
            <div className="space-y-4">
              {section.entries.map((e) => (
                <div key={e.name} className="border-t border-[var(--border)] pt-3 first:border-t-0 first:pt-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className={`badge ${STATUS_META[e.status].badge}`}>{e.status}</span>
                    <span className="font-medium">{e.name}</span>
                    {e.statusNote ? <span className="text-muted text-xs">{e.statusNote}</span> : null}
                  </div>
                  {e.details.length > 0 ? (
                    <ul className="text-muted mt-1.5 ml-1 space-y-1 text-sm">
                      {e.details.map((d, i) => (
                        <li key={i} className="pl-3 [text-indent:-0.75rem]">
                          · {d.replace(/\*\*/g, "")}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Operating rules */}
      {reg.rules.length > 0 ? (
        <section className="card mt-6 p-5">
          <h2 className="mb-2 text-sm font-semibold">Operating rules</h2>
          <ol className="text-muted list-decimal space-y-1 pl-5 text-sm">
            {reg.rules.map((r, i) => (
              <li key={i}>{r.replace(/\*\*/g, "")}</li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
