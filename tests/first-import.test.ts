import { describe, expect, it } from "vitest";
import { HOW, ONE_BY_ONE, SAVE_ALL, addedByKairos, addedTexts, importItems, partMessage, partsOf, plainDate, statedLines, summaryMessage, type ImportInput, type ImportItem } from "@/lib/first-import";
import { inSources, knownSources, phraseInSources, rememberSource } from "@/lib/import-source";
import { askToSave, boxText, tooLongFor, type ConfirmationBox, type Confirmer } from "@/lib/record-confirm";

/**
 * The confirmations of a first import, as texts (apps/local/lib/first-import.ts), and the limit of a
 * client's box for every confirmation (record-confirm.ts). Invented people and employers.
 *
 * The box of these tests is the one measured in claude.ai on 15 November 2026: it shows 4,000
 * characters and drops the line breaks. A message goes out only under 3,600.
 */
const BOX: ConfirmationBox = { maxChars: 3_600, aimChars: 1_800, oneParagraph: true, yes: "Approving" };

const resume = `Jordan Example
Denver, CO · jordan@example.com · 555-0100
Staff Nurse, Medical-Surgical Unit, Harborline Medical Center, Denver, CO
June 2021 to present
Care for 5 to 6 adult patients per shift on a 32-bed medical-surgical unit.
Precepted 9 new graduate nurses through their 12-week orientation; all 9 completed it.
Charge nurse on 2 to 3 night shifts a month since 2023.
Nurse Extern, Northwind Community Hospital, Columbus, OH
Supported registered nurses on a 24-bed telemetry unit: vital signs, blood glucose checks, patient mobility.
Bachelor of Science in Nursing, State University, 2021
Registered Nurse, State of Colorado`;

const harborline: ImportInput = {
  fileName: "01-harborline.md",
  frontmatter: {
    id: "harborline",
    company: "Harborline Medical Center",
    title: "Staff Nurse, Medical-Surgical Unit",
    location: "Denver, CO",
    start: "2021-06",
    end: "present",
    seniority_level: "IC",
    domains: ["medical-surgical nursing"],
    scope: { unit_beds: { value: "32-bed unit", prov: "R" } },
    skills: [{ name: "Precepting", proficiency: "strong", recency: "2026", prov: "R" }, { name: "Epic", proficiency: "working", recency: "2026", prov: "R" }],
    keywords: ["registered nurse", "preceptor"],
  },
  body: "## Achievements\n- Care for 5 to 6 adult patients per shift on a 32-bed medical-surgical unit. [R]\n- Precepted 9 new graduate nurses through their 12-week orientation; all 9 completed it. [R]\n- Charge nurse on 2 to 3 night shifts a month since 2023. [R]",
};
const northwind: ImportInput = {
  fileName: "02-northwind.md",
  frontmatter: { id: "northwind", company: "Northwind Community Hospital", title: "Nurse Extern", location: "Columbus, OH", start: "2020-05", end: "2021-05" },
  body: "## Summary\nNurse extern on a 24-bed telemetry unit, supporting registered nurses. [R]\n\n## Achievements\n- Supported registered nurses on a 24-bed telemetry unit: vital signs, blood glucose checks, patient mobility. [R]",
};
const degree: ImportInput = { fileName: "state-university.md", frontmatter: { institution: "State University", credential: "Bachelor of Science in Nursing", dates: "2021" }, body: "- Bachelor of Science in Nursing, State University, 2021 [R]" };
const licence: ImportInput = { fileName: "rn-licence.md", frontmatter: { institution: "State of Colorado", credential: "Registered Nurse licence" }, body: "- Registered Nurse, State of Colorado [R]" };
const identity = ["name: Jordan Example", "contact_line: Denver, CO · jordan@example.com · 555-0100", "headline: Registered Nurse, Medical-Surgical"];

