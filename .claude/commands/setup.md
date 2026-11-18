---
description: "Biographer: First run. One résumé and one job ad are enough to start: a first tailored résumé, then your settings. Re-run one part with /setup --section <name>."
argument-hint: "[--section <name>]"
---

# /setup: the first run

You are running Kairos's first run for a job seeker: a student, someone early
in a career, someone changing field, any profession. Arguments: `$ARGUMENTS`

The first run has two halves. The **quick start** comes first: one résumé and
one job ad are enough, and the student leaves with a tailored résumé. The
**14 parts** come after, when they choose: every setting, and the questions
that deepen the knowledge base.

This is the Biographer's work. The quick start also calls for the Assessor's
score and the Writer's draft.

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
   about a role or an education entry that has an open question.
4. **Additions and conflicts stay apart.** Items with status `additive` (the
   knowledge base has them; a new document only adds a date, a place or a source) go in
   their own short list: "These would be added to what you already have:".
   Ask once for approval of the whole list; apply only what they approve.
5. **Re-runs never overwrite silently.** New files: `save_experience` /
   `save_education` with `expect_new: true`. An existing file is re-saved only
   after the student approved the change: `read_experience` with
   `for_editing: true` first, change only
   the approved parts, keep everything else, then save with the merged
   `sources`. `unchanged` items are not saved again.
6. A save of a role refreshes the map of the knowledge base by itself. Call
   `rebuild_index` only after a file was edited by hand.
7. **Each change to the knowledge base, and each document read, shows a
   Claude Code confirmation.** Before the first one, tell the student: "Before
   I read one of your files, and each time I change your knowledge base, Claude
   Code shows you the file or the full change. Accept only what is right. What
   I make for one application (the posting, the score, the résumé, a letter,
   its status) is saved without that step." A declined save or read is not
   retried unless they ask. A role too long for one confirmation is saved in
   two parts.
8. At the end of each section call `mark_setup_section` with `done`, or with
   `skipped` when the student chose to skip it. Skipped settings keep their
   stated defaults (`setup_status` shows them under `unset`).
9. Search settings: every `save_search_profile` call passes
   `source: "confirmed"` and only the fields that changed (the save merges).

## Step 0: the data folder and the install

Call `create_data_folder` (it creates the data folder when it is missing and
never writes a file that exists), then `setup_status({ check_install: true })`
(it reads only).

- On a first run (not with `--section`), say once, before anything else:
  "Claude is your chief of staff for your job search." Then, in one line each,
  the three specialists they meet first: the Biographer builds their knowledge
  base from their résumé, the Assessor scores a job ad against it, the Writer
  drafts the résumé. Name the other three in one line together (Scout,
  Networker, Interview Coach: the job search, the people they know at a
  company, the interview), for later.
- Say where the data folder is. If it was just created: "I created your data
  folder at <path>. Everything you tell me is saved there, on this computer."
  If it already holds a knowledge base: "You already have a knowledge base at <path>. I will add
  to it and ask before changing anything."
- Install: if `install.warnings` is not empty, read each one out plainly.
  LibreOffice missing is not a problem: say résumés will export as Word files
  and page fit will be estimated.
- If `install.repo.warning` is set (a public fork), read it out and ask the
  student to make the fork private before going further. Continue if they say so.
- With `--section <name>`: go straight to that section (name or number, listed
  below), run only it, then do "The end".
- The knowledge base has no experiences and there is no `--section`: do the
  quick start below.
- Otherwise (the knowledge base has experiences): say which parts are done and
  continue the 14 parts from `next_section`.

## Quick start: one résumé and one job ad

The aim: a tailored résumé the student can download, with as few steps for
them as possible. Ask nothing that can wait. The settings keep their defaults
until the 14 parts.

