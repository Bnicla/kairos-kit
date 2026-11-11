import type { DailyApplications } from "@kairos/engine/funnel";

/**
 * Server-rendered bar chart: applications submitted per day, one bar per
 * calendar day from the first application to today, with week bands
 * (Monday to Sunday) that carry the week's total. Hover a day for the companies.
 */

const W = 1010;
const H = 230;
const PAD_L = 34;
const PAD_R = 8;
const PAD_T = 30;
const PAD_B = 30;

const parse = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const fmtDay = (date: string) =>
  parse(date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

const niceMax = (n: number) => (n <= 4 ? 4 : n <= 10 ? Math.ceil(n / 2) * 2 : Math.ceil(n / 5) * 5);

export default function DailyApplicationsChart({ days }: { days: DailyApplications[] }) {
  if (days.length === 0) return null;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const step = plotW / days.length;
  const barW = Math.max(1, Math.min(step * 0.72, 18));
  const max = niceMax(Math.max(...days.map((d) => d.count)));
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;
  const x = (i: number) => PAD_L + i * step;
  const tickStep = max <= 4 ? 1 : max <= 10 ? 2 : 5;
  const ticks = Array.from({ length: max / tickStep + 1 }, (_, i) => i * tickStep);

  // Week bands: Monday starts a week.
  const weeks: { start: number; end: number; total: number }[] = [];
  days.forEach((d, i) => {
    const monday = parse(d.date).getDay() === 1;
    if (i === 0 || monday) weeks.push({ start: i, end: i, total: 0 });
    const w = weeks[weeks.length - 1];
    w.end = i;
    w.total += d.count;
  });

  const months = days
    .map((d, i) => ({ d, i }))
    .filter(({ d, i }) => i === 0 || d.date.endsWith("-01"));

  const total = days.reduce((s, d) => s + d.count, 0);
  const busiest = days.reduce((a, b) => (b.count > a.count ? b : a));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={`Applications per day: ${total} over ${days.length} days, busiest ${fmtDay(busiest.date)} with ${busiest.count}`}
    >
      <style>{`
        .dc-lab { font-size: 11.5px; fill: var(--muted); font-variant-numeric: tabular-nums; }
        .dc-wk { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
        .dc-grid { stroke: var(--border); stroke-width: 1; }
        .dc-band { fill: var(--muted); opacity: 0.07; }
        .dc-bar { fill: var(--accent); }
        .dc-day:hover .dc-bar { opacity: 0.75; }
        .dc-hit { fill: transparent; }
        .dc-tip { display: none; pointer-events: none; }
        .dc-tip rect { fill: var(--foreground); }
        .dc-tip text { font-size: 12px; font-weight: 600; fill: var(--background); font-variant-numeric: tabular-nums; }
        .dc-day:hover .dc-hit { fill: var(--muted); opacity: 0.12; }
        ${days.map((_, i) => `svg:has(.dc-d${i}:hover) .dc-t${i}`).join(",\n        ")} { display: inline; }
      `}</style>

      {weeks.map((w, k) =>
        k % 2 === 0 ? (
          <rect key={`b${k}`} className="dc-band" x={x(w.start)} y={PAD_T - 18} width={(w.end - w.start + 1) * step} height={plotH + 18} />
        ) : null,
      )}
      {weeks.map((w, k) =>
        w.total > 0 ? (
          <text key={`w${k}`} className="dc-wk" x={x(w.start) + ((w.end - w.start + 1) * step) / 2} y={PAD_T - 6} textAnchor="middle">
            {w.total}
          </text>
        ) : null,
      )}

      {ticks.map((t) => (
        <g key={`t${t}`}>
          <line className="dc-grid" x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} />
          <text className="dc-lab" x={PAD_L - 6} y={y(t)} dy="0.35em" textAnchor="end">
            {t}
          </text>
        </g>
      ))}

      {days.map((d, i) => (
        <g key={d.date} className={`dc-day dc-d${i}`}>
          <title>
            {`${fmtDay(d.date)}: ${d.count} application${d.count === 1 ? "" : "s"}${d.companies.length ? ` (${d.companies.join(", ")})` : ""}`}
          </title>
          <rect className="dc-hit" x={x(i)} y={PAD_T} width={step} height={plotH} />
          {d.count > 0 && (
            <rect className="dc-bar" x={x(i) + (step - barW) / 2} y={y(d.count)} width={barW} height={y(0) - y(d.count)} rx={1} />
          )}
        </g>
      ))}

      {/* Hover labels, drawn last so no bar covers them; shown by the :has() rules above. */}
      {days.map((d, i) => {
        const text = `${fmtDay(d.date)}: ${d.count}`;
        const w = text.length * 6.6 + 14;
        const cx = Math.min(Math.max(x(i) + step / 2, PAD_L + w / 2), W - PAD_R - w / 2);
        const top = Math.max(2, y(d.count) - 28);
        return (
          <g key={`tip${d.date}`} className={`dc-tip dc-t${i}`}>
            <rect x={cx - w / 2} y={top} width={w} height={20} rx={4} />
            <text x={cx} y={top + 14} textAnchor="middle">
              {text}
            </text>
          </g>
        );
      })}

      {months.map(({ d, i }) => (
        <text key={`m${d.date}`} className="dc-lab" x={x(i)} y={H - 10}>
          {parse(d.date).toLocaleDateString("en-US", { month: "short", day: i === 0 ? "numeric" : undefined })}
        </text>
      ))}
    </svg>
  );
}
