import { describe, expect, it } from "vitest";
import { computeHealth } from "@kairos/engine/health";
import { parseExperience } from "@kairos/engine/kb/experience";
import { recordWords, sayRecord, saysRecord, worded, wordedText } from "@kairos/engine/wording";

/**
 * The product's word for what Kairos holds about the user (packages/engine/wording.ts):
 * "knowledge base" in the local product, "record" once the connector has started.
 * The tests run in order: the setting can only be turned on. All text is fictional.
 */
describe("the engine's fixed sentences in the product's words", () => {
  const userLine = "Built the knowledge base the support team searches (the KB), 400 articles.";
  const experience = () =>
    parseExperience(
      "01-support.md",
      `---\nid: support\ncompany: KB Home Services\ntitle: Support Engineer\nstart: '2024'\nend: present\n---\n\n## Achievements\n- ${userLine} [R]\n- Leveraged robust synergies — spearheaded things. [R]\n`,
    );

  it("the local product: every sentence is as it is written", () => {
    expect(saysRecord()).toBe(false);
    expect(worded`"${userLine}" is not a knowledge-base experience (use a file name from the KB)`).toBe(`"${userLine}" is not a knowledge-base experience (use a file name from the KB)`);
    expect(wordedText("From their knowledge base. The KB file name.")).toBe("From their knowledge base. The KB file name.");
    expect(JSON.stringify(computeHealth([experience()]))).toContain("across the knowledge base.");
  });

  it("the connector: the fixed parts say \"record\", a value put into a sentence is never changed", () => {
    sayRecord();
    expect(saysRecord()).toBe(true);
    expect(worded`"${userLine}" is not a knowledge-base experience (use a file name from the KB)`).toBe(`"${userLine}" is not a record experience (use a file name from the record)`);
    expect(worded`knowledge-base/experiences/${"kb-notes.md"}`).toBe("record/experiences/kb-notes.md");
    expect(worded`No experiences in the knowledge base yet.`).toBe("No experiences in the record yet.");
    expect(worded`${"KB Home Services"} and ${"the knowledge base"}`).toBe("KB Home Services and the knowledge base");
    expect(recordWords("Knowledge base, knowledge-base text, 150 KB, a KBase, kb.education")).toBe("Record, record text, 150 record, a KBase, kb.education");
    expect(wordedText("From their knowledge base. The KB file name.")).toBe("From their record. The record file name.");
    // A report of the engine: its own sentence says "record".
    const report = JSON.stringify(computeHealth([experience()]));
    expect(report).toContain("across the record.");
    expect(report).not.toContain("across the knowledge base.");
  });
});
