# TypeScript migration — Baseline

Snapshot of the Python implementation that the TypeScript migration must
reproduce. Everything here was observed directly in the repository or by running
it, unless marked **assumption**.

- Baseline commit: `d3404ed` (`main`, clean working tree)
- Recorded: 2026-10-13
- Local environment: Windows 11, Python 3.14.2, Node v24.18.0, npm 11.16.0
- CI environment (from workflows): `ubuntu-latest`, Python 3.12, Node as preinstalled on the runner

## 1. Inventory

### Python application modules

| Module | Lines | Role | Entry point |
| --- | ---: | --- | --- |
| `main.py` | 477 | Slack transport glue, routing, authorization order, Gemini conversation path. Top-level script with `sys.exit`. | `python main.py` (slack-message.yml) |
| `attention_summary.py` | 313 | Scheduled private DM summary. | `python attention_summary.py` (attention-summary.yml) |
| `tasks_list.py` | 490 | `/tasks list`. Also owns the shared Notion helpers: `call_notion_with_retries`, `retry_delay`, `notion_headers`, `copenhagen_today`, `track_from_notion_page`. | library |
| `people_due.py` | 638 | `/people` routing, `/people due`, cadence evaluation, the shared paginated `fetch_notion_pages`. | library |
| `people_suggest.py` | 928 | `/people suggest <person>`: Person resolution, Track/Purpose context, two Gemini prompts, next-step validation, Block Kit. | library |
| `people_interaction.py` | 395 | Add Interaction modal button and write path (**Notion write**). | library |
| `followup_task.py` | 586 | Follow-up Task buttons, Gemini Task suggestion, Task write path (**Notion write**). | library |
| `slack_authorization.py` | 18 | `is_private_data_request_authorized`. | library |
| `scripts/fetch_notion_schema.py` | 85 | Dev utility. Dumps live Notion schemas (read-only). | manual |
| `scripts/preview_people_suggest_prompts.py` | 100 | Dev utility. Prints `/people suggest` prompts using live Notion reads and stubbed Gemini/Slack. | manual |

Module dependency graph (imports):

```
main ─┬─ followup_task ─┬─ people_interaction ─┬─ people_due ── tasks_list
      │                 └─ tasks_list           └─ tasks_list
      ├─ people_due ── (lazy) people_suggest ─┬─ people_due
      │                                       ├─ people_interaction
      │                                       └─ tasks_list
      ├─ people_interaction
      ├─ slack_authorization
      └─ tasks_list
attention_summary ─┬─ people_due
                   └─ tasks_list
```

`people_due` imports `people_suggest` lazily to avoid a circular import.

### Non-Python components (stay as they are)

| Path | Role |
| --- | --- |
| `api/slack.js`, `api/slack-request.js` | Vercel webhook: Slack signature verification, payload shaping, modal opening, fixed acknowledgements, `repository_dispatch`. Already JavaScript, and **out of scope** for this migration. |
| `.github/workflows/slack-message.yml` | `repository_dispatch: slack_message` → masking step (inline `node -e`) → `python main.py`. |
| `.github/workflows/attention-summary.yml` | cron `0 6 * * 1,4` + `workflow_dispatch` → `python attention_summary.py`. |

### Dependencies

| Ecosystem | Declared | Pinning | Locally installed |
| --- | --- | --- | --- |
| Python (`requirements.txt`) | `requests`, `google-genai`, `tzdata` | **none** (CI installs latest on every run) | requests 2.34.2, google-genai 2.20.0 |
| npm (`package.json`) | `@vercel/functions: latest` | **none**, and no lockfile is committed | n/a |
| Test tooling | README says `python -m pytest` | not declared | **pytest is not installed locally**. The tests are `unittest`-based and run without it. |

No CI workflow runs the tests. Tests are run only locally.

## 2. Test baseline

| Suite | Command | Result | Wall time |
| --- | --- | --- | --- |
| Python | `python -m unittest discover -s tests -p "test_*.py"` | **358 tests, OK** (0 failures, 0 skipped) | ~7 s |
| JavaScript | `npm test` (`node --test`) | **96 tests, 96 pass** | ~10 s |

