import type { Funnel, FunnelNode, FunnelNodeKind } from "@kairos/engine/funnel";

/**
 * Server-rendered Sankey for the application funnel. Hand-laid-out rather than
 * auto-laid-out, because the shape is known and an automatic layout stacked
 * the small interview outcomes on top of each other:
 *   - the interview chain runs flat along the top, left to right;
 *   - interview outcomes sit in their own right-hand column, spaced so their
 *     two-line labels never touch;
 *   - the big no-interview buckets sit below the first interview stage, with
 *     nothing flowing past their labels.
 */

const COLOR: Record<FunnelNodeKind, string> = {
  applications: "#8d8c85",
  rejected: "#d9534f",
  "no-response": "#9a9a94",
  waiting: "#4a8fd8",
  closed: "#c2bfb5",
  interview: "#2f9e6e",
  offer: "#1f8a5b",
  "no-offer": "#d9703a",
  "in-progress": "#4a8fd8",
  "on-hold": "#c08a2b",
  withdrew: "#b0ada3",
};

const BUCKET_ORDER: FunnelNodeKind[] = ["rejected", "no-response", "waiting", "closed"];
const OUTCOME_ORDER: FunnelNodeKind[] = ["offer", "in-progress", "on-hold", "withdrew", "no-offer"];

const W = 1010;
const BAR = 10;
const X_APPS = 150;
const X_STAGE1 = 310;
const X_OUT = 790;
const TOP = 58;

interface Box {
  node: FunnelNode;
  x: number;
  y: number;
  h: number;
  /** Running offsets for stacking ribbons on each side. */
  out: number;
  inn: number;
}

function ribbon(x0: number, y0: number, x1: number, y1: number, h: number): string {
  const mx = (x0 + x1) / 2;
  return `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1} L${x1},${y1 + h} C${mx},${y1 + h} ${mx},${y0 + h} ${x0},${y0 + h} Z`;
}

