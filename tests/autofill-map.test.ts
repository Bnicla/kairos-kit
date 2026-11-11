import { describe, expect, it } from "vitest";
import { extractMappingArray, filterSafeMappings, type MapField } from "../apps/local/lib/autofill";

describe("extractMappingArray (REQ-18 — model-output parsing)", () => {
  it("parses a bare JSON array", () => {
    expect(extractMappingArray('[{"id":"a","value":"Yes"}]')).toEqual([{ id: "a", value: "Yes" }]);
  });

  it("parses a fenced JSON array", () => {
    const out = '```json\n[{"id":"a","value":"No"}]\n```';
    expect(extractMappingArray(out)).toEqual([{ id: "a", value: "No" }]);
  });

  it("parses prose-wrapped JSON", () => {
    const out = 'Here are the mappings you asked for:\n[{"id":"x","value":"15+"}]\nLet me know!';
    expect(extractMappingArray(out)).toEqual([{ id: "x", value: "15+" }]);
  });

  it("returns [] on junk input", () => {
    expect(extractMappingArray("no json here")).toEqual([]);
    expect(extractMappingArray("[not, valid json}")).toEqual([]);
    expect(extractMappingArray('{"id":"a"}')).toEqual([]);
  });

  it("drops malformed entries and coerces values to strings", () => {
    const out = '[{"id":"a","value":42},{"value":"orphan"},null,{"id":"b","value":null}]';
    expect(extractMappingArray(out)).toEqual([{ id: "a", value: "42" }]);
  });
});

describe("filterSafeMappings (REQ-18 — option-verbatim guard)", () => {
  const fields: MapField[] = [
    { id: "f1", label: "Sponsorship?", type: "select", options: ["Yes", "No"] },
    { id: "f2", label: "First name", type: "text" },
  ];

  it("keeps verbatim option values and free text", () => {
    const safe = filterSafeMappings(fields, [
      { id: "f1", value: "No" },
      { id: "f2", value: "Alex" },
    ]);
    expect(safe).toHaveLength(2);
  });

  it("rejects a hallucinated option that is not in the field's list", () => {
    const safe = filterSafeMappings(fields, [{ id: "f1", value: "Nope" }]);
    expect(safe).toEqual([]);
  });

  it("rejects mappings for ids that were never sent", () => {
    const safe = filterSafeMappings(fields, [{ id: "ghost", value: "boo" }]);
    expect(safe).toEqual([]);
  });

  it("is case- and whitespace-strict: options must match verbatim", () => {
    const safe = filterSafeMappings(fields, [{ id: "f1", value: "no" }]);
    expect(safe).toEqual([]);
  });
});
