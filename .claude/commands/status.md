---
description: The board - what is open and what needs action.
---

# /status: the board

Follow the `kairos` skill (Reviewing history). Arguments: `$ARGUMENTS`

1. Call `list_applications`. It is the source of truth: never answer from
   memory of earlier in the conversation.
2. Group by status and give counts: captured, scored, drafted, applied,
   interviewing, offer, and closed (rejected, withdrawn, listing closed, on
   hold). New jobs from the daily search are on the board's Sourced column.
3. Then the actions, most urgent first, one line each:
   - interviews coming up (offer `/prep`);
   - drafted résumés not yet sent;
   - scored jobs with a STRONG or COMPETITIVE band and no résumé yet (offer `/tailor`);
   - applications with no news for 14 days or more (suggest a follow-up);
   - new jobs in the Sourced column, freshest first (offer `/score`).
4. If the board is empty, say so and suggest `/find` or `/score <link>`.
5. Point to the dashboard for the full view: http://localhost:3000.

To change a status, use `set_application_status`, never a direct file edit.