function setup(withDocument = true) {
  const store = {};
  if (withDocument) rememberSource(store, "Jordan-Example-resume.docx", resume);
  const items = importItems(identity, [harborline, northwind], [degree, licence], { verbatim: (l) => (withDocument ? inSources(store, l) : null), named: (t) => (withDocument ? phraseInSources(store, t) : null), saved: () => false });
  return { store, items, documents: knownSources(store) };
}
/** A role of about `chars` characters as its box shows it. */
const roleOf = (n: number, chars: number): ImportItem => ({
  kind: "role",
  name: `Analyst at Company ${n}, 2020 to 2021`,
  nth: n,
  of: 9,
  lines: [{ text: `Line of company ${n}: ${"x".repeat(Math.max(0, chars - 90))}`, verbatim: null }],
  added: [],
  saved: false,
  fileName: `0${n}-company.md`,
});

describe("which lines of an import stand in the user's document word for word", () => {
  it("finds a line whatever its list mark, its tag, its case and its punctuation, and not a reworded one", () => {
    const { store } = setup();
    expect(inSources(store, "- Care for 5 to 6 adult patients per shift on a 32-bed medical-surgical unit. [R]")).toBe(true);
    expect(inSources(store, "precepted 9 new graduate nurses through their 12 week orientation, all 9 completed it")).toBe(true);
    // Claude's own sentence, a verb changed, a number changed, a part left out and another added: not the document's words.
    expect(inSources(store, "Nurse extern on a 24-bed telemetry unit, supporting registered nurses. [R]")).toBe(false);
    expect(inSources(store, "- Led 9 new graduate nurses through their 12-week orientation; all 9 completed it. [R]")).toBe(false);
    expect(inSources(store, "- Precepted 19 new graduate nurses through their 12-week orientation; all 9 completed it. [R]")).toBe(false);
    expect(inSources(store, "- Charge nurse on 2 to 3 night shifts a month since 2023, and unit manager. [R]")).toBe(false);
    // A skill or a search word is looked for as whole words, one word being enough.
    expect(phraseInSources(store, "Registered Nurse")).toBe(true);
    expect(phraseInSources(store, "telemetry")).toBe(true);
    expect(phraseInSources(store, "Epic")).toBe(false);
    expect(phraseInSources(store, "tele")).toBe(false);
    expect(phraseInSources(store, " · ")).toBe(false);
    // Too short to say, and a part of a word is not a word.
    expect(inSources(store, "Charge nurse")).toBe(false);
    expect(inSources(store, "are for 5 to 6 adult patients per shift")).toBe(false);
    // With no document noted for this knowledge base there is nothing to find a line in.
    expect(inSources({}, "- Care for 5 to 6 adult patients per shift on a 32-bed medical-surgical unit. [R]")).toBe(false);
    expect(knownSources({})).toEqual([]);
  });
});

