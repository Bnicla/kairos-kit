import Link from "next/link";
import { getKnowledgeBase, type KBDepth } from "@/lib/dashboard";
import KbNav from "../../components/KbNav";

export const dynamic = "force-dynamic";

const DEPTH_META: Record<KBDepth, { label: string; tone: string; dot: string }> = {
  "résumé-only": { label: "Résumé-only", tone: "badge-warn", dot: "var(--warn-fg)" },
  developing: { label: "Developing", tone: "badge-info", dot: "var(--info-fg)" },
  rich: { label: "Rich", tone: "badge-success", dot: "var(--success-fg)" },
};

type Item =
  | { key: string; group: string; label: string; sub: string; kind: "exp"; depth: KBDepth }
  | { key: string; group: string; label: string; sub: string; kind: "edu" }
  | { key: string; group: string; label: string; sub: string; kind: "voice" };

export default async function KBPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { e } = await searchParams;
  const kb = await getKnowledgeBase();

  const items: Item[] = [
    ...kb.experiences.map((x): Item => ({ key: x.fileName, group: "Experience", label: x.company, sub: x.title, kind: "exp", depth: x.depth })),
    ...kb.education.map((x): Item => ({ key: x.fileName, group: "Education", label: x.institution, sub: x.credential, kind: "edu" })),
    { key: "__voice", group: "Style", label: "Voice profile", sub: "learned writing style", kind: "voice" },
  ];
  const selectedKey = e && items.some((i) => i.key === e) ? e : items[0]?.key;

  let groupLast = "";

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <KbNav active="/kb" />
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Knowledge base</h1>
          <p className="text-muted text-sm">
            {kb.experiences.length} experiences · every fact comes from you (documents, answers, notes) and keeps its source
          </p>
        </div>
        <div className="text-muted flex items-center gap-3 text-xs">
          <span><sup className="prov prov-R">[R]</sup> résumé</span>
          <span><sup className="prov prov-C">[C]</sup> confirmed</span>
          <span><sup className="prov prov-F">[F]</sup> feedback</span>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        {/* Tabs */}
        <nav className="space-y-1">
          {items.map((it) => {
            const header = it.group !== groupLast ? ((groupLast = it.group), it.group) : null;
            const active = it.key === selectedKey;
            return (
              <div key={it.key}>
                {header && (
                  <div className="text-muted mt-3 mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider first:mt-0">
                    {header}
                  </div>
                )}
                <Link
                  href={`/kb?e=${encodeURIComponent(it.key)}`}
                  className={`block rounded-lg border px-3 py-2 transition-colors ${
                    active
                      ? "border-[var(--accent)] bg-[var(--surface)]"
                      : "border-transparent hover:bg-[var(--surface)]"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {it.kind === "exp" && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: DEPTH_META[it.depth].dot }}
                        title={DEPTH_META[it.depth].label}
                      />
                    )}
                    <div className="truncate text-sm font-medium">{it.label}</div>
                  </div>
                  <div className="text-muted truncate text-xs">{it.sub}</div>
                </Link>
              </div>
            );
          })}
        </nav>

        {/* Detail */}
        <div className="min-w-0">
          <Detail kb={kb} selectedKey={selectedKey} />
        </div>
      </div>
    </div>
  );
}

function Detail({ kb, selectedKey }: { kb: Awaited<ReturnType<typeof getKnowledgeBase>>; selectedKey?: string }) {
  if (selectedKey === "__voice") {
    return (
      <section className="card p-6">
        <h2 className="font-semibold">Voice profile</h2>
        <p className="text-muted mt-1 text-sm">Learned from your résumé and edits. Style is learned; facts never are.</p>
        <div className="kb-body text-muted mt-4 text-sm" dangerouslySetInnerHTML={{ __html: kb.voiceProfileHtml ?? "<p>None yet.</p>" }} />
      </section>
    );
  }

  const edu = kb.education.find((x) => x.fileName === selectedKey);
  if (edu) {
    return (
      <section className="card p-6">
        <h2 className="text-lg font-semibold">{edu.institution}</h2>
        <p className="text-muted mt-0.5 text-sm">
          {edu.credential}
          {edu.dates ? ` · ${edu.dates}` : ""}
        </p>
        <div className="kb-body mt-4 text-sm" dangerouslySetInnerHTML={{ __html: edu.bodyHtml }} />
      </section>
    );
  }

  const exp = kb.experiences.find((x) => x.fileName === selectedKey);
  if (!exp) return <div className="card text-muted p-6 text-sm">Select an item.</div>;

  return (
    <section className="card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{exp.title}</h2>
        <span className="text-muted text-sm">{exp.dates}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-2">
        <p className="text-muted text-sm">
          {exp.company}
          {exp.location ? ` · ${exp.location}` : ""}
          {exp.seniority ? ` · ${exp.seniority}` : ""}
        </p>
        <span className={`badge ${DEPTH_META[exp.depth].tone} text-[10px]`}>
          {DEPTH_META[exp.depth].label}
          {exp.confirmedCount > 0 ? ` · ${exp.confirmedCount} confirmed` : ""}
        </span>
      </div>

      {exp.depth !== "rich" && (
        <div className="note note-info mt-3 text-xs">
          This role is mostly your résumé. Deepen it: in Claude Code, run <code>/kairos</code> and say{" "}
          <b>&ldquo;go deeper on {exp.company}&rdquo;</b>. Kairos interviews you for context, decisions, and stories,
          and stores your answers as <sup className="prov prov-C">[C]</sup>, richer material to tailor from, without
          fabrication.
        </div>
      )}

      {exp.domains.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {exp.domains.map((d) => (
            <span key={d} className="badge badge-neutral">
              {d}
            </span>
          ))}
        </div>
      )}

      {exp.scope.length > 0 && (
        <div className="mt-4">
          <div className="text-muted mb-1 text-[10px] font-semibold uppercase tracking-wider">Scope</div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {exp.scope.map((s) => (
              <div key={s.key} className="bg-surface-2 flex items-center justify-between rounded-lg px-3 py-1.5 text-sm">
                <span className="text-muted capitalize">{s.key.replace(/_/g, " ")}</span>
                <span className="font-medium">
                  {s.value} <sup className={`prov prov-${s.prov}`}>[{s.prov}]</sup>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {exp.skills.length > 0 && (
        <div className="mt-4">
          <div className="text-muted mb-1 text-[10px] font-semibold uppercase tracking-wider">Skills</div>
          <div className="flex flex-wrap gap-1.5">
            {exp.skills.map((s) => (
              <span key={s.name} className="badge badge-neutral" title={`${s.proficiency} · ${s.recency}`}>
                {s.name} <sup className={`prov prov-${s.prov}`}>[{s.prov}]</sup>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="kb-body mt-5 border-t border-[var(--border)] pt-4 text-sm" dangerouslySetInnerHTML={{ __html: exp.bodyHtml }} />
    </section>
  );
}
