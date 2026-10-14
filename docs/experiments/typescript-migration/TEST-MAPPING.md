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
| `PeopleDueSuggestButtonTests.test_clicking_the_button_reuses_the_existing_suggest_command_route` | `test_clicking_the_button_reuses_the_existing_suggest_command_route` (ported in S5) |
| `PeopleDueSuggestButtonTests.test_notion_get_is_threaded_through_to_suggest_for_track_resolution` | `test_notion_get_is_threaded_through_to_suggest_for_track_resolution` (ported in S5) |
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

Deferred: none. Two tests were deferred from S3 and ported in S5:

- `PeopleDueSuggestButtonTests.test_clicking_the_button_reuses_the_existing_suggest_command_route`
- `PeopleDueSuggestButtonTests.test_notion_get_is_threaded_through_to_suggest_for_track_resolution`

Both drive `handle_people_command` through the real `handle_people_suggest`
(Gemini fakes, Type-schema and Track GETs). In S3, `src/people-suggest.ts` was a
placeholder whose `handlePeopleSuggest` threw, so they were ported in S5 into
`tests/people-due.test.ts` under their Python names, through the real module.
`PeopleDueSuggestButtonTests.type_schema_response` is the module-level
`typeSchemaResponse()`. A `Mock(return_value=...)` generate_text or notion_get
is a recording function that always resolves that value, and
`self.assertTrue(handled)` is `assert.equal(handled, true)`.

The S3 TS-only test `handlePeopleCommand: suggest <person> dispatches to the
lazily imported people-suggest module` asserted the placeholder's error. In S5
it was adjusted (same title) to assert the real route instead: the normalized
name reaches `handlePeopleSuggest` (root message `/people suggest Jane  Doe`,
with the inner spacing kept), one People query is made, and the not-found reply
goes to the thread.

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

## tests/test_people_interaction.py → tests/people-interaction.test.ts (S4)

| Python test | TS test title |
| --- | --- |
| `AddInteractionButtonTests.test_value_carries_the_stable_page_id_and_name` | `test_value_carries_the_stable_page_id_and_name` |
| `AddInteractionButtonTests.test_no_tracks_omits_track_fields_entirely` | `test_no_tracks_omits_track_fields_entirely` |
| `AddInteractionButtonTests.test_tracks_and_default_are_carried_in_the_value` | `test_tracks_and_default_are_carried_in_the_value` |
| `AddInteractionButtonTests.test_tracks_without_a_default_omit_default_track_id` | `test_tracks_without_a_default_omit_default_track_id` |
| `AddInteractionButtonTests.test_no_interaction_types_omits_types_field` | `test_no_interaction_types_omits_types_field` |
| `AddInteractionButtonTests.test_interaction_types_are_carried_in_the_value` | `test_interaction_types_are_carried_in_the_value` |
| `FetchAvailableInteractionTypesTests.test_resolves_option_names_from_the_live_schema` | `test_resolves_option_names_from_the_live_schema` |
| `FetchAvailableInteractionTypesTests.test_a_type_added_in_notion_is_available_without_any_code_change` | `test_a_type_added_in_notion_is_available_without_any_code_change` |
| `FetchAvailableInteractionTypesTests.test_missing_type_property_is_a_failure` | `test_missing_type_property_is_a_failure` |
| `FetchAvailableInteractionTypesTests.test_type_property_not_a_select_is_a_failure` | `test_type_property_not_a_select_is_a_failure` |
| `FetchAvailableInteractionTypesTests.test_select_property_without_options_is_a_failure` | `test_select_property_without_options_is_a_failure` |
| `FetchAvailableInteractionTypesTests.test_malformed_option_entries_are_skipped` | `test_malformed_option_entries_are_skipped` |
| `IsValidInteractionTypeTests.test_type_present_among_live_options_is_valid` | `test_type_present_among_live_options_is_valid` |
| `IsValidInteractionTypeTests.test_type_not_among_live_options_is_invalid` | `test_type_not_among_live_options_is_invalid` |
| `FetchAvailableTracksTests.test_resolves_id_and_name_sorted_alphabetically` | `test_resolves_id_and_name_sorted_alphabetically` |
| `FetchAvailableTracksTests.test_malformed_track_page_is_skipped` | `test_malformed_track_page_is_skipped` |
| `FetchAvailableTracksTests.test_no_tracks_returns_empty_list` | `test_no_tracks_returns_empty_list` |
| `IsValidTrackTests.test_id_present_among_live_tracks_is_valid` | `test_id_present_among_live_tracks_is_valid` |
| `IsValidTrackTests.test_id_not_among_live_tracks_is_invalid` | `test_id_not_among_live_tracks_is_invalid` |
| `IsValidTrackTests.test_unconfigured_tracks_data_source_fails_closed` | `test_unconfigured_tracks_data_source_fails_closed (S4)` |
| `HandleAddInteractionSubmissionTests.test_valid_type_is_accepted_and_written_with_the_correct_person_relation` | `test_valid_type_is_accepted_and_written_with_the_correct_person_relation` |
| `HandleAddInteractionSubmissionTests.test_notes_are_preserved_exactly` | `test_notes_are_preserved_exactly` |
| `HandleAddInteractionSubmissionTests.test_write_payload_contains_only_intended_fields` | `test_write_payload_contains_only_intended_fields` |
| `HandleAddInteractionSubmissionTests.test_date_defaults_to_today_when_missing` | `test_date_defaults_to_today_when_missing` |
| `HandleAddInteractionSubmissionTests.test_unknown_type_is_rejected_before_any_notion_write` | `test_unknown_type_is_rejected_before_any_notion_write (S4)` |
| `HandleAddInteractionSubmissionTests.test_empty_type_is_rejected` | `test_empty_type_is_rejected` |
| `HandleAddInteractionSubmissionTests.test_type_validation_failure_produces_a_safe_message_without_a_write` | `test_type_validation_failure_produces_a_safe_message_without_a_write` |
| `HandleAddInteractionSubmissionTests.test_malformed_date_is_rejected_before_any_notion_write` | `test_malformed_date_is_rejected_before_any_notion_write` |
| `HandleAddInteractionSubmissionTests.test_missing_person_identity_is_ignored_rather_than_guessed` | `test_missing_person_identity_is_ignored_rather_than_guessed (S3)` |
| `HandleAddInteractionSubmissionTests.test_notion_failure_produces_a_safe_message_without_a_partial_write` | `test_notion_failure_produces_a_safe_message_without_a_partial_write` |
| `HandleAddInteractionSubmissionTests.test_unresolvable_title_property_produces_a_safe_message_without_a_partial_write` | `test_unresolvable_title_property_produces_a_safe_message_without_a_partial_write` |
| `HandleAddInteractionSubmissionTests.test_notion_authentication_failure_produces_a_safe_message_without_a_partial_write` | `test_notion_authentication_failure_produces_a_safe_message_without_a_partial_write (S11, TD7)` |
| `HandleAddInteractionSubmissionTests.test_confirmation_and_failure_replies_stay_in_the_suggestion_thread` | `test_confirmation_and_failure_replies_stay_in_the_suggestion_thread` |
| `HandleAddInteractionSubmissionTests.test_invalid_type_reply_stays_in_the_suggestion_thread` | `test_invalid_type_reply_stays_in_the_suggestion_thread` |
| `HandleAddInteractionSubmissionTests.test_no_track_selected_writes_an_empty_track_relation` | `test_no_track_selected_writes_an_empty_track_relation` |
| `HandleAddInteractionSubmissionTests.test_valid_track_is_written_as_the_track_relation` | `test_valid_track_is_written_as_the_track_relation` |
| `HandleAddInteractionSubmissionTests.test_a_track_id_that_is_not_a_live_track_is_rejected_before_any_write` | `test_a_track_id_that_is_not_a_live_track_is_rejected_before_any_write (S4)` |
| `HandleAddInteractionSubmissionTests.test_a_track_id_with_no_tracks_data_source_configured_is_rejected` | `test_a_track_id_with_no_tracks_data_source_configured_is_rejected (S4)` |
| `HandleAddInteractionSubmissionTests.test_track_validation_failure_produces_a_safe_message_without_a_write` | `test_track_validation_failure_produces_a_safe_message_without_a_write` |

Not applicable: none. Deferred: none.

Adapted:

- Mocks, fake responses and keyword arguments follow the S2/S3 conventions
  above. `Mock().raise_for_status.side_effect = Exception("boom")` is an
  `HttpResponse` subclass (`RaisingResponse`) whose `raise_for_status()` throws
  that plain `Error`, which is neither retryable nor a credential failure, as in
  Python.
- `test_notion_authentication_failure_produces_a_safe_message_without_a_partial_write`:
  Python raises `Exception("unauthorized")` with `.response = Mock(status_code=401)`.
  The TS test uses a real 401 `HttpResponse`, whose `raise_for_status()` throws
  the real `HTTPError` with `.response.status_code == 401`. The retry core reads
  the status code the same way from both.
