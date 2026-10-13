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

## tests/test_people_due.py → tests/people-due.test.ts (S3)

| Python test | TS test title |
| --- | --- |
| `PeopleDueTests.test_each_supported_cadence_uses_calendar_months` | `test_each_supported_cadence_uses_calendar_months` (5 subtests) |
| `PeopleDueTests.test_no_valid_previous_interaction_is_due` | `test_no_valid_previous_interaction_is_due` |
| `PeopleDueTests.test_missing_invalid_and_future_interaction_dates_are_ignored` | `test_missing_invalid_and_future_interaction_dates_are_ignored` |
| `PeopleDueTests.test_latest_valid_interaction_wins` | `test_latest_valid_interaction_wins` |
| `PeopleDueTests.test_due_exactly_today` | `test_due_exactly_today` |
| `PeopleDueTests.test_one_day_before_due_is_not_due` | `test_one_day_before_due_is_not_due` |
| `PeopleDueTests.test_past_due_date_is_overdue` | `test_past_due_date_is_overdue` |
| `PeopleDueTests.test_month_end_and_leap_year_arithmetic` | `test_month_end_and_leap_year_arithmetic` (2 subtests) |
| `PeopleDueTests.test_people_without_cadence_are_ignored_defensively` | `test_people_without_cadence_are_ignored_defensively` |
| `PeopleDueTests.test_person_with_cadence_and_no_interaction_is_due` | `test_person_with_cadence_and_no_interaction_is_due` |
| `PeopleDueTests.test_latest_valid_interaction_is_used` | `test_latest_valid_interaction_is_used` |
| `PeopleDueTests.test_future_interaction_is_ignored` | `test_future_interaction_is_ignored` |
| `PeopleDueTests.test_stops_after_the_first_due_person` | `test_stops_after_the_first_due_person` |
| `PeopleDueTests.test_not_due_person_is_skipped_and_empty_result_is_deterministic` | `test_not_due_person_is_skipped_and_empty_result_is_deterministic` |
| `PeopleDueTests.test_output_includes_required_fields_and_queries_are_read_only` | `test_output_includes_required_fields_and_queries_are_read_only` |
| `PeopleDueTests.test_no_interaction_output_says_so_without_a_due_date` | `test_no_interaction_output_says_so_without_a_due_date` |
| `PeopleDueTests.test_calendar_month_addition_clamps_month_end` | `test_calendar_month_addition_clamps_month_end` |
| `PeopleDueTests.test_unknown_cadence_is_skipped_without_being_interpreted` | `test_unknown_cadence_is_skipped_without_being_interpreted` |
| `PeopleDueListTests.test_multiple_due_people_are_returned` | `test_multiple_due_people_are_returned` |
| `PeopleDueListTests.test_people_not_due_are_excluded` | `test_people_not_due_are_excluded` |
| `PeopleDueListTests.test_ordering_places_most_overdue_first` | `test_ordering_places_most_overdue_first` |
| `PeopleDueListTests.test_no_previous_interaction_people_are_ordered_after_dated_overdue` | `test_no_previous_interaction_people_are_ordered_after_dated_overdue` |
| `PeopleDueListTests.test_name_is_a_stable_tiebreaker_within_each_group` | `test_name_is_a_stable_tiebreaker_within_each_group` |
| `PeopleDueListTests.test_person_without_cadence_is_excluded_from_bulk_evaluation` | `test_person_without_cadence_is_excluded_from_bulk_evaluation` |
| `PeopleDueListTests.test_no_due_people_produces_the_deterministic_empty_state` | `test_no_due_people_produces_the_deterministic_empty_state` |
| `PeopleDueListTests.test_reads_are_query_only_and_bounded_to_two_notion_calls` | `test_reads_are_query_only_and_bounded_to_two_notion_calls` |
| `PeopleDueListTests.test_person_with_linkedin_url_is_rendered_as_a_clickable_link` | `test_person_with_linkedin_url_is_rendered_as_a_clickable_link` |
| `PeopleDueListTests.test_person_without_linkedin_url_is_rendered_as_plain_text` | `test_person_without_linkedin_url_is_rendered_as_plain_text` |
| `PeopleDueListTests.test_mixed_linkedin_and_no_linkedin_people_render_independently` | `test_mixed_linkedin_and_no_linkedin_people_render_independently` |
| `PeopleDueListTests.test_result_count_is_bounded_and_shows_a_remainder_indicator` | `test_result_count_is_bounded_and_shows_a_remainder_indicator (S10: 20 displayed)` |
| `PeopleDueListTests.test_result_within_the_limit_has_no_remainder_indicator` | `test_result_within_the_limit_has_no_remainder_indicator` |
| `PeopleDueListTests.test_people_pagination_collects_every_page_when_complete` | `test_people_pagination_collects_every_page_when_complete` |
| `PeopleDueListTests.test_people_scan_reaching_the_bound_marks_the_result_incomplete` | `test_people_scan_reaching_the_bound_marks_the_result_incomplete (S10: 500 scanned)` |
| `PeopleDueListTests.test_missing_next_cursor_marks_incomplete_without_looping_forever` | `test_missing_next_cursor_marks_incomplete_without_looping_forever` |
| `PeopleDueListTests.test_interaction_scan_bound_flags_incomplete_instead_of_mislabeling` | `test_interaction_scan_bound_flags_incomplete_instead_of_mislabeling (S10: 500 scanned)` |
| `PeopleDueListTests.test_incomplete_scan_appends_a_disclaimer_after_the_due_list` | `test_incomplete_scan_appends_a_disclaimer_after_the_due_list` |
| `PeopleDueListTests.test_incomplete_scan_replaces_the_empty_state_message` | `test_incomplete_scan_replaces_the_empty_state_message` |
| `PeopleDueSuggestButtonTests.test_due_person_block_has_a_suggest_button_with_the_person_name` | `test_due_person_block_has_a_suggest_button_with_the_person_name` |
| `PeopleDueSuggestButtonTests.test_button_value_is_the_exact_person_name_not_the_linkedin_label` | `test_button_value_is_the_exact_person_name_not_the_linkedin_label` |
| `PeopleDueSuggestButtonTests.test_blocks_and_linkedin_link_render_independently_for_mixed_people` | `test_blocks_and_linkedin_link_render_independently_for_mixed_people` |
| `PeopleDueSuggestButtonTests.test_cadence_and_interaction_fields_are_preserved_in_the_block_text` | `test_cadence_and_interaction_fields_are_preserved_in_the_block_text` |
| `PeopleDueSuggestButtonTests.test_build_due_people_blocks_bounds_to_the_display_limit_with_a_remainder_block` | `test_build_due_people_blocks_bounds_to_the_display_limit_with_a_remainder_block (S10: 20 displayed)` |
| `PeopleDueSuggestButtonTests.test_handle_people_due_passes_blocks_with_buttons_to_post_slack_message` | `test_handle_people_due_passes_blocks_with_buttons_to_post_slack_message` |
| `PeopleDueSuggestButtonTests.test_handle_people_due_passes_no_blocks_when_no_people_are_due` | `test_handle_people_due_passes_no_blocks_when_no_people_are_due` |
| `PeopleDueSuggestButtonTests.test_clicking_the_button_reuses_the_existing_suggest_command_route` | **Deferred to S5** (needs the real people-suggest module) |
| `PeopleDueSuggestButtonTests.test_notion_get_is_threaded_through_to_suggest_for_track_resolution` | **Deferred to S5** (needs the real people-suggest module) |
| `PeopleDueRobustnessTests.test_malformed_person_record_does_not_block_other_people` | `test_malformed_person_record_does_not_block_other_people` |
| `PeopleDueRobustnessTests.test_invalid_cadence_is_skipped_without_being_interpreted` | `test_invalid_cadence_is_skipped_without_being_interpreted` |
| `PeopleDueRobustnessTests.test_malformed_linkedin_property_falls_back_to_no_link_without_skipping` | `test_malformed_linkedin_property_falls_back_to_no_link_without_skipping` (4 subtests) |
| `PeopleDueRobustnessTests.test_malformed_interaction_record_does_not_block_valid_people` | `test_malformed_interaction_record_does_not_block_valid_people` |
| `PeopleDueRobustnessTests.test_missing_and_invalid_interaction_dates_do_not_crash_the_scan` | `test_missing_and_invalid_interaction_dates_do_not_crash_the_scan` |
| `PeopleDueRobustnessTests.test_malformed_person_is_skipped_and_reported_with_a_count` | `test_malformed_person_is_skipped_and_reported_with_a_count` |
| `PeopleDueRobustnessTests.test_transient_notion_failure_recovers_via_shared_retry` | `test_transient_notion_failure_recovers_via_shared_retry` |
| `PeopleDueRobustnessTests.test_notion_auth_failure_is_not_retried_and_propagates_uncaught` | `test_notion_auth_failure_is_not_retried_and_propagates_uncaught (S11)` |
| `PeopleDueRobustnessTests.test_exhausted_transient_failure_produces_a_safe_generic_message` | `test_exhausted_transient_failure_produces_a_safe_generic_message` |
| `PeopleDueRobustnessTests.test_malformed_query_response_produces_a_safe_message_without_raw_payload` | `test_malformed_query_response_produces_a_safe_message_without_raw_payload` |

