# Technical debt found during the TypeScript migration

These defects and oddities were found in the Python baseline (`d3404ed`). On the
user's instruction they are **preserved unchanged** by the migration, and each
should become its own follow-up issue. The TypeScript port reproduces each one,
and tests pin that behavior so that any later fix is a deliberate change.

| ID | Defect | Impact | Where (Python baseline → TS) | Suggested fix |
| --- | --- | --- | --- | --- |
| TD1 | Interaction create uses the default Notion retry policy, which retries on 5xx, timeouts and connection errors. Any of these can arrive after Notion has already created the page. | **Can create duplicate Interactions** in Notion. Task create already avoids this (it retries only 429). | `people_interaction.create_interaction_page` → `src/people-interaction.ts` | Use the Task-create policy (retry only 429), and add an "may not have been added" message. |
| TD2 | `task_from_notion_page` parses the Follow-up with `date.fromisoformat`, which rejects a datetime value such as `2026-10-13T09:00:00.000+02:00`. | A Task whose Follow-up includes a time is counted as malformed and silently skipped. `/people due` parses datetimes correctly. | `tasks_list.task_from_notion_page` → `src/tasks-list.ts` | Parse dates the way `people_due.parse_notion_date` does. |
| TD3 | Dates from modals are parsed with `date.fromisoformat`, which also accepts `20261013` and `2026-W42-2`. | Low. Slack datepickers send `YYYY-MM-DD`, but a crafted payload could pass an unusual format. Behavior also differs between Python versions. | `handle_add_interaction_submission`, `handle_add_followup_task_submission` | Accept only `YYYY-MM-DD`. |
| TD4 | `find_one_due_person` is legacy code that only tests use. | Dead code. | `people_due` → `src/people-due.ts` | Remove it together with the tests that pin it. |
| TD5 | The README is stale: it describes Notion as read-only and its repository tree is incomplete. | Misleading documentation. | `README.md` | **Fixed during the migration** (S9), because the docs are rewritten for the TypeScript runtime anyway. |
| TD6 | Python dependencies were unpinned, and no CI ran the tests. | Builds weren't reproducible and regressions could go unnoticed. | `requirements.txt` | **Superseded** by the migration: npm lockfile plus `ci.yml`. |
| TD7 | A Notion credential failure (401) on Interaction create is caught by `handle_add_interaction_submission`: the user gets the generic "Unable to add the interaction right now" and the run exits 0. Found by the S1 recorder (`interaction_create_401`). | A revoked or wrong Notion key on the write path does not fail the workflow visibly, unlike `/tasks list`, where a 401 escapes and exits 1. | `people_interaction.handle_add_interaction_submission` (`except (…, NotionAuthenticationError)`) → `src/people-interaction.ts` | Let `NotionAuthenticationError` escape after posting the failure message, so the run fails visibly. |
| TD8 | google-genai is unpinned. The two local installs had different versions (2.20.0 under 3.14, 2.30.0 under 3.12), and the 2.30.0 Interactions client raises errors from a private module (`_gaos.lib.compat_errors`). | Gemini error handling could change with no repo change. | `requirements.txt` | **Superseded** by the migration: the pinned `@google/genai`. |