1. **Ask for the two things in one message.** "Give me your résumé (PDF, Word
   or text) and one job ad you would apply to (its link, or the text). If you
   have no résumé, say so: I ask you a few short questions instead." Say once
   what the confirmations are (rule 7 above). Say once, too, that they can
   choose "Always allow" in Claude's box for the Kairos tools that only read
   (loading, showing, getting the evidence), and that every save to their
   knowledge base still asks each time. Never suggest it for a tool that
   writes. When their first message already holds the résumé and the job ad,
   say these things, and who does what (step 0), in a few lines before the
   first tool of step 2: never after the résumé is written.
2. **Biographer: the knowledge base from the résumé.** `prepare_extraction`,
   follow its `system_prompt`. With one document and an empty knowledge base
   there is nothing to compare: do not call `reconcile_sources`. Save what the
   résumé says, as it says it, every fact tagged `[R]`, and nothing else, in
   one call: `save_first_import({ profile: { name, contact_line, headline },
   experiences: [...], education: [...], sources })`, the headline built from
   the résumé's own words. Every line of a role is the résumé's own line, word
   for word; write no summary and no note of your own. `education` holds every
   degree, licence and certification: call none of them a "school" unless it
   is one, and give one a school or an issuer only when the résumé names it.
   `profile.summary` is the résumé's own summary of the person, word for
   word (a count of years they state there is their figure). `profile.skills`
   is the résumé's own list of skills, item by item in its words, and
   `profile.languages` its languages: leave nothing out and add nothing. A project of their own (a capstone, a personal project) is an
   entry with `kind: "project"`, `company` set to the project's own name, and
   no title unless the résumé states their part: never a job title or an
   employer of your own. Every title and employer is the résumé's, as
   written. The student approves in Kairos's confirmation: a short summary
   (who, which jobs and entries, how many lines are word for word from their
   document, and in full every line and every skill that is not), where they
   choose to save all of it or to see each item one by one. Tell them so in
   one line before the call, and ask no question before it. If they decline,
   ask what is wrong, correct it and offer it again. If the confirmation
   closed before they answered, or a part was declined, the result says what
   is saved and what is not: ask what they want, and call `save_first_import`
   again with the same items to offer the rest (what is saved is not asked
   again). An item the result names in `not_saved` is longer than one
   confirmation shows: save it by itself in two steps (`save_experience` with
   part of its lines, then again with the rest). After this first import
   every save to the knowledge base asks by itself. The voice profile, the
   skills review, the numbers and every setting wait for the 14 parts.
   **No résumé:** a short interview instead. Ask for the two or three
   experiences that matter most for the job ad, one at a time: for a student,
   studies, projects, clubs, part-time work and volunteering count; for someone
   changing field, the roles closest to the new field. For each: organization,
   title, start and end month, what they did themselves, one result. Then
   their degrees, licences and certifications, in one question. Every fact tagged `[C]`, source
   `interview <YYYY-MM-DD>`. Same saves.
3. **Assessor: the score.** `/score` steps 3 to 5 on the job ad (capture,
   score, save). Report in a few lines: the band and confidence, the two
   strongest points, the real gaps. If the band is DEVELOPING or WEAK, say so
   plainly and ask whether to write the résumé anyway or to try another ad.
   Otherwise go on without asking.
4. **Writer: the résumé.** `/tailor` steps 2 to 5: write it, save it, render
   the Word file, check the layout, and say where the file is and that it is
   the file to send. Report the
   coverage counts in one line, then only what needs the student's decision
   (each stretch item, each line with no origin).
