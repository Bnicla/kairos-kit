import EmptyState from "@/components/EmptyState";
import Link from "next/link";
import { getStarStories, type StarStory, type StarStoryMetrics } from "../../lib/dashboard";
import PrintButton from "../../components/PrintButton";
import KbNav from "../../components/KbNav";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  anchored: { cls: "badge-success", label: "anchored" },
  partial: { cls: "badge-warn", label: "partial" },
  gap: { cls: "badge-danger", label: "gap" },
};

/** Right-hand column: how the problem was identified and how success was measured. */
function StoryMetrics({ m }: { m?: StarStoryMetrics }) {
  if (!m) return <span className="text-muted text-xs">not reviewed yet</span>;
  const badge = m.status ? STATUS_BADGE[m.status] : null;
  const list = (label: string, items?: string[]) =>
    items?.length ? (
      <div className="mt-1.5">
        <div className="text-muted text-[11px] font-medium uppercase tracking-wide">{label}</div>
        <ul className="mt-0.5 space-y-0.5 text-xs">
          {items.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <div>
      {badge && <span className={`badge ${badge.cls} text-[10px]`}>{badge.label}</span>}
      {list("Identified by", m.identify)}
      {list("Success measured by", m.success)}
      {m.gap && (
        <div className="mt-1.5 text-xs" style={{ color: "var(--warn-fg)" }}>
          To anchor: {m.gap}
        </div>
      )}
    </div>
  );
}

/** Escape, then render the glance markup: **bold** and the ≈ reconstruction marker. */
function glanceMarkup(text: string): { __html: string } {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    __html: esc
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/≈/g, '<span class="recon" title="Reconstructed detail: say roughly, never quote as exact">≈</span>'),
  };
}