describe("the summary of a first import: read at a glance", () => {
  it("says who, which jobs with their dates and line counts, which entries, and how many lines are the document's own, counts first", () => {
    const { items, documents } = setup();
    const text = summaryMessage(items, documents, BOX)!;
    expect(text.startsWith("Kairos read your document, Jordan-Example-resume.docx. Nothing is saved yet.")).toBe(true);
    expect(text).toContain("You: Jordan Example; Denver, CO · jordan@example.com · 555-0100; headline: Registered Nurse, Medical-Surgical.");
    expect(text).toContain("2 jobs: Staff Nurse, Medical-Surgical Unit at Harborline Medical Center, Denver, CO, June 2021 to today (3 lines); Nurse Extern at Northwind Community Hospital, Columbus, OH, May 2020 to May 2021 (2 lines).");
    expect(text).toContain("2 education and credential entries: Bachelor of Science in Nursing (State University, 2021); Registered Nurse licence (State of Colorado).");
    // A licence is not called a school.
    expect(text).not.toMatch(/school/i);
    // The one line that is not in the document is shown in full, with the job it belongs to.
    expect(text).toContain('6 of the 7 lines are word for word from your document. 1 is not: Claude worded it. Check it: | (1) "Nurse extern on a 24-bed telemetry unit, supporting registered nurses." (job 2: Nurse Extern at Northwind Community Hospital)');
    // The lines that are the document's own are counted, not listed.
    expect(text).not.toContain("Precepted 9 new graduate nurses");
    // No technical field, and what Kairos derives is named in one sentence.
    for (const technical of ["01-harborline.md", "prov:", "recency", "id:", "seniority_level", "##", "[R]"]) expect(text, technical).not.toContain(technical);
    // What Kairos adds is named in one sentence; what the document does not name is listed, each once, and what it names is not.
    expect(text).toContain("Kairos also adds, to match job ads, the skills, search words and sizes it reads in those lines. 5 are not words from your document: Precepting; Epic; medical-surgical nursing; preceptor; 32-bed unit.");
    expect(text).not.toContain("registered nurse;");
    expect(text.endsWith("Choose below: save all of it, or see each item one by one. Decline saves nothing. You can read and correct every line afterwards: ask to see your knowledge base.")).toBe(true);
    // One paragraph, far under what the box shows, and under what is read before it closes.
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThan(BOX.aimChars);
    expect(HOW.enum).toEqual([SAVE_ALL, ONE_BY_ONE]);
    expect(HOW.default).toBe(SAVE_ALL);
  });

  it("when every line is the document's own it says so in one sentence; where the user cannot choose it names the one answer", () => {
    const store = {};
    rememberSource(store, "resume.pdf", resume);
    const items = importItems([], [harborline], [degree], { verbatim: (l) => inSources(store, l), saved: () => false });
    const text = summaryMessage(items, ["resume.pdf"], BOX)!;
    expect(text).toContain("All 4 lines are word for word from your document.");
    // Nothing is claimed about what Kairos adds when it could not be looked up; one sentence when the document names it all but one.
    expect(text).toContain("the skills, search words and sizes it reads in those lines. ◆ Choose below");
    const named = importItems([], [{ ...harborline, frontmatter: { ...harborline.frontmatter, skills: ["Charge nurse"], domains: [], scope: {}, keywords: ["registered nurse", "REGISTERED NURSE"] } }, { ...northwind, frontmatter: { ...northwind.frontmatter, keywords: ["Registered nurse", "telemetry", "wound care"] } }], [], {
      verbatim: (l) => inSources(store, l),
      named: (t) => phraseInSources(store, t),
      saved: () => false,
    });
    expect(summaryMessage(named, ["resume.pdf"], BOX)).toContain("those lines. 1 is not a word from your document: wound care.");
    expect(summaryMessage(named.slice(0, 1), ["resume.pdf"], BOX)).toContain("it reads in those lines; all are words from your document.");
    expect(text).toContain("1 job: ");
    expect(text).toContain("1 education or credential entry: ");
    expect(text).not.toContain("You:");
    const onCard = summaryMessage(items, ["resume.pdf"], undefined, false)!;
    expect(onCard).toContain("\n\nAccept saves all of it. Decline saves nothing.");
    expect(onCard).not.toContain("Choose below");
  });

  it("there is no summary without a document to compare with, and none when nothing is left to save", () => {
    const { items } = setup(false);
    expect(summaryMessage(items, [], BOX)).toBeNull();
    expect(summaryMessage(setup().items.map((i) => ({ ...i, saved: true })), ["resume.pdf"], BOX)).toBeNull();
    // What is saved already is said, and only the rest is listed.
    const some = setup().items.map((i) => (i.kind === "role" && i.nth === 1 ? { ...i, saved: true } : i));
    const rest = summaryMessage(some, ["resume.pdf"], BOX)!;
    expect(rest).toContain("1 item of this import is saved already; the rest is not saved yet.");
    expect(rest).toContain("1 job: Nurse Extern at Northwind Community Hospital");
    expect(rest).not.toContain("Harborline");
  });
});

