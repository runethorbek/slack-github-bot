# Equivalence fixtures

Reference data recorded from the Python implementation, which the TypeScript
implementation must reproduce (see `docs/experiments/typescript-migration/ACCEPTANCE.md`).

**These files are the frozen Python reference.** The Python application, the
recorder (`record_python.py`) and the three generators
(`generate_python_compat_golden.py`, `generate_people_suggest_prompts.py`,
`generate_followup_task_fixture.py`) were removed in migration slice S9,
together with the rest of Python. Their last `--check` runs, just before the
removal, all reported the files up to date. The files can no longer be
regenerated and must not be edited: a change to them is a change to the
specification, not a fix.

- `golden/python-compat.json`: the Python-semantics table, written by
  `generate_python_compat_golden.py`. Read by `tests/python-compat.test.ts`,
  `tests/plain-date.test.ts` and `tests/people-suggest.test.ts`.
- `people-suggest-prompts.json`: `people_suggest`'s prompt constants, built
  Gemini prompts, next-step splits and reply blocks, written by
  `generate_people_suggest_prompts.py`. Read by `tests/people-suggest.test.ts`.
  It lives outside `golden/`, which holds only the recorder's scenario goldens
  and the compat table.
- `followup-task-fixture.json`: `followup_task`'s constants (including the
  Gemini system instruction), built follow-up suggestion prompts, Block Kit
  buttons, and parser results for edge-case input, written by
  `generate_followup_task_fixture.py`. Read by `tests/followup-task.test.ts`.
  It lives outside `golden/` for the same reason.
- `scenarios/<name>.json` and `golden/<name>.json`: end-to-end scenarios and
  the observables Python produced for them, written by `record_python.py`.
  `tests/equivalence.test.ts` replays every scenario against the TypeScript
  entry points with `replay.ts` (one child process per scenario, with scripted
  HTTP and Gemini fakes) and compares the result with the golden under the
  rules below.

`npm test` runs all of these checks.

The sections below describe the formats as the recorder wrote them; Python
names in them (`__main__`, `sys.exit`, `print`, `requests`) refer to the
removed implementation that produced the files.

## Scenario format (`scenarios/<name>.json`)

| Key | Meaning |
| --- | --- |
| `name` | Equals the file name without `.json`. |
| `description` | The branch and invariants the scenario exercises. |
| `entrypoint` | `"main"` (run as `__main__`) or `"attention_summary"` (`sys.exit(main())`). |
| `today` | The frozen Copenhagen date, `YYYY-MM-DD`. |
| `env` | The exact process environment. Nothing else is set. |
| `http` | Ordered script. Each outbound call consumes the next entry. |
| `gemini` | Ordered script. Each `interactions.create` call consumes the next entry. |
| `known_leak` | Optional note. Present only if the Python baseline leaks a canary (none does). |

An `http` entry is `{"expect": {"method", "url"}, "response": {...}}` or
`{"expect": {...}, "error": "ReadTimeout" | "ConnectTimeout" | "ConnectionError"}`.
A response has `status`, optional `headers`, and either `json` or `text` (or
neither, for an empty body). Every `Retry-After` is numeric (the recorder
rejects anything else); HTTP-date values would depend on the wall clock.

A `gemini` entry is `{"output_text": "..."}` or `{"error": {"status": 429}}`.
An error is the SDK's HTTP status error, whose status is readable as
`error.response.status_code` / `error.status_code` in Python. A replay must
raise the equivalent `@google/genai` error with that status.

The goldens were checked against **google-genai 2.30.0**, where
`client.interactions.create` raises the `APIStatusError` subclasses in
`google.genai._gaos.lib.compat_errors` (`RateLimitError`, `AuthenticationError`,
`InternalServerError`, ...). With another installed version the recorder prints
a warning and continues; if that module cannot be imported it fails.

A call that is not in the script, that does not match its `expect`, or a
script entry left unused, is a harness failure, never a pass.

## Golden format (`golden/<name>.json`)