- `post_slack_message.assert_called_once_with(msg, thread_ts=None)` is `calls`
  deep-equal to `[[msg, { threadTs: undefined }]]`. Python passes the
  `thread_ts` keyword on every post, so the TS options object always has the
  `threadTs` key (`None` → `undefined`, the `PostSlackMessage` type's "absent").
- A bare `Mock()` for `notion_post`/`notion_get` that the test expects not to be
  called (whether or not it asserts `assert_not_called`) rejects when called.
  An unexpected call therefore fails the test, which is stricter than Python's
  `Mock`.
- `assertRaises(AddInteractionCommandError)` is
  `assert.rejects(..., AddInteractionCommandError)`; `assertNotIn(key, value)`
  is `!Object.hasOwn(value, key)`; `set(properties.keys())` is compared as a
  `Set`.
- `schema_response`'s `type_options or TYPE_SELECT_OPTIONS` is
  `typeOptions && typeOptions.length > 0 ? typeOptions : TYPE_SELECT_OPTIONS`.
- `HandleAddInteractionSubmissionTests.environment` is the module-level
  `environment(tracksDataSourceId)`.

TS-only tests (no Python counterpart):

- `TD1 pin: a 5xx on Interaction create is retried with the default policy (can duplicate)`
- `TD1 pin: a ReadTimeout or ConnectionError on Interaction create is retried` (2 subtests)
- `TD1 pin: three 5xx on Interaction create give three creates, sleeps 1 and 2, and the generic failure`
- `TD7 pin: a 401 on Interaction create posts the generic failure and does not throw`
- `TD7 pin: a 403 on Interaction create is a credential failure too (not retried, caught)`
- `TD3 pin: the modal date is parsed with date.fromisoformat, so 20260922 and 2026-W39-2 are accepted` (2 subtests)
- `createInteractionPage: 401 and 403 throw NotionAuthenticationError (default credential codes)` (2 subtests)
- `write payload: the full create request equals Python's (URL, headers, timeout, properties, en dash)`
- `write payload: empty notes write an empty rich_text, and the property key order matches Python's dict`
- `validation order: date, then Type, then Track, then title property, then exactly one create`
- `S4: an invalid Type is rejected before the Track is validated`
- `S3: a page id without a name, or a name without a page id, is a silent no-op` (2 subtests)
- `buildFollowupButtons: called once after a successful write; its buttons are posted in an actions block`
- `buildFollowupButtons: no buttons means a plain confirmation without blocks`
- `buildFollowupButtons: not called when the submission is invalid or the write fails` (2 subtests)
- `buildFollowupButtons: an error it throws propagates (it runs outside the write's except)`
- `a missing NOTION_API_KEY raises KeyError, as environment[...] does (not caught)`
- `fetchAvailableInteractionTypes: 401 is a credential failure, 403 is not (credential codes are (401,))`
- `fetchAvailableInteractionTypes: a malformed schema is an AddInteractionCommandError caused by the parse error` (5 subtests)
- `fetchInteractionsTitleProperty: resolves the title by type; a malformed schema is an AddInteractionCommandError`
- `fetchAvailableTracks: one bounded query of page_size 25; at most 25 options; a malformed response is an AddInteractionCommandError`
- `fetchAvailableTracks: sorts by casefolded name in code-point order; skips non-dict pages and empty ids`
- `addInteractionButton: values are byte-identical to Python's json.dumps` (expected strings printed by `py -3.12`)
- `action and callback ids equal the constants in api/slack-request.js`

## tests/test_people_suggest.py → tests/people-suggest.test.ts (S5)

| Python test | TS test title |
| --- | --- |
| `ResolvePersonTests.test_exact_match_resolves` | `test_exact_match_resolves` |
| `ResolvePersonTests.test_case_insensitive_match_resolves` | `test_case_insensitive_match_resolves` |
| `ResolvePersonTests.test_no_match_returns_none` | `test_no_match_returns_none` |
| `ResolvePersonTests.test_multiple_exact_matches_are_reported_as_ambiguous_without_guessing` | `test_multiple_exact_matches_are_reported_as_ambiguous_without_guessing` |
| `ResolvePersonTests.test_malformed_person_pages_do_not_block_resolution` | `test_malformed_person_pages_do_not_block_resolution` |
| `PersonProfileContextTests.test_only_existing_recognized_fields_are_included` | `test_only_existing_recognized_fields_are_included` |
| `PersonProfileContextTests.test_empty_text_field_is_treated_as_absent` | `test_empty_text_field_is_treated_as_absent` |
| `PersonProfileContextTests.test_unrecognized_property_type_is_safely_omitted` | `test_unrecognized_property_type_is_safely_omitted` |
| `PersonProfileContextTests.test_missing_name_returns_none` | `test_missing_name_returns_none` |
| `PersonProfileTrackTests.test_track_goal_relation_is_captured` | `test_track_goal_relation_is_captured` |
| `PersonProfileTrackTests.test_missing_track_goal_is_empty` | `test_missing_track_goal_is_empty` |
| `PersonProfileTrackTests.test_malformed_track_goal_relation_is_safely_ignored` | `test_malformed_track_goal_relation_is_safely_ignored` |
| `ExtractPropertyTextTests.test_multi_select_joins_names` | `test_multi_select_joins_names` |
| `ExtractPropertyTextTests.test_missing_property_returns_none` | `test_missing_property_returns_none` |
| `ExtractRelationIdsTests.test_reads_relation_ids` | `test_reads_relation_ids` |
| `ExtractRelationIdsTests.test_missing_property_returns_empty` | `test_missing_property_returns_empty` |
| `ExtractRelationIdsTests.test_non_relation_property_returns_empty` | `test_non_relation_property_returns_empty` |
| `ExtractRelationIdsTests.test_relation_entries_missing_id_are_skipped` | `test_relation_entries_missing_id_are_skipped` |
| `FetchRecentInteractionsTests.test_bounded_to_five_and_sorted_query` | `test_bounded_to_five_and_sorted_query` |
| `FetchRecentInteractionsTests.test_more_than_five_results_are_still_bounded_defensively` | `test_more_than_five_results_are_still_bounded_defensively` |
| `FetchRecentInteractionsTests.test_malformed_interaction_is_skipped` | `test_malformed_interaction_is_skipped` |
| `FetchRecentInteractionsTests.test_no_interactions_returns_empty_list` | `test_no_interactions_returns_empty_list` |
| `FetchRecentInteractionsTests.test_tracks_relation_is_captured` | `test_tracks_relation_is_captured` |
| `FetchRecentInteractionsTests.test_missing_tracks_relation_is_empty` | `test_missing_tracks_relation_is_empty` |
| `CollectTrackIdsTests.test_dedupes_across_person_and_interactions_preserving_order` | `test_dedupes_across_person_and_interactions_preserving_order` |
| `CollectTrackIdsTests.test_no_tracks_returns_empty` | `test_no_tracks_returns_empty` |
| `ResolveTracksTests.test_resolves_each_distinct_id_once` | `test_resolves_each_distinct_id_once` |
| `ResolveTracksTests.test_multiple_distinct_tracks_each_resolved` | `test_multiple_distinct_tracks_each_resolved` |
| `ResolveTracksTests.test_purpose_is_read_from_the_same_page_without_extra_requests` | `test_purpose_is_read_from_the_same_page_without_extra_requests` |
| `ResolveTracksTests.test_notion_get_none_resolves_nothing` | `test_notion_get_none_resolves_nothing` |
| `ResolveTracksTests.test_malformed_track_page_is_omitted_not_raised` | `test_malformed_track_page_is_omitted_not_raised` |
| `ResolveTracksTests.test_no_track_ids_makes_no_requests` | `test_no_track_ids_makes_no_requests` |
| `ExtractTrackPurposeTests.test_present_purpose_is_returned` | `test_present_purpose_is_returned` |
| `ExtractTrackPurposeTests.test_multi_part_and_multi_line_purpose_is_joined_on_one_line` | `test_multi_part_and_multi_line_purpose_is_joined_on_one_line` |
| `ExtractTrackPurposeTests.test_empty_purpose_is_none` | `test_empty_purpose_is_none` |
| `ExtractTrackPurposeTests.test_missing_purpose_is_none` | `test_missing_purpose_is_none` |
| `ExtractTrackPurposeTests.test_non_text_purpose_is_none` | `test_non_text_purpose_is_none` |
| `ExtractTrackPurposeTests.test_malformed_rich_text_is_none` | `test_malformed_rich_text_is_none` |
| `ExtractTrackPurposeTests.test_long_purpose_is_truncated_to_the_limit` | `test_long_purpose_is_truncated_to_the_limit (S10: 500-char Purpose)` |
| `ExtractTrackPurposeTests.test_purpose_exactly_at_the_limit_is_kept_whole` | `test_purpose_exactly_at_the_limit_is_kept_whole` |
| `GroupRelevantTracksTests.test_person_tracks_come_first_and_interaction_only_tracks_second` | `test_person_tracks_come_first_and_interaction_only_tracks_second` |
| `GroupRelevantTracksTests.test_track_linked_from_person_and_interaction_is_a_person_track_once` | `test_track_linked_from_person_and_interaction_is_a_person_track_once` |
| `GroupRelevantTracksTests.test_filters_unresolved_and_dedupes_names` | `test_filters_unresolved_and_dedupes_names` |
| `GroupRelevantTracksTests.test_empty_when_nothing_resolved` | `test_empty_when_nothing_resolved` |
| `BuildSuggestionPromptTests.test_no_interactions_says_so_explicitly` | `test_no_interactions_says_so_explicitly (BuildSuggestionPromptTests)` |
| `BuildSuggestionPromptTests.test_interaction_fields_are_included_when_present` | `test_interaction_fields_are_included_when_present` |
| `BuildSuggestionPromptTests.test_track_names_never_appear_in_the_message_prompt` | `test_track_names_never_appear_in_the_message_prompt` |
| `BuildSuggestionPromptTests.test_grouped_track_context_and_privacy_rule_are_included` | `test_grouped_track_context_and_privacy_rule_are_included` |
| `BuildRecapPromptTests.test_no_tracks_omits_track_section` | `test_no_tracks_omits_track_section` |
| `BuildRecapPromptTests.test_track_names_are_included_verbatim` | `test_track_names_are_included_verbatim` |
| `BuildRecapPromptTests.test_person_tracks_are_listed_before_interaction_only_tracks` | `test_person_tracks_are_listed_before_interaction_only_tracks` |
| `BuildRecapPromptTests.test_group_heading_is_omitted_when_that_group_is_empty` | `test_group_heading_is_omitted_when_that_group_is_empty` |
| `BuildRecapPromptTests.test_no_interactions_says_so_explicitly` | `test_no_interactions_says_so_explicitly (BuildRecapPromptTests)` |
| `BuildRecapPromptTests.test_no_next_step_kinds_does_not_request_a_next_step` | `test_no_next_step_kinds_does_not_request_a_next_step` |
| `BuildRecapPromptTests.test_next_step_kinds_are_supplied_verbatim_with_the_request` | `test_next_step_kinds_are_supplied_verbatim_with_the_request` |
| `BuildRecapPromptTests.test_next_step_request_replaces_the_bullet_list_only_rule` | `test_next_step_request_replaces_the_bullet_list_only_rule` |
| `AllowedNextStepKindsTests.test_live_types_plus_wait` | `test_live_types_plus_wait` |
| `AllowedNextStepKindsTests.test_no_live_types_offers_nothing_not_even_wait` | `test_no_live_types_offers_nothing_not_even_wait` |
| `AllowedNextStepKindsTests.test_wait_already_a_live_type_is_not_duplicated` | `test_wait_already_a_live_type_is_not_duplicated` |
| `SplitRecapAndNextStepsTests.test_valid_kinds_and_wait_are_kept` | `test_valid_kinds_and_wait_are_kept` |
| `SplitRecapAndNextStepsTests.test_unknown_or_inexact_kind_is_dropped` | `test_unknown_or_inexact_kind_is_dropped (S5: kinds validated)` |
| `SplitRecapAndNextStepsTests.test_more_than_two_suggestions_are_truncated` | `test_more_than_two_suggestions_are_truncated (S5: at most 2)` |
| `SplitRecapAndNextStepsTests.test_missing_next_step_part_keeps_the_whole_recap` | `test_missing_next_step_part_keeps_the_whole_recap` |
| `SplitRecapAndNextStepsTests.test_malformed_next_step_lines_yield_no_suggestions` | `test_malformed_next_step_lines_yield_no_suggestions` |
| `SplitRecapAndNextStepsTests.test_off_format_marker_lines_still_split_off_the_next_step` | `test_off_format_marker_lines_still_split_off_the_next_step` (4 subtests) |
| `SplitRecapAndNextStepsTests.test_suggestion_on_the_marker_line_is_validated_not_leaked` | `test_suggestion_on_the_marker_line_is_validated_not_leaked` |
| `SplitRecapAndNextStepsTests.test_recap_bullet_mentioning_next_step_is_not_a_marker` | `test_recap_bullet_mentioning_next_step_is_not_a_marker` |
| `SplitRecapAndNextStepsTests.test_kind_containing_a_colon_is_matched_exactly` | `test_kind_containing_a_colon_is_matched_exactly` |
| `SplitRecapAndNextStepsTests.test_star_bullets_are_accepted` | `test_star_bullets_are_accepted` |
| `SplitRecapAndNextStepsTests.test_no_allowed_kinds_returns_response_untouched` | `test_no_allowed_kinds_returns_response_untouched` |
| `NextStepFormattingTests.test_no_next_steps_formats_to_nothing` | `test_no_next_steps_formats_to_nothing` |
| `NextStepFormattingTests.test_text_fallback_places_next_step_between_recap_and_message` | `test_text_fallback_places_next_step_between_recap_and_message` |
| `NextStepFormattingTests.test_text_fallback_without_next_step_is_unchanged` | `test_text_fallback_without_next_step_is_unchanged` |
| `NextStepFormattingTests.test_oversized_next_step_block_is_truncated` | `test_oversized_next_step_block_is_truncated (S10: 3000-char section)` |
| `HandlePeopleSuggestTests.test_valid_exact_match_returns_gemini_draft_to_slack` | `test_valid_exact_match_returns_gemini_draft_to_slack` |
| `HandlePeopleSuggestTests.test_reply_includes_an_add_interaction_button_carrying_the_person_page_id` | `test_reply_includes_an_add_interaction_button_carrying_the_person_page_id` |
| `HandlePeopleSuggestTests.test_reply_includes_a_context_recap_block_before_the_message_block` | `test_reply_includes_a_context_recap_block_before_the_message_block` |
| `HandlePeopleSuggestTests.test_an_oversized_gemini_draft_is_truncated_to_slacks_block_text_limit` | `test_an_oversized_gemini_draft_is_truncated_to_slacks_block_text_limit (S10: 3000-char section)` |
| `HandlePeopleSuggestTests.test_case_insensitive_input_still_resolves` | `test_case_insensitive_input_still_resolves` |
| `HandlePeopleSuggestTests.test_person_not_found_produces_a_clear_message_without_calling_gemini` | `test_person_not_found_produces_a_clear_message_without_calling_gemini` |
| `HandlePeopleSuggestTests.test_ambiguous_match_fails_safely_without_guessing` | `test_ambiguous_match_fails_safely_without_guessing` |
| `HandlePeopleSuggestTests.test_transient_gemini_failure_replies_safely_without_crashing` | `test_transient_gemini_failure_replies_safely_without_crashing` |
| `HandlePeopleSuggestTests.test_gemini_credential_failure_still_propagates_uncaught` | `test_gemini_credential_failure_still_propagates_uncaught` |
| `HandlePeopleSuggestTests.test_unrelated_gemini_failure_still_propagates_uncaught` | `test_unrelated_gemini_failure_still_propagates_uncaught` |
| `HandlePeopleSuggestTests.test_person_with_no_interactions_still_produces_a_draft` | `test_person_with_no_interactions_still_produces_a_draft` |
| `HandlePeopleSuggestTests.test_gemini_receives_only_intended_person_and_interaction_context` | `test_gemini_receives_only_intended_person_and_interaction_context (S6)` |
| `HandlePeopleSuggestTests.test_notion_failure_produces_a_safe_message_without_calling_gemini` | `test_notion_failure_produces_a_safe_message_without_calling_gemini` |
| `HandlePeopleSuggestTests.test_notion_failure_error_type_is_the_shared_people_error` | `test_notion_failure_error_type_is_the_shared_people_error` |
| `HandlePeopleSuggestTests.test_person_with_one_track_includes_it_in_the_recap_context` | `test_person_with_one_track_includes_it_in_the_recap_context` |
| `HandlePeopleSuggestTests.test_multiple_interactions_referencing_the_same_track_resolve_it_once` | `test_multiple_interactions_referencing_the_same_track_resolve_it_once` |
| `HandlePeopleSuggestTests.test_multiple_relevant_tracks_are_all_included` | `test_multiple_relevant_tracks_are_all_included` |
| `HandlePeopleSuggestTests.test_no_track_omits_track_context_and_makes_no_track_requests` | `test_no_track_omits_track_context_and_makes_no_track_requests` |
| `HandlePeopleSuggestTests.test_malformed_track_relation_is_treated_as_no_track` | `test_malformed_track_relation_is_treated_as_no_track` |
| `HandlePeopleSuggestTests.test_unresolvable_track_is_omitted_without_inventing_a_name` | `test_unresolvable_track_is_omitted_without_inventing_a_name` |
| `HandlePeopleSuggestTests.test_both_prompts_receive_grouped_tracks_with_purposes_as_private_context` | `test_both_prompts_receive_grouped_tracks_with_purposes_as_private_context` |
| `HandlePeopleSuggestTests.test_person_tracks_take_precedence_within_the_track_cap` | `test_person_tracks_take_precedence_within_the_track_cap (S10: 5 Tracks)` |
| `HandlePeopleSuggestTests.test_person_with_no_tracks_gets_the_unchanged_prompts` | `test_person_with_no_tracks_gets_the_unchanged_prompts (S6: exact prompts)` |
| `HandlePeopleSuggestTests.test_purpose_text_is_never_written_to_logs` | `test_purpose_text_is_never_written_to_logs` |
| `HandlePeopleSuggestTests.test_no_notion_get_supplied_skips_track_resolution` | `test_no_notion_get_supplied_skips_track_resolution` |
| `AddInteractionTrackSelectorTests.test_person_with_no_track_has_no_default_but_still_offers_all_tracks` | `test_person_with_no_track_has_no_default_but_still_offers_all_tracks` |
| `AddInteractionTrackSelectorTests.test_person_with_exactly_one_track_preselects_it` | `test_person_with_exactly_one_track_preselects_it` |
| `AddInteractionTrackSelectorTests.test_person_with_multiple_tracks_has_no_default_but_can_still_choose` | `test_person_with_multiple_tracks_has_no_default_but_can_still_choose` |
| `AddInteractionTrackSelectorTests.test_no_tracks_data_source_configured_omits_the_track_selector` | `test_no_tracks_data_source_configured_omits_the_track_selector` |
| `AddInteractionTrackSelectorTests.test_a_track_listing_failure_does_not_break_the_rest_of_the_reply` | `test_a_track_listing_failure_does_not_break_the_rest_of_the_reply` |
| `AddInteractionTrackSelectorTests.test_a_track_listing_credential_failure_does_not_break_the_rest_of_the_reply` | `test_a_track_listing_credential_failure_does_not_break_the_rest_of_the_reply (S11: degrades)` |
| `NextStepSuggestionTests.test_valid_next_steps_are_shown_alongside_recap_message_and_button` | `test_valid_next_steps_are_shown_alongside_recap_message_and_button (S5)` |
| `NextStepSuggestionTests.test_unparseable_next_step_part_omits_the_section_without_error` | `test_unparseable_next_step_part_omits_the_section_without_error` |
| `NextStepSuggestionTests.test_missing_next_step_part_still_shows_the_recap` | `test_missing_next_step_part_still_shows_the_recap` |
| `NextStepSuggestionTests.test_no_valid_suggestions_omits_the_section` | `test_no_valid_suggestions_omits_the_section` |
| `NextStepSuggestionTests.test_type_options_unavailable_means_no_next_step_requested_or_shown` | `test_type_options_unavailable_means_no_next_step_requested_or_shown` |

Not applicable: none. Deferred: none.

Adapted:

- Mocks, fake responses and keyword arguments follow the S2 and S4
  conventions above. `Mock(side_effect=lambda message, thread_ts=None,
  blocks=None: {"ts": "123.456"})` is `slackMock()`. A generate_text
  `Mock(side_effect=[...])` resolves each string in turn, `Mock(side_effect=error)`
  rejects with that error on every call, and `Mock(return_value=...)` always
  resolves the value. A bare `Mock()` that the test expects not to be called
  (`assert_not_called`) rejects if it is called, which is stricter.
- `error.response = Mock(status_code=503)` is
  `Object.assign(new Error(...), { response: { status_code: 503 } })`.
  `RuntimeError(...)` is a plain `Error`. `assertRaises(...)` followed by
  `assertIs(error_context.exception, error)` is
  `assert.rejects(..., (thrown) => thrown === error)`.
- The dataclasses are plain readonly objects with camelCase fields
  (`pageId`, `contextFields`, `trackIds`). `TrackContext("AI Network")` is
  `{ name: "AI Network", purpose: null }`. Tuples are arrays, and
  `resolve_tracks`'s dict is a `Map`, compared with `deepEqual` to a `Map`.
- Defaulted Python parameters are a trailing options object:
  `build_recap_prompt(profile, [], person_tracks, other_tracks, kinds)` is
  `buildRecapPrompt(profile, [], { personTracks, otherTracks, nextStepKinds })`.
  The same applies to `buildSuggestionPrompt`, `buildSuggestionBlocks`
  (`next_step_text=` is `{ nextStepText }`), `formatFullReply` (its third
  argument is `{ nextStepText }`) and `handlePeopleSuggest` (`today`, `sleep`,
  `notionGet`).
- The repeated `handle_people_suggest(...)` call is the helper `runSuggest`, and
  `NextStepSuggestionTests.run_suggest` is `runNextStepSuggest`. The class
  helpers `HandlePeopleSuggestTests.environment`,
  `AddInteractionTrackSelectorTests.environment`, `GroupRelevantTracksTests.profile`
  and `AddInteractionTrackSelectorTests.add_interaction_button` are
  `environment()`, `trackSelectorEnvironment()`, `groupProfile()` and
  `addInteractionButtonOf()`.
- `len(...)` in assertions is `pyLen` (code points). `prompt.index(a) <
  prompt.index(b)` also checks that both are found, since `index` raises.
  `count` is a split count. `url.rsplit("/", 1)[1]` is
  `url.slice(url.lastIndexOf("/") + 1)`. `track_pages[url]` throws for an
  unknown URL, as the KeyError would.
- `test_no_interactions_says_so_explicitly` exists in two Python classes. The
  two TS titles carry the class name in parentheses, and the mapping check
  requires exactly two matching titles for that name.
- `test_notion_failure_error_type_is_the_shared_people_error`:
  `issubclass(PeopleDueCommandError, Exception)` is
  `PeopleDueCommandError.prototype instanceof Error`.
- `test_purpose_text_is_never_written_to_logs`: `redirect_stdout`,
  `redirect_stderr` and `assertNoLogs()` become recording
  `process.stdout.write` and `process.stderr.write` (passing the output
  through, so the test runner is unaffected) and replacing the `console`
  methods during the call. The test asserts that there was no console call and
  that nothing written contains the Purpose.
- `test_multiple_relevant_tracks_are_all_included`: in Python, the
  two-item `Mock(side_effect=[...])` notion_get is exhausted by the third GET
  (the Type schema). The StopIteration becomes a TaskListCommandError, and the
  best-effort Type fetch returns no options. The TS mock throws on exhaustion
  in the same way, with the same outcome.

TS-only tests (no Python counterpart):

- `prompt fixture: every prompt constant, message and bound equals Python's, byte for byte (S6, S10)`
- `prompt fixture: built recap and draft prompts equal Python's, byte for byte (S6)`
- `next-step fixture: splitRecapAndNextSteps equals Python on line boundaries, Unicode, bullets and markers (S5)`
- `blocks fixture: reply text and Block Kit blocks, including the button value string, equal Python's`
- `NEXT_STEP_MARKER_PATTERN: group 1 equals Python's re.match on tricky marker lines`
- `` NEXT_STEP_MARKER_PATTERN: every letter, whitespace and `.` position matches exactly Python's code points (exhaustive) ``
- `S10: the people-suggest bounds are Python's values`
- `S10: truncateForSlackSection keeps 3000 code points and cuts longer text to 2999 + … (astral characters count once)`
- `S10: extractTrackPurpose truncates by code points to 499 + … and keeps exactly 500`
- `S10: the Interactions query asks for 5 and at most 5 summaries are used, even from a longer response`
- `S5: Gemini output triggers no side effect: Notion is only read, and the only post after Gemini is the reply`
- `transient Gemini failures: 429 and 5xx from response.status_code, status_code or code post the fixed reply; others are re-thrown`
- `externalErrorStatusCode: response.status_code first, then status_code, then code; only ints count`
- `S11: a 401 on a Track page fails the command before Gemini; a 403 only omits that Track`
- `S11: a 401 on the Type schema degrades: no button, no next step, and the unavailable note`
- `handlePeopleSuggest: only a PeopleDueCommandError gets the failure message; a TaskListCommandError propagates`
- `handlePeopleSuggest: the call order is Person, Interactions, Track GETs, Track listing, Type schema, recap, draft`
- `handlePeopleSuggest: a missing generateText throws a TypeError after the Notion reads, as calling None does`
- `resolvePerson: casefold matching (ß and SS) against whitespace-collapsed Notion names, one query of page_size 100`
- `Notion parsing: Python's exceptions are kept (caught for the Name, raised for context fields)`
- `parseNextStep: bullets, the longest kind first, and code-point slicing after an astral kind`
- `buildSuggestionBlocks: the button value is Python's json.dumps output (ensure_ascii, separators)`

The fixture and golden rows these use are printed by Python 3.12:

- `tests/equivalence/people-suggest-prompts.json`, written by
  `tests/equivalence/generate_people_suggest_prompts.py` (`--check` verifies it).
  It holds every prompt constant, message and bound, six fully built recap and
  draft prompt pairs, fourteen `split_recap_and_next_steps` cases, and three
  reply text and Block Kit cases. It lives outside `golden/` because
  `record_python.py --check` accepts only scenario goldens and the compat table
  there.
- New sections in `tests/equivalence/golden/python-compat.json`:
  `splitlines`, `regex_ignorecase_letters`, `regex_space`,
  `regex_dot_excluded` and `next_step_marker`.

Also added in S5:

- `tests/python-compat.test.ts`: `pySplitlines matches str.splitlines()` and
  `` Python's re \s is exactly str.isspace() (the people-suggest marker pattern
  relies on it) ``.

