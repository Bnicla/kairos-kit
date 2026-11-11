import { describe, expect, it } from "vitest";
import {
  readProfileSettings,
  compileBannedPatterns,
  maxSourcedCards,
  dailyRun,
  DEFAULT_MAX_SOURCED_CARDS,
  DEFAULT_DAILY_RUN_TIME,
  DEFAULT_STORIES_MAP,
  storiesMapPath,
} from "@kairos/engine/settings";
import { checkProse } from "@kairos/engine/tools/prose-checks";
import { topSourced } from "@kairos/engine/sourcing/backlog";
import { planDreamWatch, fetchDreamCompany, dreamQueries } from "@kairos/engine/sourcing/dream-watch";
import { describeSearchProfile, deriveSearchProfile } from "@kairos/engine/sourcing/search-profile";
import { autofillIdentity } from "@/lib/autofill";
import { writeWritingSamples, upsertStarStory, upsertMetricEntry } from "@/lib/kb-files";
import { parseMetricsRegister } from "@/lib/metrics-register";

const profileMd = (fm: string) => `---\n${fm}\n---\n# Candidate profile\n`;

describe("profile.md settings", () => {
  it("absent file or fields give empty settings", () => {
    expect(readProfileSettings(null)).toEqual({});
    expect(readProfileSettings(profileMd("name: Jane Doe"))).toEqual({});
    expect(readProfileSettings("not frontmatter at all")).toEqual({});
  });

  it("reads standing_base_app, aliases, page target, page-2 anchor and voice", () => {
    const s = readProfileSettings(
      profileMd(
        [
          "standing_base_app: 2026-01-01_standing_generic",
          "resume_leadin_aliases:",
          "  Old Name: New Name",
          "target_pages: 2",
          "resume_page2_anchor: Product Manager, Search",
          "voice:",
          "  banned_patterns: [synergy, '/deep dive/']",
          "  replace_default_patterns: true",
        ].join("\n"),
      ),
    );
    expect(s).toEqual({
      standing_base_app: "2026-01-01_standing_generic",
      resume_leadin_aliases: { "Old Name": "New Name" },
      target_pages: 2,
      resume_page2_anchor: "Product Manager, Search",
      voice: { banned_patterns: ["synergy", "/deep dive/"], replace_default_patterns: true },
    });
  });

  it("ignores an invalid page target", () => {
    expect(readProfileSettings(profileMd("target_pages: 3")).target_pages).toBeUndefined();
  });

  it("stories_map: default path, a data-folder path, and no escape from the data folder", () => {
    expect(DEFAULT_STORIES_MAP).toBe("knowledge-base/stories-map.json");
    expect(storiesMapPath(readProfileSettings(null))).toEqual(["knowledge-base", "stories-map.json"]);
    const s = readProfileSettings(profileMd("stories_map: notes/stories.json"));
    expect(s.stories_map).toBe("notes/stories.json");
    expect(storiesMapPath(s)).toEqual(["notes", "stories.json"]);
    expect(storiesMapPath({ stories_map: "/etc/passwd" })).toEqual(["knowledge-base", "stories-map.json"]);
    expect(storiesMapPath({ stories_map: "../x.json" })).toEqual(["knowledge-base", "stories-map.json"]);
  });
});

describe("voice.banned_patterns in the prose gate", () => {
  const letter = (body: string) =>
    `Jane Doe\n\nNovember 4, 2026\n\nDear Hiring Team,\n\n${body}\n\nBest,\nJane Doe\n`;
  const body =
    "I spent four years at Northwind building the search ranking service used by 3 million shoppers, and I moved query latency from 900 ms to 300 ms by rewriting the index layer. Before that I ran the pricing data pipeline at Contoso for two years, where I owned the nightly jobs and their alerting, and I want to bring that synergy of search and data work to your catalog team, where the posting describes the same ranking problem at a larger size.";
  const slop = (v: ReturnType<typeof checkProse>) => v.filter((x) => x.rule === "slop-phrase").map((x) => x.detail);

  it("absent: only the built-in list applies", () => {
    expect(slop(checkProse(letter(body)))).toEqual([]);
    expect(slop(checkProse(letter(body + " We should move the needle.")))).toEqual(['"move the needle"']);
  });

  it("present: user phrases extend the built-in list", () => {
    const v = checkProse(letter(body + " We should move the needle."), { voice: { banned_patterns: ["synergy"] } });
    expect(slop(v).sort()).toEqual(['"move the needle"', '"synergy"']);
    expect(v.find((x) => x.detail === '"synergy"')?.hard).toBe(true);
  });

  it("replace_default_patterns drops the built-in list", () => {
    const v = checkProse(letter(body + " We should move the needle."), {
      voice: { banned_patterns: ["synergy"], replace_default_patterns: true },
    });
    expect(slop(v)).toEqual(['"synergy"']);
  });

  it("compiles literals as whole words, /x/ as regex, skips invalid regex", () => {
    const [lit, re] = compileBannedPatterns(["at scale", "/team(?:s)? player/"]);
    expect(lit.test("we work AT  SCALE daily")).toBe(true);
    expect(lit.test("we work at scaled sites")).toBe(false);
    expect(re.test("a true team player")).toBe(true);
    expect(compileBannedPatterns(["/(/"])).toEqual([]);
    expect(compileBannedPatterns(undefined)).toEqual([]);
  });
});

