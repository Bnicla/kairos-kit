# ADR-0003: Attribution guard, not input sanitization, against prompt injection

**Status:** accepted · 2026-08-29

## Context
The tailor agent reads job-ad snapshots (untrusted web text) while holding
write tools (`save_confirmed_fact`). A poisoned posting could instruct the
model to store fabricated "confirmed" facts — which the grounding gate would
then treat as truth forever (provenance poisoning). Classic defenses:
sanitize/filter the untrusted text, or detect injection with a classifier.

## Decision
Do not try to make the input safe. Instead, make the WRITE conditional on
attribution: content saved as candidate-confirmed must token-trace to something
the candidate actually typed in the chat transcript (fuzzy containment with a
strict rule for numbers), and no write is honored before the candidate's first
message of the session.

## Why
1. **Sanitization is a losing race** — injection phrasing is unbounded, and a
   filter that eats legitimate ad text degrades the product.
2. **The invariant is about provenance, not politeness.** The system's promise
   is "facts come from the candidate." Enforcing exactly that invariant at the
   write boundary covers every injection phrasing, including ones not invented
   yet.
3. **Defense in depth still applies**: the snapshot is delimited and labeled
   untrusted in the context (cheap), but the guard is the control.

## Consequences
- Legitimate paraphrase can be rejected when it drifts too far from the
  candidate's words; the error message tells the model to quote the candidate,
  which converges in one turn.
- Answer text (model-drafted, human-approved) cannot be word-attributed — so
  the QUESTION carries the attribution requirement instead. Recorded in code
  comments at the guard site.

## Amendment (2026-11-09): the Claude Code version
Where Claude Code runs the conversation (the local app and the Kit), the
Kairos MCP server receives tool calls but never the transcript, so it cannot
check a fact against what the candidate typed. There, the same invariant is
enforced by the user instead of by token overlap: every tool that puts facts
into the record (`save_confirmed_fact`, `save_experience`, `save_education`,
`save_metric`, `save_profile`) sends an MCP elicitation that Claude Code shows
to the user, with only the lines that are new against the file on record. The
write happens only on the user's Accept; a decline, a cancel, a timeout, a
non-interactive run, or a client without elicitation saves nothing
(`apps/local/lib/record-confirm.ts`). The model cannot answer an elicitation;
a user-configured Elicitation hook can, which is the user's own choice.
Cost accepted: one confirmation per save, also during first-run setup.
