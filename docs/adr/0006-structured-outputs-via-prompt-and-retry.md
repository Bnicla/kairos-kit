# ADR-0006: Structured outputs via prompt-JSON + zod validate-and-retry, not forced tool_choice

**Status:** accepted · 2026-08-30

## Context
Scoring and generation need machine-parseable JSON (ScoreReport, résumé
sections). The API offers two enforcement mechanisms: forcing a tool call
(`tool_choice: {type: "tool"}`) whose input_schema constrains the output, or
newer output-format constraints. Kairos instead asks for JSON in the prompt,
extracts it, validates with zod, and on failure retries once with the
validation issues fed back verbatim.

## Decision
Keep prompt-JSON + zod validate-and-retry as the structured-output mechanism
for scoring and generation. Do not force tool use for final outputs.

## Why
1. **Forced tool use is incompatible with adaptive thinking.** The quality-
   load-bearing tasks (ADR-0005) run with thinking enabled; forcing a tool
   call disables it. Reasoning quality on scoring honesty outranks
   schema-guarantee-by-construction.
2. **The retry loop is already the product's shape.** Deterministic gates
   (ADR-0002) feed findings back for one retry; schema validation is just the
   first gate in that chain. One mechanism, uniformly applied, uniformly
   evaluated (`evals/run-scoring.mts` mirrors it).
3. **zod is the single schema authority.** Types, runtime validation, and
   retry feedback all derive from one zod schema. A parallel JSON-Schema copy
   for the API layer is drift waiting to happen; zod 4's `z.toJSONSchema`
   would close that gap and is the ready migration path if constraint 1 lifts.

## Consequences
- A malformed response costs one extra model call instead of zero; eval runs
  show the retry converges (tier-2 scoring: 5/5 after one schema retry).
- Extraction from prose (`extractJson`) must stay tolerant of code fences and
  leading commentary; it is tested, but it is a parser we own.
- Revisit when the API supports output-format constraints alongside adaptive
  thinking; the zod schemas convert mechanically at that point.