| Key | Content |
| --- | --- |
| `http_calls` | In order: `method`, `url`, `params`, `headers`, `json` (request body), `timeout`. Absent values are `null`. |
| `gemini_calls` | In order: `model`, `input` (the exact prompt). |
| `sleeps` | Retry sleep durations in seconds, in order. |
| `stdout` | The lines printed deliberately with `print`, in order. |
| `exit` | `{"code": 0}`, or `{"code": 1}`, or `{"code": 1, "uncaught": {"type", "message"}}` when an exception escaped the entry point (`message` is `str(exc)`). |

Files are written with sorted keys, `ensure_ascii`, two-space indentation and LF
line endings. Key order inside a request body is therefore not recorded, and
bodies compare semantically (ACCEPTANCE.md §1). Strings inside the body, such
as Block Kit button `value`s, keep Python's exact `json.dumps` output.

Every scenario uses canary values for secrets and private data
(`xoxb-CANARY-SLACK-TOKEN`, `secret_CANARY_NOTION_KEY`, `CANARY-GEMINI-KEY`,
`https://hooks.slack.com/commands/CANARY-RESPONSE-URL`, and `CANARY-PRIVATE` in
Slack text and Notion notes). The recorder fails if any canary reaches stdout,
stderr, an uncaught exception message, or that exception's full formatted
traceback including its chain (invariant S7). The replay should check the
same on everything the TS entry point writes to stdout and stderr.

## Replay normalisation rules

Rules for the TypeScript replay harness when it compares its observables with a
golden:

- **`url` and `params`.** Python passes query parameters separately
  (`params`) and the URL without a query string. Compare the URL without its
  query string to `url`, and the query parameters (as a string-to-string map,
  order ignored) to `params`. `params: null` means no query string.
- **`headers`.** Exact name and value equality for the headers the
  application sets. Headers added by the transport (`fetch` or `requests`
  defaults such as `User-Agent`, `Content-Length`) are not part of the golden.
- **`timeout`.** Seconds, as the application passes it to the HTTP adapter
  (`timeout=10` in Python; the `src/http.ts` adapter takes the same value). It
  is not the transport's internal timeout mechanism.
- **`json`.** Request bodies compare semantically: parse both and compare
  structures, ignoring key order and whitespace. String values inside compare
  exactly. That includes Block Kit button `value` strings, which are
  serialized JSON and must equal Python's `json.dumps` output byte for byte
  (`", "` / `": "` separators, `\uXXXX` escapes), because the 2000-character
  limit is measured on that string.
- **`gemini_calls`.** `model` and `input` compare exactly.
- **`sleeps`.** Compare numerically, in order: `2` and `2.0` are equal.
- **`stdout`.** Exact line equality, in order.
- **`exit`.** `code` compares exactly (0 vs non-zero is the outcome; 1 is the
  only non-zero code recorded). For `uncaught`, the replay always checks the
  exit code and that no canary appears in the error output. It also checks that
  the error output contains `message`, but **only when the message is an
  application-defined string** (for example `Slack authentication failed
  (invalid_auth).` or `Notion authentication failed (HTTP 401).`). Messages
  that come from Python's own exception formatting, such as `str(KeyError)` →
  `'SLACK_TEXT'`, are not required: ACCEPTANCE §1 permits the crash-output
  format to differ. (This is an Orchestrator spec decision, made at S1 review
  R6.) The Python `type` name is informational: it does not have to match a TS
  class name.

## How the files were produced (historical)

Until S9, the files were written and checked under Python 3.12 (the recorder
refused any other version) with `py -3.12 tests/equivalence/record_python.py`
and each generator, each with a `--check` mode that CI ran. The recorder ran
the real Python entry points in-process with `requests`,
`google.genai.Client`, `time.sleep` and `copenhagen_today` replaced. Those
scripts no longer exist in the working tree; they remain in the Git history
before S9.

**The goldens are the frozen Python reference.** They must not be regenerated
or edited. A change to them is a change to the specification, not a fix.