`python -m unittest discover -s tests -t .` fails (`tests` is not a package). Use
the command above.

Python test count per file (`def test_` count, which matches the 358 run):

| File | Tests | Notes |
| --- | ---: | --- |
| `test_people_suggest.py` | 110 | |
| `test_people_due.py` | 56 | includes tests of the legacy `find_one_due_person` |
| `test_followup_task.py` | 53 | |
| `test_people_interaction.py` | 39 | |
| `test_attention_summary.py` | 36 | |
| `test_main_routing.py` | 32 | runs `main` via `runpy` with fake `requests` / `google.genai` modules |
| `test_tasks_list.py` | 23 | |
| `test_slack_authorization.py` | 5 | |
| `test_cross_layer_contract.py` | 4 | spawns `node` to run `api/slack-request.js`, feeds the dispatch payload into `main`, and asserts on the workflow YAML text |

## 3. External integrations (every outbound call)

| Service | Method and endpoint | Caller | Kind |
| --- | --- | --- | --- |
| Slack | `POST https://slack.com/api/chat.postMessage` | main (`post_slack_message`), attention_summary (DM to user ID) | write |
| Slack | `GET https://slack.com/api/conversations.replies` | main (thread history) | read |
| Slack | `POST <SLACK_RESPONSE_URL>` (ephemeral) | main (`post_ephemeral_command_response`) | write |
| Notion | `POST /v1/data_sources/{id}/query` | tasks, people, interactions, tracks reads | read |
| Notion | `GET /v1/pages/{id}` | Track resolution | read |
| Notion | `GET /v1/data_sources/{id}` | Interactions Type / title schema, Tasks schema | read |
| Notion | `POST /v1/pages` | `create_interaction_page`, `create_task_page` | **write** |
| Gemini | `genai.Client().interactions.create(model="gemini-3.5-flash-lite", input=prompt)` → `.output_text.strip()` | conversation, `/people suggest` (2 calls), follow-up Task suggestion (1 call) | model call |

Every Notion call sends `Notion-Version: 2025-09-03`. Every `requests` call uses `timeout=10`.

Gemini SDK facts that affect equivalence (read from the installed google-genai 2.20.0 source):
the Interactions resource is a generated client with `_DEFAULT_MAX_RETRIES = 2`, and
`output_text` concatenates the trailing run of text parts in the final `model_output` steps.
The API key comes implicitly from the `GEMINI_API_KEY` environment variable.

## 4. Runtime contract (environment)

`main.py` reads `SLACK_TEXT`, `SLACK_CHANNEL_ID` and `SLACK_BOT_TOKEN` with
`os.environ[...]`. If any is missing, the run crashes with `KeyError` and exits
non-zero. It reads these optionally (default `""`): `SLACK_COMMAND`, `SLACK_USER_ID`,
`SLACK_EVENT_TYPE` (default `slash_command`), `SLACK_EVENT_TS`, `SLACK_THREAD_TS`,
`SLACK_CHANNEL_TYPE`, `SLACK_RESPONSE_URL`, `AUTHORIZED_SLACK_USER_ID`,
`TASKS_SLACK_CHANNEL_ID`, `SLACK_PERSON` (JSON), `SLACK_TASK` (JSON),
`SLACK_VIEW_CALLBACK_ID`, `SLACK_INTERACTION_TYPE`, `SLACK_INTERACTION_NOTES`,
`SLACK_INTERACTION_DATE`, `SLACK_INTERACTION_TRACK_ID`, `NOTION_*`, `GEMINI_API_KEY`
(implicit).

`attention_summary.py` needs `SLACK_BOT_TOKEN` and `AUTHORIZED_SLACK_USER_ID`. If
either is missing it prints `::error::…` and exits 1. It also needs `NOTION_API_KEY`
and the `NOTION_{TASKS,PEOPLE,INTERACTIONS}_DATA_SOURCE_ID` variables.