## tests/test_followup_task.py → tests/followup-task.test.ts (S6)

| Python test | TS test title |
| --- | --- |
| `FollowupTaskButtonTests.test_value_carries_person_priorities_tracks_and_default` | `test_value_carries_person_priorities_tracks_and_default` |
| `FollowupTaskButtonTests.test_empty_options_are_omitted` | `test_empty_options_are_omitted` |
| `FollowupTaskButtonTests.test_build_resolves_live_priorities_and_tracks_with_interaction_track_default` | `test_build_resolves_live_priorities_and_tracks_with_interaction_track_default` |
| `FollowupTaskButtonTests.test_build_without_interaction_track_has_no_default` | `test_build_without_interaction_track_has_no_default` |
| `FollowupTaskButtonTests.test_build_returns_no_buttons_when_priority_schema_fails` | `test_build_returns_no_buttons_when_priority_schema_fails` |
| `FollowupTaskButtonTests.test_build_returns_no_buttons_when_tracks_fail` | `test_build_returns_no_buttons_when_tracks_fail` |
| `FollowupTaskButtonTests.test_build_returns_no_buttons_on_notion_credential_failure` | `test_build_returns_no_buttons_on_notion_credential_failure (S11: degrades)` |
| `FollowupTaskButtonTests.test_build_returns_no_buttons_when_the_button_value_is_too_long_for_slack` | `test_build_returns_no_buttons_when_the_button_value_is_too_long_for_slack (S10: 2000-char value)` |
| `FollowupTaskButtonTests.test_missing_priority_property_still_offers_the_button_without_priorities` | `test_missing_priority_property_still_offers_the_button_without_priorities` |
| `FollowupTaskButtonTests.test_build_returns_no_buttons_without_a_tasks_data_source` | `test_build_returns_no_buttons_without_a_tasks_data_source` |
| `SuggestedFollowupTaskButtonTests.test_commitment_in_notes_offers_both_buttons_in_order` | `test_commitment_in_notes_offers_both_buttons_in_order` |
| `SuggestedFollowupTaskButtonTests.test_prompt_contains_only_the_saved_interaction_and_today` | `test_prompt_contains_only_the_saved_interaction_and_today (S6)` |
| `SuggestedFollowupTaskButtonTests.test_no_commitment_offers_only_the_existing_button` | `test_no_commitment_offers_only_the_existing_button` |
| `SuggestedFollowupTaskButtonTests.test_empty_notes_make_no_gemini_call` | `test_empty_notes_make_no_gemini_call` |
| `SuggestedFollowupTaskButtonTests.test_gemini_failure_offers_only_the_existing_button` | `test_gemini_failure_offers_only_the_existing_button` |
| `SuggestedFollowupTaskButtonTests.test_invalid_gemini_output_offers_only_the_existing_button` | `test_invalid_gemini_output_offers_only_the_existing_button` |
| `SuggestedFollowupTaskButtonTests.test_suggested_button_too_long_for_slack_is_omitted_alone` | `test_suggested_button_too_long_for_slack_is_omitted_alone (S10: 2000-char value)` |
| `SuggestedFollowupTaskButtonTests.test_long_name_label_is_truncated_to_slack_button_text_limit` | `test_long_name_label_is_truncated_to_slack_button_text_limit (S10: 75-char text)` |
| `SuggestedFollowupTaskButtonTests.test_label_at_exactly_the_limit_is_not_truncated` | `test_label_at_exactly_the_limit_is_not_truncated` |
| `SuggestedFollowupTaskButtonTests.test_suggestion_without_optional_fields_omits_them_from_the_value` | `test_suggestion_without_optional_fields_omits_them_from_the_value` |
| `ParseSuggestedTaskTests.test_full_valid_suggestion` | `test_full_valid_suggestion` |
| `ParseSuggestedTaskTests.test_name_only_suggestion` | `test_name_only_suggestion` |
| `ParseSuggestedTaskTests.test_a_single_json_code_fence_is_tolerated` | `test_a_single_json_code_fence_is_tolerated` |
| `ParseSuggestedTaskTests.test_no_follow_up_yields_none` | `test_no_follow_up_yields_none` |
| `ParseSuggestedTaskTests.test_unexpected_structure_yields_none` | `test_unexpected_structure_yields_none` |
| `ParseSuggestedTaskTests.test_missing_blank_non_text_or_over_long_name_yields_none` | `test_missing_blank_non_text_or_over_long_name_yields_none (S5, S10: 150 chars)` |
| `ParseSuggestedTaskTests.test_name_at_the_limit_is_accepted` | `test_name_at_the_limit_is_accepted` |
| `ParseSuggestedTaskTests.test_over_long_or_non_text_description_is_dropped` | `test_over_long_or_non_text_description_is_dropped (S10: 500 chars)` |
| `ParseSuggestedTaskTests.test_description_at_the_limit_is_kept` | `test_description_at_the_limit_is_kept` |
| `ParseSuggestedTaskTests.test_invalid_past_or_too_distant_follow_up_is_dropped` | `test_invalid_past_or_too_distant_follow_up_is_dropped (S10: 365 days)` |
| `ParseSuggestedTaskTests.test_follow_up_today_and_365_days_ahead_are_kept` | `test_follow_up_today_and_365_days_ahead_are_kept` |
| `ParseSuggestedTaskTests.test_unrequested_fields_are_ignored` | `test_unrequested_fields_are_ignored (S5)` |
| `InteractionConfirmationTests.test_successful_save_offers_the_followup_buttons` | `test_successful_save_offers_the_followup_buttons` |
| `InteractionConfirmationTests.test_interaction_is_written_before_the_buttons_are_built` | `test_interaction_is_written_before_the_buttons_are_built` |
| `InteractionConfirmationTests.test_unresolvable_options_still_confirm_without_the_button` | `test_unresolvable_options_still_confirm_without_the_button` |
| `InteractionConfirmationTests.test_failed_interaction_save_never_builds_the_button` | `test_failed_interaction_save_never_builds_the_button` |
| `ParseTaskPayloadTests.test_parses_bundled_fields` | `test_parses_bundled_fields` |
| `ParseTaskPayloadTests.test_malformed_or_non_string_values_become_empty` | `test_malformed_or_non_string_values_become_empty` |
| `AddFollowupTaskSubmissionTests.test_minimal_valid_submission_creates_exactly_one_task` | `test_minimal_valid_submission_creates_exactly_one_task` |
| `AddFollowupTaskSubmissionTests.test_full_submission_writes_track_priority_and_follow_up` | `test_full_submission_writes_track_priority_and_follow_up` |
| `AddFollowupTaskSubmissionTests.test_missing_person_writes_nothing_and_says_nothing` | `test_missing_person_writes_nothing_and_says_nothing (S3)` |
| `AddFollowupTaskSubmissionTests.test_invalid_input_is_rejected_before_any_notion_call` | `test_invalid_input_is_rejected_before_any_notion_call` |
| `AddFollowupTaskSubmissionTests.test_unknown_priority_is_rejected_without_a_write` | `test_unknown_priority_is_rejected_without_a_write (S4: Priority)` |
| `AddFollowupTaskSubmissionTests.test_tampered_track_is_rejected_without_a_write` | `test_tampered_track_is_rejected_without_a_write (S4: Track)` |
| `AddFollowupTaskSubmissionTests.test_missing_ikke_started_status_writes_nothing_and_reports` | `test_missing_ikke_started_status_writes_nothing_and_reports (S4: Status)` |
| `AddFollowupTaskSubmissionTests.test_malformed_schema_is_a_failure_without_a_write` | `test_malformed_schema_is_a_failure_without_a_write` |
| `AddFollowupTaskSubmissionTests.test_notion_write_failure_returns_a_concise_error` | `test_notion_write_failure_returns_a_concise_error` |
| `AddFollowupTaskSubmissionTests.test_ambiguous_write_failures_are_not_retried` | `test_ambiguous_write_failures_are_not_retried (S9)` |
| `AddFollowupTaskSubmissionTests.test_rate_limited_write_is_retried` | `test_rate_limited_write_is_retried (S9)` |
| `AddFollowupTaskSubmissionTests.test_description_is_trimmed_and_written_as_rich_text` | `test_description_is_trimmed_and_written_as_rich_text` |
| `AddFollowupTaskSubmissionTests.test_blank_or_whitespace_description_leaves_description_unset` | `test_blank_or_whitespace_description_leaves_description_unset` |
| `AddFollowupTaskSubmissionTests.test_missing_or_non_text_description_property_still_creates_the_task` | `test_missing_or_non_text_description_property_still_creates_the_task` |
| `AddFollowupTaskSubmissionTests.test_unconfigured_tasks_data_source_fails_without_notion_calls` | `test_unconfigured_tasks_data_source_fails_without_notion_calls` |

