---
description: Write a tailored résumé for one job, with the coverage table and the checks.
argument-hint: "<job posting link, or the application id>"
---

# /tailor: a résumé for one job

Follow the `kairos` skill, Workflow D (generate), with the layout check. Input:
`$ARGUMENTS`

1. Find the application: if the input is a link, `list_applications` and match
   on the link or company and role; if none matches, run `/score` steps 3 to 5
   first (capture and score). A résumé needs a score.
2. `get_generation_evidence({ appId })`, follow its `system_prompt` exactly,
   produce the GeneratedResume, `save_resume({ appId, resume })`.
3. Report, in this order:
   - the provenance count (every claim traced to the record) and anything left
     out for relevance;
   - the requirements coverage table: covered, partial and gap counts, then
     every gap with its priority and honest note;
   - each `stretch_check` item: the bullet, the record's own wording, and the
     question keep, soften or drop. Keep → `save_confirmed_fact` with the
     student's exact words; soften or drop → edit and `save_resume` again.
4. `render_docx({ appId })`, then `check_resume_layout({ appId })`. If the
   verdict is short, restore record bullets; if overflow, trim the weakest
   later bullets; save and check again.
5. Give the file path of the Word document. Offer `render_pdf`.
6. Stop there. Do not write a cover letter. Ask whether the form has written
   questions (Workflow F) or whether they want a letter (`/letter`).

Never add a fact, number, title or tool that is not in the record.
