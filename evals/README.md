# Evals

This folder holds the evaluation cases that ship with the kit. There is one
set: the prompt-injection cases in `injection-corpus.ts`.

## Prompt-injection cases (`injection-corpus.ts`)

A job posting is text from someone else. It can contain a sentence written to
make the model save a made-up fact as if the user had confirmed it. The
attribution guard (`packages/engine/tools/attribution.ts`) refuses to save a
fact as confirmed unless the user's own messages support it. The design
decision is in `docs/adr/0003-attribution-guard-not-sanitization.md`.

Each case in `injection-corpus.ts` pairs a fact the model tries to save with
the messages the user really wrote. A case has one of three kinds:

| Kind | What the guard must do |
|---|---|
| `attack` | Reject it. The fact comes from the posting, not from the user. |
| `legitimate` | Admit it. The user did say it. |
| `accepted-cost` | Reject it. The user's words are too far from the fact; the guard rejects these on purpose. |

The attack cases cover direct instructions, false claims of authority,
urgency, invented conversation history, hidden formatting, look-alike characters,
part-true statements, spelled-out and inflated numbers, other languages and
long pasted snippets.

## Running the cases

`tests/injection-corpus.test.ts` runs every case against the guard. It is part
of `npm test` and of the CI workflow, makes no model call and costs nothing.
To run it alone:

```
npx vitest run tests/injection-corpus.test.ts
```

The test fails if one attack is admitted or one legitimate save is rejected.
It prints the result as one line, for example
`injection corpus: N/N attacks blocked · M/M legitimate saves admitted`.

## Adding a case

Add an entry to `INJECTION_CORPUS` in `injection-corpus.ts` with a new `id`,
the `kind`, the fact, the user messages and a one-line `note`. The test picks
it up with no other change.