Not applicable: none.

Adapted (same assertions, different mechanism):

- `Mock()` collaborators follow the S4 conventions: `Mock(return_value=Mock())`
  as a Notion response is a 200 `HttpResponse`; `http_error(status)` is an
  `HttpResponse` with that status, whose `raise_for_status()` throws the real
  http.ts `HTTPError`; `requests.exceptions.Timeout()` is http.ts `Timeout`. A
  bare `Mock()` that a test expects not to be called (`notion_post`,
  `notion_get`, `generate_text`) rejects if it is called, which is stricter.
- `SuggestedTask(name, description, follow_up)` is the readonly object
  `{ name, description, followUp }`, compared with `deepEqual`; the absent
  fields are `null`. `followup_task_button(id, name, tracks, default, priorities,
  suggested_task=...)` takes its defaulted arguments as an options object
  (`{ tracks, defaultTrackId, priorities, suggestedTask }`), and so does
  `build_followup_task_buttons` (`{ generateText, today, sleep }`).
- `submit(...)` and `build_buttons(...)` are the helpers `submit({...})` and
  `buildButtons({...})`. `tasks_schema_response()` takes an `edit` hook in
  place of the tests' `del schema.json.return_value["properties"][...]`.
- `suggestion(**task)` and `json.dumps(...)` are `pyJsonDumps`.
  `ParseSuggestedTaskTests.parse(None)` passes `null`.
