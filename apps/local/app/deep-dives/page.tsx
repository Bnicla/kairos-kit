import EmptyState from "@/components/EmptyState";
import { getDeepDives } from "../../lib/dashboard";
import KbNav from "../../components/KbNav";
import PrintButton from "../../components/PrintButton";

export const dynamic = "force-dynamic";

/** Split a war-story Action cell into its fix-lever label and the rest, when present. */
function splitLever(action: string): { lever: string | null; rest: string } {
  const m = action.match(/^Fix lever:\s*([^.]+)\.\s*(.*)$/s);
  return m ? { lever: m[1].trim(), rest: m[2] } : { lever: null, rest: action };
}

export default async function DeepDivesPage() {
  const { warTheme, depths } = await getDeepDives();

  return (
    <div className="print-page mx-auto max-w-5xl px-6 py-8">
      <KbNav active="/deep-dives" />
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Deep dives</h1>
          <p className="text-muted text-sm">
            The zoom-in layer: war stories with their fix levers, and the approved depth notes behind
            the headline STAR stories. For when an interviewer says &ldquo;go deeper&rdquo;.
          </p>
        </div>
        <PrintButton />
      </div>

      {/* War stories */}
      {warTheme ? (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold">
            {warTheme.theme}
            <span className="text-muted ml-2 font-normal">
              {warTheme.stories.length} stories · each one failure class → lever → verified fix
            </span>
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {warTheme.stories.map((story) => {
              const { lever, rest } = splitLever(story.a);
              return (
                <article key={story.story} className="card flex flex-col p-4">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <h3 className="font-medium">{story.story}</h3>
                    {lever ? <span className="badge badge-info shrink-0">{lever}</span> : null}
                  </div>
                  <p className="text-muted text-sm">{story.s}</p>
                  <p className="mt-2 text-sm">{rest}</p>
                  <p className="mt-2 border-t border-[var(--border)] pt-2 text-sm font-medium">
                    {story.r}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      ) : (
        <EmptyState
          title="No war stories yet"
          file="knowledge-base/star-stories.json"
          ask='Deep dives show the STAR theme whose name starts with "War Stories" (a failure, the lever, the verified fix). Ask Kairos to add one with save_star_story.'
        />
      )}

      {/* Depth layers behind headline stories */}
      {depths.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold">
            Depth layers
            <span className="text-muted ml-2 font-normal">
              approved follow-up material behind {depths.length} headline stories
            </span>
          </h2>
          <div className="space-y-3">
            {depths.map((d) => (
              <details key={d.title} className="card p-4">
                <summary className="cursor-pointer font-medium">{d.title}</summary>
                <ul className="text-muted mt-2 space-y-2 text-sm">
                  {d.layers.map((layer, i) => (
                    <li key={i} className="border-l-2 border-[var(--border)] pl-3">
                      {layer}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
