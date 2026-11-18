# Kairos Kit

Kairos Kit is a job-search system that runs inside Claude Code on your own
computer. It is built and tested on a Mac; a Windows installer is included and
is new (see "Status and limits"). It keeps a knowledge base of your career built only from what you provide:
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

Claude is your chief of staff for your job search. The work has six names, the
same in every form of Kairos:

| Specialist | The work | Command |
|---|---|---|
| Biographer | Builds and keeps your knowledge base. | `/setup` |
| Scout | Finds new job postings. | `/find` |
| Assessor | Scores a posting against your knowledge base and names the gaps. | `/score` |
| Writer | Writes the résumé, the cover letter and the answers to a form's questions. | `/tailor`, `/letter` |
| Networker | Shows who you know at a company and drafts a message to them. | `/message` |
| Interview Coach | Prepares an interview with you. | `/prep` |

The six are names on the work, not separate assistants: you talk to Claude,
and Claude says whose work a piece is ("the Assessor's score"). The board
(`/status`) and filling a form (`/apply`) are Claude's own.

Your data is stored on your machine, in a data folder outside this repository
(a folder named `Kairos` in your user folder by default: `~/Kairos`). There is no Kairos server: the parts a task needs go
to Anthropic through Claude Code, under your own Claude plan (see "What is sent
to AI" below), and nowhere else.

## How it works

[docs/architecture.md](docs/architecture.md) shows how the parts fit together,
the data folder's layout, one application from posting to submitted form, and
the controls that keep the output true to the user's knowledge base. To report a
security problem, see [SECURITY.md](SECURITY.md).

## Design decisions

Each one is written up in `docs/adr`, with the context and the costs accepted.

| Record | Decision |
|---|---|
| [0001](docs/adr/0001-hand-rolled-agent-loop.md) | A plain tool-use loop, no agent framework. |
| [0002](docs/adr/0002-deterministic-gates-not-llm-judges.md) | The checks that decide whether a document is saved are code, not a model's judgment. A number in a résumé must appear word for word in the source it claims. |
| [0003](docs/adr/0003-attribution-guard-not-sanitization.md) | Against prompt injection from job postings, only the user can put a fact into the knowledge base. In the kit, every save of personal data (the knowledge base, form answers, application answers, stories, search settings) and every document read shows the user the full change, removals included, in a Claude Code confirmation the model cannot answer; nothing is saved or read without their Accept. |
| [0004](docs/adr/0004-provenance-memory-model.md) | Memory is readable Markdown where every fact is tagged with its source, not a vector store. Unverified facts are removed in code before evidence reaches a model; only the edit view of a role file keeps them, marked. |
| [0005](docs/adr/0005-model-routing-and-cost.md) | One registry decides which model each task uses; tasks where quality decides the outcome use the strongest model. |
| [0006](docs/adr/0006-structured-outputs-via-prompt-and-retry.md) | Structured output by JSON in the prompt, schema validation, and one retry with the errors fed back. |

Some records describe the hosted version of Kairos, which is not in this
repository. Where the kit works differently, the knowledge base says how in an
amendment (0003).

## Try it with the demo knowledge base (about ten minutes)

You need Node.js 22.17 or newer, or 24 or newer, `git`, and Claude Code signed
in with a Claude Pro or Max plan.

On a Mac (macOS 14 or newer; Node with `brew install node@22`), in Terminal:

```bash
git clone https://github.com/Bnicla/kairos-kit.git ~/kairos-kit
cd ~/kairos-kit
./install.sh --home ~/Kairos-demo --demo --no-dashboard --no-daily
claude
```

On a Windows PC (Windows 10 or 11; Node from nodejs.org, Git for Windows from
git-scm.com), in PowerShell:

```powershell
cd $HOME
git clone https://github.com/Bnicla/kairos-kit.git
cd kairos-kit
node install.mjs --home $HOME\Kairos-demo --demo --no-dashboard --no-daily
claude
```

Approve the `kairos` MCP server when Claude Code asks. `demo/` is the knowledge base of
a made-up student, Jordan Example. In Claude Code, try:

- `/status`: the board of applications;
- `/score` with the link to any job posting: the fit against the knowledge base, with
  the gaps;
- `/tailor`: a tailored résumé for one application, with the table of which
  facts cover which requirements, and the checks.

On a Mac, keep the kit outside `~/Documents`, `~/Desktop` and `~/Downloads`:
macOS stops background services from running scripts in those folders. On
Windows, keep it outside any folder OneDrive syncs (often Documents and
Desktop): OneDrive tries to sync the package files and can lock them.

## Use it for your own search

```bash
./install.sh          # on a Mac
node install.mjs      # on Windows
claude
```

Then type `/setup`. One résumé and one job ad are enough to start: it builds
your knowledge base from the résumé, scores the ad and writes a résumé for that
job (with no résumé, it asks you a few short questions instead). It then asks
the two or three questions that would improve that résumé most. The rest of
the first run comes when you choose: it asks for your other documents and
fills every setting, which takes about twenty minutes.

The installer (`install.sh` on a Mac, `install.mjs` on Windows; same options)
installs the packages, creates the data folder, records it in `.kairos-home`,
writes `.mcp.json`, and asks whether to run the dashboard at login and the job
search every morning. Run it with `--help` for the options. It never changes a
data folder that already exists, and it refuses a folder holding a knowledge
base it did not create unless you add `--use-existing`.

Optional:
- LibreOffice (`brew install --cask libreoffice` on a Mac, the installer from
  libreoffice.org on Windows), for a PDF copy of each résumé beside the Word
  file. Without it you get the Word file only.
- poppler (`brew install poppler` on a Mac), with LibreOffice, for a page
  count measured on the rendered résumé. Without both, page fit is estimated
  from the word count. Windows has no standard installer for poppler; the
  measured count works there when `pdfinfo` and `pdftotext` are on your PATH.
- The Claude in Chrome extension, connected to Claude Code, for `/apply`:
  Claude fills an application form open in your Chrome, one page at a time.
  You submit.

## Commands

| Command | What it does | Whose work |
|---|---|---|
| `/setup` | First run: from one résumé and one job ad, your knowledge base and a first tailored résumé; then your settings. `/setup --section <name>` re-runs one part. | Biographer |
| `/find` | Runs the job search now and shows the new matches. | Scout |
| `/score <link>` | Scores one job posting against your knowledge base. | Assessor |
| `/tailor` | Writes a tailored résumé for one job, with the checks. | Writer |
| `/letter` | Writes a cover letter, only when you ask for one. | Writer |
| `/prep` | Interview prep for one application. | Interview Coach |
| `/apply` | Fills an application form open in Chrome, one page at a time. You submit. | Claude |
| `/status` | The board: what is open and what needs action. | Claude |
| `/update` | Pulls the latest kit. Your data folder is not touched. | Claude |

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
| `demo/` | The demo knowledge base |

## Status and limits

- Built and tested on a Mac (macOS 14 or newer). The kit is exported from the
  Kairos system its author uses every day, on a Mac, for a real job search.
- Windows 10 and 11 (PowerShell or Command Prompt, with Git for Windows) are
  supported by `install.mjs` and by Windows versions of the daily search and of
  the dashboard's start. This is new: the kit's tests run on Windows in this
  repository's CI on every push, and it has not yet been used by a person on a
  PC. Please report what does not work.
- Linux, and Linux inside Windows (WSL): the MCP server, the dashboard and the
  scripts are plain Node, and the tests run on Linux in CI. `node install.mjs`
  installs the packages and the data folder there; nothing is set up to run in
  the background.
- The kit itself has not yet been tested by other users.
- The job search covers the job systems listed above. Postings on other sites
  can be added by link.

## Development

- Tests: `npm test`. Typecheck: `npm run typecheck`.
- Personal-data scan: `npm run scan`. CI runs it on every push.
- More: [Getting started](docs/getting-started.md).

## Licence

MIT. See [LICENSE](LICENSE). Built by Boris Nicolas.
