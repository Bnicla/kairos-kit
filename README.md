# Kairos Kit

Kairos Kit is a job-search system that runs inside Claude Code on your own Mac.
It keeps a knowledge base of your career built only from what you provide:
your résumé and other documents, a LinkedIn export, your answers to its
questions, and notes you add. Every fact keeps its source. From that knowledge
base it scores job postings, writes a tailored résumé for each application,
tracks applications on a board, and runs a daily job search across more than
10,000 public company job boards.

Claude Code is the agent. The kit adds what Claude Code needs to do this work
well:

- a local MCP server with 46 tools (`apps/local/mcp/server.ts`) that reads and
  writes the knowledge base, the applications and the settings;
- a skill (`.claude/skills/kairos/SKILL.md`) that holds the workflows: building
  the knowledge base, scoring, tailoring, cover letters, application answers,
  interview prep;
- nine slash commands (`/setup`, `/find`, `/score`, `/tailor`, `/letter`,
  `/prep`, `/apply`, `/status`, `/update`);
- code checks that every generated résumé, and every number in a cover letter,
  must pass before it is saved.

Your data is stored on your machine, in a data folder outside this repository
(`~/Kairos` by default). There is no Kairos server: the parts a task needs go
to Anthropic through Claude Code, under your own Claude plan (see "What is sent
to AI" below), and nowhere else.

## How it works

[docs/architecture.md](docs/architecture.md) shows how the parts fit together,
the data folder's layout, one application from posting to submitted form, and
the controls that keep the output true to the user's record. To report a
security problem, see [SECURITY.md](SECURITY.md).

## Design decisions

Each one is written up in `docs/adr`, with the context and the costs accepted.

| Record | Decision |
|---|---|
| [0001](docs/adr/0001-hand-rolled-agent-loop.md) | A plain tool-use loop, no agent framework. |
| [0002](docs/adr/0002-deterministic-gates-not-llm-judges.md) | The checks that decide whether a document is saved are code, not a model's judgment. A number in a résumé must appear word for word in the source it claims. |
| [0003](docs/adr/0003-attribution-guard-not-sanitization.md) | Against prompt injection from job postings, only the user can put a fact into the record. In the kit, every save of personal data (the record, form answers, application answers, stories, search settings) and every document read shows the user the full change, removals included, in a Claude Code confirmation the model cannot answer; nothing is saved or read without their Accept. |
| [0004](docs/adr/0004-provenance-memory-model.md) | Memory is readable Markdown where every fact is tagged with its source, not a vector store. Unverified facts are removed in code before evidence reaches a model; only the edit view of a role file keeps them, marked. |
| [0005](docs/adr/0005-model-routing-and-cost.md) | One registry decides which model each task uses; tasks where quality decides the outcome use the strongest model. |
| [0006](docs/adr/0006-structured-outputs-via-prompt-and-retry.md) | Structured output by JSON in the prompt, schema validation, and one retry with the errors fed back. |

Some records describe the hosted version of Kairos, which is not in this
repository. Where the kit works differently, the record says how in an
amendment (0003).

## Try it with the demo record (about ten minutes)

You need a Mac (macOS 14 or newer), Node.js 22.17 or newer, or 24 or newer
(`brew install node@22`), and Claude Code signed in with a Claude Pro or Max
plan.

```bash
git clone https://github.com/Bnicla/kairos-kit.git ~/kairos-kit
cd ~/kairos-kit
./install.sh --home ~/Kairos-demo --demo --no-dashboard --no-daily
claude
```

Approve the `kairos` MCP server when Claude Code asks. `demo/` is the record of
a made-up student, Jordan Example. In Claude Code, try:

- `/status`: the board of applications;
- `/score` with the link to any job posting: the fit against the record, with
  the gaps;
- `/tailor`: a tailored résumé for one application, with the table of which
  facts cover which requirements, and the checks.

Keep the kit outside `~/Documents`, `~/Desktop` and `~/Downloads`: macOS stops
background services from running scripts in those folders.

## Use it for your own search

```bash
./install.sh
claude
```

Then type `/setup`. It asks for your documents (or interviews you if you have
none) and fills every setting. Setup takes about twenty minutes.

`install.sh` installs the packages, creates the data folder, records it in
`.kairos-home`, writes `.mcp.json`, and asks whether to run the dashboard at
login and the job search every morning. Run `./install.sh --help` for the
options. It never changes a data folder that already exists, and it refuses a
folder holding a record it did not create unless you add `--use-existing`.

Optional:
- LibreOffice (`brew install --cask libreoffice`), for exact résumé page
  counts. Without it, page fit is estimated.
- The Claude in Chrome extension, connected to Claude Code, for `/apply`:
  Claude fills an application form open in your Chrome, one page at a time.
  You submit.

## Commands

| Command | What it does |
|---|---|
| `/setup` | First run: builds your knowledge base and settings. `/setup --section <name>` re-runs one part. |
| `/find` | Runs the job search now and shows the new matches. |
| `/score <link>` | Scores one job posting against your knowledge base. |
| `/tailor` | Writes a tailored résumé for one job, with the checks. |
| `/letter` | Writes a cover letter, only when you ask for one. |
| `/prep` | Interview prep for one application. |
| `/apply` | Fills an application form open in Chrome, one page at a time. You submit. |
| `/status` | The board: what is open and what needs action. |
| `/update` | Pulls the latest kit. Your data folder is not touched. |

You can also ask in plain words, for example "score this" with a job link.

## What is sent to AI

Claude Code sends Anthropic the parts of your knowledge base that a task needs,
under your own Claude plan and its terms. Nothing goes to the kit's author or
to any other server. The job search reads public job-board APIs (Greenhouse,
Lever, Ashby, Workday, SmartRecruiters, BambooHR) and sends them no personal
data.

## What is in here

| Path | What it is |
|---|---|
| `apps/local` | MCP server, dashboard (Next.js, port 3000, answers on this computer only) and the daily job-search scripts |
| `packages/engine` | Scoring, résumé checks, rendering, sourcing |
| `apps/autofill-extension` | Chrome extension that fills application forms from your knowledge base |
| `.claude/skills/kairos` | The skill that drives the workflows |
| `.claude/commands` | The slash commands |
| `docs/architecture.md` | How the parts fit together, and the controls |
| `docs/adr` | Design decisions |
| `evals` | Evaluation cases, including a prompt-injection set |
| `demo/` | The demo record |

## Status and limits

- macOS only. The MCP server is plain Node and may work elsewhere; the
  installer and the background services are macOS-specific.
- The kit is exported from the Kairos system its author uses every day for a
  real job search. The kit itself has not yet been tested by other users.
- The job search covers the job systems listed above. Postings on other sites
  can be added by link.

## Development

- Tests: `npm test`. Typecheck: `npm run typecheck`.
- Personal-data scan: `npm run scan`. CI runs it on every push.
- More: [Getting started](docs/getting-started.md).

## Licence

MIT. See [LICENSE](LICENSE). Built by Boris Nicolas.
