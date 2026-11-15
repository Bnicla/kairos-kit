import { ORIGIN_CHIP, ORIGIN_NOTE, ORIGIN_NOTE_COMPUTED, cutFact, educationLabel, factParts, originCounts, originGroups, plainLine, type LineOriginView } from "@kairos/engine/line-origin-view";
import Byline from "@/components/Byline";

/** A fact of the knowledge base, its provenance tag in the colour the knowledge-base page gives it. */
function Fact({ text }: { text: string }) {
  const cut = cutFact(text);
  return (
    <span title={cut === text ? undefined : text}>
      {factParts(cut).map((part, i) =>
        part.tag ? (
          <span key={i} className={`prov-${part.tag} font-semibold`}>
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </span>
  );
}

/**
 * The origin of each line of the résumé: the verified fact or facts of the
 * knowledge base it comes from, found by code at save time (resume.json line_origins).
 * Collapsed by default, like the requirements coverage table above it.
 */
export default function LineOrigins({ view }: { view: LineOriginView }) {
  const counts = originCounts(view.lines);
  const groups = originGroups(view);
  return (
    <details className="card mb-6 p-4">
      <summary className="text-muted cursor-pointer text-xs font-medium uppercase tracking-wide">
        Line origins<Byline name="Writer" />
        <span className="ml-2 font-normal normal-case tracking-normal">
          {counts.strong} strong · {counts.partial} partial · {counts.none} none
        </span>
      </summary>
      <p className="text-muted mt-2 text-xs">
        {ORIGIN_NOTE}
        {!view.saved && ORIGIN_NOTE_COMPUTED}
      </p>
      <table className="mt-3 w-full table-fixed text-sm">
        <thead>
          <tr className="text-muted text-left text-[11px] uppercase tracking-wide">
            <th className="w-[42%] pb-1.5 pr-3 font-medium">Résumé line</th>
            <th className="w-[5.5rem] pb-1.5 pr-3 font-medium">Origin</th>
            <th className="pb-1.5 font-medium">Fact in your knowledge base</th>
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
              const chip = ORIGIN_CHIP[l.strength];
              return (
                <tr key={i} className="border-border border-t align-top">
                  <td className="py-1.5 pr-3">
                    {plainLine(l.text)}
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
                            {educationLabel(f)}
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
