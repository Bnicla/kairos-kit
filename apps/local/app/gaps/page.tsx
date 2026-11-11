import Link from "next/link";
import { getGapReport } from "../../lib/dashboard";
import KbNav from "../../components/KbNav";
import {
  BAND_WEIGHT,
  DEFAULT_WINDOW_DAYS,
  HALF_LIFE_DAYS,
  SEVERITY_WEIGHT,
  TIER_RULES,
  type AggregatedGap,
  type GapTier,
} from "@kairos/engine/gaps";

export const dynamic = "force-dynamic";

// Which gaps recur across the postings the user is targeting: what to learn or build,
// and which "possibly uncaptured" gaps are really knowledge-base facts to confirm.
const TIER_CHIP: Record<GapTier, string> = {
  Critical: "badge badge-danger",
  High: "badge badge-warn",
  Medium: "badge badge-info",
  Low: "badge badge-neutral",
};
const WINDOWS = [30, 90, 180] as const;

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function GapRow({ g, showQuestion }: { g: AggregatedGap; showQuestion: boolean }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-1.5">
      <span className={`${TIER_CHIP[g.tier]} w-16 justify-center`}>{g.tier}</span>
      <div className="min-w-0 flex-1 basis-72">
        <div className="text-sm leading-snug font-medium">
          {g.label}
          {g.kind === "mixed" ? (
            <span
              className="text-muted ml-2 text-xs font-normal"
              title={`${g.uncaptured_mentions} possibly uncaptured, ${g.genuine_mentions} genuine mentions`}
            >
              {g.uncaptured_mentions} of {g.uncaptured_mentions + g.genuine_mentions} mentions uncaptured
            </span>
          ) : null}
        </div>
        {showQuestion && g.questions[0] ? (
          <div className="text-muted line-clamp-1 text-xs leading-snug" title={g.questions[0]}>
            ↳ {g.questions[0]}
          </div>
        ) : null}
      </div>
      <span className="text-muted w-20 text-right text-xs tabular-nums" title={`score ${g.score}`}>
        {g.occurrences} {g.occurrences === 1 ? "posting" : "postings"}
      </span>
      <span className="flex basis-full flex-wrap gap-x-2 text-xs sm:basis-80">
        {g.applications.map((o) => (
          <Link
            key={o.appId}
            href={`/applications/${o.appId}`}
            className="text-muted hover:text-[var(--foreground)] hover:underline"
            title={`${o.role} · ${o.band ?? "unscored"} · ${o.severity.toLowerCase()} · ${shortDate(o.scored_at)}`}
          >
            {o.company}
          </Link>
        ))}
      </span>
    </li>
  );
}

function GapSection({ title, note, gaps, showQuestion }: { title: string; note: string; gaps: AggregatedGap[]; showQuestion: boolean }) {
  const main = gaps.filter((g) => g.tier !== "Low");
  const low = gaps.filter((g) => g.tier === "Low");
  return (
    <section>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-muted text-xs font-semibold tracking-wider uppercase">{title}</h2>
        <span className="text-muted text-xs">{note}</span>
      </div>
      {gaps.length === 0 ? (
        <p className="text-muted text-sm">None in this window.</p>
      ) : (
        <div className="card overflow-hidden">
          {main.length ? <ul className="divide-y divide-[var(--border)]">{main.map((g) => <GapRow key={g.key} g={g} showQuestion={showQuestion} />)}</ul> : null}
          {low.length ? (
            <details className={main.length ? "border-t border-[var(--border)]" : ""}>
              <summary className="text-muted cursor-pointer px-3 py-1.5 text-xs">
                {low.length} low-weight {low.length === 1 ? "gap" : "gaps"} (one posting each, or old and strong-fit)
              </summary>
              <ul className="divide-y divide-[var(--border)]">{low.map((g) => <GapRow key={g.key} g={g} showQuestion={showQuestion} />)}</ul>
            </details>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default async function GapsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days: daysParam } = await searchParams;
  const parsed = Number.parseInt(daysParam ?? "", 10);
  const days = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 730) : DEFAULT_WINDOW_DAYS;
  const report = await getGapReport(days);
  const confirm = report.gaps.filter((g) => g.section === "confirm");
  const genuine = report.gaps.filter((g) => g.section === "genuine");
  const circumstances = report.gaps.filter((g) => g.section === "circumstance");
  const t = report.totals;
  const tierCount = (tier: GapTier) => [...confirm, ...genuine].filter((g) => g.tier === tier).length;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-4">
      <KbNav active="/gaps" />
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Gaps across postings</h1>
        <div className="text-muted flex items-center gap-1 text-xs">
          {WINDOWS.map((w) => (
            <Link
              key={w}
              href={w === DEFAULT_WINDOW_DAYS ? "/gaps" : `/gaps?days=${w}`}
              className={
                w === days
                  ? "rounded-md bg-[var(--border)] px-2 py-0.5 font-medium text-[var(--foreground)]"
                  : "rounded-md px-2 py-0.5 hover:bg-[var(--border)]"
              }
            >
              {w} days
            </Link>
          ))}
        </div>
      </div>
      <p className="text-muted mb-4 text-sm">
        {t.applications} scored {t.applications === 1 ? "posting" : "postings"} from {shortDate(report.window.from)} to{" "}
        {shortDate(report.window.to)}, {t.gap_mentions} gap mentions, {confirm.length + genuine.length} distinct skill gaps:{" "}
        {confirm.length} to confirm, {genuine.length} genuine. {tierCount("Critical")} Critical, {tierCount("High")} High.
        {t.excluded.archived ? ` Archived cards (${t.excluded.archived}) are left out.` : ""}
      </p>

      <div className="space-y-5">
        <GapSection
          title="Possibly uncaptured: confirm these in the knowledge base"
          note="The scorer suspects the experience exists but the knowledge base does not record it. Each confirmed fact can lift several postings."
          gaps={confirm}
          showQuestion
        />
        <GapSection
          title="Genuine gaps"
          note="Missing experience, ranked by how often, how recently and how far from a fit the postings were."
          gaps={genuine}
          showQuestion={false}
        />

        {circumstances.length ? (
          <section>
            <h2 className="text-muted mb-1.5 text-xs font-semibold tracking-wider uppercase">Not skills</h2>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {circumstances.map((g) => (
                <span key={g.key} title={g.applications.map((o) => o.company).join(", ")}>
                  {g.label} <span className="text-muted tabular-nums">×{g.occurrences}</span>
                </span>
              ))}
            </div>
          </section>
        ) : null}

        <p className="text-muted border-t border-[var(--border)] pt-2 text-xs leading-relaxed">
          Score per posting: fit band (WEAK {BAND_WEIGHT.WEAK}, DEVELOPING {BAND_WEIGHT.DEVELOPING}, COMPETITIVE{" "}
          {BAND_WEIGHT.COMPETITIVE}, STRONG {BAND_WEIGHT.STRONG}) × severity (deal-breaker {SEVERITY_WEIGHT["DEAL-BREAKER"]},
          important {SEVERITY_WEIGHT.IMPORTANT}, nice-to-have {SEVERITY_WEIGHT["NICE-TO-HAVE"]}) × recency (half-life{" "}
          {HALF_LIFE_DAYS} days), summed over postings.{" "}
          {TIER_RULES.map((r) => `${r.tier} ≥ ${r.minScore}${r.minPostings > 1 ? ` across ${r.minPostings}+ postings` : ""}`).join("; ")}.
          Gap wording is grouped into topics by a fixed synonym table (packages/engine/gaps.ts).
        </p>
      </div>
    </div>
  );
}
