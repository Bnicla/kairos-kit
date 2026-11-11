# ADR-0001: Hand-rolled agent loop, no framework

**Status:** accepted · 2026-07 (recorded 2026-08-30)

## Context
The cloud lane needs a server-side tool-use loop (tailor/enrich/interview/
capture agents). LangGraph-style frameworks are the 2026 default and ship
checkpointing, memory abstractions, and graph topologies.

## Decision
A plain loop over `client.messages.stream(...)` with explicit tool dispatch —
roughly 60 lines per agent — and no orchestration framework.

## Why
1. **The guards are the product.** Attribution checks, style gates, and
   grounding rejection must sit BETWEEN the model's tool call and the write.
   In a framework these become middleware fighting the abstraction; in a plain
   loop they are ordinary `if` statements a reviewer can audit in one read.
2. **The loops are short and linear.** Six iterations max, no branching
   topology, no parallel nodes. A graph engine models complexity these agents
   deliberately do not have.
3. **Debuggability over features.** Every message in/out is a value in scope —
   trivially loggable, testable with a scripted mock (see
   `tests/tailor-agent.test.ts`), and free of framework version churn.

## Consequences
- We re-implement small things frameworks give free (transcript slicing,
  retry-on-bad-JSON). Accepted: they total tens of lines.
- If agents ever need real graphs (parallel tool fan-out, cross-agent
  hand-off), revisit — the tool-core seam (§9 of the cloud spec) keeps tools
  portable to any executor.
