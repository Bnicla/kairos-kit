/**
 * The sourcing code takes its words from the user's search profile: nothing in
 * it assumes a profession. Two invented people stand in for "anyone": a
 * software engineer and a financial analyst.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BAMBOO_MAX_DETAIL,
  fetchBoardDetailed,
  WORKDAY_MAX_PAGES,
  WORKDAY_MAX_SEARCH_TERMS,
  workdaySearchWords,
} from "@kairos/engine/sourcing/adapters";
import { dreamQueries, fetchDreamCompany } from "@kairos/engine/sourcing/dream-watch";
import { functionGateVerdict } from "@kairos/engine/sourcing/filter";
import { deriveSearchProfile, feedSearchTerms, mergeSearchProfile } from "@kairos/engine/sourcing/search-profile";
import { fetchBoards, searchProfileWarnings, sweepFetchOptions } from "@kairos/engine/sourcing/sweep";
import { buildTriagePrompt } from "@kairos/engine/sourcing/triage";
import type { RankedPosting, RegistryEntry, SearchProfile } from "@kairos/engine/sourcing/types";

const base: SearchProfile = {
  function_terms: [],
  exclude_terms: [],
  locations: ["denver"],
  boost_terms: [],
  seniority_terms: [],
  max_age_days: 7,
};

/** A software engineer. */
const engineer: SearchProfile = {
  ...base,
  function_terms: ["engineer", "software engineer", "developer"],
  exclude_terms: ["sales", "support", "intern"],
  role_phrases: ["software engineer", "backend engineer"],
  soft_exclude_terms: ["sales", "support"],
};

/** A financial analyst. */
const analyst: SearchProfile = {
  ...base,
  function_terms: ["financial analyst", "fp&a", "finance"],
  exclude_terms: ["sales"],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

const wd: RegistryEntry = { ats: "workday", slug: "acme@wd1@careers" };

/**
 * A Workday tenant: `hits[word]` is the list of posting ids its search returns
 * for that word ("" = the unfiltered listing). Records every search text and
 * offset asked for.
 */
function workdayTenant(hits: Record<string, number[]>, opts: { failWord?: string } = {}) {
  const asked: { searchText: string; offset: number }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { searchText: string; offset: number; limit: number };
    asked.push({ searchText: body.searchText, offset: body.offset });
    if (opts.failWord === body.searchText) return jsonResponse({}, 404);
    const ids = hits[body.searchText] ?? [];
    return jsonResponse({
      total: body.offset === 0 ? ids.length : 0,
      jobPostings: ids.slice(body.offset, body.offset + body.limit).map((id) => ({
        title: `Role ${id}`,
        externalPath: `/job/Denver/R${id}`,
        locationsText: "Denver, Colorado",
        postedOn: "Posted Today",
      })),
    });
  }));
  return asked;
}

describe("feedSearchTerms: the words a search-only job site is asked for", () => {
  it("come from the function terms, in the profile's order, skipping a term another one covers", () => {
    expect(feedSearchTerms(engineer)).toEqual({ terms: ["engineer", "developer"], left_out: [] });
    expect(feedSearchTerms(analyst)).toEqual({ terms: ["financial analyst", "fp&a", "finance"], left_out: [] });
  });

  it("are capped, and the words left out are reported", () => {
    const many = { ...base, function_terms: ["nurse", "midwife", "paramedic", "radiographer", "pharmacist"] };
    const got = feedSearchTerms(many);
    expect(got.terms).toEqual(["nurse", "midwife", "paramedic"]);
    expect(got.terms).toHaveLength(WORKDAY_MAX_SEARCH_TERMS);
    expect(got.left_out).toEqual(["radiographer", "pharmacist"]);
    expect(searchProfileWarnings(many).join("\n")).toMatch(/not searched: "radiographer", "pharmacist".*search_terms/);
  });

  it("are the profile's search_terms when it sets them", () => {
    const p = { ...engineer, search_terms: [" Engineer ", "engineer"] };
    expect(feedSearchTerms(p)).toEqual({ terms: ["engineer"], left_out: [] });
    expect(searchProfileWarnings(p)).toEqual([]);
  });

  it("are empty for a profile with no target role, and the run log says nothing can match", () => {
    expect(feedSearchTerms(base)).toEqual({ terms: [], left_out: [] });
    expect(searchProfileWarnings(base).join("\n")).toMatch(/names no target role/);
    expect(searchProfileWarnings(engineer)).toEqual([]);
  });
});