Not applicable: none.

Deferred to S5 (needs the real people-suggest module):

- `PeopleDueSuggestButtonTests.test_clicking_the_button_reuses_the_existing_suggest_command_route`
- `PeopleDueSuggestButtonTests.test_notion_get_is_threaded_through_to_suggest_for_track_resolution`

Both drive `handle_people_command` through the real `handle_people_suggest`
(Gemini fakes, Type-schema and Track GETs). In S3, `src/people-suggest.ts` is a
placeholder whose `handlePeopleSuggest` throws, so they are ported in S5 into
`tests/people-due.test.ts` under their Python names. Until then, the TS-only
test `handlePeopleCommand: suggest <person> dispatches to the lazily imported
people-suggest module` shows that the branch reaches the dynamically imported
module.

Adapted:

- Mocks, fake responses and keyword arguments follow the S2 conventions above.
  `Mock().json.return_value = {...}` is an `HttpResponse` whose body is that
  JSON. `raise_for_status.side_effect = NotionHttpError(429, {"Retry-After": "2"})`
  is an `HttpResponse` with status 429 and that header, so the real `HTTPError`
  carries it. `json.return_value = {"results": "not-a-list-of-people"}` is a body
  with that value. `sleep.assert_called_once_with(2.0)` is `sleep.calls`
  deep-equal to `[[2]]`; JS has one number type.
