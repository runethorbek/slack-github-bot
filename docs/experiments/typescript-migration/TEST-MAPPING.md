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

## Security-invariant evidence (G6)

Filled in as slices land. Tests named here fail if the invariant breaks.

| Invariant | TS tests so far |
| --- | --- |
| S1 | `test_dm_authorization_uses_exact_user_id`, `test_missing_authorization_configuration_fails_closed`, `test_user_id_match_without_dm_identity_is_rejected` (slack-authorization.test.ts) |
| S2 | **Deferred to S8**: the authorization-before-calls order lives in `main.ts` (PLAN.md §9 amendment). |
| S3 (partial: Interaction write) | `test_missing_person_identity_is_ignored_rather_than_guessed`, `S3: a page id without a name, or a name without a page id, is a silent no-op` (people-interaction.test.ts). The Task write is evidenced in S6, `parse_person_payload` in S8. |
| S4 (partial: Interaction Type and Track) | `test_unknown_type_is_rejected_before_any_notion_write`, `S4: an invalid Type is rejected before the Track is validated`, `test_a_track_id_that_is_not_a_live_track_is_rejected_before_any_write`, `test_a_track_id_with_no_tracks_data_source_configured_is_rejected`, `test_unconfigured_tracks_data_source_fails_closed`, `test_type_property_not_a_select_is_a_failure` (a malformed schema is not an empty allowlist), `validation order: date, then Type, then Track, then title property, then exactly one create` (people-interaction.test.ts). Task Priority and Status are evidenced in S6. |
| S6 (partial: `/people due`) | `S6: /people due never calls generateText` (people-due.test.ts). The suggest prompt contents are evidenced in S5. |
| S7 (partial: `raise … from`, generic failure text) | `withPyCause records __cause__ without Node printing it` (python-compat.test.ts); `callNotionWithRetries: the final TaskListCommandError carries the request error as its cause`; `test_exhausted_transient_failure_produces_a_safe_generic_message`, `test_malformed_query_response_produces_a_safe_message_without_raw_payload` (people-due.test.ts) |
| S10 (partial: 500 scanned, 20 displayed, 3 Tracks shown, 25 Track options) | `test_stops_after_five_pages_and_avoids_a_false_empty_claim`, `test_renders_no_more_than_twenty_eligible_tasks`, `test_truncates_after_ordering_and_reports_the_remainder`, `test_only_displayed_tasks_trigger_track_resolution`; People and Interactions (people-due.test.ts): `test_people_scan_reaching_the_bound_marks_the_result_incomplete`, `test_interaction_scan_bound_flags_incomplete_instead_of_mislabeling`, `test_result_count_is_bounded_and_shows_a_remainder_indicator`, `test_build_due_people_blocks_bounds_to_the_display_limit_with_a_remainder_block`; 25 Track options (people-interaction.test.ts): `fetchAvailableTracks: one bounded query of page_size 25; at most 25 options; a malformed response is an AddInteractionCommandError` |
| S11 (partial: `/tasks list`, `/people due`, Interaction write) | `test_credential_failure_fails_with_a_safe_notion_specific_message`, `S11: a 401 on a Track lookup fails the run without a cause`, `test_terminal_track_permission_failure_is_isolated` (403 on a Track degrades); `test_notion_auth_failure_is_not_retried_and_propagates_uncaught` (people-due.test.ts); the Interaction write degrades (TD7): `test_notion_authentication_failure_produces_a_safe_message_without_a_partial_write` (401 on the schema read), `TD7 pin: a 401 on Interaction create posts the generic failure and does not throw`, `TD7 pin: a 403 on Interaction create is a credential failure too (not retried, caught)`; `fetchAvailableInteractionTypes: 401 is a credential failure, 403 is not (credential codes are (401,))` (people-interaction.test.ts) |

TECH-DEBT pins (each fails if the preserved defect is fixed or changed):

| TD | TS tests |
| --- | --- |
| TD1 (Interaction create retries 5xx, timeouts, connection errors) | `TD1 pin: a 5xx on Interaction create is retried with the default policy (can duplicate)`, `TD1 pin: a ReadTimeout or ConnectionError on Interaction create is retried`, `TD1 pin: three 5xx on Interaction create give three creates, sleeps 1 and 2, and the generic failure` (people-interaction.test.ts) |
| TD2 | `TD2: a Follow-up with a time is parsed with date.fromisoformat and skipped as malformed` (tasks-list.test.ts) |
| TD3 (Interaction date) | `TD3 pin: the modal date is parsed with date.fromisoformat, so 20260922 and 2026-W39-2 are accepted` (people-interaction.test.ts). The Task `follow_up` is pinned in S6. |
| TD7 (credential failure on the Interaction write is caught) | `TD7 pin: a 401 on Interaction create posts the generic failure and does not throw`, `TD7 pin: a 403 on Interaction create is a credential failure too (not retried, caught)`, `test_notion_authentication_failure_produces_a_safe_message_without_a_partial_write` (people-interaction.test.ts) |
