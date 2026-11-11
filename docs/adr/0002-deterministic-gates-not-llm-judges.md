# ADR-0002: Deterministic gates at write time, LLM judgment only upstream

**Status:** accepted · 2026-07 (recorded 2026-08-30)

## Context
Generated documents need quality control. The 2026 default is LLM-as-a-judge
everywhere, including as the shipping gate.

## Decision
Every write-time gate is deterministic code: grounding audit (metric tokens
must exist verbatim in the claimed provenance source), style rules (banned
vocabulary, em-dash ban, lead-in grammar), word floors, and a LibreOffice
layout probe that measures real rendered pages. LLM judgment runs UPSTREAM
(scoring, triage) where its output is advisory, never as the final arbiter of
what ships.

## Why
1. **A gate you cannot argue with.** The failure mode this system exists to
   prevent is a persuasive fabrication. An LLM judge can be persuaded; a
   token-set intersection cannot.
2. **Free and instant** — gates run on every save and inside retry loops
   (generation converges against the layout probe in 1–3 attempts). An LLM
   judge at that frequency costs real money and adds variance.
3. **Testable to exhaustion.** The gates carry ~90 unit tests including
   adversarial fixtures. Equivalent coverage of a judge model is not possible.

## Consequences
- Deterministic gates miss semantic problems (a grounded-but-misleading
  sentence). Accepted: the human review step and the upstream honest-scoring
  prompt own semantics; the gates own verifiability.
- Style rules needed an escape valve for legitimate context (the
  "orchestration near AI vocabulary" carve-out) — context-sensitivity is
  encoded as code, not delegated to a model.
