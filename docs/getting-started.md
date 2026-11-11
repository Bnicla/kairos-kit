# Getting started with Kairos Kit

## 0. Before you start

- A Mac on macOS 14 or newer, with `git`: `xcode-select --install`.
- Homebrew (brew.sh), then Node 22 (22.17 or newer) or 24: `brew install node@22`.
- Claude Code installed and signed in with a Claude Pro or Max plan. Run
  `claude` once in Terminal to check.
- Your résumé (PDF or DOCX). A LinkedIn export or other documents help.

## 1. Install

```bash
git clone https://github.com/Bnicla/kairos-kit.git ~/kairos-kit
cd ~/kairos-kit
./install.sh
```

The installer:

1. Checks Node (22 or newer), the Claude Code CLI and LibreOffice (optional).
2. Installs the packages (`npm ci`).
3. Creates the data folder. The default is `~/Kairos`; choose another with
   `--home <folder>`. An existing folder is used as it is, except that a
   folder holding a record this kit did not create is refused unless you add
   `--use-existing`.
4. Records the data folder in `.kairos-home`, in the kit folder. The Kairos
   server, the dashboard (`npm run dev`), `/find` and the scripts all read it,
   so they always use the same folder. `KAIROS_HOME`, when set, overrides it.
5. Writes `.mcp.json`, which tells Claude Code how to start the Kairos server.
6. Asks whether to run the dashboard at login and the job search every morning.
   Both are macOS launchd services: `com.kairos-kit.dashboard` and
   `com.kairos-kit.daily`. Flags: `--dashboard`, `--daily 08:15`.

## 2. First session

```bash
cd ~/kairos-kit
claude
```

Claude Code asks to approve the `kairos` MCP server the first time. Approve it.
Then type `/setup` and follow the questions; it can start from a documents folder, one résumé (PDF or DOCX), or an interview. Claude
extracts your roles, asks about anything unclear, and saves each fact with its
source. Add what the résumé leaves out: projects, results with numbers, tools.

Tell it what you are looking for: target titles, level, places, remote or not,
pay floor, industries and companies you will not consider. These go into
`sourcing/search-profile.json` in your data folder and drive the daily search.

## 3. Daily use

- **Score a posting:** paste a job link and ask "score this".
- **Tailor a résumé:** "tailor my résumé for this one". Claude writes it from
  your record, runs the checks (no invented claims, page fit, layout) and saves
  a DOCX and a PDF in the application's folder.
- **Cover letter:** only when you ask for one.
- **Fill an application form:** open the form in Chrome, then type `/apply`.
  Claude fills it one page at a time from your record, shows each page's plan
  and checks every field. It never signs in and never submits: you click
  Submit. It needs the Claude in Chrome extension connected to Claude Code.
  Answers a form needs that the record lacks (exact months, a title used on
  forms, a role to leave off) can be saved once and reused on every form.
- **The board:** open http://localhost:3000. Sourced jobs, drafts, applied,
  interviews, closed.
- **Daily search:** new matches appear in the Sourced column each morning. Run
  it by hand with `npm -w kairos-local run sourcing-run`.

The long-lived token for the daily run: the morning job runs without you
logged in, so it cannot use your Claude Code login. Run `claude setup-token`
and save the token in `~/.config/kairos/claude-oauth-token` (only you can read
it: `chmod 600`). Without it, the search still runs but the matches are not
ranked.

## 4. Where your data lives

Everything personal is in the data folder (`KAIROS_HOME`):

| Path | What it is |
|---|---|
| `profile.md` | Name, contact line, targets |
| `knowledge-base/` | Your record: experiences, education, voice, stories |
| `applications/` | One folder per application: posting, score, résumé, letter |
| `sourcing/` | Search profile and daily search results |
| `logs/` | Daily run and service logs |

Back it up like any folder you care about. Keep it out of public repositories.

## 5. Updating

Type `/update` in Claude Code. It pulls the latest kit, reinstalls the
packages, runs the tests and says what changed. By hand:

```bash
cd ~/kairos-kit
git pull
npm ci
```

Updates change only the code. Your data folder is not touched.

## 6. Troubleshooting

- **Claude does not see the Kairos tools:** start `claude` from the kit folder,
  and check that `.mcp.json` exists there (re-run `./install.sh --skip-npm`).
- **The dashboard does not load:** `launchctl kickstart -k gui/$(id -u)/com.kairos-kit.dashboard`,
  then read `$KAIROS_HOME/logs/com.kairos-kit.dashboard.err.log`.
- **The daily run did nothing:** read `$KAIROS_HOME/logs/daily.log`.
- **The dashboard or `/find` shows the wrong record:** `cat .kairos-home` in
  the kit folder shows the data folder in use. Re-run
  `./install.sh --skip-npm --home <folder>` to change it.
