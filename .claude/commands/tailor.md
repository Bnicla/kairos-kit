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
3. Report the Writer's draft, in this order:
   - the provenance count (how many claims name the fact of the knowledge
     base they rest on) and anything left out for relevance. A named fact says
     where a claim comes from; it does not say that the claim is true as
     worded. The stretch check and the line origins below are what look at
     the wording;
   - the requirements coverage table: covered, partial and gap counts, then
     every gap with its priority and honest note;
   - each `stretch_check` item (a bullet or a summary sentence the knowledge base does
     not fully support): the text, the knowledge base's own wording, and the question
     keep, soften or drop. Keep → `save_confirmed_fact` with the student's
     exact words; soften or drop → edit and `save_resume` again;
   - `line_origins`: how many lines have a strong, partial or no origin in
     the knowledge base, then each `no_origin` line (confirm the fact with
     `save_confirmed_fact`, reword, or drop) and each `audit_disagreements` entry;
   - each `[ungrounded_skill]` warning: a tool on the skills line that the
     knowledge base never mentions. The student confirms it as a fact, or it comes off.
4. Read `layout` in the `save_resume` result: it is the measure of the Word
   file the save wrote. If the verdict is short, restore knowledge base
   bullets; if overflow, trim the weakest later bullets; then `save_resume`
   again. Do not call `render_docx` or `check_resume_layout` after a save:
   they are for a résumé whose source was edited by hand. The one exception:
   when `layout.available` is false, call `check_resume_layout` once.
5. Give the file path of the Word document (`docxPath` in the same result).
   Offer `render_pdf`.
6. Stop there. Do not write a cover letter. Ask whether the form has written
   questions (Workflow F) or whether they want a letter (`/letter`).
7. Going deeper, the Biographer's part: when the coverage table has gaps that
   the knowledge base may be missing (the score's possibly-uncaptured gaps),
   name the two or three whose true answer would change this résumé most and
   offer to ask them, one at a time. A yes is saved in the student's words
   (`save_confirmed_fact`), then the résumé is written again; a no closes the
   question. Never rephrase a question to get a yes. Ask whether it happened,
   not where it might have: an example of a place is a suggested answer.

Never add a fact, number, title or tool that is not in the knowledge base.