describe("board.max_sourced_cards", () => {
  const cards = Array.from({ length: 15 }, (_, i) => ({ id: i, guess_band: "STRONG", age_days: i, rank_score: 1 }));
  it("absent: default 10", () => {
    expect(maxSourcedCards(null)).toBe(DEFAULT_MAX_SOURCED_CARDS);
    expect(maxSourcedCards({})).toBe(10);
    expect(topSourced(cards, maxSourcedCards({}))).toHaveLength(10);
  });
  it("present: the profile's cap", () => {
    expect(topSourced(cards, maxSourcedCards({ board: { max_sourced_cards: 4 } }))).toHaveLength(4);
  });
  it("invalid: falls back to the default", () => {
    expect(maxSourcedCards({ board: { max_sourced_cards: 0 } })).toBe(10);
  });
});

describe("daily_run", () => {
  it("absent: enabled at the default time", () => {
    expect(dailyRun(undefined)).toEqual({ enabled: true, time: DEFAULT_DAILY_RUN_TIME, hour: 8, minute: 15 });
  });
  it("present: time and switch", () => {
    expect(dailyRun({ daily_run: { time: "7:30", enabled: false } })).toEqual({ enabled: false, time: "07:30", hour: 7, minute: 30 });
  });
  it("invalid time falls back to the default", () => {
    expect(dailyRun({ daily_run: { time: "25:00" } }).time).toBe(DEFAULT_DAILY_RUN_TIME);
  });
});

describe("dream_companies", () => {
  it("absent: nothing to watch", () => {
    expect(planDreamWatch(undefined)).toEqual({ fetchable: [], browser: [], invalid: [] });
    expect(planDreamWatch({})).toEqual({ fetchable: [], browser: [], invalid: [] });
  });

  it("present: splits feeds, browser checks and invalid entries", () => {
    const plan = planDreamWatch({
      dream_companies: [
        { name: "Acme", ats: "greenhouse", slug: "acme" },
        { name: "Globex", ats: "google", queries: ['"product manager"'] },
        { name: "Initech", ats: "browser", url: "https://careers.initech.example" },
        { name: "NoSlug", ats: "ashby" },
        { name: "Hooli", ats: "eightfold", host: "jobs.hooli.example" },
      ],
    });
    expect(plan.fetchable.map((c) => c.name)).toEqual(["Acme", "Globex"]);
    expect(plan.browser.map((c) => c.name)).toEqual(["Initech"]);
    expect(plan.invalid).toHaveLength(2);
  });

  it("fetches a greenhouse board through the injected fetch", async () => {
    const calls: string[] = [];
    const fake = async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ jobs: [{ title: "Senior Product Manager", absolute_url: "https://x/1", location: { name: "Remote" } }] }),
        text: async () => "",
      };
    };
    const jobs = await fetchDreamCompany({ name: "Acme", ats: "greenhouse", slug: "acme" }, { function_terms: ["product"] }, fake);
    expect(calls).toEqual(["https://boards-api.greenhouse.io/v1/boards/acme/jobs"]);
    expect(jobs).toEqual([{ company: "Acme", title: "Senior Product Manager", location: "Remote", url: "https://x/1" }]);
  });

  it("google queries default to the function terms", () => {
    expect(dreamQueries({ name: "G", ats: "google" }, { function_terms: ["designer"] })).toEqual(['"designer"']);
    expect(dreamQueries({ name: "G", ats: "google", queries: ["x"] }, { function_terms: ["designer"] })).toEqual(["x"]);
  });

  it("the profile description lists the new settings", () => {
    const p = { ...deriveSearchProfile({}), dream_companies: [{ name: "Acme", ats: "greenhouse" as const, slug: "acme" }] };
    const d = describeSearchProfile(p);
    expect(d).toContain("Dream companies checked directly: Acme");
    expect(d).toContain("Board column: 10 sourced cards");
    expect(d).toContain("Daily run: at 08:15");
  });
});

