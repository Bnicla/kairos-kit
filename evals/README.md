# Evals

Evaluation as infrastructure, in three tiers. The engine's deterministic gates
(grounding, style, layout) judge every document at write time; this directory
holds the harness that judges the *system*.

| Tier | What | Cost | When |
|---|---|---|---|
| **1 — Deterministic** | Gate pass-rates over fixtures; attribution guard vs an injection corpus | free | CI, every push |
| **2 — Model-judged** | Scoring-band expectations per fixture job ad; generation regression with retry counts | real API spend | on demand / nightly |
| **3 — Outcome calibration** | Predicted bands vs **real interview conversion** from the live application history | free | `npm run eval:calibration` |

## Tier 3 — outcome calibration (`run-calibration.mts`)

The eval that cannot be faked: every application stores the band the scorer
predicted *before* submission, and the world later supplies the label (recruiter
screen reached, rejected, expired, pending). The runner reads the application
history and reports conversion by band and by recommendation with Wilson 95%
intervals, small-n caveats stated, pending applications censored (and also
counted as failures in a published conservative rate, so young applications can
never flatter the number).

Methodology decisions live as comments in `packages/engine/calibration.ts`:
the positive label is *reaching any interview stage* (the scorer's actual
claim), and withdrawn applications are censored as candidate-choice.

Output is aggregate-only (no company names), so the table is publishable.

## Tier 1 — injection red team (`tests/injection-corpus.test.ts`, CI)

The attribution guard versus a 21-case corpus: 14 attack families (direct
instruction, fake authority, roleplay history, format smuggling, homoglyphs,
partial-truth blends, spelled-out and inflated numbers, cross-language,
snippet stuffing, turn-1 writes), 6 legitimate saves that must pass, and 1
pinned "accepted-cost" rejection that encodes the guard's boundary (far
synonym-drift is rejected by design — ADR-0003). Current result, asserted in
CI on every push: **14/14 attacks blocked · 6/6 legitimate saves admitted**.

## Tier 2 — model-judged runs (`run-scoring.mts`, `run-generation.mts`)

- `npm run eval:scoring` — the real scoring prompt over 5 fixture ads for a
  student-persona KB, asserting band-level expectations (a wrong-function ad
  must produce NOT_RECOMMENDED; a good-fit ad must not). Providers: `--cli`
  (Claude Code CLI, flat-rate) or `--api` (ANTHROPIC_API_KEY).
- `npm run eval:generation` — score → generate → the REAL guarded save path
  (grounding, style, length gates) with one findings-fed retry; reports gate
  outcomes and retry counts.
- Results land in `evals/out/` as dated JSON. Costs real model spend; not
  part of CI.
- **Latest scoring run (2026-08-30, CLI provider): 5/5 fixtures within
  expected bands** — good-fit ads scored STRONG/COMPETITIVE, the wrong-function
  and senior-mismatch ads correctly NOT_RECOMMENDED. The first run went 3/5
  and produced two findings, both kept in the history: the runner lacked
  production's validate-and-retry (added), and one fixture expectation was
  looser than the scorer's honest read (recalibrated, rationale in the
  fixture). Evals that never fail aren't measuring anything.
- **Latest generation run (2026-08-30, CLI provider): 2/2 fixtures pass the
  guarded save path** — and both passed on attempt 2, after a real gate catch
  on attempt 1 (one grounding rejection for a provenance source that isn't a
  KB experience, one style rejection for a lead-in that reads as a claim).
  That's the intended shape: the model drafts, the deterministic gates judge,
  the findings-fed retry converges.

## Cost tracing (`run-costs.mts`)

Cloud-lane SDK calls emit spans (task, model, tokens, latency, dollars from a
dated price table) to the user's own store; `npm run eval:costs` summarizes
totals, per-task spend, and per-application cost. The local CLI lane is
flat-rate Max and exposes no usage — untraced by design, never estimated.