export default function FunnelSankey({ funnel }: { funnel: Funnel }) {
  const byId = new Map(funnel.nodes.map((n) => [n.id, n]));
  const apps = byId.get("applications");
  if (!apps || apps.value === 0) return null;

  const k = Math.min(4, 380 / apps.value);
  const size = (v: number) => Math.max(3, v * k);
  const stages = funnel.nodes.filter((n) => n.kind === "interview").sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const buckets = BUCKET_ORDER.map((kind) => funnel.nodes.find((n) => n.kind === kind)).filter((n): n is FunnelNode => !!n);
  const outcomes = OUTCOME_ORDER.map((kind) => funnel.nodes.find((n) => n.kind === kind)).filter((n): n is FunnelNode => !!n);

  const boxes = new Map<string, Box>();
  const place = (node: FunnelNode, x: number, y: number) => {
    const b: Box = { node, x, y, h: size(node.value), out: 0, inn: 0 };
    boxes.set(node.id, b);
    return b;
  };

  place(apps, X_APPS, TOP);
  const stageGap = stages.length > 1 ? (X_OUT - X_STAGE1) / stages.length : 0;
  stages.forEach((s, i) => place(s, X_STAGE1 + i * stageGap, TOP));

  // Outcomes: spaced by label height, not by value, so small nodes stay legible.
  let y = TOP;
  for (const o of outcomes) {
    const b = place(o, X_OUT, y);
    y += Math.max(b.h, 32) + 14;
  }
  const outcomesBottom = y;

  const firstStageH = stages[0] ? size(stages[0].value) : 0;
  y = TOP + firstStageH + (stages.length ? 64 : 0);
  for (const bk of buckets) {
    const b = place(bk, X_STAGE1, y);
    y += b.h + 18;
  }
  const H = Math.max(y, outcomesBottom, TOP + size(apps.value)) + 16;

  // Ribbons leave each node top-to-bottom in a fixed order: the next interview
  // stage first (keeps the chain flat), then outcomes in column order, then
  // buckets. They enter outcome nodes latest-stage first.
  const rank = (id: string) => {
    const n = byId.get(id)!;
    if (n.kind === "interview") return 0;
    const o = OUTCOME_ORDER.indexOf(n.kind);
    return o >= 0 ? 1 + o : 10 + BUCKET_ORDER.indexOf(n.kind);
  };
  const stageIndex = (id: string) => stages.findIndex((s) => s.id === id);
  const links = [...funnel.links].sort(
    (a, b) => stageIndex(b.source) - stageIndex(a.source) || rank(a.target) - rank(b.target),
  );
  const outOrder = [...funnel.links].sort((a, b) => rank(a.target) - rank(b.target));
  const outOffset = new Map<string, number>();
  for (const l of outOrder) {
    const s = boxes.get(l.source)!;
    outOffset.set(`${l.source}>${l.target}`, s.out);
    s.out += size(l.value) * (s.h / Math.max(s.h, sumOut(funnel, l.source, size)));
  }

  const paths = links.map((l) => {
    const s = boxes.get(l.source)!;
    const t = boxes.get(l.target)!;
    const scale = s.h / Math.max(s.h, sumOut(funnel, l.source, size));
    const h = Math.max(1.5, size(l.value) * scale);
    const y0 = s.y + (outOffset.get(`${l.source}>${l.target}`) ?? 0);
    const y1 = t.y + t.inn;
    t.inn += Math.min(h, t.h);
    const target = t.node;
    const title = `${s.node.label} → ${target.label}: ${l.value}${target.companies?.length ? ` (${target.companies.join(", ")})` : ""}`;
    return { d: ribbon(s.x + BAR, y0, t.x, y1, h), color: COLOR[target.kind], title, key: `${l.source}>${l.target}` };
  });

  const label = (b: Box) => {
    const n = b.node;
    if (n.kind === "applications") {
      return (
        <g key={n.id} transform={`translate(${b.x - 12}, ${b.y + b.h / 2})`} textAnchor="end">
          <text className="fs-num" dy="-0.15em">{n.value}</text>
          <text className="fs-lab" dy="1.25em">{n.label}</text>
        </g>
      );
    }
    if (n.kind === "interview") {
      return (
        <g key={n.id} transform={`translate(${b.x}, ${b.y})`}>
          <text className="fs-num-sm" y={-27}>{n.value}</text>
          <text className="fs-lab" y={-10}>{n.label}</text>
        </g>
      );
    }
    return (
      <g key={n.id} transform={`translate(${b.x + BAR + 10}, ${b.y + Math.min(b.h, 32) / 2})`}>
        <text className="fs-num" dy="-0.1em">{n.value}</text>
        <text className="fs-lab" dy="1.2em">{n.label}</text>
        {n.companies?.length ? <title>{n.companies.join(", ")}</title> : null}
      </g>
    );
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Application funnel: ${funnel.total} applications, ${funnel.interviewed} reached an interview`}>
      <style>{`
        .fs-num { font-size: 22px; font-weight: 600; fill: var(--foreground); font-variant-numeric: tabular-nums; }
        .fs-num-sm { font-size: 16px; font-weight: 600; fill: var(--foreground); font-variant-numeric: tabular-nums; }
        .fs-lab { font-size: 12.5px; fill: var(--muted); }
        .fs-rib { opacity: 0.38; transition: opacity 0.15s; }
        .fs-rib:hover { opacity: 0.7; }
      `}</style>
      <g>
        {paths.map((p) => (
          <path key={p.key} className="fs-rib" d={p.d} fill={p.color}>
            <title>{p.title}</title>
          </path>
        ))}
      </g>
      <g>
        {[...boxes.values()].map((b) => (
          <rect key={b.node.id} x={b.x} y={b.y} width={BAR} height={b.h} rx={2} fill={COLOR[b.node.kind]} />
        ))}
      </g>
      <g>{[...boxes.values()].map(label)}</g>
    </svg>
  );
}

/** Total drawn height of a node's outgoing ribbons (min sizes can exceed the node). */
function sumOut(funnel: Funnel, id: string, size: (v: number) => number): number {
  return funnel.links.filter((l) => l.source === id).reduce((a, l) => a + size(l.value), 0);
}