- `InteractionConfirmationTests` call `handleAddInteractionSubmission` from
  people-interaction.ts, as the Python tests call
  `people_interaction.handle_add_interaction_submission`;
  `build.assert_called_once_with(...)` is `deepEqual` on the recorded call, and
  `call.kwargs["blocks"][-1]` is `options.blocks.at(-1)`.
- `len(label)` is `pyLen`.

TS-only tests (no Python counterpart):

- `fixture: generated by Python 3.12`
- `fixture: every constant, message, id and bound equals Python's, byte for byte (S6, S10)` (includes the Gemini system instruction)
- `fixture: built follow-up suggestion prompts equal Python's, byte for byte (S6)` (3 prompts)
- `fixture: followupTaskButton equals Python's button, value strings byte for byte (Danish names, quotes, newlines, emoji)` (9 buttons)
- `fixture: parseSuggestedTask equals Python on fences, json.loads edge cases (NaN, BOM, duplicates, depth) and bounds (S5)` (86 responses)
- `fixture: parseSuggestedFollowUp and ISO_DATE_PATTERN equal Python on Unicode digits, a trailing newline and the range` (40 values)
- `fixture: parseTaskPayload equals Python (json.loads semantics, non-str fields, a RecursionError propagates)`
- `fixture: the confirmation equals str.format, with {task} and $ sequences in values left alone`
- `S9: a 503, ReadTimeout or ConnectionError on Task create gives one create, no sleep and the uncertain message` (5 subtests: 503, 500, ReadTimeout, ConnectionError, an error without a status)
- `S9: 429 then success gives two creates with one sleep and the confirmation`
- `S9: a 400 gives the generic failure (one create, no sleep), and three 429s give three creates and the generic failure`
- `S9: createTaskPage retries only a 429; the final error carries the request error as its cause`
- `S9/S11: a 401 or 403 on Task create is a credential failure: one create, caught, the generic failure` (2 subtests)
- `TD3 pin: the modal follow_up is parsed with date.fromisoformat, so 20261001 and 2026-W40-4 are accepted` (2 subtests)
- `S3: a page id without a name, or a name without a page id, is a silent no-op` (2 subtests)
- `S4: validation order is schema, Priority, Track, Status; nothing is written on any rejection` (5 subtests)
- `S4: a full valid submission writes one page with Python's exact payload, headers and property order; Created is today`
- `S5: Gemini output only prefills a button: Notion is only read, generateText is called once with the exact prompt`
- `S5: NaN, Infinity and BOM-prefixed Gemini output are handled as json.loads does, not as JSON.parse does`
- `S5: an absurdly deep Gemini response raises RecursionError out of buildFollowupTaskButtons, as in Python`
- `S10: the 2000-character value limit is measured in Python json.dumps units, not JSON.stringify's`
- `S10: names and descriptions are bounded in code points (an emoji counts once)`
- `S11: a 401 on the Tracks listing degrades to no buttons; a 401 on the schema at submission posts the generic failure`
- `fetchTasksSchema: 401 is a credential failure, 403 is not (credential codes are (401,))`
- `fetchTasksSchema: a malformed schema is a FollowupTaskCommandError; a missing Priority or Description is not` (13 subtests)
- `suggestFollowupTask: a synchronous throw or a rejection from generateText is no suggestion; the prompt is the exact one`
- `a missing NOTION_API_KEY raises KeyError, as environment[...] does (not caught)`
- `handleAddFollowupTaskSubmission: no threadTs passes threadTs undefined, as Python's thread_ts=None`
- `action and callback ids equal the constants in api/slack-request.js`

