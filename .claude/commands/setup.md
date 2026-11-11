---
description: First run. Builds your Kairos record and settings from your documents or an interview. Re-run one part with /setup --section <name>.
argument-hint: "[--section <name>]"
---

# /setup: the first-run interview

You are running Kairos's first-run interview for a student or early-career job
seeker. Arguments: `$ARGUMENTS`

The student's answers live ONLY in their data folder (`KAIROS_HOME`, default
`~/Kairos`), written through the `kairos` MCP tools. Never write their answers
into this repository: no edits to code, commands, CLAUDE.md or the skill.

If the `kairos` MCP tools are not available, say: "The Kairos tools are not
connected. Start Claude Code from the kit folder and approve the kairos server
when asked." Then stop.

## How to talk

- Plain, literal sentences. No jargon, no field names, no file formats in what
  you say to the student, except when you list the files written at the end.
- One topic at a time. Ask, then wait. Short questions with an example answer.
- Never invent a fact. Everything saved comes from a document or from what the
  student told you. If they do not know, leave it out and say what the default is.
- Before each section, say its number and name ("Part 8 of 14: places").
- After each section, say in one or two lines what you saved.

## Rules for saving (every section)

1. **Every fact keeps its source.** Facts read from a document are tagged `[R]`;
   facts the student tells you are tagged `[C]`. Pass `sources` to
   `save_experience` and `save_education`: the document names, or
   `interview <YYYY-MM-DD>` for answers.
2. **Compare before saving.** After extracting, and before any save, call
   `reconcile_sources` with what every document (and the interview so far) says.
3. **Disagreements become numbered questions.** If `reconcile_sources` returns
   `questions`, show them all in one message, numbered as returned, each with
   the options and which document says what. Wait for the answers. Save nothing
   about a role or school that has an open question.
4. **Additions and conflicts stay apart.** Items with status `additive` (the
   record has them; a new document only adds a date, a place or a source) go in
   their own short list: "These would be added to what you already have:".
   Ask once for approval of the whole list; apply only what they approve.
5. **Re-runs never overwrite silently.** New files: `save_experience` /
   `save_education` with `expect_new: true`. An existing file is re-saved only
   after the student approved the change: `read_experience` first, change only
   the approved parts, keep everything else, then save with the merged
   `sources`. `unchanged` items are not saved again.
6. After saving experiences, call `rebuild_index`.
7. **Each save to the record shows a Claude Code confirmation.** Before the
   first one, tell the student: "Each time I save something to your record,
   Claude Code shows you exactly what would be saved. Accept only what is
   true." A declined save is not retried unless they ask.
7. At the end of each section call `mark_setup_section` with `done`, or with
   `skipped` when the student chose to skip it. Skipped settings keep their
   stated defaults (`setup_status` shows them under `unset`).
8. Search settings: every `save_search_profile` call passes
   `source: "confirmed"` and only the fields that changed (the save merges).

## Step 0: the data folder and the install

Call `setup_status({ init: true, check_install: true })`.

- Say where the data folder is. If it was just created: "I created your data
  folder at <path>. Everything you tell me is saved there, on this computer."
  If it already holds a record: "You already have a record at <path>. I will add
  to it and ask before changing anything."
- Install: if `install.warnings` is not empty, read each one out plainly.
  LibreOffice missing is not a problem: say résumés will export as Word files
  and page fit will be estimated.
- If `install.repo.warning` is set (a public fork), read it out and ask the
  student to make the fork private before going further. Continue if they say so.
- With `--section <name>`: go straight to that section (name or number, listed
  below), run only it, then do "The end". Otherwise, if `next_section` is not the
  first section, say which parts are done and continue from `next_section`.

## Step 1: choose a way in

Skip this step when the record already has experiences and the student is
re-running. Otherwise ask:

"How would you like to start?
 A. Point me to a folder with your documents: résumé, LinkedIn data export, transcripts.
 B. Give me one résumé (PDF, Word or text file).
 C. No documents: I ask you questions and build it from your answers."

Record the choice with `mark_setup_section({ section: "identity", status: ...})`
only at the end of part 1; pass `path: "A" | "B" | "C"` on that first call.

**A. A documents folder.** Ask for the folder path. Call
`list_source_documents({ folder })` and show the list with what each file looks
like (résumé, LinkedIn export, transcript, other). Ask which to use. For a
LinkedIn export, explain how to get one if they do not have it yet: LinkedIn,
Settings, Data privacy, Get a copy of your data; the .zip or the folder both
work. Then for each document: `prepare_extraction({ path })`, follow the
returned `system_prompt`, and produce the ExtractionResult JSON. Do not save yet.
A transcript gives education only.