/** One story as a glance card: example, step boxes (final one highlighted), line to say, notes. */
function GlanceStory({ story }: { story: StarStory }) {
  const g = story.glance;
  return (
    <article className="card glance-story">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{story.story}</h3>
        <Link href={`/kb?e=${encodeURIComponent(story.source)}`} className="text-accent text-xs hover:underline">
          {story.source.replace(/^\d+-|\.md$/g, "")}
        </Link>
      </div>
      {g ? (
        <>
          {g.example?.length ? (
            <div className="glance-ex">
              {g.example.map((x) => (
                <div key={x} dangerouslySetInnerHTML={glanceMarkup(x)} />
              ))}
            </div>
          ) : null}
          <div className="glance-steps">
            {g.steps.map((st) => (
              <div key={st.h} className={`glance-step${st.final ? " final" : ""}`}>
                <div className="gh">{st.h}</div>
                <div dangerouslySetInnerHTML={glanceMarkup(st.text)} />
              </div>
            ))}
          </div>
          {g.say ? <div className="glance-say" dangerouslySetInnerHTML={glanceMarkup(`"${g.say}"`)} /> : null}
          {g.notes?.length ? (
            <div className="glance-notes">
              {g.notes.map((n) => (
                <div key={n} dangerouslySetInnerHTML={glanceMarkup(n)} />
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-muted mt-1 text-sm">No glance version yet · {story.r}</p>
      )}
    </article>
  );
}

export default async function StoriesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const full = view === "full";
  const data = await getStarStories();

  if (!data) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <KbNav active="/stories" />
        <h1 className="text-xl font-semibold tracking-tight">STAR stories repository</h1>
        <EmptyState
          title="No STAR stories yet"
          file="knowledge-base/star-stories.json"
          ask="Ask Kairos to draft interview stories from your knowledge base; each one is saved with save_star_story."
        />
      </div>
    );
  }

  const behavioralThemes = data.themes.filter((t) => !t.theme.startsWith("War Stories"));
  const storyCount = behavioralThemes.reduce((n, t) => n + t.stories.length, 0);

  return (
    <div className="print-page mx-auto max-w-[1400px] px-6 py-8">
      <KbNav active="/stories" />
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">STAR stories repository</h1>
          <p className="text-muted text-sm">
            {full
              ? `${storyCount} stories across ${behavioralThemes.length} behavioral themes`
              : `${data.themes.reduce((n, t) => n + t.stories.length, 0)} stories across ${data.themes.length} themes, war stories included`}{" "}
            · every fact grounded in the knowledge base
            {data.updated_at ? ` · updated ${data.updated_at}` : ""}
            {full ? (
              <>
                {" "}· war stories live in{" "}
                <Link href="/deep-dives" className="text-accent hover:underline">
                  Deep dives
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex rounded-md border border-[var(--border)] text-sm">
            <Link href="/stories" className={`rounded-l-md px-2.5 py-1 ${full ? "text-muted" : "bg-[var(--border)] font-medium"}`}>
              Glance
            </Link>
            <Link href="/stories?view=full" className={`rounded-r-md px-2.5 py-1 ${full ? "bg-[var(--border)] font-medium" : "text-muted"}`}>
              Full table
            </Link>
          </div>
          <PrintButton />
        </div>
      </div>

      {!full ? (
        <div className="space-y-6">
          <p className="text-muted text-xs">
            Final box = the decision or fix that worked · <span className="recon">≈</span> = reconstructed detail, say
            &ldquo;roughly&rdquo;, never quote as exact
          </p>
          {data.themes.map((theme) => (
            <section key={theme.theme}>
              <h2 className="text-muted mb-2 text-xs font-semibold uppercase tracking-wider">
                {theme.theme} · {theme.stories.length}
              </h2>
              <div className="space-y-2">
                {theme.stories.map((story) => (
                  <GlanceStory key={story.story} story={story} />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
      <section className="card overflow-x-auto p-5">
        <table className="w-full min-w-[1100px] text-sm">
          <thead>
            <tr className="text-muted text-left text-xs">
              <th className="w-[10%] pb-2 pr-3 font-medium">Theme</th>
              <th className="w-[12%] pb-2 pr-3 font-medium">Story</th>
              <th className="w-[15%] pb-2 pr-3 font-medium">Situation</th>
              <th className="w-[13%] pb-2 pr-3 font-medium">Task</th>
              <th className="w-[18%] pb-2 pr-3 font-medium">Action</th>
              <th className="w-[15%] pb-2 pr-3 font-medium">Result</th>
              <th className="w-[17%] pb-2 font-medium">
                Metrics{" "}
                <Link href="/metrics" className="text-accent font-normal hover:underline">
                  (register)
                </Link>
              </th>
            </tr>
          </thead>
          <tbody>
            {behavioralThemes.map((theme) =>
              theme.stories.map((story, i) => (
                <tr
                  key={`${theme.theme}-${story.story}`}
                  className={`align-top ${i === 0 ? "border-t-2 border-[var(--border)]" : "border-t border-[var(--border)]"}`}
                >
                  {i === 0 ? (
                    <td className="py-2.5 pr-3" rowSpan={theme.stories.length}>
                      <div className="font-semibold">{theme.theme}</div>
                      <div className="text-muted mt-1 text-xs">
                        {theme.stories.length} {theme.stories.length === 1 ? "story" : "stories"}
                      </div>
                    </td>
                  ) : null}
                  <td className="py-2.5 pr-3">
                    <div className="font-medium">{story.story}</div>
                    <Link
                      href={`/kb?e=${encodeURIComponent(story.source)}`}
                      className="text-accent text-xs hover:underline"
                      title="Open the source experience in the knowledge base"
                    >
                      {story.source.replace(/^\d+-|\.md$/g, "")}
                    </Link>
                  </td>
                  <td className="text-muted py-2.5 pr-3">{story.s}</td>
                  <td className="text-muted py-2.5 pr-3">{story.t}</td>
                  <td className="py-2.5 pr-3">{story.a}</td>
                  <td className="py-2.5 pr-3 font-medium">{story.r}</td>
                  <td className="py-2.5">
                    <StoryMetrics m={story.metrics} />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </section>
      )}
    </div>
  );
}
