---
description: Write a cover letter for one application. Only when you ask for one.
argument-hint: "<job posting link, or the application id>"
---

# /letter: a cover letter, on request only

Follow the `kairos` skill, Workflow E. Input: `$ARGUMENTS`

This command runs only because the student asked for a letter. Never start it
from another command.

1. Find the application (`list_applications`, match on the link or company and
   role). If it has no score yet, run `/score` first.
2. If the record has no writing samples, say the letter will follow the house
   style only, and offer `/setup --section voice` first.
3. `get_cover_letter_evidence({ appId })`, follow its `system_prompt` exactly.
   One through-line, plain prose, the student's register, any real gap named
   once and plainly.
4. `save_cover_letter({ appId, markdown })`. If it reports prose-check
   violations, fix them and save again.
5. Say where it is saved and that it can be downloaded from the board.