5. **Biographer: going deeper, for this job.** From the score's gaps that may
   be missing from the knowledge base and the requirements the résumé does not
   cover, pick the two or three whose true answer would change this résumé
   most. Ask them one at a time, plainly, each with the way out: "The ad asks
   for SQL. Have you used SQL in a job, a project or a class that your résumé
   does not mention? If not, say no." A yes is saved in their words
   (`save_confirmed_fact`); a no closes the question. Never rephrase a question
   to get a yes, and never suggest an answer or a place where it might have
   happened beyond the three kinds above: no example answers, no "like X or
   Y", and no tool, product or option the student did not name themselves.
   Before you ask, read their own list of skills (the profile's `skills`): a
   skill on it is theirs, so ask where they used it, never whether they have
   it. A fact they give that is a project of their own is saved as one
   (`kind: "project"`, its own name, no job title, no employer). After the answers, offer once to
   write the résumé again with the new facts.
6. **Close in a few lines.** What exists now (the knowledge base with its
   roles, one scored job, one résumé). What is thin: the roles that hold only
   what the résumé said; a short interview about one of them
   (`/setup --section experience`) gives the Writer more to choose from for the
   next job. What comes next, their choice: another job (`/score <link>`), the
   rest of the first run (`/setup` continues with the 14 parts: goals, places,
   pay, the daily search), or the job search (`/find`).

Do not call `mark_setup_section` in the quick start: no part was gone through
in full, and `/setup` later starts the 14 parts from the first one, with what
the quick start saved already in place.

Facts only. The questions of step 5 ask what happened; they never invite the
student to claim more than is true. There is no score or count to raise: a
short, true knowledge base is a good one.

## Step 1: choose a way in

This step and the 14 parts are the full first run, after the quick start or
with `--section`. Skip this step when the knowledge base already has
experiences (the quick start, or an earlier run, put them there). Otherwise ask:

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
- each degree, licence or certification: `save_education({ ..., sources, expect_new: true })`;
- the voice profile from the résumé: `save_voice_profile`;
- name, contact line and headline: part 1.

## The 14 parts

Each part can be run alone with `/setup --section <name>`. Names in backticks.

### 1. Identity and contact (`identity`)
Confirm or ask: full name; contact line (email · phone · city · LinkedIn URL);
a headline for the top of the résumé (offer one built from their knowledge base, e.g.
"Statistics Graduate, Data Analysis"); languages with level; work authorization
("Are you allowed to work in <country> without a visa? Will you need sponsorship
now or later?").
Save: `save_profile({ name, contact_line, headline, languages, preferences: { work_authorization } })`
and `save_autofill({ contact: { full_name, email, phone }, links: { linkedin, github, portfolio }, work_authorization: { ... } })`.

### 2. Education and certifications (`education`)
Confirm each degree: school, field, dates, honors. Ask about certifications
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
that role with the skill (`prov: "C"`) after `read_experience` with
`for_editing: true`, or add a
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
For internship searches, check in part 7 that "intern" is not among the
excluded words.

### 7. Deal-breakers (`dealbreakers`)
Industries, companies and kinds of role they will not consider.
Save: `save_profile({ deal_breakers })` and `save_search_profile({ exclude_terms,
excluded_companies, triage_rules, source: "confirmed" })`. Title words go in
`exclude_terms` (the default is empty, except intern, internship, junior and
apprentice when the stated level is senior); company names in
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
Saving the setting does not schedule anything on the computer. Ask: "Shall I
set the schedule on this computer now? You will see a permission prompt for the
command." On yes, run the installer in the kit folder, with the Bash tool. It
is `./install.sh` on a Mac and `node install.mjs` on Windows (never
`./install.sh` on Windows: it is a zsh script), with the same options:
`--schedule-only --daily HH:MM`, or `--schedule-only --no-daily` when they
turned it off. Read its last line back. If it fails, say so plainly, quote the
error, and tell them the same command can be run by hand. Then tell them the
three things to check later: the setting (saved), the schedule (installed or
not), and the last run (`/status`, or the log at logs/daily.log in the data
folder). The computer must be on and they must be signed in at that time; a
missed run happens at the next wake (on Windows, the next time the computer is
on and they are signed in).

## The end

1. Call `setup_status`. List the files written, as paths inside the data folder
   (profile.md, sourcing/search-profile.json, autofill.json, each file under
   knowledge-base/). Name any part still marked todo or partial, with
   `/setup --section <name>` to finish it later.
2. Call `resume_health_check`. Give the overall result and the top three fixes
   in plain words. Offer to fix one now.
3. Suggest the first commands:
   - `/find` to run the job search now (Scout);
   - `/score <link>` to check how well one job fits (Assessor);
   - `/tailor <link>` to write a résumé for one job (Writer);
   - `/status` to see the board.
