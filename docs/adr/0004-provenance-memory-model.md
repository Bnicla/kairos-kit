# ADR-0004: Provenance-tagged memory instead of a vector store

**Status:** accepted · 2026-06 (recorded 2026-08-30)

## Context
The knowledge base is the system's memory: the facts résumés are built from.
The 2026 default memory stack is embeddings + retrieval with saliency scoring.

## Decision
Memory is human-readable markdown with per-fact provenance tags — `[R]`
(verified against source documents), `[C]` (confirmed by the candidate in
conversation), `[?]` (extracted but unverified) — and one mechanical rule:
`stripUnverified` removes every `[?]` fact IN CODE before any evidence reaches
a model.

## Why
1. **The retrieval problem is small; the trust problem is existential.** The
   corpus is a few dozen KB — it fits in context whole. What matters is that a
   fabricated or unverified fact can never launder itself into a document.
2. **Auditability**: a recruiter-facing claim traces to a named file, section,
   and tag a human can read. Embeddings give similarity, not accountability.
3. **The tag is a write-path contract**: `save_confirmed_fact` is the only way
   content becomes `[C]`, and it sits behind the attribution guard (ADR-0003).

## Consequences
- No semantic retrieval means the Q&A bank currently reuses answers by
  recency; an embeddings layer over the bank (with a hit-rate eval) is a
  planned addition — for RANKING, never as the provenance mechanism.
- Context cost grows with the corpus; acceptable at personal scale, budgeted
  per-section for the student product.
