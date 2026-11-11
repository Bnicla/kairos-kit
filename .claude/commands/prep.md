---
description: Interview prep for one application, built from your record.
argument-hint: "<application: company name, link or id>"
---

# /prep: interview preparation

Follow the `kairos` skill, Workflow H (interview prep). Input: `$ARGUMENTS`

1. Find the application: `list_applications`, match on company, link or id. If
   several match, ask which one. `read_application({ appId })` for the score and
   the ad.
2. Ask once about the interview: the round (screen, hiring manager, panel), the
   format, and who they meet. Do not look people up beyond what the student
   shares.
3. Search for the company's recent news (one or two searches, last six months).
4. Write the brief, short and in this order: the company in 60 seconds; the
   three strongest stories from the record mapped to the ad's own words, each
   with its real numbers; the biggest gap and the truthful way to address it;
   what the interviewers are really testing; three questions to ask them.
5. Stories: use `knowledge-base/star-stories.json` when it has them; build the
   missing ones from the record with the student, then `save_star_story`
   (source = the experience file, numbers from the metrics register).
6. Offer practice: likely questions one at a time, feedback grounded in the
   record. Save answers the student likes with `save_qa`.
7. If the application is not yet in the interviewing column,
   `set_application_status({ appId, status: "interviewing", interview_round })`.

Never coach the student to claim something the record does not hold.
