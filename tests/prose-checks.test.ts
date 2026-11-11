import { describe, expect, it } from "vitest";
import { checkProse, hardProseViolations, letterBody } from "@kairos/engine/tools/prose-checks";

/**
 * Regression cases come from real drafts rejected as "AI sloppy"
 * (a cover letter, 2026-10-09): two attention hooks, a "Here's why" set-up,
 * a mic-drop line, and stock closers all passed the old vocabulary-only gate.
 */
const wrap = (body: string) => `Jane Doe\nDenver\n\nOctober 9, 2026\n\nDear Hiring Team,\n\n${body}\n\nBest regards,\n\nJane Doe`;
const rules = (body: string, jobText?: string) => checkProse(wrap(body), { jobText }).map((v) => v.rule);

describe("checkProse", () => {
  it("rejects repeated attention hooks (the 'caught my attention' + 'stood out to me' draft)", () => {
    const r = rules("Your AI Platform role caught my attention because it matches my work at Northwind. One line in your posting stood out to me: decisions made once at the gateway.");
    expect(r).toContain("attention-hook");
    expect(r).toContain("hook-repeated");
  });

  it("rejects reveal set-ups and mic-drop one-liners", () => {
    const r = rules("Your posting says decisions belong at the gateway. Here's why I agree. The gate did say no. Review time went from 12 working days to 5 across 20+ teams.");
    expect(r).toContain("reveal-setup");
    expect(r).toContain("mic-drop");
  });

  it("rejects stock closers and fit-flattery", () => {
    const r = rules("I owned the readiness gate for every model release outside the US. This role is the perfect fit, and I'd welcome the chance to discuss it.");
    expect(r).toEqual(expect.arrayContaining(["stock-closer", "sycophancy"]));
  });

  it("rejects contrastive reframes and significance tails (Antislop / Wikipedia families)", () => {
    const r = rules("Atlas was built on a hosted model platform, highlighting our cloud depth. It's not a gateway problem. It's a trust problem at Brightpath scale with 97% uptime.");
    expect(r).toEqual(expect.arrayContaining(["significance-tail", "contrastive-reframe"]));
  });

  it("passes a plain, fact-carrying letter with a bullet block", () => {
    const body = [
      "Acme is putting every model and agent call behind one gateway. I did a smaller version of that at Brightpath, where we built Atlas on a hosted model platform and had to migrate off a preview model the vendor deprecated mid-build.",
      "A few specifics from that work and from Northwind:",
      "- **Eval-gated releases:** I owned the go/no-go gate for every Northwind model release outside the US, with each market held within 15% of US performance on four metrics.\n- **Agent guardrails:** when testing showed the Atlas agent over-trusting uploaded documents, I made verification against the source records a required step.",
      "I have not run self-hosted model serving in production, and would be learning that part of the stack.",
    ].join("\n\n");
    expect(hardProseViolations(checkProse(wrap(body)))).toEqual([]);
  });

  it("rejects a body-first letter with a placeholder after the greeting (generated 2026-10-09)", () => {
    const misordered = `At Brightpath I led product delivery for Atlas, the system that let a clinic bring up to 50,000 records into one case file, and we set two launch gates before launch: import above 90% and search at parity, checked against what the agent actually does, not just what it reports.

Jane Doe
Denver

October 9, 2026

Dear Hiring Manager,

[The above three paragraphs are the body.]

Jane Doe`;
    const v = checkProse(misordered);
    expect(v.filter((x) => x.rule === "structure").length).toBeGreaterThanOrEqual(2);
    expect(v.map((x) => x.rule)).toContain("contrastive-reframe"); // the misplaced body is still checked
  });

  it("strips header, greeting and sign-off before checking", () => {
    expect(letterBody(wrap("Body sentence with enough words in it."))).toBe("Body sentence with enough words in it.");
  });

  it("warns (softly) when several sentences copy the posting verbatim", () => {
    const job = "Own the vision for a governed model-agnostic gateway that all model and agent traffic routes through";
    const v = checkProse(
      wrap("I want to own the vision for a governed model-agnostic gateway that all teams use. I would build a governed model-agnostic gateway that all model and agent traffic routes through."),
      { jobText: job },
    );
    expect(v.find((x) => x.rule === "jd-parroting")?.hard).toBe(false);
  });
});