describe("workday: the search text comes from the profile", () => {
  it("runs one paged query per search word and keeps a posting found twice once", async () => {
    const asked = workdayTenant({ engineer: [1, 2, 3], developer: [3, 4] });
    const { postings } = await fetchBoards({ boards: [wd], fetchOptions: sweepFetchOptions(engineer) });
    expect(asked).toEqual([
      { searchText: "engineer", offset: 0 },
      { searchText: "developer", offset: 0 },
    ]);
    expect(postings.map((p) => p.title)).toEqual(["Role 1", "Role 2", "Role 3", "Role 4"]);
  });

  it("asks for a financial analyst's words, never for another profession's", async () => {
    const asked = workdayTenant({ "financial analyst": [1], "fp&a": [], finance: [1, 2] });
    await fetchBoards({ boards: [wd], fetchOptions: sweepFetchOptions(analyst) });
    expect(asked.map((a) => a.searchText)).toEqual(["financial analyst", "fp&a", "finance"]);
  });

  it("pages each word on its own: a page of postings another word already found does not end the paging", async () => {
    const forty = Array.from({ length: 40 }, (_, i) => i);
    const asked = workdayTenant({ engineer: forty.slice(0, 20), developer: forty });
    const r = await fetchBoardDetailed(wd, Date.now(), { searchTerms: ["engineer", "developer"] });
    expect(asked).toEqual([
      { searchText: "engineer", offset: 0 },
      { searchText: "developer", offset: 0 }, // 20 postings, all found by "engineer" already
      { searchText: "developer", offset: 20 },
    ]);
    expect(r.postings).toHaveLength(40);
  });

  it("bounds the requests: at most the word cap times the page cap", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => i);
    const asked = workdayTenant({ a: big, b: big, c: big, d: big, e: big });
    await fetchBoardDetailed(wd, Date.now(), { searchTerms: ["a", "b", "c", "d", "e"] });
    expect(new Set(asked.map((a) => a.searchText))).toEqual(new Set(["a", "b", "c"]));
    expect(asked).toHaveLength(WORKDAY_MAX_SEARCH_TERMS * WORKDAY_MAX_PAGES);
  });

  it("with no search word lists the board unfiltered, in one paged query", async () => {
    const asked = workdayTenant({ "": [1, 2] });
    const r = await fetchBoardDetailed(wd);
    expect(asked).toEqual([{ searchText: "", offset: 0 }]);
    expect(r.postings).toHaveLength(2);
    expect(workdaySearchWords(undefined)).toEqual([""]);
    expect(workdaySearchWords([" ", ""])).toEqual([""]);
    // The sweep of a profile with no target role sends no word either.
    asked.length = 0;
    await fetchBoards({ boards: [wd], fetchOptions: sweepFetchOptions(base) });
    expect(asked.map((a) => a.searchText)).toEqual([""]);
  });

  it("a later word that fails keeps the earlier words' postings, marks the board partial and stops", async () => {
    const asked = workdayTenant({ engineer: [1, 2], developer: [3], architect: [4] }, { failWord: "developer" });
    const r = await fetchBoardDetailed(wd, Date.now(), { searchTerms: ["engineer", "developer", "architect"] });
    expect(r.failure).toBeUndefined();
    expect(r.partial).toEqual({ kind: "gone", status: 404 });
    expect(r.postings.map((p) => p.title)).toEqual(["Role 1", "Role 2"]);
    expect(asked.map((a) => a.searchText)).toEqual(["engineer", "developer"]);
  });
});

