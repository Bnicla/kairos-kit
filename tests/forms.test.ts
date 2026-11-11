import { describe, it, expect } from "vitest";
import { parseGreenhouseUrl, normalizeGreenhouseForm, formSummary, isWritingQuestion } from "@kairos/engine/forms";

describe("parseGreenhouseUrl", () => {
  it("parses hosted board URLs (both hosts, with query strings)", () => {
    expect(parseGreenhouseUrl("https://job-boards.greenhouse.io/acmepay/jobs/1234567001?gh_src=abc")).toEqual({
      eu: false,
      board: "acmepay",
      jobId: "1234567001",
    });
    expect(parseGreenhouseUrl("https://boards.greenhouse.io/brightpath/jobs/1234567002")).toEqual({
      eu: false,
      board: "brightpath",
      jobId: "1234567002",
    });
  });

  it("parses EU boards and embed URLs", () => {
    expect(parseGreenhouseUrl("https://job-boards.eu.greenhouse.io/acme/jobs/123")).toEqual({
      eu: true,
      board: "acme",
      jobId: "123",
    });
    expect(
      parseGreenhouseUrl("https://boards.greenhouse.io/embed/job_app?for=acme&token=456"),
    ).toMatchObject({ board: "acme", jobId: "456" });
  });

  it("rejects non-greenhouse and malformed URLs", () => {
    expect(parseGreenhouseUrl("https://jobs.lever.co/acme/abc")).toBeNull();
    expect(parseGreenhouseUrl("https://greenhouse.io/blog/jobs/123x")).toBeNull();
    expect(parseGreenhouseUrl(null)).toBeNull();
  });
});

const RAW = {
  questions: [
    { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text" }] },
    { label: "Resume/CV", required: true, fields: [{ name: "resume", type: "input_file" }] },
    {
      label: "Why do you want to work here?",
      required: true,
      fields: [{ name: "question_123", type: "textarea" }],
    },
    { label: "LinkedIn Profile", required: false, fields: [{ name: "question_124", type: "input_text" }] },
    {
      label: "Do you require sponsorship?",
      required: true,
      fields: [
        { name: "question_125", type: "multi_value_single_select", values: [{ label: "Yes" }, { label: "No" }] },
      ],
    },
    { label: "hidden", required: false, fields: [{ name: "question_126", type: "input_hidden" }] },
  ],
  demographic_questions: { questions: [] },
  compliance: [{ type: "eeoc" }],
};

describe("normalizeGreenhouseForm", () => {
  const form = normalizeGreenhouseForm(RAW, { board: "acme", jobId: "1" }, () => "2026-08-03T00:00:00Z")!;

  it("separates standard fields from custom questions and drops hidden inputs", () => {
    expect(form.questions.map((q) => q.custom)).toEqual([false, false, true, true, true]);
    expect(form.questions.find((q) => q.label === "hidden")).toBeUndefined();
  });

  it("maps kinds and captures select options", () => {
    expect(form.questions.find((q) => q.label.startsWith("Why"))!.kind).toBe("essay");
    expect(form.questions.find((q) => q.label.startsWith("Do you require"))!.options).toEqual(["Yes", "No"]);
    expect(form.has_demographic_section).toBe(true);
    expect(form.has_compliance_section).toBe(true);
  });

  it("returns null on payloads without a questions array", () => {
    expect(normalizeGreenhouseForm({ id: 1 }, { board: "a", jobId: "1" })).toBeNull();
    expect(normalizeGreenhouseForm(null, { board: "a", jobId: "1" })).toBeNull();
  });

  it("summarizes the writing burden", () => {
    expect(formSummary(form)).toEqual({ custom_questions: 3, writing_questions: 1, needs_cover_letter: false });
  });

  it("treats contact/identity fields as housekeeping, not writing", () => {
    expect(isWritingQuestion(form.questions.find((q) => q.label.startsWith("Why"))!)).toBe(true);
    expect(isWritingQuestion(form.questions.find((q) => q.label === "LinkedIn Profile")!)).toBe(false);
    // Selects are never writing questions, even when required.
    expect(isWritingQuestion(form.questions.find((q) => q.label.startsWith("Do you require"))!)).toBe(false);
  });
});
