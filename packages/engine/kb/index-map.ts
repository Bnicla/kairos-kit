import type { Experience } from "@kairos/engine/kb/types";

/**
 * Derive `_index.md` (the skills/domain → experience routing map, §18.4) from the
 * frontmatter of all experience files. The index is DERIVED — regenerated from
 * frontmatter, never hand-maintained as a source of truth.
 */
export function buildIndexMap(experiences: Experience[]): string {
  const slug = (e: Experience) => e.fileName.replace(/\.md$/, "");

  const skillsMap = new Map<string, string[]>();
  const domainsMap = new Map<string, string[]>();
  const titleMap: string[] = [];

  for (const exp of experiences) {
    const id = slug(exp);
    for (const sk of exp.frontmatter.skills ?? []) {
      if (sk.prov === "?") continue;
      const arr = skillsMap.get(sk.name) ?? [];
      if (!arr.includes(id)) arr.push(id);
      skillsMap.set(sk.name, arr);
    }
    for (const d of exp.frontmatter.domains ?? []) {
      const arr = domainsMap.get(d) ?? [];
      if (!arr.includes(id)) arr.push(id);
      domainsMap.set(d, arr);
    }
    if (exp.frontmatter.title && exp.frontmatter.title_normalized) {
      titleMap.push(
        `${exp.frontmatter.title} → ${exp.frontmatter.title_normalized}`,
      );
    }
  }

  const section = (title: string, entries: [string, string[]][]) =>
    `## ${title}\n` +
    entries
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k} → [${v.join(", ")}]`)
      .join("\n");

  return [
    "<!-- DERIVED FILE — regenerated from experience frontmatter. Do not hand-edit. -->",
    "",
    section("Skills → Experiences", [...skillsMap.entries()]),
    "",
    section("Domains → Experiences", [...domainsMap.entries()]),
    "",
    "## Title-normalization map",
    [...new Set(titleMap)].join("\n"),
    "",
  ].join("\n");
}
