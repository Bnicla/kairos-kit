import { describe, expect, it } from "vitest";
import { checkAttribution } from "@kairos/engine/tools/attribution";
import { INJECTION_CORPUS } from "../evals/injection-corpus";

/**
 * Tier-1 red-team eval, run in CI on every push: the attribution guard versus
 * the full injection corpus. Both directions are asserted — every attack
 * rejected AND every legitimate save admitted — and the corpus-wide pass rate
 * is printed so the number in the README stays a measured fact.
 */

describe("attribution guard vs injection corpus (tier-1 red team)", () => {
  const attacks = INJECTION_CORPUS.filter((c) => c.kind === "attack");
  const legit = INJECTION_CORPUS.filter((c) => c.kind === "legitimate");
  const costs = INJECTION_CORPUS.filter((c) => c.kind === "accepted-cost");

  it.each(attacks.map((c) => [c.id, c] as const))("rejects %s", (_id, c) => {
    const r = checkAttribution(c.factToSave, c.userMessages);
    expect(r.attributed, `${c.id} (${c.note}) should be REJECTED but passed`).toBe(false);
  });

  it.each(legit.map((c) => [c.id, c] as const))("admits %s", (_id, c) => {
    const r = checkAttribution(c.factToSave, c.userMessages);
    expect(r.attributed, `${c.id} (${c.note}) should be ADMITTED but was rejected: ${r.reason}`).toBe(true);
  });

  it.each(costs.map((c) => [c.id, c] as const))("still rejects %s (documented accepted cost)", (_id, c) => {
    const r = checkAttribution(c.factToSave, c.userMessages);
    expect(r.attributed, `${c.id} is a PINNED rejection (${c.note}); if the guard now admits it, the boundary moved — re-review ADR-0003`).toBe(false);
  });

  it("reports the corpus-wide result", () => {
    const blocked = attacks.filter((c) => !checkAttribution(c.factToSave, c.userMessages).attributed).length;
    const admitted = legit.filter((c) => checkAttribution(c.factToSave, c.userMessages).attributed).length;
    // eslint-disable-next-line no-console
    console.log(
      `injection corpus: ${blocked}/${attacks.length} attacks blocked · ${admitted}/${legit.length} legitimate saves admitted`,
    );
    expect(blocked).toBe(attacks.length);
    expect(admitted).toBe(legit.length);
  });
});
