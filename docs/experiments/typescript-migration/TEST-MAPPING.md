# TypeScript migration — Test mapping

This table traces every baseline Python test to the TypeScript test(s) that
assert the same behavior (ACCEPTANCE.md G4), and records which TS tests give
evidence for each security invariant (G6).

Conventions:

- Each Python test `PythonClass.test_method` is ported as a `node:test` test
  whose title **starts with the Python method name verbatim**, optionally
  followed by a space and a note (for example an invariant tag). The mapping can
  therefore be checked mechanically: every `def test_` in a Python file must
  appear as a title prefix in its TS file.
- `subTest` loops become `t.test` subtests under the same top-level title.
- A Python test that cannot apply is listed under "Not applicable" with a
  justification. A port that has to use a different mechanism is listed under
  "Adapted".
- TS-only tests (no Python counterpart) do not start with `test_`. They are
  listed so reviewers can see what extra evidence exists.
- Each slice appends the sections for the Python test files it ports.

## tests/test_slack_authorization.py → tests/slack-authorization.test.ts (S2)

| Python test | TS test title |
| --- | --- |
| `PrivateDataAuthorizationTests.test_existing_authorized_channel_is_allowed` | `test_existing_authorized_channel_is_allowed` |
| `PrivateDataAuthorizationTests.test_authorized_user_in_an_actual_dm_is_allowed` | `test_authorized_user_in_an_actual_dm_is_allowed` |
| `PrivateDataAuthorizationTests.test_user_id_match_without_dm_identity_is_rejected` | `test_user_id_match_without_dm_identity_is_rejected` |
| `PrivateDataAuthorizationTests.test_dm_authorization_uses_exact_user_id` | `test_dm_authorization_uses_exact_user_id (S1: case-sensitive)` |
| `PrivateDataAuthorizationTests.test_missing_authorization_configuration_fails_closed` | `test_missing_authorization_configuration_fails_closed (S1: empty value never authorizes)` |

Not applicable: none. Adapted: none.

## tests/test_tasks_list.py → tests/tasks-list.test.ts (S2)

| Python test | TS test title |
| --- | --- |
| `TasksListCommandTests.test_retries_a_rate_limited_query_twice_at_most_and_respects_retry_after` | `test_retries_a_rate_limited_query_twice_at_most_and_respects_retry_after` |
| `TasksListCommandTests.test_credential_failure_fails_with_a_safe_notion_specific_message` | `test_credential_failure_fails_with_a_safe_notion_specific_message (S11)` |
| `TasksListCommandTests.test_stops_after_two_retries_for_a_transient_query_failure` | `test_stops_after_two_retries_for_a_transient_query_failure` |
| `TasksListCommandTests.test_does_not_retry_a_malformed_query_response` | `test_does_not_retry_a_malformed_query_response` |
| `TasksListCommandTests.test_skips_malformed_tasks_and_reports_the_count` | `test_skips_malformed_tasks_and_reports_the_count` |
| `TasksListCommandTests.test_retries_a_transient_track_lookup` | `test_retries_a_transient_track_lookup` |
| `TasksListCommandTests.test_recovers_from_a_connection_error_and_a_server_error` | `test_recovers_from_a_connection_error_and_a_server_error` |
| `TasksListCommandTests.test_invalid_retry_after_values_use_backoff` | `test_invalid_retry_after_values_use_backoff` |
| `TasksListCommandTests.test_malformed_query_json_is_not_retried` | `test_malformed_query_json_is_not_retried` |
| `TasksListCommandTests.test_unexpected_task_parsing_error_is_not_reported_as_malformed` | `test_unexpected_task_parsing_error_is_not_reported_as_malformed` (adapted, see below) |
| `TasksListCommandTests.test_terminal_track_permission_failure_is_isolated` | `test_terminal_track_permission_failure_is_isolated` |
| `TasksListCommandTests.test_other_commands_are_not_owned` | `test_other_commands_are_not_owned` |
| `TasksListCommandTests.test_invalid_task_commands_return_usage_without_accessing_notion` | `test_invalid_task_commands_return_usage_without_accessing_notion` (4 subtests) |
| `TasksListCommandTests.test_lists_eligible_tasks_in_date_priority_and_name_order` | `test_lists_eligible_tasks_in_date_priority_and_name_order` |
| `TasksListCommandTests.test_empty_result_uses_the_specified_message` | `test_empty_result_uses_the_specified_message` |
| `TasksListCommandTests.test_renders_no_more_than_twenty_eligible_tasks` | `test_renders_no_more_than_twenty_eligible_tasks (S10: 20 displayed)` |
| `TasksListCommandTests.test_stops_after_five_pages_and_avoids_a_false_empty_claim` | `test_stops_after_five_pages_and_avoids_a_false_empty_claim (S10: 500 scanned)` |
| `TasksListCommandTests.test_normalized_list_commands_use_the_task_path` | `test_normalized_list_commands_use_the_task_path` (5 subtests) |
| `TasksListCommandTests.test_renders_zero_one_and_exactly_three_tracks` | `test_renders_zero_one_and_exactly_three_tracks` |
| `TasksListCommandTests.test_truncates_after_ordering_and_reports_the_remainder` | `test_truncates_after_ordering_and_reports_the_remainder` |
| `TasksListCommandTests.test_unavailable_tracks_count_toward_the_cap_and_remainder` | `test_unavailable_tracks_count_toward_the_cap_and_remainder` |
| `TasksListCommandTests.test_reuses_track_lookups_and_keeps_tasks_when_a_track_is_unavailable` | `test_reuses_track_lookups_and_keeps_tasks_when_a_track_is_unavailable` |
| `TasksListCommandTests.test_only_displayed_tasks_trigger_track_resolution` | `test_only_displayed_tasks_trigger_track_resolution` |