describe("a first import item by item: every line, no item cut, no message longer than the box shows", () => {
  it("one item reads as a sentence: the job, its lines numbered, then what Kairos adds in plain words", () => {
    const { items } = setup();
    const text = partMessage([items[0], items[1]], 1, 3, true, BOX);
    expect(text.startsWith("Kairos: your first import, part 1 of 3. Nothing of this part is saved yet.")).toBe(true);
    expect(text).toContain("Job 1 of 2: Staff Nurse, Medical-Surgical Unit at Harborline Medical Center, Denver, CO, June 2021 to today.");
    expect(text).toContain("Its 3 lines: (1) Care for 5 to 6 adult patients per shift on a 32-bed medical-surgical unit. (2) Precepted 9 new graduate nurses through their 12-week orientation; all 9 completed it. (3) Charge nurse on 2 to 3 night shifts a month since 2023.");
    expect(text).toContain("Kairos adds, to match job ads: skills: Precepting (strong); Epic (working); level: individual contributor; field: medical-surgical nursing; sizes: 32-bed unit; search words: registered nurse, preceptor.");
    expect(text.endsWith("Approving saves part 1 only. Decline saves nothing of it. 2 more parts follow.")).toBe(true);
    for (const technical of ["01-harborline.md", "prov:", "(R)", "recency", "##", "[R]"]) expect(text, technical).not.toContain(technical);
    // The line that is Claude's own is marked where it stands; with no document nothing is marked.
    const second = partMessage([items[2]], 2, 3, true, BOX);
    expect(second).toContain("(1) Nurse extern on a 24-bed telemetry unit, supporting registered nurses. [Claude's wording, not in your document] (2) Supported registered nurses");
    expect(second.endsWith("Approving saves part 2 only. Decline saves nothing of it; what you approved before stays. 1 more part follows.")).toBe(true);
    expect(partMessage([setup(false).items[2]], 2, 3, false, BOX)).not.toContain("Claude's wording");
    // An entry whose one line only repeats its name is not said twice; the last part says that nothing follows.
    const last = partMessage([items[3], items[4]], 3, 3, true, BOX);
    expect(last).toContain("Education and credentials, 1 of 2: Bachelor of Science in Nursing (State University, 2021). ◆ Education and credentials, 2 of 2: Registered Nurse licence (State of Colorado).");
    expect(last).not.toContain("Its line");
    expect(last.endsWith("Approving saves part 3 only. Decline saves nothing of it; what you approved before stays.")).toBe(true);
    // One part alone names no part.
    expect(partMessage(items, 1, 1, true, BOX)).toMatch(/^Kairos: your first import\. Nothing is saved yet\..*Approving saves all of it\. Decline saves nothing\.$/);
  });

  it("what Kairos adds leaves out the technical marks and says any other field as it is", () => {
    expect(addedByKairos({ id: "x", sources: ["a.pdf"], title: "T", company: "C", start: "2020", end: "2021" })).toEqual([]);
    expect(addedByKairos({ skills: ["SQL", { name: "Python", proficiency: "working", recency: "2025", prov: "R" }], seniority_level: "Lead", company_context: "A bank", scope: { team: { value: "8 people", prov: "R" } } })).toEqual([
      "skills: SQL; Python (working)",
      "level: lead",
      "sizes: 8 people",
      "company context: A bank",
    ]);
    // The texts among them that name something about the person: the levels are not texts to look for.
    expect(addedTexts({ id: "x", title: "T", skills: ["SQL", { name: "Python", proficiency: "working" }], seniority_level: "Lead", domains: ["banking"], keywords: ["analyst"], scope: { team: { value: "8 people", prov: "R" } }, company_context: "A bank" })).toEqual(["SQL", "Python", "banking", "analyst", "8 people", "company context: A bank"]);
    expect(plainDate("2021-06")).toBe("June 2021");
    expect(plainDate("present")).toBe("today");
    expect(plainDate("2021")).toBe("2021");
    expect(statedLines("## Summary\nOne line. [R]\n\n## Achievements\n- A bullet. [R]\n\n## Raw material / notes\n")).toEqual(["One line. [R]", "A bullet. [R]"]);
  });

  it("an import that is read before the box closes is one part; a longer one is split, and no part is longer than the box shows", () => {
    const limits = { aim: BOX.aimChars, max: BOX.maxChars };
    // Under what one box aims at: one part.
    const short = [roleOf(1, 500), roleOf(2, 500), roleOf(3, 400)];
    expect(partsOf(short, false, limits, BOX).parts).toEqual([short]);
    // Just over it: two parts, the items whole and in order.
    const longer = [roleOf(1, 600), roleOf(2, 600), roleOf(3, 600)];
    const split = partsOf(longer, false, limits, BOX);
    expect(split.parts.map((p) => p.map((i) => i.nth))).toEqual([[1, 2], [3]]);
    // Many items: every item is in exactly one part, whole, in order, and every message is under the limit.
    const many = Array.from({ length: 9 }, (_, i) => roleOf(i + 1, 300 + i * 250));
    const { parts, tooLong } = partsOf(many, false, limits, BOX);
    expect(tooLong).toEqual([]);
    expect(parts.flat().map((i) => i.nth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    parts.forEach((p, k) => {
      const text = partMessage(p, k + 1, parts.length, false, BOX);
      expect(text.length, `part ${k + 1}`).toBeLessThanOrEqual(BOX.maxChars);
      expect(tooLongFor({ box: BOX }, text)).toBeNull();
      expect(text).toContain(`part ${k + 1} of ${parts.length}`);
      // No item is cut in two: each line of each of its items is in this message, complete.
      for (const item of p) for (const line of item.lines) expect(text).toContain(line.text);
    });
    expect(parts.length).toBeGreaterThan(3);
  });

  it("sizes at, under and over the limit: an item longer than what a box aims at has a box of its own; one longer than the box shows is in no part", () => {
    const limits = { aim: BOX.aimChars, max: BOX.maxChars };
    const size = (i: ImportItem) => partMessage([i], 1, 2, false, BOX).length;
    // Longer than a box aims at, under what it shows: alone, whole.
    const big = roleOf(2, 2_600);
    expect(size(big)).toBeGreaterThan(BOX.aimChars);
    expect(size(big)).toBeLessThanOrEqual(BOX.maxChars);
    expect(partsOf([roleOf(1, 900), big, roleOf(3, 900)], false, limits, BOX).parts.map((p) => p.map((i) => i.nth))).toEqual([[1], [2], [3]]);
    // At the limit: the largest item that still fits is shown whole, in a message of at most 3,600 characters.
    let chars = 3_000;
    while (partsOf([roleOf(1, chars + 1)], false, limits, BOX).tooLong.length === 0) chars++;
    const atLimit = roleOf(1, chars);
    expect(partsOf([atLimit], false, limits, BOX)).toEqual({ parts: [[atLimit]], tooLong: [] });
    expect(size(atLimit)).toBeLessThanOrEqual(BOX.maxChars);
    expect(size(atLimit)).toBeGreaterThan(BOX.maxChars - 300);
    // One character more: it cannot be shown whole, so it is in no part, and the others are asked as before.
    const over = roleOf(1, chars + 1);
    expect(partsOf([over, roleOf(2, 500)], false, limits, BOX)).toEqual({ parts: [[roleOf(2, 500)]], tooLong: [over] });
  });

  it("the profile goes with the first job, jobs and education do not share a part unless all fits, and one by one every job is apart", () => {
    const { items } = setup();
    const limits = { aim: BOX.aimChars, max: BOX.maxChars };
    const kinds = (parts: ImportItem[][]) => parts.map((p) => p.map((i) => (i.kind === "profile" ? "profile" : `${i.kind} ${i.nth}`)));
    // Short enough to be read at once: one part.
    expect(kinds(partsOf(items, true, limits, BOX).parts)).toEqual([["profile", "role 1", "role 2", "education 1", "education 2"]]);
    // One by one: each job in its own box, the profile with the first, the entries together.
    expect(kinds(partsOf(items, true, { ...limits, apart: true }, BOX).parts)).toEqual([["profile", "role 1"], ["role 2"], ["education 1", "education 2"]]);
    // A tight box: the same order, and education never joins a job's part.
    expect(kinds(partsOf(items, true, { aim: 900, max: BOX.maxChars }, BOX).parts)).toEqual([["profile", "role 1"], ["role 2"], ["education 1", "education 2"]]);
  });
});

describe("every confirmation: written for the client's box, and never sent cut", () => {
  const confirmer = (box: ConfirmationBox | undefined, shown: string[]): Confirmer => ({
    box,
    supportsElicitation: () => true,
    elicit: async ({ message }) => {
      shown.push(message);
      return { action: "accept" };
    },
  });

  it("a box that drops line breaks gets one paragraph with marks; a client that keeps them gets lines", async () => {
    expect(boxText([["a", "b"], ["c"]], BOX)).toBe("a | b ◆ c");
    expect(boxText([["a", "b"], ["c"]])).toBe("a\nb\n\nc");
    const lines = ["New or changed:", "+ headline: Nurse educator", "", "Removed:", "- headline: Staff nurse"];
    const inBox: string[] = [];
    expect(await askToSave(confirmer(BOX, inBox), "change your profile", lines)).toBeNull();
    expect(inBox[0]).toBe("Kairos: change your profile ◆ New or changed: | + headline: Nurse educator ◆ Removed: | - headline: Staff nurse ◆ Approving saves this to your knowledge base. Decline if you did not say it or it is wrong.");
    const withLines: string[] = [];
    expect(await askToSave(confirmer(undefined, withLines), "change your profile", lines)).toBeNull();
    expect(withLines[0]).toBe("Kairos: change your profile\n\nNew or changed:\n+ headline: Nurse educator\n\nRemoved:\n- headline: Staff nurse\n\nAccept saves this to your knowledge base. Decline if you did not say it or it is wrong.");
  });

  it("a single save longer than the box shows is refused, not cut, with the way to save it in steps; one that fits is asked", async () => {
    const shown: string[] = [];
    const line = (n: number) => `+ - Fact number ${n} of a long role, told in a full sentence of some length. [R]`;
    const fitting = Array.from({ length: 40 }, (_, i) => line(i));
    expect(await askToSave(confirmer(BOX, shown), "add the role Analyst at Company (01-company.md)", fitting)).toBeNull();
    expect(shown).toHaveLength(1);
    expect(shown[0].length).toBeLessThanOrEqual(BOX.maxChars);
    for (const l of fitting) expect(shown[0]).toContain(l);
    const tooMany = Array.from({ length: 60 }, (_, i) => line(i));
    const refused = await askToSave(confirmer(BOX, shown), "add the role Analyst at Company (01-company.md)", tooMany);
    expect(shown).toHaveLength(1);
    expect(refused).toMatch(/^Nothing was saved: this change is too long to show whole in one confirmation \(\d+ characters; the confirmation shows 3600\), and a change is never shown cut\./);
    expect(refused).toContain("save the item first with part of its lines, then save it again with the rest added. The second confirmation shows only what is new.");
    // The same change in a client whose box shows it all is asked whole.
    const whole: string[] = [];
    expect(await askToSave(confirmer(undefined, whole), "add the role Analyst at Company (01-company.md)", tooMany)).toBeNull();
    for (const l of tooMany) expect(whole[0]).toContain(l);
  });
});