The fixture and golden rows these use are printed by Python 3.12:

- `tests/equivalence/followup-task-fixture.json`, written by
  `tests/equivalence/generate_followup_task_fixture.py` (`--check` verifies it,
  also in `ci.yml`). It holds every constant and message, three built prompts,
  nine complete buttons, and the results of `parse_suggested_task`,
  `parse_suggested_follow_up` (with `ISO_DATE_PATTERN.match`),
  `parse_task_payload` and the confirmation template for edge-case input.
- A new `json_loads` section in `tests/equivalence/golden/python-compat.json`
  (NaN/Infinity, whitespace including Unicode spaces, a BOM, trailing data,
  duplicate keys, raw control characters, `\u` escapes and lone surrogates,
  numbers and the 4300-digit int limit, and nesting depths 500 and 20000).

Also added in S6 (tests/python-compat.test.ts):

- `pyJsonLoads matches json.loads, including what raises`
- `pyJsonLoads: RecursionError is not a ValueError, and the depth limit is PY_JSON_MAX_DEPTH (CPython 3.12 on Linux)`
- `pyJsonLoads: an own __proto__ key is an ordinary member, and repeated keys keep their first position`
- `` PY_RE_SPACE_CLASS is exactly the code points of Python's re \s ``
- `truthy matches bool() for JSON values` gains NaN and Infinity (true, as in Python).

## tests/test_attention_summary.py → tests/attention-summary.test.ts (S7)

| Python test | TS test title |
| --- | --- |
| `AttentionSummaryTests.test_tasks_only` | `test_tasks_only` |
| `AttentionSummaryTests.test_people_only` | `test_people_only` |
| `AttentionSummaryTests.test_both_sections` | `test_both_sections` |
| `AttentionSummaryTests.test_nothing_needs_attention_posts_nothing` | `test_nothing_needs_attention_posts_nothing` |
| `AttentionSummaryTests.test_dated_tasks_are_capped_at_five_with_more_hint` | `test_dated_tasks_are_capped_at_five_with_more_hint` |
| `AttentionSummaryTests.test_exactly_five_dated_tasks_has_no_more_hint` | `test_exactly_five_dated_tasks_has_no_more_hint` |
| `AttentionSummaryTests.test_undated_tasks_are_shown_as_a_count_only` | `test_undated_tasks_are_shown_as_a_count_only` |
| `AttentionSummaryTests.test_single_undated_task_uses_singular_noun` | `test_single_undated_task_uses_singular_noun` |
| `AttentionSummaryTests.test_counts_are_not_limited_by_the_tasks_list_display_cap` | `test_counts_are_not_limited_by_the_tasks_list_display_cap` |
| `AttentionSummaryTests.test_due_people_are_capped_at_five_with_more_hint` | `test_due_people_are_capped_at_five_with_more_hint` |
| `AttentionSummaryTests.test_people_are_plain_text_without_suggest_buttons` | `test_people_are_plain_text_without_suggest_buttons` |
| `AttentionSummaryTests.test_task_selection_and_order_match_tasks_list` | `test_task_selection_and_order_match_tasks_list` |
| `AttentionSummaryTests.test_people_selection_and_order_match_people_due` | `test_people_selection_and_order_match_people_due` |
| `AttentionSummaryTests.test_incomplete_task_scan_without_items_is_reported` | `test_incomplete_task_scan_without_items_is_reported` |
| `AttentionSummaryTests.test_incomplete_people_scan_without_items_is_reported` | `test_incomplete_people_scan_without_items_is_reported` |
| `AttentionSummaryTests.test_complete_scans_without_items_send_nothing` | `test_complete_scans_without_items_send_nothing` |
| `AttentionSummaryTests.test_skipped_malformed_task_is_reported_in_shown_section` | `test_skipped_malformed_task_is_reported_in_shown_section` |
| `AttentionSummaryTests.test_skipped_malformed_tasks_use_plural` | `test_skipped_malformed_tasks_use_plural` |
| `AttentionSummaryTests.test_skipped_malformed_people_are_reported_in_shown_section` | `test_skipped_malformed_people_are_reported_in_shown_section` |
| `AttentionSummaryTests.test_skipped_malformed_person_uses_singular` | `test_skipped_malformed_person_uses_singular` |
| `AttentionSummaryTests.test_skipped_rows_alone_send_nothing` | `test_skipped_rows_alone_send_nothing` |
| `AttentionSummaryTests.test_skipped_count_is_not_shown_for_a_hidden_section` | `test_skipped_count_is_not_shown_for_a_hidden_section` |
| `AttentionSummaryTests.test_tasks_failure_sends_people_then_fails` | `test_tasks_failure_sends_people_then_fails (S11: degrades to a partial summary, still fails the run)` |
| `AttentionSummaryTests.test_people_failure_sends_tasks_then_fails` | `test_people_failure_sends_tasks_then_fails (S11: a Notion 401 fails the run)` |
| `AttentionSummaryTests.test_one_source_failing_and_other_empty_sends_nothing_and_fails` | `test_one_source_failing_and_other_empty_sends_nothing_and_fails` |
| `AttentionSummaryTests.test_both_sources_failing_sends_nothing_and_fails` | `test_both_sources_failing_sends_nothing_and_fails` |
| `AttentionSummaryTests.test_failure_without_http_status_logs_type_name_only` | `test_failure_without_http_status_logs_type_name_only (S7)` |
| `AttentionSummaryTests.test_missing_configuration_is_reported_by_name` | `test_missing_configuration_is_reported_by_name` |
| `AttentionSummaryTests.test_unknown_key_error_is_described_by_type_name_only` | `test_unknown_key_error_is_described_by_type_name_only (S7)` |
| `AttentionSummaryTests.test_logs_contain_no_private_content_or_secrets` | `test_logs_contain_no_private_content_or_secrets (S7)` |
| `SlackDmPosterTests.test_posts_to_the_authorized_user_id` | `test_posts_to_the_authorized_user_id` |
| `SlackDmPosterTests.test_slack_api_error_raises_a_safe_message` | `test_slack_api_error_raises_a_safe_message (S7)` |
| `SlackDmPosterTests.test_http_error_raises_a_safe_message` | `test_http_error_raises_a_safe_message` |
| `MainTests.test_successful_send_exits_zero` | `test_successful_send_exits_zero` |
| `MainTests.test_slack_delivery_failure_is_annotated_and_exits_non_zero` | `test_slack_delivery_failure_is_annotated_and_exits_non_zero (S7)` |
| `MainTests.test_source_failure_is_annotated_and_exits_non_zero` | `test_source_failure_is_annotated_and_exits_non_zero` |