**B. One résumé.** Ask for the file path. `prepare_extraction({ path })`, follow
the `system_prompt`, produce the ExtractionResult. Do not save yet.

**C. An interview.** Parts 1 to 4 become the interview. Build each role from
the answers, every bullet tagged `[C]`, source `interview <date>`. Ask for the
roles one at a time: organization, title, start and end month, what they
personally did, results with numbers, tools. Projects, clubs, teaching and
volunteering count as experiences when they have substance.

Then, for A and B: call `reconcile_sources` with one entry per document
(`source` = the file name; `candidate`, `experiences` with company, title,
start, end, location; `education`). Ask the numbered questions, show the
additive list, and save as the rules above say:

- each role: `save_experience({ fileName, frontmatter, body, sources, expect_new: true })`,
  using the answers to the questions for titles and dates;
- each school: `save_education({ ..., sources, expect_new: true })`;
- the voice profile from the résumé: `save_voice_profile`;
- name, contact line and headline: part 1.

## The 14 parts

Each part can be run alone with `/setup --section <name>`. Names in backticks.

### 1. Identity and contact (`identity`)
Confirm or ask: full name; contact line (email · phone · city · LinkedIn URL);
a headline for the top of the résumé (offer one built from their record, e.g.
"Statistics Graduate, Data Analysis"); languages with level; work authorization
("Are you allowed to work in <country> without a visa? Will you need sponsorship
now or later?").
Save: `save_profile({ name, contact_line, headline, languages, preferences: { work_authorization } })`
and `save_autofill({ contact: { full_name, email, phone }, links: { linkedin, github, portfolio }, work_authorization: { ... } })`.

### 2. Education and certifications (`education`)
Confirm each school: degree, field, dates, honors. Ask about certifications
(each one is its own education entry). Coursework only when it matters for the
roles they want. Save with `save_education` (sources, `expect_new` for new files).

### 3. Experience (`experience`)
Go through each role, most recent first. For each: what they personally built
or did (their part, not the team's), results with numbers, tools used. For the
one or two roles that matter most for their goals, call
`get_enrichment_questions({ fileName })` and ask those questions; store each
real answer with `save_confirmed_fact`. Ask whether anything is missing:
projects, research, clubs, part-time jobs.
Every number gets a metrics entry: `save_metric({ section: "<Organization> (<file>)", name, status, status_note: "[C] <date>", details })`.
Status DEFENDED when they can say the starting point and how it was measured;
PARTIAL when one side is missing; OPEN when they are not sure. Explain once:
"Only numbers you can back up go on a résumé."

### 4. Skills (`skills`)
Show the skills found, grouped by role. Ask which are wrong, and which are
missing. Every added skill must be tied to a role where they used it: re-save
that role with the skill (`prov: "C"`) after `read_experience`, or add a
"Skills note" with `save_confirmed_fact`.

### 5. Goals and target titles (`goals`)
First the work: "What would you like to spend your days doing?" Then titles.
Propose three to five nearby titles they may not have thought of (for a data
analyst: product analyst, business analyst, analytics engineer, operations
analyst) and let them choose. Ask about industries or topics that interest them.
Save: `save_profile({ target_roles, domains })` and
`save_search_profile({ function_terms, boost_terms, source: "confirmed" })`.
Function terms are the title words a job must contain: keep the list short
(e.g. "analyst", "analytics"). Never a lone generic word such as "engineer",
"manager", "associate" or "specialist": it lets in every software engineer or
sales associate. Keep the whole phrase instead ("analytics engineer").
Say so if a choice would hide most jobs.

### 6. Role shape and seniority (`level`)
Level they target (internship, entry level or new graduate, associate, mid
level) and the level they will not go above. Shape: individual work, leading a
small team, or a mix.
Save: `save_profile({ target_seniority, role_shape_preference })` and
`save_search_profile({ seniority_terms, seniority_ceiling, notes, source: "confirmed" })`.
For internship searches, remind them that part 7 removes "intern" from the
excluded words.

### 7. Deal-breakers (`dealbreakers`)
Industries, companies and kinds of role they will not consider.
Save: `save_profile({ deal_breakers })` and `save_search_profile({ exclude_terms,
excluded_companies, triage_rules, source: "confirmed" })`. Title words go in
`exclude_terms` (the default excludes intern, internship, junior, coordinator,
apprentice: change it for internship or junior searches); company names in
`excluded_companies` (lowercase); industries and anything else in plain
sentences in `triage_rules`.

### 8. Places (`places`)
Where they live or want to work; remote, hybrid or onsite; would they move, and
where; places that are out; jobs abroad yes or no.
Save: `save_profile({ preferences: { location, remote, relocation } })` and
`save_search_profile({ locations, secondary_locations, excluded_locations,
international_ok, relocation: { open, places }, source: "confirmed" })`.
`locations` are lowercase place words: city, metro name, full state name
("denver", "greater denver", "colorado"). A two-letter state code only
with a city ("boulder, co"), never alone. Places they would move to for a
strong fit go in `secondary_locations`, written the same way. A region they
rule out ("the South", "the West Coast") is not a place word: read the states
back to them ("Texas, Florida, Georgia, ... Is that what you mean?") and save
the full state names and their largest cities in `excluded_locations`.

### 9. Pay floor (`pay`)
"What is the lowest base pay you would accept?" Ask whether it differs for
expensive cities. If they are not sure, offer to skip: there is no floor by
default, and they can add one later with `/setup --section pay`.
Save: `save_profile({ preferences: { pay_floor } })` (their words) and
`save_search_profile({ pay_floor: { amount, currency, period, by_location }, source: "confirmed" })`.

### 10. Dream companies (`companies`)
Companies whose own career sites are checked every day. For each: find the job
system from the careers page address. `boards.greenhouse.io/<id>` or
`job-boards.greenhouse.io/<id>` → greenhouse; `jobs.ashbyhq.com/<id>` → ashby;
`jobs.lever.co/<id>` → lever. Otherwise use `ats: "browser"` with the careers
page `url` (a reminder to check it by hand). Then ask for companies to rank
higher in the daily search (lowercase names).
Save: `save_search_profile({ dream_companies: [ { name, ats, slug } ], watched_companies, source: "confirmed" })`
with the complete lists.

### 11. Writing voice (`voice`)
Ask for two or three things they wrote themselves: a letter, an email, a post,
a class essay. Not text written by a tool and not a template. Store them
verbatim: `save_writing_samples({ samples: [ { title, text, imitate, avoid } ] })`.
Ask for words or phrases they never want in their letters ("passionate",
"leverage"): `save_profile({ voice: { banned_patterns } })`. Then write or
update the voice profile with `save_voice_profile`, from the samples and, if
there is one, the résumé. On path C this is the first voice profile: a résumé is
not needed for it.

### 12. Résumé format (`resume`)
Page target: one page is the norm for students. Two pages only with several
years of experience; then ask which role should open page 2.
Save: `save_profile({ target_pages, resume_page2_anchor })`. Ask what education
details to show (GPA, coursework, honors) and update the education entries with
`save_education` after they approve. The standing base résumé is set later,
after the first tailored résumé.

### 13. Application form answers (`forms`)
Optional; say so. Mailing address; standard answers (earliest start date, how
they heard about jobs, notice period); EEO questions (gender, ethnicity,
veteran, disability) only if they want the browser extension to fill them, and
only with the answers they give, never guessed.
Save: `save_autofill({ address, common_answers, eeo, share_eeo, defaults: { never_auto_submit: true } })`.
`share_eeo` is true only when they say yes to filling those questions.

### 14. Daily search (`daily`)
Daily job search on or off; the time it runs; how fresh postings must be (7
days by default); how many new jobs the board shows (10 by default).
Save: `save_search_profile({ daily_run: { enabled, time: "HH:MM" }, max_age_days, board: { max_sourced_cards }, source: "confirmed" })`.
Saving the setting does not schedule anything on the Mac. Ask: "Shall I set
the schedule on this Mac now? You will see a permission prompt for the command."
On yes, run in the kit folder, with the Bash tool:
`./install.sh --schedule-only --daily HH:MM` (or `./install.sh --schedule-only
--no-daily` when they turned it off). Read its last line back. If it fails, say
so plainly, quote the error, and tell them the same command can be run by hand.
Then tell them the three things to check later: the setting (saved), the
schedule (installed or not), and the last run (`/status`, or the log at
logs/daily.log in the data folder). The Mac must be awake at that time; a missed
run happens at the next wake.

## The end

1. Call `setup_status`. List the files written, as paths inside the data folder
   (profile.md, sourcing/search-profile.json, autofill.json, each file under
   knowledge-base/). Name any part still marked todo or partial, with
   `/setup --section <name>` to finish it later.
2. Call `resume_health_check`. Give the overall result and the top three fixes
   in plain words. Offer to fix one now.
3. Suggest the first commands:
   - `/find` to run the job search now;
   - `/score <link>` to check how well one job fits;
   - `/tailor <link>` to write a résumé for one job;
   - `/status` to see the board.
