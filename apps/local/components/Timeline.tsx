import { fmtDate } from "@kairos/engine/format";
import type { ApplicationMeta } from "@kairos/engine/applications";

const STATUS_LABEL: Record<string, string> = {
  captured: "Captured",
  scored: "Scored",
  drafted: "Draft started",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};
const STATUS_TONE: Record<string, string> = {
  offer: "var(--success-fg)",
  interviewing: "var(--accent)",
  rejected: "var(--danger-fg)",
  withdrawn: "var(--muted)",
  applied: "var(--accent)",
};

/** Vertical, timestamped status timeline for one application. */
export default function Timeline({ meta }: { meta: ApplicationMeta }) {
  const history = meta.status_history ?? [{ status: meta.status, at: meta.captured_at }];
  const year = new Date(meta.captured_at).getUTCFullYear();

  return (
    <ol className="relative ml-1 space-y-3 border-l border-[var(--border)] pl-4">
      {history.map((h, i) => {
        const isLast = i === history.length - 1;
        const color = STATUS_TONE[h.status] ?? "var(--muted)";
        return (
          <li key={i} className="relative">
            <span
              className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-[var(--background)]"
              style={{ background: isLast ? color : "var(--muted)" }}
            />
            <div className="flex items-baseline justify-between gap-3">
              <span className={`text-sm ${isLast ? "font-medium" : ""}`}>
                {STATUS_LABEL[h.status] ?? h.status}
              </span>
              <span className="text-muted text-xs tabular-nums">{fmtDate(h.at, year)}</span>
            </div>
            {h.note && <p className="text-muted mt-0.5 text-xs">{h.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}