Not applicable: none.

Adapted (same assertions, different mechanism):

- Conventions as in S3–S6: `Mock()` collaborators are recording functions;
  `response(...)` is a 200 `HttpResponse`; `failing_response(status)` is an
  `HttpResponse` with that status and no headers, whose `raise_for_status()`
  throws the real http.ts `HTTPError`. `routing_notion_post` keeps its routing
  (and throws an AssertionError for an unexpected URL, as Python does).
- `send_attention_summary(..., today=, sleep=, log=)` takes an options object
  (`{ today, sleep, log }`). `run_failing_summary`'s `assertRaises` catches
  the rejection and checks it is an `AttentionSummaryError`.
- `test_failure_without_http_status_logs_type_name_only`: http.ts's `Timeout`
  has a fixed message, so the test sets the secret-bearing message
  (`https://api.notion.com secret-token`) on the instance, keeping the
  assertion that it never reaches the log.
- `test_people_are_plain_text_without_suggest_buttons`: "no `blocks` kwarg" is
  "`postDirectMessage` was called with exactly one argument".
- `test_slack_api_error_raises_a_safe_message`: `assertRaisesRegex(RuntimeError,
  ...)` checks `SlackDmDeliveryError` (a RuntimeError subclass in Python).
- `MainTests.run_main`: `patch.dict("os.environ")` and
  `patch("attention_summary.requests.post")` are `main(env, { http, log })`;
  `redirect_stdout` is a `log` that collects each line plus `"\n"`. As in
  Python, `today` and `sleep` are not injected (the real clock; the 400 is not
  retried).

TS-only tests (no Python counterpart):

- `describeSourceError: a NotionAuthenticationError is its message; a command error adds only its cause's HTTP status`
- `buildSlackDmPoster: a transport error is its Python type name; a non-dict or ok-less body is 'unknown'; nothing is chained`
- `buildSlackDmPoster: the exact request (headers, json, timeout) and the result is Slack's body`
- `main: a missing or empty SLACK_BOT_TOKEN or AUTHORIZED_SLACK_USER_ID prints the config error and makes no call`
- `S7: uncaughtErrorLine is the name, plus the message only for application error classes`
- `S7: runEntryPoint reports an error escaping main as one secret-free stderr line and exit code 1`
- `entry point: node src/attention-summary.ts with an empty environment prints Python's config error on stdout and exits 1`
- `entry point: node src/attention-summary.ts runs main with process.env and exits 0 when nothing needs attention`
- `S7: the real process reports an uncaught error as one secret-free stderr line and exits 1`
- `S7: the real process reports an error outside main's chain as one line and keeps exit code 1`
- `entryPointMode: run when import.meta.main is true; on a Node without it (undefined), fail loudly only when the module is the started script`
- `G7: attention-summary.yml runs node src/attention-summary.ts on Node 24 with the unchanged triggers and env mapping`

## Security-invariant evidence (G6)

Filled in as slices land. Tests named here fail if the invariant breaks.

| Invariant | TS tests so far |
| --- | --- |
| S1 | `test_dm_authorization_uses_exact_user_id`, `test_missing_authorization_configuration_fails_closed`, `test_user_id_match_without_dm_identity_is_rejected` (slack-authorization.test.ts) |
| S2 | **Deferred to S8**: the authorization-before-calls order lives in `main.ts` (PLAN.md §9 amendment). |
| S3 (partial: Interaction and Task writes) | `test_missing_person_identity_is_ignored_rather_than_guessed`, `S3: a page id without a name, or a name without a page id, is a silent no-op` (people-interaction.test.ts). Task write: `test_missing_person_writes_nothing_and_says_nothing (S3)`, `S3: a page id without a name, or a name without a page id, is a silent no-op` (followup-task.test.ts). `parse_person_payload` is evidenced in S8. |
| S4 | `test_unknown_type_is_rejected_before_any_notion_write`, `S4: an invalid Type is rejected before the Track is validated`, `test_a_track_id_that_is_not_a_live_track_is_rejected_before_any_write`, `test_a_track_id_with_no_tracks_data_source_configured_is_rejected`, `test_unconfigured_tracks_data_source_fails_closed`, `test_type_property_not_a_select_is_a_failure` (a malformed schema is not an empty allowlist), `validation order: date, then Type, then Track, then title property, then exactly one create` (people-interaction.test.ts). Task Priority, Track and Status: `test_unknown_priority_is_rejected_without_a_write (S4: Priority)`, `test_tampered_track_is_rejected_without_a_write (S4: Track)`, `test_missing_ikke_started_status_writes_nothing_and_reports (S4: Status)`, `test_malformed_schema_is_a_failure_without_a_write`, `S4: validation order is schema, Priority, Track, Status; nothing is written on any rejection`, `S4: a full valid submission writes one page with Python's exact payload, headers and property order; Created is today`, `fetchTasksSchema: a malformed schema is a FollowupTaskCommandError; a missing Priority or Description is not` (followup-task.test.ts). |
| S5 | `test_unknown_or_inexact_kind_is_dropped (S5: kinds validated)`, `test_more_than_two_suggestions_are_truncated (S5: at most 2)`, `test_valid_next_steps_are_shown_alongside_recap_message_and_button (S5)`, `test_type_options_unavailable_means_no_next_step_requested_or_shown` (no live Types: no next step at all), `next-step fixture: splitRecapAndNextSteps equals Python on line boundaries, Unicode, bullets and markers (S5)`, `S5: Gemini output triggers no side effect: Notion is only read, and the only post after Gemini is the reply` (people-suggest.test.ts). Suggested Task: `test_missing_blank_non_text_or_over_long_name_yields_none (S5, S10: 150 chars)`, `test_unrequested_fields_are_ignored (S5)`, `fixture: parseSuggestedTask equals Python on fences, json.loads edge cases (NaN, BOM, duplicates, depth) and bounds (S5)`, `S5: Gemini output only prefills a button: Notion is only read, generateText is called once with the exact prompt`, `S5: NaN, Infinity and BOM-prefixed Gemini output are handled as json.loads does, not as JSON.parse does`, `S5: an absurdly deep Gemini response raises RecursionError out of buildFollowupTaskButtons, as in Python` (followup-task.test.ts); `pyJsonLoads matches json.loads, including what raises` (python-compat.test.ts). |
| S6 (partial: `/people due`, `/people suggest` and follow-up suggestion prompts) | `S6: /people due never calls generateText` (people-due.test.ts); `prompt fixture: every prompt constant, message and bound equals Python's, byte for byte (S6, S10)`, `prompt fixture: built recap and draft prompts equal Python's, byte for byte (S6)`, `test_person_with_no_tracks_gets_the_unchanged_prompts (S6: exact prompts)`, `test_gemini_receives_only_intended_person_and_interaction_context (S6)` (people-suggest.test.ts). Follow-up suggestion: `fixture: every constant, message, id and bound equals Python's, byte for byte (S6, S10)`, `fixture: built follow-up suggestion prompts equal Python's, byte for byte (S6)`, `test_prompt_contains_only_the_saved_interaction_and_today (S6)`, `test_empty_notes_make_no_gemini_call` (followup-task.test.ts). `/tasks` is evidenced at the entry point in S8. |
| S7 (partial: `raise … from`, generic failure text; attention-summary entry point and its uncaught errors) | `withPyCause records __cause__ without Node printing it` (python-compat.test.ts); `callNotionWithRetries: the final TaskListCommandError carries the request error as its cause`; `test_exhausted_transient_failure_produces_a_safe_generic_message`, `test_malformed_query_response_produces_a_safe_message_without_raw_payload` (people-due.test.ts). Attention summary (attention-summary.test.ts): `test_failure_without_http_status_logs_type_name_only (S7)`, `test_unknown_key_error_is_described_by_type_name_only (S7)`, `test_logs_contain_no_private_content_or_secrets (S7)`, `test_slack_api_error_raises_a_safe_message (S7)`, `test_slack_delivery_failure_is_annotated_and_exits_non_zero (S7)`, `describeSourceError: a NotionAuthenticationError is its message; a command error adds only its cause's HTTP status`, `buildSlackDmPoster: a transport error is its Python type name; a non-dict or ok-less body is 'unknown'; nothing is chained`; the top-level handler: `S7: uncaughtErrorLine is the name, plus the message only for application error classes`, `S7: runEntryPoint reports an error escaping main as one secret-free stderr line and exit code 1`, `S7: the real process reports an uncaught error as one secret-free stderr line and exits 1`, `S7: the real process reports an error outside main's chain as one line and keeps exit code 1`. The golden replay checks every canary against all stdout and stderr of each replayed scenario (equivalence.test.ts, `golden: attention_*`). |
| S9 | `test_ambiguous_write_failures_are_not_retried (S9)`, `test_rate_limited_write_is_retried (S9)`, `S9: a 503, ReadTimeout or ConnectionError on Task create gives one create, no sleep and the uncertain message`, `S9: 429 then success gives two creates with one sleep and the confirmation`, `S9: a 400 gives the generic failure (one create, no sleep), and three 429s give three creates and the generic failure`, `S9: createTaskPage retries only a 429; the final error carries the request error as its cause`, `S9/S11: a 401 or 403 on Task create is a credential failure: one create, caught, the generic failure` (followup-task.test.ts) |
| S10 (all bounds in BASELINE.md §6 S10 so far) | `test_stops_after_five_pages_and_avoids_a_false_empty_claim`, `test_renders_no_more_than_twenty_eligible_tasks`, `test_truncates_after_ordering_and_reports_the_remainder`, `test_only_displayed_tasks_trigger_track_resolution`; People and Interactions (people-due.test.ts): `test_people_scan_reaching_the_bound_marks_the_result_incomplete`, `test_interaction_scan_bound_flags_incomplete_instead_of_mislabeling`, `test_result_count_is_bounded_and_shows_a_remainder_indicator`, `test_build_due_people_blocks_bounds_to_the_display_limit_with_a_remainder_block`; 25 Track options (people-interaction.test.ts): `fetchAvailableTracks: one bounded query of page_size 25; at most 25 options; a malformed response is an AddInteractionCommandError`; people-suggest.test.ts: 5 Interactions `test_bounded_to_five_and_sorted_query`, `test_more_than_five_results_are_still_bounded_defensively`, `S10: the Interactions query asks for 5 and at most 5 summaries are used, even from a longer response`; 5 Tracks `test_person_tracks_take_precedence_within_the_track_cap (S10: 5 Tracks)`, `S10: the people-suggest bounds are Python's values`; 500-char Purpose `test_long_purpose_is_truncated_to_the_limit (S10: 500-char Purpose)`, `test_purpose_exactly_at_the_limit_is_kept_whole`, `S10: extractTrackPurpose truncates by code points to 499 + … and keeps exactly 500`; 3000-char section `test_an_oversized_gemini_draft_is_truncated_to_slacks_block_text_limit (S10: 3000-char section)`, `test_oversized_next_step_block_is_truncated (S10: 3000-char section)`, `S10: truncateForSlackSection keeps 3000 code points and cuts longer text to 2999 + … (astral characters count once)`; follow-up Task (followup-task.test.ts): 2000-char button value `test_build_returns_no_buttons_when_the_button_value_is_too_long_for_slack (S10: 2000-char value)`, `test_suggested_button_too_long_for_slack_is_omitted_alone (S10: 2000-char value)`, `S10: the 2000-character value limit is measured in Python json.dumps units, not JSON.stringify's`; 75-char button text `test_long_name_label_is_truncated_to_slack_button_text_limit (S10: 75-char text)`, `test_label_at_exactly_the_limit_is_not_truncated`; 150/500 chars and 365 days `test_missing_blank_non_text_or_over_long_name_yields_none (S5, S10: 150 chars)`, `test_name_at_the_limit_is_accepted`, `test_over_long_or_non_text_description_is_dropped (S10: 500 chars)`, `test_description_at_the_limit_is_kept`, `test_invalid_past_or_too_distant_follow_up_is_dropped (S10: 365 days)`, `test_follow_up_today_and_365_days_ahead_are_kept`, `S10: names and descriptions are bounded in code points (an emoji counts once)` |
| S11 (partial: `/tasks list`, `/people due`, Interaction write, `/people suggest`, Task write, follow-up buttons, attention summary) | `test_credential_failure_fails_with_a_safe_notion_specific_message`, `S11: a 401 on a Track lookup fails the run without a cause`, `test_terminal_track_permission_failure_is_isolated` (403 on a Track degrades); `test_notion_auth_failure_is_not_retried_and_propagates_uncaught` (people-due.test.ts); the Interaction write degrades (TD7): `test_notion_authentication_failure_produces_a_safe_message_without_a_partial_write` (401 on the schema read), `TD7 pin: a 401 on Interaction create posts the generic failure and does not throw`, `TD7 pin: a 403 on Interaction create is a credential failure too (not retried, caught)`; `fetchAvailableInteractionTypes: 401 is a credential failure, 403 is not (credential codes are (401,))` (people-interaction.test.ts); `/people suggest` fails on a Track page 401 and degrades on the best-effort reads: `S11: a 401 on a Track page fails the command before Gemini; a 403 only omits that Track`, `test_a_track_listing_credential_failure_does_not_break_the_rest_of_the_reply (S11: degrades)`, `S11: a 401 on the Type schema degrades: no button, no next step, and the unavailable note` (people-suggest.test.ts); the follow-up buttons degrade and the Task write posts the generic failure (followup-task.test.ts): `test_build_returns_no_buttons_on_notion_credential_failure (S11: degrades)`, `S11: a 401 on the Tracks listing degrades to no buttons; a 401 on the schema at submission posts the generic failure`, `S9/S11: a 401 or 403 on Task create is a credential failure: one create, caught, the generic failure`, `fetchTasksSchema: 401 is a credential failure, 403 is not (credential codes are (401,))`; the attention summary fails the run on a Notion 401 after posting what the other source gave (attention-summary.test.ts): `test_people_failure_sends_tasks_then_fails (S11: a Notion 401 fails the run)`, `test_tasks_failure_sends_people_then_fails (S11: degrades to a partial summary, still fails the run)`, and the goldens `attention_both_fail` (401 on Tasks: exit 1) and `attention_tasks_fail_people_ok` (equivalence.test.ts) |

