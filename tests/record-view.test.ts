import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "@/store/local-fs";
import {
  DEPTH_LABEL,
  GAP_TIER_TONE,
  GAP_WINDOWS,
  HEALTH_GROUPS,
  HEALTH_STATUS_TONE,
  PROVENANCE_LEGEND,
  METRIC_STATUS_META,
  METRIC_STATUS_ORDER,
  RECON_NOTE,
  RECORD_BODY_MAX,
  STORY_STATUS,
  bodyBlocks,
  glanceParts,
  healthScoreTone,
  isWarStoriesTheme,
  loadRecordView,
  recordDepth,
  storySourceLabel,
} from "@kairos/engine/record-view";

/**
 * The knowledge base as a view shows it (packages/engine/record-view.ts): shared by the
 * local dashboard's record page and the connector's. All data is fictional.
 */
describe("the knowledge base as a view shows it", () => {
  it("a role's depth is the count of facts confirmed in conversation, by the rule the dashboard has always used", () => {
    // The dashboard's rule as it was written in apps/local/lib/dashboard.ts before it called the engine.
    const earlier = (body: string) => {
      const confirmedCount = (body.match(/\[C\]/g) ?? []).length;
      return { confirmedCount, depth: confirmedCount === 0 ? "résumé-only" : confirmedCount < 4 ? "developing" : "rich" };
    };
    const fact = (tag: string) => `- Built a dashboard the ops team uses daily. [${tag}]\n`;
    for (const body of ["", fact("R").repeat(6), fact("C"), fact("R") + fact("C").repeat(3), fact("C").repeat(4), fact("C").repeat(9) + fact("F"), "No tags at all [c] [CC]"]) expect(recordDepth(body), body.slice(0, 40)).toEqual(earlier(body));
    expect(recordDepth(fact("C").repeat(3))).toEqual({ confirmedCount: 3, depth: "developing" });
    expect(recordDepth(fact("C").repeat(4))).toEqual({ confirmedCount: 4, depth: "rich" });
  });

  it("the names of the three depths and of the three tags are the ones the dashboard's page writes", () => {
    const page = readFileSync(path.join("apps", "local", "app", "kb", "page.tsx"), "utf8");
    for (const { label } of Object.values(DEPTH_LABEL)) expect(page, label).toContain(`label: "${label}"`);
    for (const { tag, meaning } of PROVENANCE_LEGEND) expect(page.replace(/\s+/g, " "), tag).toMatch(new RegExp(`\\[${tag}\\]</sup> ${meaning}`));
    expect(Object.keys(DEPTH_LABEL)).toEqual(["résumé-only", "developing", "rich"]);
  });

  it("the health view's groups, status colours and score thresholds are the ones the dashboard's health page writes", () => {
    const page = readFileSync(path.join("apps", "local", "app", "health", "page.tsx"), "utf8");
    expect(page).toContain(`["${HEALTH_GROUPS.join('", "')}"]`);
    expect(page).toContain('{ strong: "badge-success", ok: "badge-warn", weak: "badge-danger" }');
    expect(HEALTH_STATUS_TONE).toEqual({ strong: "success", ok: "warn", weak: "danger" });
    expect(page).toContain('overall >= 85 ? "var(--success-fg)" : overall >= 60 ? "var(--warn-fg)" : "var(--danger-fg)"');
    expect([100, 85, 84, 60, 59, 0].map(healthScoreTone)).toEqual(["success", "success", "warn", "warn", "danger", "danger"]);
  });

  it("the gaps view's tier colours and windows are the ones the dashboard's gaps page writes", () => {
    const page = readFileSync(path.join("apps", "local", "app", "gaps", "page.tsx"), "utf8");
    for (const [tier, tone] of Object.entries(GAP_TIER_TONE)) expect(page, tier).toContain(`${tier}: "badge badge-${tone}"`);
    expect(page).toContain(`const WINDOWS = [${GAP_WINDOWS.join(", ")}] as const;`);
  });

  it("reads an entry's body as headings, list items and paragraphs of text, with each tag apart", () => {
    const body = [
      "## Summary",
      "Summer internship on the **internal tools** team. [R]",
      "",
      "## Achievements",
      "- Built a dashboard the ops team uses daily. [R]",
      "- Ran the reconciliation job nightly;",
      "  finance stopped its manual checks. [C]",
      "* Recruiter said the dashboard story was the strongest. [F]",
      "1. Negotiated the vendor contract. [?]",
      "",
      "A closing paragraph with `code` and *emphasis*,",
      "on two lines.",
      "<script>alert(1)</script>",
    ].join("\n");
    const { blocks, cut } = bodyBlocks(body);
    expect(cut).toBe(false);
    expect(blocks).toEqual([
      { kind: "heading", parts: [{ text: "Summary" }] },
      { kind: "text", parts: [{ text: "Summer internship on the internal tools team. " }, { text: "[R]", tag: "R" }] },
      { kind: "heading", parts: [{ text: "Achievements" }] },
      { kind: "item", parts: [{ text: "Built a dashboard the ops team uses daily. " }, { text: "[R]", tag: "R" }] },
      { kind: "item", parts: [{ text: "Ran the reconciliation job nightly; finance stopped its manual checks. " }, { text: "[C]", tag: "C" }] },
      { kind: "item", parts: [{ text: "Recruiter said the dashboard story was the strongest. " }, { text: "[F]", tag: "F" }] },
      { kind: "item", parts: [{ text: "Negotiated the vendor contract. " }, { text: "[?]", tag: "?" }] },
      // Markup in the text stays text: the page writes it as characters, never as HTML.
      { kind: "text", parts: [{ text: "A closing paragraph with code and emphasis, on two lines. <script>alert(1)</script>" }] },
    ]);
    // A body longer than the limit is cut at a line's end, and the view is told.
    const long = bodyBlocks(`${"- A fact of ordinary length about the work. [R]\n".repeat(400)}`);
    expect(long.cut).toBe(true);
    expect(long.blocks.length).toBeGreaterThan(100);
    expect(long.blocks.reduce((n, b) => n + b.parts.reduce((m, p) => m + p.text.length, 0), 0)).toBeLessThanOrEqual(RECORD_BODY_MAX);
    expect(bodyBlocks("")).toEqual({ blocks: [], cut: false });
  });

  it("loads the roles in the knowledge base's order, the education entries and how the user writes", async () => {
    const store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-record-view-")));
    // The demo folder is kit/demo in the source repository and demo in the exported Kit.
    await store.writeFile(["knowledge-base", "experiences", "01-fintech-intern.md"], readFileSync(path.join(existsSync("kit/demo") ? "kit/demo" : "demo", "knowledge-base", "experiences", "01-fintech-intern.md"), "utf8"));
    await store.writeFile(
      ["knowledge-base", "experiences", "02-capstone.md"],
      "---\nid: capstone\ncompany: State University\ntitle: Capstone Project Lead\nstart: '2025'\nend: present\nlocation: Springfield\nscope:\n  team_size: { value: 4, prov: R }\n---\n\n## Achievements\n- Led a team of 4. [R]\n- Chose Flutter after a two-week trial. [C]\n- An untagged line.\n",
    );
    await store.writeFile(["knowledge-base", "education", "state-university.md"], "---\ninstitution: State University\ncredential: B.S. Computer Science\ndates: expected May 2027\n---\n\n- GPA 3.6. [R]\n");
    const empty = await loadRecordView(new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-record-empty-"))));
    expect(empty).toEqual({ experiences: [], education: [], voice: null });

    const view = await loadRecordView(store);
    expect(view.voice).toBeNull();
    expect(view.experiences.map((e) => [e.key, e.company, e.title, e.dates, e.depth, e.confirmedCount, e.facts])).toEqual([
      ["01-fintech-intern.md", "Ledgerly", "Software Engineering Intern", "2025 – 2025", "résumé-only", 0, 4],
      ["02-capstone.md", "State University", "Capstone Project Lead", "2025 – present", "developing", 1, 3],
    ]);
    expect(view.experiences[0]).toMatchObject({ seniority: "IC", domains: ["Fintech", "Internal Tools"], skills: [{ name: "React", prov: "R" }, { name: "Python", prov: "R" }], cut: false });
    expect(view.experiences[1]).toMatchObject({ location: "Springfield", scope: [{ key: "team_size", value: "4", prov: "R" }] });
    expect(view.education).toEqual([{ key: "state-university.md", institution: "State University", credential: "B.S. Computer Science", dates: "expected May 2027", body: [{ kind: "item", parts: [{ text: "GPA 3.6. " }, { text: "[R]", tag: "R" }] }], cut: false }]);

    await store.writeFile(["knowledge-base", "_voice-profile.md"], "## Register\nPlain and short.\n");
    expect((await loadRecordView(store)).voice).toEqual({ body: [{ kind: "heading", parts: [{ text: "Register" }] }, { kind: "text", parts: [{ text: "Plain and short." }] }], cut: false });
  });

  it("the stories: the badges, the themes left to the deep dives, the source's name and the two marks of a one-glance line are the dashboard page's", () => {
    const page = readFileSync(path.join("apps", "local", "app", "stories", "page.tsx"), "utf8");
    const cls = { success: "badge-success", warn: "badge-warn", danger: "badge-danger" };
    for (const [status, { label, tone }] of Object.entries(STORY_STATUS)) expect(page, status).toContain(`${status}: { cls: "${cls[tone]}", label: "${label}" }`);
    expect(page).toContain('!t.theme.startsWith("War Stories")');
    expect(isWarStoriesTheme("War Stories: retrieval")).toBe(true);
    expect(isWarStoriesTheme("Ownership")).toBe(false);
    expect(page).toContain('story.source.replace(/^\\d+-|\\.md$/g, "")');
    expect(storySourceLabel("01-fintech-intern.md")).toBe("fintech-intern");
    expect(page.replace(/\s+/g, " ")).toContain("reconstructed detail, say &ldquo;roughly&rdquo;, never quote as exact");
    expect(RECON_NOTE).toBe('≈ = reconstructed detail, say "roughly", never quote as exact');
    // The page marks **bold** and ≈ and nothing else; here the same two, as parts, and markup stays text.
    expect(glanceParts("A late item showed up **the same morning**, after ≈ two weeks.")).toEqual([
      { text: "A late item showed up " },
      { text: "the same morning", bold: true },
      { text: ", after " },
      { text: "≈", recon: true },
      { text: " two weeks." },
    ]);
    expect(glanceParts("**≈ 40** users <b>x</b> *one star* **")).toEqual([{ text: "≈", recon: true }, { text: " 40", bold: true }, { text: " users <b>x</b> *one star* **" }]);
    expect(glanceParts("")).toEqual([]);
  });

  it("the numbers: the five statuses, their order, colour and meaning are the dashboard register page's", () => {
    const page = readFileSync(path.join("apps", "local", "app", "metrics", "full", "page.tsx"), "utf8");
    const cls = { success: "badge-success", info: "badge-info", warn: "badge-warn", danger: "badge-danger", neutral: "badge-neutral" };
    for (const [status, { tone, hint }] of Object.entries(METRIC_STATUS_META)) expect(page, status).toContain(`${status}: { badge: "${cls[tone]}", hint: "${hint}" }`);
    expect(page).toContain(`const STATUS_ORDER: MetricStatus[] = [${METRIC_STATUS_ORDER.map((x) => `"${x}"`).join(", ")}];`);
  });
});
