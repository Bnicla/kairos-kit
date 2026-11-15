---
description: "Writer: Write a tailored résumé for one job, with the coverage table and the checks."
argument-hint: "<job posting link, or the application id>"
---

# /tailor: a résumé for one job

Follow the `kairos` skill, Workflow D (generate), with the layout check. Input:
`$ARGUMENTS`

This is the Writer's work.

1. Find the application: if the input is a link, `list_applications` and match
   on the link or company and role; if none matches, run `/score` steps 3 to 5
   first (capture and score). A résumé needs a score.
2. `get_generation_evidence({ appId })`, follow its `system_prompt` exactly,
   produce the GeneratedResume, `save_resume({ appId, resume })`.
3. **Before showing the draft, put right what you added yourself.** The
   save's result lists, without stopping the save, what on the résumé the
   knowledge base does not hold:
   - `put_right_before_showing`: a title, a date, an issuer, a count of
     years, a skill, a stronger verb, an "I", a statement of what the student
     did not do, a line no fact holds. If you wrote it, put it right from the
     knowledge base (their title, their dates, their figure, their list of
     skills, the fact's own verb) and save again. Another verb for the same
     claim, or a number written in words, changes nothing. Do this before the
     student sees anything.
   - What is left after that, and anything the student asked for themselves,
     is theirs to decide. Tell them, in plain words and with no judgement and
     no "you must": which line, and what differs from their knowledge base
     ("Your résumé says this role runs to today; your knowledge base has it
     ending in 2025. Keep it as it is?"). If they say keep it, it stays as
     saved. If it will come back on every résumé, offer to remember it:
     `save_profile({ resume_choices: [{ key, says }] })` with the item's
     `key` and their own words; it is then not raised again. They can see and
     change these choices in their profile (`resume_choices`).
   - `tell_the_user`: what only they can settle (a count of years worked out
     from dates). Ask in plain words, with no suggested answer. A fact they
     give is saved (`save_confirmed_fact`), then the résumé again.
   The same holds for what used to stop a save: an employer or an
   organisation the knowledge base does not know, a number or a credential on
   no line of it, a number their register withholds, a phrasing they wrote
   never to claim, a writing rule. If you added it, it goes: Kairos does not
   invent. If the student wants it, tell them what differs (each item's `say`
   is the sentence) and keep it on their word; tell them every time, unless
   they had it remembered. Only an input that is not in the tool's shape, or
   a storage error, stops the save. Never show a résumé that was not saved.
4. Report the Writer's draft, in this order, in the student's words: never
   say provenance, audit, stretch check, line origins, grounding, source file
   or tagged, and never a field name of the result (the names below are for
   you):
   - how many lines rest on a fact of the knowledge base (the
     `provenance_audit` count) and anything left out for relevance. A named
     fact says where a line comes from; it does not say that the line is true
     as worded. The two checks below are what look at the wording;
   - the requirements coverage table: covered, partial and gap counts, then
     every gap with its priority and honest note;
   - each `stretch_check` item (a bullet or a summary sentence the knowledge base does
     not fully support): the text, the knowledge base's own wording, and the question
     keep, soften or drop. Keep → `save_confirmed_fact` with the student's
     exact words; soften or drop → edit and `save_resume` again;
   - `line_origins`: how many lines were found in the knowledge base in full,
     in part or not at all, then each `no_origin` line (confirm the fact with
     `save_confirmed_fact`, reword, or drop). A wrong source is put right by
     the save itself (`sources_corrected`): say nothing of it. If an
     `audit_disagreements` entry remains, set that line's `source_experience`
     to the entry it names and save again; do not report it;
   - each `[ungrounded_skill]` warning: a tool on the skills line that the
     knowledge base never mentions. The student confirms it as a fact, or it comes off;
   - each `[years_from_dates]` warning: a count of years nobody stated, worked
     out from dates. Ask whether it is true of what the sentence says ("you
     were a teacher for eight years: were you writing for an audience all
     eight?"), or take the count out;
   - each `[listed_skill_left_out]` warning: a skill on the student's own list
     that the ad names: add it as they wrote it and save again;
   - a `repeat:` warning is yours to fix: drop the bullet that says the role's
     introduction again, and save again, without asking.
5. Read `layout` in the `save_resume` result: it is the measure of the Word
   file the save wrote. If the verdict is short, restore facts of the
   knowledge base that are not on the résumé yet; when there are none, a short
   page is the right result: say so, and never add, repeat or stretch a line
   to fill it. If overflow, trim the weakest later bullets; then `save_resume`
   again. Do not call `render_docx` or `check_resume_layout` after a save:
   they are for a résumé whose source was edited by hand. The one exception:
   when `layout.available` is false, call `check_resume_layout` once.
6. Give the file path of the Word document (`docxPath` in the same result).
   Offer `render_pdf`.
7. Stop there. Do not write a cover letter. Ask whether the form has written
   questions (Workflow F) or whether they want a letter (`/letter`).
8. Going deeper, the Biographer's part: when the coverage table has gaps that
   the knowledge base may be missing (the score's possibly-uncaptured gaps),
   name the two or three whose true answer would change this résumé most and
   offer to ask them, one at a time. A yes is saved in the student's words
   (`save_confirmed_fact`), then the résumé is written again; a no closes the
   question. Never rephrase a question to get a yes. Ask whether it happened,
   not where it might have: an example of a place is a suggested answer. Give
   no example answers and name no tool, product or option the student did not
   name ("like" followed by a tool's name, "SQS or RabbitMQ", "for example
   pallets"): name only
   what the ad asks for. A skill on their own list is theirs: ask where they
   used it, never whether they have it.

Never add a fact, number, title or tool that is not in the knowledge base.
