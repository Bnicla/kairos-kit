# ADR-0005: Task-keyed model registry; quality-load-bearing tasks pin to Opus

**Status:** accepted · 2026-08-29

## Context
Model choice was scattered as string literals; users of the cloud lane pay
with their own keys, making cost a product surface, not an ops detail.

## Decision
One registry (`apps/cloud/lib/models.ts`): interactive flows offer a curated
three-point speed/cost/quality picker defaulting to Sonnet; quality-load-
bearing tasks (KB extraction, scoring, generation, letters) pin to Opus via
`TASK_MODELS` regardless of the picker, with max-tokens and thinking settings
living beside the id.

## Why
1. **The guarded save path is only as good as its worst input.** Gates reject
   bad output, but retry loops on a weaker model burn the user's money to
   converge; pinning quality tasks is cheaper end-to-end than retrying.
2. **Zero literals outside the registry** makes model migrations one-line and
   prevents picker/call-site drift (the bug class the registry replaced).
3. **BYO-key transparency**: per-task defaults are documented where the user
   can read them; cost tracing (see `evals/`) makes spend per application a
   published number rather than a surprise.

## Consequences
- Opus pinning raises per-application cost; accepted deliberately, and
  revisited whenever the eval harness shows a cheaper model matching the gate
  pass-rates on fixtures.
