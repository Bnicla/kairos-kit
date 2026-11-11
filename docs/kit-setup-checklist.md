# Kairos Kit: `/setup` checklist

Generated from `packages/engine/setup/sections.ts` (`renderChecklist`). Do not edit by hand:
`tests/setup-sections.test.ts` fails when this file and the code disagree, and when a
setting the engine reads has no section and no stated default.

## Sections

| # | `/setup --section` | Asks | Saves with |
|---|---|---|---|
| 1 | `identity` | Name, contact line, headline, links, languages, work authorization. | `save_profile`, `save_autofill` |
| 2 | `education` | Degrees, schools, dates, certifications, honors; coursework only if it matters for the target roles. | `save_education` |
| 3 | `experience` | Each role, internship or project: dates, what the student personally built, results with numbers, tools. | `save_experience`, `save_confirmed_fact`, `save_metric`, `get_enrichment_questions` |
| 4 | `skills` | Confirm the skills found per role and add missing ones, each tied to a role where it was used. | `save_experience`, `save_confirmed_fact` |
| 5 | `goals` | The work they want day to day, then target titles; propose nearby titles; industries and topics of interest. | `save_profile`, `save_search_profile` |
| 6 | `level` | The level they target, the ceiling they will not go above, and the shape of role (individual work, team lead, mix). | `save_profile`, `save_search_profile` |
| 7 | `dealbreakers` | Industries, companies and role types they will not consider. | `save_profile`, `save_search_profile` |
| 8 | `places` | Cities, remote or hybrid, relocation yes or no and where, places that are out, postings abroad. | `save_profile`, `save_search_profile` |
| 9 | `pay` | The lowest base pay they would accept, and a different floor for expensive cities if needed. | `save_profile`, `save_search_profile` |
| 10 | `companies` | Companies whose career sites are checked directly every day, and companies to rank higher in the daily search. | `save_search_profile` |
| 11 | `voice` | Two or three samples of their own writing, and phrases they never want in letters or answers. | `save_voice_profile`, `save_writing_samples`, `save_profile` |
| 12 | `resume` | Page target, which role opens page 2 on a two-page résumé, what education to show (GPA, coursework). | `save_profile`, `save_education` |
| 13 | `forms` | Optional: address, standard answers (start date, how they heard, notice period), EEO answers only if they want them filled. | `save_autofill` |
| 14 | `daily` | Daily search on or off, the time it runs, how fresh postings must be, how many cards the board shows. | `save_search_profile` |

## Settings