Exit codes: a handled path calls `sys.exit(0)`. An uncaught exception exits 1 and
prints a traceback. The scheduled summary exits 1 on any source failure, even after
it has posted a partial summary.

## 5. Externally observable behavior of `main.py` (routing order)

1. **DM tracer.** Applies when `event_type == "message"` and `channel_type == "im"`. An unauthorized user is logged as `Unauthorized Slack DM ignored` and the run exits 0 without any call. An authorized user gets `DM conversation received.` in the thread (`thread_ts or event_ts`). A missing root ts raises.
2. **`view_submission`.** Checked with `is_private_data_request_authorized`. If unauthorized, the run logs and exits 0 silently. If authorized, it dispatches on `SLACK_VIEW_CALLBACK_ID`: `add_followup_task_modal` goes to the Task write, anything else goes to the Interaction write.
3. **`/tasks` and `/people` authorization.** An unauthorized request from a DM is silently ignored. An unauthorized request from a channel gets an ephemeral refusal through the response URL. Either way, nothing touches Notion.
4. **`handle_people_command`**: `due`, `suggest <name>`, and usage guidance for anything else.
5. **`handle_tasks_command`**: `list`, and usage guidance for anything else.
6. **Gemini conversation.** A slash command creates the `💬 {text}` root. A thread reply needs `SLACK_THREAD_TS` and raises without it. The full thread is read, and a thread rooted at `/tasks list` gets a fixed refusal. Otherwise the run sends the prompt to Gemini. A transient Gemini error (429/5xx) gets a fixed reply. Gemini 401/403 raises a secret-free `RuntimeError`.

Each module defines its user-facing text as constants. The TypeScript port must reproduce them byte for byte. The constants are the `*_MESSAGE`, `*_USAGE`, `*_REFUSAL` and prompt `*_INSTRUCTION` / `*_RULES` names in each module.

## 6. Security-critical functionality