describe("bamboohr: which titles get a posting-date call comes from the profile", () => {
  const board = (titles: string[]) => {
    const dated: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const m = String(url).match(/careers\/(\d+)\/detail$/);
      if (m) {
        dated.push(titles[Number(m[1])]);
        return jsonResponse({ result: { jobOpening: { datePosted: "2026-11-01" } } });
      }
      return jsonResponse({ result: titles.map((t, i) => ({ id: String(i), jobOpeningName: t })) });
    }));
    return dated;
  };
  const bamboo: RegistryEntry = { ats: "bamboohr", slug: "acmelabs" };
  const titles = ["Head of Product", "Senior Financial Analyst", "Backend Engineer", "Finance Manager, Sales Operations", "AI Strategy Lead"];

  it("dates the financial analyst's titles and no others", async () => {
    const dated = board(titles);
    const { postings } = await fetchBoards({ boards: [bamboo], fetchOptions: sweepFetchOptions(analyst) });
    expect(dated).toEqual(["Senior Financial Analyst"]); // "Finance Manager, Sales Operations" is excluded by the profile
    expect(postings.find((p) => p.title === "Senior Financial Analyst")?.posted_at).toContain("2026-11-01");
    expect(postings.find((p) => p.title === "Head of Product")?.posted_at).toBeNull();
  });

  it("dates the software engineer's titles and no others", async () => {
    const dated = board(titles);
    await fetchBoards({ boards: [bamboo], fetchOptions: sweepFetchOptions(engineer) });
    expect(dated).toEqual(["Backend Engineer"]);
  });

  it("keeps the per-board cap, and without a test dates the first postings listed", async () => {
    const many = Array.from({ length: 10 }, (_, i) => `Staff Engineer ${i}`);
    let dated = board(many);
    await fetchBoards({ boards: [bamboo], fetchOptions: sweepFetchOptions(engineer) });
    expect(dated).toHaveLength(BAMBOO_MAX_DETAIL);
    dated = board(many);
    await fetchBoardDetailed(bamboo);
    expect(dated.sort()).toEqual(many.slice(0, BAMBOO_MAX_DETAIL));
  });
});

describe("function gate: the soft-exclude override is the profile's, for any role", () => {
  const gate = (title: string, p: SearchProfile) => functionGateVerdict(title, p);

  it("keeps a software engineer's titles whose excluded word names what the role works for", () => {
    for (const title of ["Software Engineer, Sales Platform", "Senior Backend Engineer - Customer Support Tools", "Software Engineer (Sales Systems)"]) {
      expect([title, gate(title, engineer)]).toEqual([title, "pass"]);
    }
  });

  it("still blocks when the excluded word is the role itself, when no role phrase is present, and for hard terms", () => {
    for (const title of ["Sales Software Engineer", "Software Engineer in Sales", "Sales Engineer", "Support Engineer", "Software Engineer Intern, Sales Platform"]) {
      expect([title, gate(title, engineer)]).toEqual([title, "exclude_term"]);
    }
  });

  it("gives no title a built-in exception: a product-management title gets none in an analyst's profile", () => {
    expect(gate("Product Manager, Sales Finance", analyst)).toBe("exclude_term");
    expect(gate("Financial Analyst, Sales", analyst)).toBe("exclude_term");
    const soft = { ...analyst, role_phrases: ["financial analyst"], soft_exclude_terms: ["sales"] };
    expect(gate("Financial Analyst, Sales", soft)).toBe("pass");
    expect(gate("Product Manager, Sales Finance", soft)).toBe("exclude_term");
  });
});

