import type { ApplicationMeta } from "@kairos/engine/applications";

/**
 * Application funnel: where every submitted application ended up, as nodes
 * and flows for a Sankey chart. Pure function over the application metas, so
 * the dashboard page recomputes it on every load.
 *
 * Interview depth comes from `meta.interview_round` (highest round reached:
 * 1 recruiter screen, 2 hiring manager interview, 3 on-site).
 * Status history cannot give it: one "interviewing" entry may cover two rounds
 * and three entries may all be the same recruiter screen. An interviewed
 * application without the field counts as round 1.
 */

export type FunnelNodeKind =
  | "applications"
  | "rejected"
  | "no-response"
  | "waiting"
  | "closed"
  | "interview"
  | "offer"
  | "no-offer"
  | "in-progress"
  | "on-hold"
  | "withdrew";

export interface FunnelNode {
  id: string;
  label: string;
  kind: FunnelNodeKind;
  value: number;
  /** Companies behind the node, for hover text (interview-side nodes only). */
  companies?: string[];
}

export interface FunnelLink {
  source: string;
  target: string;
  value: number;
}

export interface Funnel {
  total: number;
  interviewed: number;
  nodes: FunnelNode[];
  links: FunnelLink[];
  firstAppliedAt: string | null;
}

/** Days of silence after which a pending application counts as "no response". */
export const NO_RESPONSE_DAYS = 30;

/** Interview rounds are named after these usual stages; later rounds are "Round N" (2026-10-11). */
const STAGE_NAMES = ["Recruiter screen", "Hiring manager interview", "On-site"];
export const stageName = (round: number) => STAGE_NAMES[round - 1] ?? `Round ${round}`;

/** When it was submitted; null if it never was. Old cards carry an "applied"
 *  history entry with no timestamp, so fall back to the capture date. */
const appliedAt = (m: ApplicationMeta): string | null => {
  if (m.applied_at) return m.applied_at;
  const entry = m.status_history?.find((h) => h.status === "applied");
  return entry ? (entry.at ?? m.captured_at) : null;
};

const everInterviewed = (m: ApplicationMeta) =>
  m.status === "interviewing" ||
  m.status === "offer" ||
  (m.interview_round ?? 0) > 0 ||
  (m.status_history ?? []).some((h) => h.status === "interviewing" || h.status === "offer");

export interface DailyApplications {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  count: number;
  companies: string[];
}

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Applications submitted per calendar day (local time), from the first one to
 * `now`, with empty days included so gaps show. Same counting rule as the
 * funnel: applied date, else the capture date of an interviewed card.
 */
export function buildDaily(metas: ApplicationMeta[], now: Date = new Date()): DailyApplications[] {
  const byDay = new Map<string, DailyApplications>();
  let first: Date | null = null;
  for (const m of metas) {
    const at = appliedAt(m) ?? (everInterviewed(m) ? m.captured_at : null);
    if (!at) continue;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) continue;
    if (!first || d < first) first = d;
    const key = dayKey(d);
    const day = byDay.get(key) ?? { date: key, count: 0, companies: [] };
    day.count += 1;
    day.companies.push(m.company);
    byDay.set(key, day);
  }
  if (!first) return [];
  const out: DailyApplications[] = [];
  const cursor = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  while (cursor <= end) {
    const key = dayKey(cursor);
    out.push(byDay.get(key) ?? { date: key, count: 0, companies: [] });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export function buildFunnel(metas: ApplicationMeta[], now: Date = new Date()): Funnel {
  const nodes = new Map<string, FunnelNode>();
  const links = new Map<string, FunnelLink>();
  const node = (id: string, label: string, kind: FunnelNodeKind) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, kind, value: 0 });
    return nodes.get(id)!;
  };
  const flow = (from: FunnelNode, to: FunnelNode, company?: string) => {
    const key = `${from.id}>${to.id}`;
    const l = links.get(key) ?? { source: from.id, target: to.id, value: 0 };
    l.value += 1;
    links.set(key, l);
    to.value += 1;
    if (company && to.kind !== "interview") (to.companies ??= []).push(company);
  };

  const apps = node("applications", "Applications", "applications");
  let interviewed = 0;
  let first: string | null = null;

  for (const m of metas) {
    // An interviewed application counts even when it was never marked applied
    // (one came in through a referral, one with the candidate's own documents; both
    // were missing from the first version of this chart).
    const at = appliedAt(m) ?? (everInterviewed(m) ? m.captured_at : null);
    if (!at) continue; // never submitted: not part of the funnel
    apps.value += 1;
    if (!first || at < first) first = at;

    if (!everInterviewed(m)) {
      if (m.status === "rejected") flow(apps, node("rejected", "Rejected or refused, no interview", "rejected"));
      else if (m.status === "withdrawn" || m.status === "expired")
        flow(apps, node("closed", "Posting closed or withdrawn", "closed"));
      else if ((now.getTime() - Date.parse(at)) / 86_400_000 > NO_RESPONSE_DAYS)
        flow(apps, node("no-response", `No response (${NO_RESPONSE_DAYS}+ days)`, "no-response"));
      else flow(apps, node("waiting", `Waiting (under ${NO_RESPONSE_DAYS} days)`, "waiting"));
      continue;
    }

    interviewed += 1;
    const rounds = Math.max(1, Math.floor(m.interview_round ?? 1));
    let prev = apps;
    for (let r = 1; r <= rounds; r++) {
      const stage = node(`interview-${r}`, stageName(r), "interview");
      flow(prev, stage);
      prev = stage;
    }
    const outcome =
      m.status === "offer"
        ? node("offer", "Offer", "offer")
        : m.status === "rejected"
          ? node("no-offer", "Rejected or refused", "no-offer")
          : m.status === "on_hold"
            ? node("on-hold", "On hold", "on-hold")
            : m.status === "withdrawn" || m.status === "expired"
              ? node("withdrew", "Withdrew or closed", "withdrew")
              : node("in-progress", "Still in progress", "in-progress");
    flow(prev, outcome, m.company);
  }

  return { total: apps.value, interviewed, nodes: [...nodes.values()], links: [...links.values()], firstAppliedAt: first };
}