describe("autofill identity", () => {
  const edu = (fm: string) => `---\n${fm}\n---\nbody`;
  it("absent data: empty identity, no literals", () => {
    expect(autofillIdentity({ workHistory: [], educationRaws: [] })).toEqual({});
  });
  it("derives employer and school from the knowledge base", () => {
    expect(
      autofillIdentity({
        candidateName: "Jane Doe",
        workHistory: [
          { company: "Contoso", current: false, start: "2019-01" },
          { company: "Northwind", current: true, start: "2022-03" },
        ],
        educationRaws: [edu("institution: Open Course Hub\ncredential: Certificate in SQL"), edu("institution: State University\ncredential: BS Computer Science")],
      }),
    ).toEqual({ full_name: "Jane Doe", current_employer: "Northwind", school: "State University" });
  });
  it("explicit autofill.json answers win", () => {
    expect(
      autofillIdentity({
        commonAnswers: { current_employer: "Globex", school: "Tech Institute" },
        workHistory: [{ company: "Northwind", current: true }],
        educationRaws: [edu("institution: State University\ncredential: BS")],
      }),
    ).toEqual({ current_employer: "Globex", school: "Tech Institute" });
  });
});

describe("curated KB file writers", () => {
  it("writing samples: creates, then appends with continued numbering", () => {
    const first = writeWritingSamples(null, [{ title: "email to a manager", text: "Hi Sam,\n\nShort update." }]);
    expect(first).toMatch(/^# Own writing/);
    expect(first).toContain("## Sample 1: email to a manager");
    expect(first).toContain("> Hi Sam,");
    const second = writeWritingSamples(first, [{ title: "post", text: "x", avoid: ["the closing line"] }]);
    expect(second).toContain("## Sample 2: post");
    expect(second).toContain("Do not imitate");
    expect(writeWritingSamples(second, [{ title: "only", text: "y" }], "replace")).not.toContain("Sample 2");
  });

  it("STAR stories: inserts into a new theme, replaces by title", () => {
    const story = { story: "Search rewrite", source: "02-northwind-search-platform.md", s: "s", t: "t", a: "a", r: "r" };
    const one = upsertStarStory(null, "Ownership", story, "2026-11-04T00:00:00Z");
    expect(one.replaced).toBe(false);
    expect(one.data).toEqual({ themes: [{ theme: "Ownership", stories: [story] }], updated_at: "2026-11-04T00:00:00Z" });
    const two = upsertStarStory(one.data, "Ownership", { ...story, r: "r2" });
    expect(two.replaced).toBe(true);
    expect(two.data.themes[0].stories).toHaveLength(1);
    expect(two.data.themes[0].stories[0].r).toBe("r2");
  });

  it("metrics register: written entries parse back, replace in place, new sections before the rules", () => {
    const a = upsertMetricEntry(null, {
      section: "Northwind Search (02-northwind-search-platform.md, 2022–2026)",
      name: "Query latency down 66%",
      status: "DEFENDED",
      status_note: "[C] 2026-11-04",
      details: ["900 ms to 300 ms p95, from the team dashboard"],
    });
    let reg = parseMetricsRegister(a.markdown);
    expect(reg.sections).toHaveLength(1);
    expect(reg.sections[0].entries[0]).toEqual({
      name: "Query latency down 66%",
      status: "DEFENDED",
      statusNote: "[C] 2026-11-04",
      details: ["900 ms to 300 ms p95, from the team dashboard"],
    });

    const withRules = a.markdown + "\n## Operating rules\n\n1. Only DEFENDED or SCOPE numbers ship.\n";
    const b = upsertMetricEntry(withRules, { section: "Northwind Search (02-northwind-search-platform.md, 2022–2026)", name: "Query latency down 66%", status: "PARTIAL", details: [] });
    expect(b.replaced).toBe(true);
    const c = upsertMetricEntry(b.markdown, { section: "Contoso Pricing", name: "Jobs on time 99%", status: "OPEN" });
    const d = upsertMetricEntry(c.markdown, { section: "Contoso Pricing", name: "Shoppers 3M", status: "SCOPE" });
    reg = parseMetricsRegister(d.markdown);
    expect(reg.sections.map((s) => s.section)).toEqual(["Northwind Search (02-northwind-search-platform.md, 2022–2026)", "Contoso Pricing"]);
    expect(reg.sections[0].entries).toEqual([{ name: "Query latency down 66%", status: "PARTIAL", statusNote: "", details: [] }]);
    expect(reg.sections[1].entries.map((e) => e.name)).toEqual(["Jobs on time 99%", "Shoppers 3M"]);
    expect(reg.rules).toEqual(["Only DEFENDED or SCOPE numbers ship."]);
    expect(reg.counts).toMatchObject({ PARTIAL: 1, OPEN: 1, SCOPE: 1 });
  });
});