| # | Invariant | Where |
| --- | --- | --- |
| S1 | DM tracer and DM-originated commands require an exact, case-sensitive match on `AUTHORIZED_SLACK_USER_ID`, and an empty configured value never matches. | `main.is_authorized_slack_user`, `slack_authorization` |
| S2 | `/tasks`, `/people` and modal submissions are authorized (configured channel, or the authorized user's DM) **before** any Notion or Gemini access. Unauthorized DMs get no response. | `main.py` |
| S3 | Notion writes take Person identity only from the structured payload. If the identity is missing or malformed, the write is a silent no-op. | `parse_person_payload`, both write handlers |
| S4 | Interaction Type is re-validated against the live Notion schema at write time. Track id is re-validated against the live Tracks list. A Track id is rejected if the Tracks data source is unconfigured. Task Priority is validated, and Status `Ikke startet` must exist. No Notion select option is ever created. | `people_interaction`, `followup_task` |
| S5 | Gemini output never triggers a side effect. Next-step kinds are validated against the live Types list plus `Wait`, with at most 2. A suggested Task is validated and bounded, and it only prefills a modal. | `people_suggest`, `followup_task` |
| S6 | `/tasks` and `/people due` never call Gemini. Gemini receives only the bounded context that has been documented. | `docs/people-suggest-gemini-context.md` |
| S7 | Logs and error messages carry no secrets, Slack text, Notion data, prompts or model output. Exceptions are re-raised with `from None` to drop causes that could include them. The attention summary logs only error types, HTTP status codes and missing config names. | all |
| S8 | The workflow masks payload text fields and the response URL. The response URL is exported via `$GITHUB_ENV`, never through an `env:` mapping. | `slack-message.yml` |
| S9 | Non-idempotent Task create retries only on HTTP 429. A 5xx, timeout or connection error gives the "may not have been added" message instead of a retry. | `followup_task.create_task_page` |
| S10 | Reads and output are bounded: 500 scanned rows, 20 displayed, 25 Track options, 5 Interactions, 5 resolved Tracks, 500-char Purpose, 3000-char Slack section, 2000-char button value, 75-char button text, and limits of 150/500 chars and 365 days on a suggested Task. | constants |
| S11 | Notion credential failures (401, and 403 where configured) raise `NotionAuthenticationError` and fail the run visibly on read commands. Best-effort paths (Track selector, Type options, follow-up buttons) degrade instead, and so do both write handlers, which catch it and post a generic failure (see TECH-DEBT TD7). | `call_notion_with_retries` and its callers |

## 7. Observed quirks that must be preserved, not fixed

These behaviors are probably unintentional, but they are current behavior. Under
the experiment rules they are reproduced and listed, not fixed.

1. `task_from_notion_page` parses the Follow-up with `date.fromisoformat`. If the Notion Follow-up contains a time (`2026-10-13T09:00:00.000+02:00`), the task is counted as **malformed and skipped**. By contrast, `people_due.parse_notion_date` accepts datetimes and takes the date in the string's own offset.
2. Interaction create (`create_interaction_page`) uses the default retry policy, which retries 5xx and timeouts. So unlike Task create (S9), it can duplicate an Interaction on an ambiguous failure.
3. `date.fromisoformat` in Python 3.11+ accepts more than `YYYY-MM-DD`, for example `20261013` and `2026-W42-2`. Modal dates (`SLACK_INTERACTION_DATE`, the Task `follow_up`) are parsed this way. **Assumption:** in practice Slack datepickers only send `YYYY-MM-DD`.
4. `find_one_due_person` is legacy and is used only by tests.
5. The README is stale. It describes Notion as read-only and its repository tree omits `people_interaction.py` and `followup_task.py`.
6. The local Python (3.14) differs from CI (3.12). Some `fromisoformat` and `casefold` details depend on the version. The TypeScript reference is CI's 3.12 behavior where the two differ. **Assumption:** no test depends on the difference, since all 358 pass on 3.14.

## 8. Python-semantics hazards for a TypeScript port

These are places where a naive translation would silently change behavior:

| Python | Naive JS/TS | Difference |
| --- | --- | --- |
| `str.casefold()` | `toLowerCase()` | `ß` → `ss` (casefold), but `toLowerCase` gives `ß`. Approximate with `toUpperCase().toLowerCase()` (verified locally: `ß` → `ss`). |
| `str.strip()` / `str.split()` | `trim()` / `split(/\s+/)` | The whitespace sets differ (`\x1c-\x1f`, `﻿`). |
| `len(s)`, `s[:n]` | `s.length`, `slice` | Python counts code points and JS counts UTF-16 units. All truncation and length limits (S10) are affected by emoji and other astral characters. |
| `json.dumps(v)` | `JSON.stringify(v)` | Python uses `", "` / `": "` separators and `ensure_ascii` (`ø` → `ø`). The 2000-char button-value limit is measured on that output. |
| `date` / `date.fromisoformat` / `datetime.fromisoformat(...).date()` | `new Date(...)` | JS converts to local time or UTC, and its accepted formats differ. A timezone-free date type is needed. |
| tuple sort keys, `str <` | `localeCompare` | Python compares by code point. JS `<` compares UTF-16 units, which differs only for astral characters. |
| `float(retry_after)` | `Number(...)` | `Number("")` is 0, while `float("")` raises. `float("1_0")` gives 10. |
| `email.utils.parsedate_to_datetime` | `Date.parse` | The accepted formats differ. |
| `requests` `raise_for_status`, `Timeout`, `ConnectionError`, `timeout=10` (connect/read) | `fetch` + `AbortSignal.timeout` (total) | fetch never throws on HTTP status, and its error classes and timeout semantics differ. |
| Exceptions with `from None` and the traceback | uncaught Node error | Node prints `cause` chains and fetch error details. Top-level error output must be controlled (S7). |
| SDK error `.code` / `.status_code` / `.response.status_code` | `@google/genai` `ApiError.status` | The status extraction must be mapped. |
| `print(...)` | `console.log` | Equivalent. Workflow commands such as `::error::` must stay on stdout. |
