/**
 * Pure parser for knowledge-base/metrics-register.md. Lives in the engine so
 * the save-time checks (tools/checks.ts) and the dashboard read the register
 * the same way.
 */
export type MetricStatus = "DEFENDED" | "PARTIAL" | "OPEN" | "RETIRED" | "SCOPE";
export interface MetricEntry {
  name: string;
  status: MetricStatus;
  statusNote: string; // anything after the status word on the header line
  details: string[]; // the entry's bullet lines, markdown stripped of leading dashes
}
export interface MetricSection {
  section: string;
  entries: MetricEntry[];
}
export interface MetricsRegisterData {
  sections: MetricSection[];
  rules: string[];
  counts: Record<MetricStatus, number>;
  headerNote: string | null;
}

export const METRIC_STATUSES: MetricStatus[] = ["DEFENDED", "PARTIAL", "OPEN", "RETIRED", "SCOPE"];

/** Statuses that let a number appear in a generated document, unless profile.md says otherwise. */
export const DEFAULT_ALLOWED_METRIC_STATUSES: readonly MetricStatus[] = ["DEFENDED", "SCOPE"];

/** One register entry as the checks read it. */
export interface RegisterEntry {
  section: string;
  name: string;
  status: MetricStatus;
  /** Everything the entry says: its header line (name and what follows the status) and the bullets under it. */
  text: string;
}

/**
 * The entries whose header line states a status. An entry written with no
 * status word is shown as OPEN on the dashboard; the checks leave it alone,
 * because the user has not said anything about it.
 */
export function registerEntries(raw: string): RegisterEntry[] {
  const stated: { section: string; entry: MetricEntry }[] = [];
  walkRegister(raw, (section, entry, hasStatus) => {
    if (hasStatus) stated.push({ section, entry });
  });
  // Read after the walk: an entry's bullets are collected after its header.
  return stated.map(({ section, entry }) => ({
    section,
    name: entry.name,
    status: entry.status,
    text: [entry.name, entry.statusNote, ...entry.details].join("\n"),
  }));
}

export function parseMetricsRegister(raw: string): MetricsRegisterData {
  return walkRegister(raw, () => {});
}

function walkRegister(
  raw: string,
  onEntry: (section: string, entry: MetricEntry, statusStated: boolean) => void,
): MetricsRegisterData {
  const counts: Record<MetricStatus, number> = { DEFENDED: 0, PARTIAL: 0, OPEN: 0, RETIRED: 0, SCOPE: 0 };
  const sections: MetricSection[] = [];
  const rules: string[] = [];
  let headerNote: string | null = null;

  const headerMatch = raw.match(/^### Canonical[^\n]*/m);
  if (headerMatch) headerNote = headerMatch[0].replace(/^### /, "");

  let current: MetricSection | null = null;
  let currentEntry: MetricEntry | null = null;
  let inRules = false;

  for (const line of raw.split("\n")) {
    const section = line.match(/^## (.+)$/);
    if (section) {
      const title = section[1].trim();
      if (/^Operating rules/i.test(title)) {
        inRules = true;
        current = null;
        currentEntry = null;
        continue;
      }
      inRules = false;
      current = { section: title, entries: [] };
      sections.push(current);
      currentEntry = null;
      continue;
    }
    if (inRules) {
      const rule = line.match(/^\d+\.\s+(.*)$/);
      if (rule) rules.push(rule[1]);
      continue;
    }
    if (!current) continue;

    const entry = line.match(/^\*\*(.+?)\*\*\s*[—–:-]+\s*(.*)$/);
    if (entry) {
      const rest = entry[2].trim();
      const stated = METRIC_STATUSES.find((s) => rest.toUpperCase().startsWith(s));
      const status = stated ?? "OPEN";
      counts[status] += 1;
      currentEntry = {
        name: entry[1].trim(),
        status,
        statusNote: rest.slice(status.length).replace(/^[\s—–:-]+/, "").trim(),
        details: [],
      };
      current.entries.push(currentEntry);
      onEntry(current.section, currentEntry, Boolean(stated));
      continue;
    }
    const detail = line.match(/^- (.+)$/);
    if (detail && currentEntry) currentEntry.details.push(detail[1].trim());
  }

  return { sections, rules, counts, headerNote };
}