| Setting | File | Filled by | Default when not set | What it changes |
|---|---|---|---|---|
| `profile.name` | profile.md | 1. identity | Taken from the résumé. | Résumé header, file names, form autofill. |
| `profile.contact_line` | profile.md | 1. identity | Taken from the résumé. | Résumé contact line; health check. |
| `profile.headline` | profile.md | 1. identity | No tagline. | Tagline under the name on the résumé. |
| `profile.languages` | profile.md | 1. identity | Not stated: scoring treats language requirements as unconfirmed. | Given to scoring so language requirements are not marked unconfirmed. |
| `profile.preferences` | profile.md | not asked | Empty. | Container for the preference fields below. |
| `profile.preferences.work_authorization` | profile.md | 1. identity | Not stated: scoring flags authorization requirements as unconfirmed. | Given to scoring (sponsorship and citizenship requirements). |
| `profile.preferences.location` | profile.md | 8. places | Not stated. | Given to scoring; seeds search_profile.locations on first derivation. |
| `profile.preferences.remote` | profile.md | 8. places | Not stated. | Read by triage through the profile summary. |
| `profile.preferences.relocation` | profile.md | 8. places | Not stated. | Given to scoring as a profile fact. |
| `profile.preferences.pay_floor` | profile.md | 9. pay | Not stated. | Read by triage through the profile summary; the structured floor is search_profile.pay_floor. |
| `profile.target_roles` | profile.md | 5. goals | None: the search falls back to 'product'. | Enrichment questions; seeds function terms; triage summary. |
| `profile.target_seniority` | profile.md | 6. level | Any level. | Seeds seniority terms; triage summary. |
| `profile.role_shape_preference` | profile.md | 6. level | None. | Copied into the search profile notes on first derivation. |
| `profile.domains` | profile.md | 5. goals | None. | Seeds boost terms; triage summary. |
| `profile.deal_breakers` | profile.md | 7. dealbreakers | None. | Triage summary (the hard gates are in the search profile). |
| `profile.target_pages` | profile.md | 12. resume | Derived from years of experience (1 page for students). | Résumé length policy and layout check. |
| `profile.resume_page2_anchor` | profile.md | 12. resume | No anchor: any clean page break passes. | Layout check on two-page résumés. |
| `profile.standing_base_app` | profile.md | not asked | None until the first tailored résumé; tailor-resume asks for spec.base. | Base résumé for tailor-resume when a spec names none. |
| `profile.resume_leadin_aliases` | profile.md | not asked | {} (nothing renamed yet). | Maps renamed bullet lead-ins so old tailoring specs keep matching. |
| `profile.stories_map` | profile.md | not asked | knowledge-base/stories-map.json. | Data-folder path of the stories map the deep-dives page reads. |
| `profile.voice` | profile.md | not asked | Built-in banned phrase list only. | Container for the voice settings below. |
| `profile.voice.banned_patterns` | profile.md | 11. voice | Built-in phrase list only. | Letter and answer prose check. |
| `profile.voice.replace_default_patterns` | profile.md | 11. voice | false (the user's list extends the built-in one). | true: the user's list replaces the built-in one. |
| `search_profile.function_terms` | sourcing/search-profile.json | 5. goals | Derived from target_roles. | Hard gate: a title must contain one of these words. |
| `search_profile.exclude_terms` | sourcing/search-profile.json | 7. dealbreakers | intern, internship, junior, coordinator, apprentice (change them for internship searches). | Hard gate: titles with these words are dropped. |
| `search_profile.locations` | sourcing/search-profile.json | 8. places | Derived from preferences.location; remote postings always match. | Places that count as local; others go to the stretch bucket. |
| `search_profile.secondary_locations` | sourcing/search-profile.json | 8. places | None. | Higher-bar places (strong fits only), may be abroad. |
| `search_profile.excluded_locations` | sourcing/search-profile.json | 8. places | None. | Hard gate: onsite/hybrid postings there are dropped. |
| `search_profile.boost_terms` | sourcing/search-profile.json | 5. goals | Derived from domains. | Rank boost for title words. |
| `search_profile.seniority_terms` | sourcing/search-profile.json | 6. level | Derived from target_seniority. | Rank boost for level words; never a gate. |
| `search_profile.seniority_ceiling` | sourcing/search-profile.json | 6. level | No ceiling. | Triage rule: skip roles above it. |
| `search_profile.watched_companies` | sourcing/search-profile.json | 10. companies | None. | Rank boost for these companies. |
| `search_profile.excluded_companies` | sourcing/search-profile.json | 7. dealbreakers | None. | Hard gate: these companies never reach triage. |
| `search_profile.dream_companies` | sourcing/search-profile.json | 10. companies | None: dream-watch says so and exits. | Career sites checked directly every day (dream-watch). |
| `search_profile.triage_rules` | sourcing/search-profile.json | 7. dealbreakers | None. | The user's own rules, given verbatim to triage. |
| `search_profile.pay_floor` | sourcing/search-profile.json | 9. pay | No floor. | Triage rule: skip postings whose stated range tops out below it. |
| `search_profile.relocation` | sourcing/search-profile.json | 8. places | Not stated. | Triage rule on onsite roles outside the listed places. |
| `search_profile.max_age_days` | sourcing/search-profile.json | 14. daily | 7 days. | Hard recency cap for the daily search. |
| `search_profile.international_ok` | sourcing/search-profile.json | 8. places | false. | Whether postings outside the home country appear. |
| `search_profile.notes` | sourcing/search-profile.json | 6. level | None. | Free text added to the triage summary. |
| `search_profile.after_triage_hook` | sourcing/search-profile.json | not asked | None. | Optional module the daily search runs after triage (it can log, never decides). |
| `search_profile.board` | sourcing/search-profile.json | not asked | Defaults below. | Container for board settings. |
| `search_profile.board.max_sourced_cards` | sourcing/search-profile.json | 14. daily | 10. | Sourced cards shown on the board column. |
| `search_profile.daily_run` | sourcing/search-profile.json | not asked | On at 08:15. | Container for the daily-run settings. |
| `search_profile.daily_run.enabled` | sourcing/search-profile.json | 14. daily | On. | Daily search on or off. |
| `search_profile.daily_run.time` | sourcing/search-profile.json | 14. daily | 08:15. | Local time of the daily search (install.sh --daily HH:MM applies it). |
| `search_profile.source` | sourcing/search-profile.json | not asked | derived (set to confirmed by /setup). | 'confirmed' once the user has answered; 'derived' when guessed. |
| `search_profile.updated_at` | sourcing/search-profile.json | not asked | Set automatically. | Written by every save. |
| `autofill.contact` | autofill.json | 1. identity | Name from profile.md; the rest is left blank on forms. | Form autofill: name, email, phone. |
| `autofill.links` | autofill.json | 1. identity | Left blank on forms. | Form autofill: LinkedIn, GitHub, portfolio. |
| `autofill.work_authorization` | autofill.json | 1. identity | Left blank on forms. | Form autofill: authorization and sponsorship questions. |
| `autofill.address` | autofill.json | 13. forms | Left blank on forms. | Form autofill: address fields. |
| `autofill.common_answers` | autofill.json | 13. forms | Employer and school from the record; the rest blank. | Form autofill: standard answers (start date, how they heard, current employer, school). |
| `autofill.eeo` | autofill.json | 13. forms | Never filled. | Form autofill: demographic questions, only when share_eeo is true. |
| `autofill.share_eeo` | autofill.json | 13. forms | false. | Opt-in for serving the EEO answers. |
| `autofill.defaults` | autofill.json | 13. forms | { never_auto_submit: true }. | Extension behaviour flags. |
| `autofill.work_history_overrides` | autofill.json | 13. forms | The record's title and years, as on the résumé. | How each record role appears on application forms: HR title, exact months, ended or current, or left off. |
| `kb.education` | knowledge-base/education/*.md | 2. education | No education section. | Résumé education section; scoring. |
| `kb.experiences` | knowledge-base/experiences/*.md | 3. experience | None: scoring and tailoring refuse to run. | Everything: scoring, résumés, letters, prep. |
| `kb.skills` | knowledge-base/experiences/*.md (skills in frontmatter) | 4. skills | Skills found in the documents. | Scoring and résumé skills line. |
| `kb.metrics_register` | knowledge-base/metrics-register.md | 3. experience | Empty: numbers stay as tagged in the record. | Which numbers may appear in documents (DEFENDED and SCOPE only). |
| `kb.voice_profile` | knowledge-base/_voice-profile.md | 11. voice | Learned from the résumé. | Résumé and letter style. |
| `kb.writing_samples` | knowledge-base/_writing-samples.md | 11. voice | None: letters follow the house style only. | Cover-letter style few-shots. |
| `kb.star_stories` | knowledge-base/star-stories.json | not asked | Built later by /prep from the record. | Dashboard Stories page; interview prep. |