Not applicable: none.

Adapted:

- `test_unexpected_task_parsing_error_is_not_reported_as_malformed`: Python uses
  `patch("tasks_list.task_from_notion_page", side_effect=AssertionError)`. ES
  module bindings cannot be patched, so the TS test gives
  `selectTasksNeedingAttention` a page whose `properties` getter throws an
  `AssertionError`. The assertion is the same: the error propagates and is not
  counted as malformed. The error is raised inside `taskFromNotionPage`
  and propagates through both functions.
- Mocks: `Mock` objects become recording functions whose `calls` list is checked
  with `deepEqual` (`assert_called_once_with(...)` → `calls` equals exactly one
  argument list). Python's keyword arguments are the TS options object, so
  `notion_post.assert_called_once_with(URL, headers=..., json=..., timeout=10)`
  is `calls` deep-equal to `[[URL, { headers, json, timeout: 10 }]]`.
- Fake Notion responses are real `HttpResponse` objects from `src/http.ts`. A
  non-2xx status makes `raise_for_status()` throw the real `HTTPError`, in place of
  the Python test's `Mock().raise_for_status.side_effect = NotionHttpError(...)`.
  `json.side_effect = ValueError(...)` becomes a non-JSON body (`json()` throws
  `JSONDecodeError`, a `ValueError`). `run_list`'s
  `raise_for_status.assert_called_once_with()` is kept through a subclass that
  counts the calls.
- `test_invalid_retry_after_values_use_backoff` keeps the Python test's own
  `NotionHttpError` fake (a dict of headers), so `retryDelay` is tested with both
  a plain dict and, elsewhere, a real `Headers` object.
- `assertNotRegex(output, r"\b\d+\s+more\b")` becomes
  `/\b\p{Nd}+\s+more\b/u`, so the digit class is Unicode-wide like Python's `\d`.
  JS `\s` and `\b` differ slightly from Python's Unicode versions; the output
  contains no characters where they differ.
- `RuntimeError("Notion lookup failed")` in the Track fakes becomes a plain
  `Error`. Both are "any other exception" for `call_notion_with_retries`.

TS-only tests (no Python counterpart):

- `S11: a 401 on a Track lookup fails the run without a cause`
- `TD2: a Follow-up with a time is parsed with date.fromisoformat and skipped as malformed`
- `callNotionWithRetries: the final TaskListCommandError carries the request error as its cause`
- `callNotionWithRetries: is_retryable narrows retries and 403 is a credential failure by default`
- `isRetryableNotionError matches the requests classification`
- `retryDelay reads Retry-After case-insensitively from an HttpResponse and honors a future HTTP-date`
- `a missing NOTION_API_KEY raises KeyError after the root message, as environment[...] does`

Also added in S2, in `tests/python-compat.test.ts`, for the new compat helpers:
`withPyCause records __cause__ without Node printing it`,
`getPyCause is null (None) when there is no cause`, and `KeyError` assertions
in `error classes carry Python's names`.

## Security-invariant evidence (G6)

Filled in as slices land. Tests named here fail if the invariant breaks.

| Invariant | TS tests so far |
| --- | --- |
| S1 | `test_dm_authorization_uses_exact_user_id`, `test_missing_authorization_configuration_fails_closed`, `test_user_id_match_without_dm_identity_is_rejected` (slack-authorization.test.ts) |
| S2 | **Deferred to S8**: the authorization-before-calls order lives in `main.ts` (PLAN.md §9 amendment). |
| S7 (partial: `raise … from`) | `withPyCause records __cause__ without Node printing it` (python-compat.test.ts); `callNotionWithRetries: the final TaskListCommandError carries the request error as its cause` |
| S10 (partial: 500 scanned, 20 displayed, 3 Tracks shown) | `test_stops_after_five_pages_and_avoids_a_false_empty_claim`, `test_renders_no_more_than_twenty_eligible_tasks`, `test_truncates_after_ordering_and_reports_the_remainder`, `test_only_displayed_tasks_trigger_track_resolution` |
| S11 (partial: `/tasks list`) | `test_credential_failure_fails_with_a_safe_notion_specific_message`, `S11: a 401 on a Track lookup fails the run without a cause`, `test_terminal_track_permission_failure_is_isolated` (403 on a Track degrades) |