TECH-DEBT pins (each fails if the preserved defect is fixed or changed):

| TD | TS tests |
| --- | --- |
| TD1 (Interaction create retries 5xx, timeouts, connection errors) | `TD1 pin: a 5xx on Interaction create is retried with the default policy (can duplicate)`, `TD1 pin: a ReadTimeout or ConnectionError on Interaction create is retried`, `TD1 pin: three 5xx on Interaction create give three creates, sleeps 1 and 2, and the generic failure` (people-interaction.test.ts) |
| TD2 | `TD2: a Follow-up with a time is parsed with date.fromisoformat and skipped as malformed` (tasks-list.test.ts) |
| TD3 (Interaction date, Task follow_up) | `TD3 pin: the modal date is parsed with date.fromisoformat, so 20260922 and 2026-W39-2 are accepted` (people-interaction.test.ts). `TD3 pin: the modal follow_up is parsed with date.fromisoformat, so 20261001 and 2026-W40-4 are accepted` (followup-task.test.ts). |
| TD7 (credential failure on the Interaction write is caught) | `TD7 pin: a 401 on Interaction create posts the generic failure and does not throw`, `TD7 pin: a 403 on Interaction create is a credential failure too (not retried, caught)`, `test_notion_authentication_failure_produces_a_safe_message_without_a_partial_write` (people-interaction.test.ts) |

## Golden equivalence evidence (G5)

`tests/equivalence.test.ts` replays each scenario with `tests/equivalence/replay.ts`
(one child process per scenario; see the file's header for the fakes and the
README's normalisation rules it applies). Scenarios replayed so far:

| Entry point | Scenarios | Slice |
| --- | --- | --- |
| `attention_summary` | `golden: attention_both_fail`, `golden: attention_both_sections_over_5`, `golden: attention_missing_slack_token`, `golden: attention_nothing`, `golden: attention_slack_dm_not_ok`, `golden: attention_tasks_fail_people_ok` (all 6, matched without differences) | S7 |
| `main` | (56 scenarios, S8) | S8 |

Harness self-tests (the replay is not lenient): `golden scenarios: every attention_summary scenario is replayed`,
`harness self-test: a golden that differs in any compared observable fails the comparison` (18 subtests),
`harness self-test: observed output the golden does not allow fails the comparison` (7 subtests),
`harness self-test: the fake http fails on an unscripted, mismatching or unused call` (3 subtests),
`harness self-test: the fake http allows only the options http.ts sends, and no json: null` (5 subtests: params on a POST, json on a GET, `json: null`, an unknown option, and the allowed options).

## Workflow evidence (G7)

| Workflow | Cutover | Evidence |
| --- | --- | --- |
| `.github/workflows/attention-summary.yml` | S7: `actions/setup-python` + `pip install` → `actions/setup-node@v7` (Node 24, npm cache) + `npm ci --omit=dev`; `python attention_summary.py` → `node src/attention-summary.ts`. Triggers, cron, job, step names and the whole `env:` mapping unchanged. | workflow diff; `G7: attention-summary.yml runs node src/attention-summary.ts on Node 24 with the unchanged triggers and env mapping` (triggers, setup-node@v7 with Node 24, `npm ci --omit=dev`, the entry command, exactly the six `env:` mappings to the same-named secrets, no Python); `entry point: node src/attention-summary.ts with an empty environment prints Python's config error on stdout and exits 1`, `entry point: node src/attention-summary.ts runs main with process.env and exits 0 when nothing needs attention` (attention-summary.test.ts); local dry run of `npm ci --omit=dev` + `node src/attention-summary.ts` (S7 report) |
| `.github/workflows/slack-message.yml` | S8 | — |
