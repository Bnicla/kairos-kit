# Getting started with Kairos Kit

## 0. Before you start

On a Mac:

- macOS 14 or newer, with `git`: `xcode-select --install`.
- Homebrew (brew.sh), then Node 22 (22.17 or newer) or 24: `brew install node@22`.

On a Windows PC (the Windows installer is new; the README's "Status and limits"
says what has been tested):

- Windows 10 or 11.
- Git for Windows, from git-scm.com. Claude Code on Windows uses the Git Bash
  that comes with it.
- Node 22 (22.17 or newer) or 24, from nodejs.org.

On both:

- Claude Code installed and signed in with a Claude Pro or Max plan. Run
  `claude` once in Terminal (Mac) or PowerShell (Windows) to check.
- Your résumé (PDF or DOCX). A LinkedIn export or other documents help.

## 1. Install

On a Mac, in Terminal:

```bash
git clone https://github.com/Bnicla/kairos-kit.git ~/kairos-kit
cd ~/kairos-kit
./install.sh
```

On Windows, in PowerShell:

```powershell
cd $HOME
git clone https://github.com/Bnicla/kairos-kit.git
cd kairos-kit
node install.mjs
```

On Windows, keep the kit outside any folder OneDrive syncs (often Documents
and Desktop). The commands in the rest of this guide (`claude`, `npm`, `git`)
are the same on both; where this guide says `./install.sh`, use
`node install.mjs` on Windows, with the same options.

The installer:

1. Checks Node (22 or newer), the Claude Code CLI and LibreOffice (optional).
2. Installs the packages (`npm ci`).
3. Creates the data folder. The default is `~/Kairos` (on Windows, `Kairos` in
   your user folder, for example `C:\Users\you\Kairos`); choose another with
   `--home <folder>`. An existing folder is used as it is, except that a
   folder holding a knowledge base this kit did not create is refused unless you add
   `--use-existing`.
4. Records the data folder in `.kairos-home`, in the kit folder. The Kairos
   server, the dashboard (`npm run dev`), `/find` and the scripts all read it,
   so they always use the same folder. `KAIROS_HOME`, when set, overrides it.
5. Writes `.mcp.json`, which tells Claude Code how to start the Kairos server.
6. Asks whether to run the dashboard at login and the job search every morning.
   Flags: `--dashboard`, `--daily 08:15`.
   - On a Mac both are launchd services: `com.kairos-kit.dashboard` and
     `com.kairos-kit.daily`.
   - On Windows the daily search is a task in Task Scheduler, "Kairos Kit daily
     search", which runs while you are signed in, also on battery, and at the
     next chance when the PC was off or asleep at that time. A window named
     "Kairos Kit daily search" is open while it runs and closes by itself. The
     dashboard is a file in your Startup folder, "Kairos Kit dashboard.cmd",
     which starts it in a minimized window when you sign in; closing that
     window stops the dashboard. To remove them:
     `node install.mjs --schedule-only --no-daily`, and delete the file.

## 2. First session

```bash
cd ~/kairos-kit
claude
```

Claude Code asks to approve the `kairos` MCP server the first time. Approve it.
Then type `/setup`. It starts with the quick start: give it one résumé (PDF or
DOCX) and one job ad, and you get a résumé written for that job. With no
résumé, it asks you a few short questions instead. Claude extracts your roles
and saves each fact with its source, then asks the two or three questions that
would improve that résumé most. The rest of the first run comes when you
choose: it can read a documents folder, asks about anything unclear, and fills
every setting. Add what the résumé leaves out: projects, results with numbers,
tools.

Claude is your chief of staff for your job search. The work has six names
(Biographer, Scout, Assessor, Writer, Networker, Interview Coach), listed with
their commands in the README. This first run is the Biographer's work.

Tell it what you are looking for: target titles, level, places, remote or not,
pay floor, industries and companies you will not consider. These go into
`sourcing/search-profile.json` in your data folder and drive the daily search.

## 3. Daily use

- **Score a posting (Assessor):** paste a job link and ask "score this".
- **Tailor a résumé (Writer):** "tailor my résumé for this one". Claude writes it from
  your knowledge base, runs the checks (no invented claims, page fit, layout) and saves
  a DOCX and a PDF in the application's folder.
- **Cover letter (Writer):** only when you ask for one.
- **Fill an application form:** open the form in Chrome, then type `/apply`.
  Claude fills it one page at a time from your knowledge base, shows each page's plan
  and checks every field. It never signs in and never submits: you click
  Submit. It needs the Claude in Chrome extension connected to Claude Code.
  Answers a form needs that the knowledge base lacks (exact months, a title used on
  forms, a role to leave off) can be saved once and reused on every form.
- **The board:** open http://localhost:3000. Sourced jobs, drafts, applied,
  interviews, closed.
- **Daily search (Scout):** new matches appear in the Sourced column each morning. Run
  it by hand with `npm -w kairos-local run sourcing-run`.

The long-lived token for the daily run: on a Mac the morning job runs outside
your login session, so it cannot use your Claude Code login. Run
`claude setup-token` and save the token in
`~/.config/kairos/claude-oauth-token` (only you can read it: `chmod 600`).
Without it, the search still runs but the matches are not ranked. On Windows
the task runs in your own session, where Claude Code keeps your sign-in in a
file, so it is expected to work without the token; this has not been confirmed
on a PC yet. If the morning's matches come unranked, save the token in
`.config\kairos\claude-oauth-token` under your user folder.

## 4. Where your data lives

Everything personal is in the data folder (`KAIROS_HOME`):

| Path | What it is |
|---|---|
| `profile.md` | Name, contact line, targets |
| `knowledge-base/` | Your knowledge base: experiences, education, voice, stories |
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
  and check that `.mcp.json` exists there (re-run the installer with
  `--skip-npm`).
- **The dashboard does not load:** on a Mac,
  `launchctl kickstart -k gui/$(id -u)/com.kairos-kit.dashboard`, then read
  `logs/com.kairos-kit.dashboard.err.log` in the data folder. On Windows, look
  for the minimized window named "Kairos Kit dashboard" and read what it says;
  if there is none, run `npm run dev` in the kit folder.
- **The daily run did nothing:** read `logs/daily.log` in the data folder. On
  Windows, also open Task Scheduler and look at the last result of "Kairos Kit
  daily search".
- **The dashboard or `/find` shows the wrong knowledge base:** the file
  `.kairos-home` in the kit folder holds the data folder in use. Re-run the
  installer with `--skip-npm --home <folder>` to change it.
- **No PDF beside the Word file:** LibreOffice was not found. Install it from
  libreoffice.org, or set `SOFFICE_PATH` to its `soffice` program
  (`soffice.exe` on Windows) if it is installed somewhere unusual.
