import Link from "next/link";
import { getDailyApplications, getFunnel } from "../../lib/dashboard";
import FunnelSankey from "../../components/FunnelSankey";
import DailyApplicationsChart from "../../components/DailyApplicationsChart";
import RefreshOnFocus from "../../components/RefreshOnFocus";
import { NO_RESPONSE_DAYS } from "@kairos/engine/funnel";

export const dynamic = "force-dynamic";

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");

export default async function FunnelPage() {
  const [funnel, daily] = await Promise.all([getFunnel(), getDailyApplications()]);
  const dailyTotal = daily.reduce((s, d) => s + d.count, 0);
  const perWeek = daily.length ? (dailyTotal / (daily.length / 7)).toFixed(1) : "0";
  const busiest = daily.reduce<(typeof daily)[number] | null>((a, b) => (!a || b.count > a.count ? b : a), null);
  const busiestLabel = busiest
    ? `${new Date(`${busiest.date}T12:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric" })} with ${busiest.count}`
    : "none";
  const value = (id: string) => funnel.nodes.find((n) => n.id === id)?.value ?? 0;
  const answered = funnel.total - value("no-response") - value("waiting");
  const tiles = [
    { label: "Applications", value: String(funnel.total) },
    { label: "Got any answer", value: String(answered), sub: pct(answered, funnel.total) },
    { label: "Reached a recruiter screen", value: `${funnel.interviewed}`, sub: pct(funnel.interviewed, funnel.total) },
    { label: "In progress now", value: String(value("in-progress")) },
    { label: "Offers", value: String(value("offer")) },
  ];

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <RefreshOnFocus />
      <Link href="/" className="text-muted text-xs hover:underline">
        ← Dashboard
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Application funnel</h1>
        <p className="text-muted mt-1 text-sm">
          Every application submitted
          {funnel.firstAppliedAt ? ` since ${new Date(funnel.firstAppliedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}` : ""}
          , and where it ended up. Updates as cards move on the board.
        </p>
      </div>

      {funnel.total === 0 ? (
        <div className="card text-muted p-8 text-center text-sm">No submitted applications yet.</div>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {tiles.map((t) => (
              <div key={t.label} className="card p-3">
                <div className="text-muted text-xs">{t.label}</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tabular-nums">{t.value}</span>
                  {t.sub && <span className="text-muted text-sm tabular-nums">{t.sub}</span>}
                </div>
              </div>
            ))}
          </div>
          <div className="card p-5">
            <FunnelSankey funnel={funnel} />
          </div>
          <p className="text-muted mt-3 text-xs leading-relaxed">
            An application counts once it is marked applied. No response means {NO_RESPONSE_DAYS}+ days of silence;
            newer ones are still waiting. Interview stages are the furthest one recorded on the card: recruiter
            screen, hiring manager interview, on-site (hover an outcome to see the companies).
          </p>

          <h2 className="mt-8 mb-1 text-base font-semibold tracking-tight">Applications per day</h2>
          <p className="text-muted mb-3 text-sm">
            {daily.length} days, {perWeek} a week on average; busiest day {busiestLabel}. Numbers above the bars are
            weekly totals (Monday to Sunday); hover a day to see the companies.
          </p>
          <div className="card p-5">
            <DailyApplicationsChart days={daily} />
          </div>
        </>
      )}
    </div>
  );
}
