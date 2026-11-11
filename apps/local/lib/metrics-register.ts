/** Pure parser for knowledge-base/metrics-register.md. Extracted for tests. */
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

const METRIC_STATUSES: MetricStatus[] = ["DEFENDED", "PARTIAL", "OPEN", "RETIRED", "SCOPE"];

export function parseMetricsRegister(raw: string): MetricsRegisterData {
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
      const status = METRIC_STATUSES.find((s) => rest.toUpperCase().startsWith(s)) ?? "OPEN";
      counts[status] += 1;
      currentEntry = {
        name: entry[1].trim(),
        status,
        statusNote: rest.slice(status.length).replace(/^[\s—–:-]+/, "").trim(),
        details: [],
      };
      current.entries.push(currentEntry);
      continue;
    }
    const detail = line.match(/^- (.+)$/);
    if (detail && currentEntry) currentEntry.details.push(detail[1].trim());
  }

  return { sections, rules, counts, headerNote };
}