- `final_call.kwargs["blocks"]` / `assertIsNone(...)`: the TS options object is
  checked to *have* a `blocks` key whose value is `null`, since Python's
  `kwargs["blocks"]` would raise if the keyword were not passed.
- The Python fixtures (`person`, `interaction`, `malformed_person`, `response`,
  `paged_response`, `environment`) are identical in every Python test class, so
  they are defined once at module level. `due_person` differs between
  `PeopleDueListTests` (`Person(name, name, "1 month")`) and
  `PeopleDueSuggestButtonTests` (`Person("p1", name, cadence, ...)`); both are
  kept as `listDuePerson` and `buttonDuePerson`.
- `Person` and `DuePerson` are plain readonly objects with camelCase fields
  (`pageId`, `linkedinUrl`, `latestInteraction`, `nextContactDue`); a Python
  `Person(...)` with the `linkedin_url` default is written with
  `linkedinUrl: null`.

TS-only tests (no Python counterpart):

- `handlePeopleCommand: suggest <person> dispatches to the lazily imported people-suggest module`
- `handlePeopleCommand: other commands are not owned; invalid text gets the usage response`
- `S6: /people due never calls generateText`
- `handlePeopleDue: the incomplete and skipped notes are added to the text and the blocks`
- `fetchNotionPages: a malformed response is a PeopleDueCommandError caused by the parse error, not retried`
- `fetchNotionPages: passes each cursor to buildRequestJson and stops at maxScanned // pageSize pages`
- `parseNotionDate: a datetime keeps the date written in its own offset (quirk 1)`
- `findDuePeople: Python dict-key semantics for Person ids`

Also added in S3:

- `tests/python-compat.test.ts`, for the untrusted-JSON accessors moved there
  from `src/tasks-list.ts` (review carry-over R5):
  `isDict is isinstance(value, dict) for JSON values`,
  `truthy matches bool() for JSON values`,
  `subscript matches value[key] for a str key`,
  `dictGet matches value.get(key, fallback)`,
  `dictContains matches key in dict, own keys only`,
  `iterate matches iter(value)`,
  `assertHashable raises TypeError for a list or dict, like a dict key lookup`,
  `isAccessError and isParseError match the Python except clauses`.
- `tests/tasks-list.test.ts` (review carry-over R2):
  `sleepSeconds raises what Python 3.12's time.sleep raises, at once`.

## Security-invariant evidence (G6)

Filled in as slices land. Tests named here fail if the invariant breaks.

| Invariant | TS tests so far |
| --- | --- |
| S1 | `test_dm_authorization_uses_exact_user_id`, `test_missing_authorization_configuration_fails_closed`, `test_user_id_match_without_dm_identity_is_rejected` (slack-authorization.test.ts) |
| S2 | **Deferred to S8**: the authorization-before-calls order lives in `main.ts` (PLAN.md §9 amendment). |
| S6 (partial: `/people due`) | `S6: /people due never calls generateText` (people-due.test.ts). The suggest prompt contents are evidenced in S5. |
| S7 (partial: `raise … from`, generic failure text) | `withPyCause records __cause__ without Node printing it` (python-compat.test.ts); `callNotionWithRetries: the final TaskListCommandError carries the request error as its cause`; `test_exhausted_transient_failure_produces_a_safe_generic_message`, `test_malformed_query_response_produces_a_safe_message_without_raw_payload` (people-due.test.ts) |
| S10 (partial: 500 scanned, 20 displayed, 3 Tracks shown) | `test_stops_after_five_pages_and_avoids_a_false_empty_claim`, `test_renders_no_more_than_twenty_eligible_tasks`, `test_truncates_after_ordering_and_reports_the_remainder`, `test_only_displayed_tasks_trigger_track_resolution`; People and Interactions (people-due.test.ts): `test_people_scan_reaching_the_bound_marks_the_result_incomplete`, `test_interaction_scan_bound_flags_incomplete_instead_of_mislabeling`, `test_result_count_is_bounded_and_shows_a_remainder_indicator`, `test_build_due_people_blocks_bounds_to_the_display_limit_with_a_remainder_block` |
| S11 (partial: `/tasks list`, `/people due`) | `test_credential_failure_fails_with_a_safe_notion_specific_message`, `S11: a 401 on a Track lookup fails the run without a cause`, `test_terminal_track_permission_failure_is_isolated` (403 on a Track degrades); `test_notion_auth_failure_is_not_retried_and_propagates_uncaught` (people-due.test.ts) |
