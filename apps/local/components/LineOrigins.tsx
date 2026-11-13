import type { LineOrigin, OriginStrength } from "@kairos/engine/types";
import type { LineOriginView } from "@/lib/dashboard";

const CHIP: Record<OriginStrength, { tone: string; label: string }> = {
  strong: { tone: "success", label: "Strong" },
  partial: { tone: "info", label: "Partial" },
  none: { tone: "warn", label: "None" },
};

/** Longest fact shown in full; a longer one is cut, with the whole text on hover. */
const FACT_MAX = 420;

const plain = (s: string) => s.replace(/\*\*/g, "").trim();

/** A fact of the record, its provenance tag in the colour the knowledge-base page gives it. */
function Fact({ text }: { text: string }) {
  const cut = text.length > FACT_MAX ? `${text.slice(0, FACT_MAX - 1).replace(/\s*\[[RCF]\]\s*/g, " ").trimEnd()}… ${text.match(/\[[RCF]\]\s*$/)?.[0] ?? ""}` : text;
  return (
    <span title={cut === text ? undefined : text}>
      {cut.split(/(\[[RCF]\])/).map((part, i) =>
        /^\[[RCF]\]$/.test(part) ? (
          <span key={i} className={`prov-${part[1]} font-semibold`}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}

/**
 * The origin of each line of the résumé: the verified fact or facts of the
 * record it comes from, found by code at save time (resume.json line_origins).
 * Collapsed by default, like the requirements coverage table above it.
 */
export default function LineOrigins({ view }: { view: LineOriginView }) {
  const count = (s: OriginStrength) => view.lines.filter((l) => l.strength === s).length;
  const groups: { label: string; lines: LineOrigin[] }[] = [
    { label: "Executive summary", lines: view.lines.filter((l) => l.kind === "summary") },
    ...view.roles.map((label, role) => ({ label, lines: view.lines.filter((l) => l.kind !== "summary" && l.role === role) })),
  ].filter((g) => g.lines.length);
  return (
    <details className="card mb-6 p-4">
      <summary className="text-muted cursor-pointer text-xs font-medium uppercase tracking-wide">
        Line origins
        <span className="ml-2 font-normal normal-case tracking-normal">
          {count("strong")} strong · {count("partial")} partial · {count("none")} none
        </span>
      </summary>
      <p className="text-muted mt-2 text-xs">
        Each line of the résumé beside the fact of your record it comes from, found by matching words and numbers. Strong: the
        facts hold most of the line, in their wording, and all its numbers. Partial: the line was rewritten further, says
        more than the facts found, or (a summary sentence) is composed from several of them. None: no fact was found;
        confirm the fact, reword the line or drop it.
        {!view.saved && " This résumé was saved before origins were recorded: they are computed now, from your record as it is today."}
      </p>
      <table className="mt-3 w-full table-fixed text-sm">
        <thead>
          <tr className="text-muted text-left text-[11px] uppercase tracking-wide">
            <th className="w-[42%] pb-1.5 pr-3 font-medium">Résumé line</th>
            <th className="w-[5.5rem] pb-1.5 pr-3 font-medium">Origin</th>
            <th className="pb-1.5 font-medium">Fact in your record</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.label}>
            <tr className="border-border border-t">
              <td colSpan={3} className="text-muted pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide">
                {g.label}
              </td>
            </tr>
            {g.lines.map((l, i) => {
              const chip = CHIP[l.strength];
              return (
                <tr key={i} className="border-border border-t align-top">
                  <td className="py-1.5 pr-3">
                    {plain(l.text)}
                    {l.kind === "role_intro" && <span className="text-muted text-xs"> · role intro</span>}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className={`badge badge-${chip.tone}`}>{chip.label}</span>
                  </td>
                  <td className="text-muted py-1.5 text-xs">
                    {l.facts.length === 0
                      ? "—"
                      : l.facts.map((f, k) => (
                          <p key={k} className={k ? "mt-1.5" : undefined}>
                            <Fact text={f.fact} />
                          </p>
                        ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </details>
  );
}