describe("deriveSearchProfile: neutral defaults", () => {
  it("assumes no role when the candidate profile names none", () => {
    const p = deriveSearchProfile({});
    expect(p.function_terms).toEqual([]);
    expect(p.exclude_terms).toEqual([]);
    expect(mergeSearchProfile(null, { locations: ["denver"] }).function_terms).toEqual([]);
  });

  it("keeps level words out of the function terms of a role outside the built-in disciplines", () => {
    expect(deriveSearchProfile({ target_roles: ["Restaurant Manager"] }).function_terms).toEqual(["restaurant"]);
    expect(deriveSearchProfile({ target_roles: ["Junior Paralegal"] }).function_terms).toEqual(["paralegal"]);
    expect(deriveSearchProfile({ target_roles: ["Manager"] }).function_terms).toEqual(["manager"]);
  });

  it("does not exclude early-career titles for a student or when no level is stated", () => {
    const student = deriveSearchProfile({ target_roles: ["Software Engineer Intern", "Junior Developer"] });
    expect(student.function_terms).toContain("engineer");
    expect(student.exclude_terms).toEqual([]);
    expect(deriveSearchProfile({ target_roles: ["Financial Analyst"], target_seniority: "Entry level" }).exclude_terms).toEqual([]);
    expect(deriveSearchProfile({ target_roles: ["Financial Analyst"] }).exclude_terms).toEqual([]);
    expect(deriveSearchProfile({ target_roles: ["Associate Product Manager"], target_seniority: "Senior associate" }).exclude_terms).toEqual([]);
  });

  it("excludes early-career titles only for a profile that states a senior level", () => {
    const senior = deriveSearchProfile({ target_roles: ["Senior Financial Analyst"] });
    expect(senior.function_terms).toEqual(["financial", "analyst"]); // "senior" is a level, not a function
    expect(senior.exclude_terms).toEqual(["intern", "internship", "junior", "apprentice"]);
    expect(deriveSearchProfile({ target_roles: ["Software Engineer"], target_seniority: "Principal" }).exclude_terms).toContain("intern");
  });
});

describe("triage prompt: names no function of its own", () => {
  const rows: RankedPosting[] = [{
    ats: "greenhouse", slug: "acme", company: "Acme", title: "Backend Engineer", url: "https://example.com/1",
    location: "Denver", remote: false, posted_at: null, age_days: null, rank_score: 0, location_fit: "match", reasons: [],
  }];

  it("asks to skip functions other than the candidate's, without listing any", () => {
    const prompt = buildTriagePrompt(rows, "Software engineer, five years of backend work.");
    expect(prompt).toMatch(/a function other than the candidate's own/);
    expect(prompt).not.toMatch(/engineering-IC|marketing|recruiting|product manag/i);
  });

  it("a user's own function rule still reaches the prompt as a hard rule", () => {
    const prompt = buildTriagePrompt(rows, "Financial analyst.", ["Engineering roles are the wrong function: SKIP them."]);
    expect(prompt).toMatch(/CANDIDATE RULES[\s\S]*Engineering roles are the wrong function/);
  });
});

describe("dream watch: search queries come from the entry or the profile", () => {
  const page = (html: string) => {
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ positions: [] }), text: async () => html };
    };
    return { urls, f };
  };

  it("defaults to the profile's function terms, and to nothing when there are none", () => {
    expect(dreamQueries({ name: "G", ats: "google" }, { function_terms: ["financial analyst", " "] })).toEqual(['"financial analyst"']);
    expect(dreamQueries({ name: "G", ats: "google" }, { function_terms: [] })).toEqual([]);
  });

  it("searches a search-only career site for the software engineer's words", async () => {
    const { urls, f } = page("");
    await fetchDreamCompany({ name: "G", ats: "google" }, { function_terms: ["engineer"] }, f);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`q=${encodeURIComponent('"engineer"')}`);
  });

  it("fails that company with the reason, without any request, when there is nothing to search for", async () => {
    for (const c of [{ name: "G", ats: "google" as const }, { name: "E", ats: "eightfold" as const, host: "careers.example.com", domain: "example.com" }]) {
      const { urls, f } = page("");
      await expect(fetchDreamCompany(c, { function_terms: [] }, f)).rejects.toThrow(/nothing to search for/);
      expect(urls).toEqual([]);
    }
  });
});

describe("user-visible text and the form-mapping prompt name no profession", () => {
  const root = join(__dirname, "..");
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");
  // The exported kit keeps the sourcing scripts in the local app.
  const sourcingRun = ["apps/local/scripts/sourcing-run.mts", "apps/local/scripts/sourcing-run.mts"].find((f) => existsSync(join(root, f)))!;

  it("the triage-failure notices do not name target roles", () => {
    for (const file of [sourcingRun, "apps/local/app/sourced/page.tsx"]) {
      expect([file, /chief of staff|group pm|product manager/i.test(read(file))]).toEqual([file, false]);
    }
  });

  it("the form-mapping prompt points at the years_ answers, not at one profession's key", () => {
    const route = read("apps/local/app/api/autofill-map/route.ts");
    expect(route).not.toMatch(/product_management/);
    expect(route).toMatch(/key starts with "years_"/);
  });
});
