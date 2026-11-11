import { describe, expect, it } from "vitest";
import { applyWorkHistoryOverrides, formAttachments, mergeAutofill, type WorkHistoryRow } from "../apps/local/lib/autofill";

const rows: WorkHistoryRow[] = [
  { id: "acme-lead", company: "Acme", title: "Product Lead, Search", location: "Denver, CO", start: "2022", end: "2026", current: false },
  { id: "globex-pm", company: "Globex", title: "Product Manager", location: "Paris, France", start: "2018", end: "present", current: true },
  { id: "teaching", company: "State University", title: "Guest Lecturer", location: "Cambridge, MA", start: "2025", end: "present", current: true },
];

describe("applyWorkHistoryOverrides (how record roles appear on forms)", () => {
  it("returns the record unchanged when there are no overrides", () => {
    expect(applyWorkHistoryOverrides(rows, undefined)).toEqual(rows);
    expect(applyWorkHistoryOverrides(rows, {})).toEqual(rows);
  });

  it("replaces title, dates and current, and lists what it changed", () => {
    const out = applyWorkHistoryOverrides(rows, {
      "acme-lead": { title: "Senior Product Manager, Technical" },
      "globex-pm": { start: "02/2018", end: "05/2026", current: false },
    });
    expect(out[0]).toMatchObject({ title: "Senior Product Manager, Technical", start: "2022", overridden: ["title"] });
    expect(out[1]).toMatchObject({ start: "02/2018", end: "05/2026", current: false, overridden: ["start", "end", "current"] });
    expect(out[2].overridden).toBeUndefined();
  });

  it("drops an excluded role", () => {
    const out = applyWorkHistoryOverrides(rows, { teaching: { exclude: true } });
    expect(out.map((r) => r.id)).toEqual(["acme-lead", "globex-pm"]);
  });

  it("never adds a role the record does not hold", () => {
    const out = applyWorkHistoryOverrides(rows, { "made-up-employer": { title: "Director" } });
    expect(out).toEqual(rows);
  });

  it("ignores blank strings instead of erasing the record's value", () => {
    const out = applyWorkHistoryOverrides(rows, { "acme-lead": { title: "  ", end: "" } });
    expect(out[0]).toEqual(rows[0]);
  });
});

describe("mergeAutofill with work_history_overrides", () => {
  it("merges id by id and keeps other ids", () => {
    const first = mergeAutofill(null, { work_history_overrides: { "acme-lead": { title: "A" } } });
    const next = mergeAutofill(first, { work_history_overrides: { "globex-pm": { end: "2026" } } });
    expect(next.work_history_overrides).toEqual({ "acme-lead": { title: "A" }, "globex-pm": { end: "2026" } });
  });
});

describe("formAttachments (files to attach on a form)", () => {
  it("prefers the submit-ready copies, PDF first", () => {
    const names = ["resume.pdf", "resume.docx", "Alex_Doe-acme-resume.docx", "Alex_Doe-acme-resume.pdf", "Alex_Doe-acme-cover-letter.pdf"];
    expect(formAttachments(names)).toEqual({ resume: "Alex_Doe-acme-resume.pdf", cover_letter: "Alex_Doe-acme-cover-letter.pdf" });
  });

  it("falls back to the masters, and to null when nothing exists", () => {
    expect(formAttachments(["resume.docx", "meta.json"])).toEqual({ resume: "resume.docx", cover_letter: null });
    expect(formAttachments([])).toEqual({ resume: null, cover_letter: null });
  });
});
