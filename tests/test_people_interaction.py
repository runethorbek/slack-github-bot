import json
import unittest
from datetime import date
from unittest.mock import Mock

from people_interaction import (
    ADD_INTERACTION_ACTION_ID,
    AddInteractionCommandError,
    INTERACTION_ADDED_MESSAGE_TEMPLATE,
    INTERACTION_FAILURE_MESSAGE,
    INTERACTION_INVALID_MESSAGE,
    add_interaction_button,
    fetch_available_interaction_types,
    fetch_available_tracks,
    handle_add_interaction_submission,
    is_valid_interaction_type,
    is_valid_track,
)


FIXED_TODAY = date(2026, 9, 22)

# The live Interactions "Type" select property, as it would come back from
# Notion's "retrieve a data source" endpoint. Deliberately includes a value
# ("Video call") absent from every hardcoded list this feature used to
# carry, so tests built on this fixture demonstrate a schema-driven Type
# becoming available without any code change.
TYPE_SELECT_OPTIONS = [{"name": "Coffee"}, {"name": "Walk"}, {"name": "Video call"}]


def schema_response(title_property_name="Title of interaction", type_options=None):
    response = Mock()
    response.json.return_value = {
        "properties": {
            "People": {"type": "relation"},
            "Type": {
                "type": "select",
                "select": {"options": type_options or TYPE_SELECT_OPTIONS},
            },
            "Date": {"type": "date"},
            "Notes": {"type": "rich_text"},
            title_property_name: {"type": "title"},
        }
    }
    return response


def ok_response():
    response = Mock()
    response.json.return_value = {"id": "new-interaction-id"}
    return response


def schema_response_missing_title():
    # No property has type "title": the schema fetch cannot resolve where to
    # write a required title, and must not crash the caller. The Type
    # property is otherwise valid, so this isolates the title-resolution
    # failure from Type validation.
    response = Mock()
    response.json.return_value = {
        "properties": {
            "People": {"type": "relation"},
            "Type": {"type": "select", "select": {"options": TYPE_SELECT_OPTIONS}},
        }
    }
    return response


def track_page(track_id, name, priority=None):
    return {
        "id": track_id,
        "properties": {
            "Navn": {
                "type": "title",
                "title": [{"plain_text": name}] if name else [],
            },
            "Priority": {
                "type": "select",
                "select": {"name": priority} if priority else None,
            },
        },
    }


def tracks_response(pages, has_more=False, next_cursor=None):
    response = Mock()
    response.json.return_value = {
        "results": pages,
        "has_more": has_more,
        "next_cursor": next_cursor,
    }
    return response


class AddInteractionButtonTests(unittest.TestCase):
    def test_value_carries_the_stable_page_id_and_name(self):
        button = add_interaction_button("person-page-id", "Jane Doe")

        self.assertEqual(button["action_id"], ADD_INTERACTION_ACTION_ID)
        self.assertEqual(
            json.loads(button["value"]),
            {"page_id": "person-page-id", "name": "Jane Doe"},
        )

    def test_no_tracks_omits_track_fields_entirely(self):
        button = add_interaction_button(
            "person-page-id", "Jane Doe", tracks=(), default_track_id=None
        )

        self.assertNotIn("tracks", json.loads(button["value"]))
        self.assertNotIn("default_track_id", json.loads(button["value"]))

    def test_tracks_and_default_are_carried_in_the_value(self):
        tracks = [{"id": "t1", "name": "AI Network"}, {"id": "t2", "name": "Investors"}]

        button = add_interaction_button(
            "person-page-id", "Jane Doe", tracks=tracks, default_track_id="t1"
        )

        value = json.loads(button["value"])
        self.assertEqual(value["tracks"], tracks)
        self.assertEqual(value["default_track_id"], "t1")

    def test_tracks_without_a_default_omit_default_track_id(self):
        tracks = [{"id": "t1", "name": "AI Network"}]

        button = add_interaction_button(
            "person-page-id", "Jane Doe", tracks=tracks, default_track_id=None
        )

        self.assertNotIn("default_track_id", json.loads(button["value"]))

    def test_no_interaction_types_omits_types_field(self):
        button = add_interaction_button(
            "person-page-id", "Jane Doe", interaction_types=()
        )

        self.assertNotIn("types", json.loads(button["value"]))

    def test_interaction_types_are_carried_in_the_value(self):
        button = add_interaction_button(
            "person-page-id",
            "Jane Doe",
            interaction_types=["Coffee", "Walk"],
        )

        self.assertEqual(json.loads(button["value"])["types"], ["Coffee", "Walk"])


class FetchAvailableInteractionTypesTests(unittest.TestCase):
    def test_resolves_option_names_from_the_live_schema(self):
        notion_get = Mock(return_value=schema_response())

        types_ = fetch_available_interaction_types(
            notion_get, "secret", "interactions-id", Mock()
        )

        self.assertEqual(types_, ["Coffee", "Walk", "Video call"])

    def test_a_type_added_in_notion_is_available_without_any_code_change(self):
        # Demonstrates the issue #17 guarantee directly: a value never
        # present in any hardcoded list this feature used to carry becomes
        # available purely because the mocked schema response says so.
        notion_get = Mock(
            return_value=schema_response(
                type_options=[{"name": "Brand New Type From Notion"}]
            )
        )

        types_ = fetch_available_interaction_types(
            notion_get, "secret", "interactions-id", Mock()
        )

        self.assertEqual(types_, ["Brand New Type From Notion"])

    def test_missing_type_property_is_a_failure(self):
        response = Mock()
        response.json.return_value = {"properties": {"People": {"type": "relation"}}}
        notion_get = Mock(return_value=response)

        with self.assertRaises(AddInteractionCommandError):
            fetch_available_interaction_types(
                notion_get, "secret", "interactions-id", Mock()
            )

    def test_type_property_not_a_select_is_a_failure(self):
        response = Mock()
        response.json.return_value = {"properties": {"Type": {"type": "rich_text"}}}
        notion_get = Mock(return_value=response)

        with self.assertRaises(AddInteractionCommandError):
            fetch_available_interaction_types(
                notion_get, "secret", "interactions-id", Mock()
            )

    def test_select_property_without_options_is_a_failure(self):
        response = Mock()
        response.json.return_value = {"properties": {"Type": {"type": "select"}}}
        notion_get = Mock(return_value=response)

        with self.assertRaises(AddInteractionCommandError):
            fetch_available_interaction_types(
                notion_get, "secret", "interactions-id", Mock()
            )

    def test_malformed_option_entries_are_skipped(self):
        response = Mock()
        response.json.return_value = {
            "properties": {
                "Type": {
                    "type": "select",
                    "select": {"options": [{"name": "Coffee"}, {}, "not-a-dict"]},
                }
            }
        }
        notion_get = Mock(return_value=response)

        types_ = fetch_available_interaction_types(
            notion_get, "secret", "interactions-id", Mock()
        )

        self.assertEqual(types_, ["Coffee"])


class IsValidInteractionTypeTests(unittest.TestCase):
    def test_type_present_among_live_options_is_valid(self):
        notion_get = Mock(return_value=schema_response())

        self.assertTrue(
            is_valid_interaction_type(
                "Coffee", notion_get, "secret", "interactions-id", Mock()
            )
        )

    def test_type_not_among_live_options_is_invalid(self):
        notion_get = Mock(return_value=schema_response())

        self.assertFalse(
            is_valid_interaction_type(
                "Linkedon", notion_get, "secret", "interactions-id", Mock()
            )
        )


class FetchAvailableTracksTests(unittest.TestCase):
    def test_resolves_id_and_name_sorted_alphabetically(self):
        notion_post = Mock(
            return_value=tracks_response(
                [track_page("t2", "Investors"), track_page("t1", "AI Network")]
            )
        )

        tracks = fetch_available_tracks(notion_post, "secret", "tracks-id", Mock())

        self.assertEqual(
            tracks,
            [{"id": "t1", "name": "AI Network"}, {"id": "t2", "name": "Investors"}],
        )

    def test_malformed_track_page_is_skipped(self):
        notion_post = Mock(
            return_value=tracks_response(
                [{"id": "t1", "properties": {}}, track_page("t2", "Investors")]
            )
        )

        tracks = fetch_available_tracks(notion_post, "secret", "tracks-id", Mock())

        self.assertEqual(tracks, [{"id": "t2", "name": "Investors"}])

    def test_no_tracks_returns_empty_list(self):
        notion_post = Mock(return_value=tracks_response([]))

        tracks = fetch_available_tracks(notion_post, "secret", "tracks-id", Mock())

        self.assertEqual(tracks, [])


class IsValidTrackTests(unittest.TestCase):
    def test_id_present_among_live_tracks_is_valid(self):
        notion_post = Mock(return_value=tracks_response([track_page("t1", "AI Network")]))

        self.assertTrue(
            is_valid_track("t1", notion_post, "secret", "tracks-id", Mock())
        )

    def test_id_not_among_live_tracks_is_invalid(self):
        notion_post = Mock(return_value=tracks_response([track_page("t1", "AI Network")]))

        self.assertFalse(
            is_valid_track("forged-id", notion_post, "secret", "tracks-id", Mock())
        )

    def test_unconfigured_tracks_data_source_fails_closed(self):
        notion_post = Mock()

        self.assertFalse(is_valid_track("t1", notion_post, "secret", "", Mock()))
        notion_post.assert_not_called()


class HandleAddInteractionSubmissionTests(unittest.TestCase):
    def test_valid_type_is_accepted_and_written_with_the_correct_person_relation(self):
        notion_post = Mock(return_value=ok_response())
        notion_get = Mock(return_value=schema_response())
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Talked about the new role.",
            "2026-09-22",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        notion_post.assert_called_once()
        request = notion_post.call_args
        self.assertEqual(request.args[0], "https://api.notion.com/v1/pages")
        properties = request.kwargs["json"]["properties"]
        self.assertEqual(
            properties["People"], {"relation": [{"id": "person-page-id"}]}
        )
        self.assertEqual(properties["Type"], {"select": {"name": "Coffee"}})
        self.assertEqual(properties["Date"], {"date": {"start": "2026-09-22"}})
        post_slack_message.assert_called_once_with(
            INTERACTION_ADDED_MESSAGE_TEMPLATE.format(name="Jane Doe"), thread_ts=None
        )

    def test_notes_are_preserved_exactly(self):
        notion_post = Mock(return_value=ok_response())
        notion_get = Mock(return_value=schema_response())
        post_slack_message = Mock()
        notes = "  Exact notes,\nnot summarized or rewritten.  "

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            notes,
            "2026-09-22",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        properties = notion_post.call_args.kwargs["json"]["properties"]
        self.assertEqual(
            properties["Notes"]["rich_text"][0]["text"]["content"], notes
        )

    def test_write_payload_contains_only_intended_fields(self):
        notion_post = Mock(return_value=ok_response())
        notion_get = Mock(return_value=schema_response())
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "2026-09-22",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        properties = notion_post.call_args.kwargs["json"]["properties"]
        self.assertEqual(
            set(properties.keys()),
            {"People", "Type", "Date", "Notes", "Track", "Title of interaction"},
        )
        request_json = notion_post.call_args.kwargs["json"]
        self.assertEqual(
            request_json["parent"], {"data_source_id": "interactions-id"}
        )

    def test_date_defaults_to_today_when_missing(self):
        notion_post = Mock(return_value=ok_response())
        notion_get = Mock(return_value=schema_response())
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        properties = notion_post.call_args.kwargs["json"]["properties"]
        self.assertEqual(
            properties["Date"], {"date": {"start": FIXED_TODAY.isoformat()}}
        )

    def test_unknown_type_is_rejected_before_any_notion_write(self):
        notion_post = Mock()
        notion_get = Mock(return_value=schema_response())
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Linkedon",
            "Notes",
            "2026-09-22",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        # The live schema is read to check the submitted Type, but the
        # Interaction is never written.
        notion_get.assert_called_once()
        notion_post.assert_not_called()
        post_slack_message.assert_called_once_with(INTERACTION_INVALID_MESSAGE, thread_ts=None)

    def test_empty_type_is_rejected(self):
        notion_post = Mock()
        notion_get = Mock(return_value=schema_response())
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "",
            "Notes",
            "2026-09-22",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        notion_post.assert_not_called()
        post_slack_message.assert_called_once_with(INTERACTION_INVALID_MESSAGE, thread_ts=None)

    def test_type_validation_failure_produces_a_safe_message_without_a_write(self):
        # The Type schema fetch itself can fail (a Notion outage, a
        # malformed response); this must be caught exactly like any other
        # Notion failure, and must never fall back to accepting or
        # guessing a Type.
        failing = Mock()
        failing.raise_for_status.side_effect = Exception("boom")
        notion_get = Mock(return_value=failing)
        notion_post = Mock()
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "2026-09-22",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        notion_post.assert_not_called()
        post_slack_message.assert_called_once_with(INTERACTION_FAILURE_MESSAGE, thread_ts=None)

    def test_malformed_date_is_rejected_before_any_notion_write(self):
        notion_post = Mock()
        notion_get = Mock()
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "not-a-date",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        notion_post.assert_not_called()
        notion_get.assert_not_called()
        post_slack_message.assert_called_once_with(INTERACTION_INVALID_MESSAGE, thread_ts=None)

    def test_missing_person_identity_is_ignored_rather_than_guessed(self):
        notion_post = Mock()
        notion_get = Mock()
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "",
            "",
            "Coffee",
            "Notes",
            "2026-09-22",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        notion_post.assert_not_called()
        post_slack_message.assert_not_called()

    def test_notion_failure_produces_a_safe_message_without_a_partial_write(self):
        notion_get = Mock(return_value=schema_response())
        failing = Mock()
        failing.raise_for_status.side_effect = Exception("boom")
        notion_post = Mock(return_value=failing)
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "2026-09-22",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        post_slack_message.assert_called_once_with(INTERACTION_FAILURE_MESSAGE, thread_ts=None)

    def test_unresolvable_title_property_produces_a_safe_message_without_a_partial_write(self):
        # The schema fetch itself can fail to find a title property (or fail
        # outright); that must be caught exactly like a Notion write failure,
        # not crash the Action.
        notion_get = Mock(return_value=schema_response_missing_title())
        notion_post = Mock()
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "2026-09-22",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        notion_post.assert_not_called()
        post_slack_message.assert_called_once_with(INTERACTION_FAILURE_MESSAGE, thread_ts=None)

    def test_notion_authentication_failure_produces_a_safe_message_without_a_partial_write(self):
        # A 401/403 from Notion raises NotionAuthenticationError, a distinct
        # exception type from a generic TaskListCommandError; it must be
        # caught the same way rather than crashing the Action uncaught.
        failing = Mock()
        error = Exception("unauthorized")
        error.response = Mock(status_code=401)
        failing.raise_for_status.side_effect = error
        notion_get = Mock(return_value=failing)
        notion_post = Mock()
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "2026-09-22",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        notion_post.assert_not_called()
        post_slack_message.assert_called_once_with(INTERACTION_FAILURE_MESSAGE, thread_ts=None)

    def test_confirmation_and_failure_replies_stay_in_the_suggestion_thread(self):
        notion_post = Mock(return_value=ok_response())
        notion_get = Mock(return_value=schema_response())
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "2026-09-22",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            thread_ts="100.001",
            sleep=Mock(),
        )

        post_slack_message.assert_called_once_with(
            INTERACTION_ADDED_MESSAGE_TEMPLATE.format(name="Jane Doe"),
            thread_ts="100.001",
        )

    def test_invalid_type_reply_stays_in_the_suggestion_thread(self):
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Linkedon",
            "Notes",
            "2026-09-22",
            "",
            post_slack_message,
            Mock(),
            Mock(return_value=schema_response()),
            self.environment(),
            thread_ts="100.001",
            sleep=Mock(),
        )

        post_slack_message.assert_called_once_with(
            INTERACTION_INVALID_MESSAGE, thread_ts="100.001"
        )

    def test_no_track_selected_writes_an_empty_track_relation(self):
        notion_post = Mock(return_value=ok_response())
        notion_get = Mock(return_value=schema_response())
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "2026-09-22",
            "",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        properties = notion_post.call_args.kwargs["json"]["properties"]
        self.assertEqual(properties["Track"], {"relation": []})

    def test_valid_track_is_written_as_the_track_relation(self):
        # notion_post is used for both the live Track validation query and
        # the final Interaction write; the validation query returns the
        # submitted id as a real Track before the write is attempted.
        notion_post = Mock(
            side_effect=[
                tracks_response([track_page("track-1", "AI Network")]),
                ok_response(),
            ]
        )
        notion_get = Mock(return_value=schema_response())
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "2026-09-22",
            "track-1",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(tracks_data_source_id="tracks-id"),
            sleep=Mock(),
        )

        write_call = notion_post.call_args_list[-1]
        properties = write_call.kwargs["json"]["properties"]
        self.assertEqual(properties["Track"], {"relation": [{"id": "track-1"}]})
        post_slack_message.assert_called_once_with(
            INTERACTION_ADDED_MESSAGE_TEMPLATE.format(name="Jane Doe"), thread_ts=None
        )

    def test_a_track_id_that_is_not_a_live_track_is_rejected_before_any_write(self):
        notion_post = Mock(
            return_value=tracks_response([track_page("track-1", "AI Network")])
        )
        notion_get = Mock(return_value=schema_response())
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "2026-09-22",
            "forged-or-stale-id",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(tracks_data_source_id="tracks-id"),
            sleep=Mock(),
        )

        # Type validation (notion_get) and the Track validation query
        # (notion_post) both ran; the Interaction page was never created,
        # and the title-property schema fetch never ran.
        notion_post.assert_called_once()
        notion_get.assert_called_once()
        post_slack_message.assert_called_once_with(INTERACTION_INVALID_MESSAGE, thread_ts=None)

    def test_a_track_id_with_no_tracks_data_source_configured_is_rejected(self):
        notion_post = Mock()
        notion_get = Mock(return_value=schema_response())
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "2026-09-22",
            "track-1",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        notion_post.assert_not_called()
        post_slack_message.assert_called_once_with(INTERACTION_INVALID_MESSAGE, thread_ts=None)

    def test_track_validation_failure_produces_a_safe_message_without_a_write(self):
        failing = Mock()
        failing.raise_for_status.side_effect = Exception("boom")
        notion_post = Mock(return_value=failing)
        notion_get = Mock(return_value=schema_response())
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "Notes",
            "2026-09-22",
            "track-1",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(tracks_data_source_id="tracks-id"),
            sleep=Mock(),
        )

        # Type validation ran (and passed); the title-property schema fetch
        # never ran because Track validation failed first.
        notion_get.assert_called_once()
        post_slack_message.assert_called_once_with(INTERACTION_FAILURE_MESSAGE, thread_ts=None)

    @staticmethod
    def environment(tracks_data_source_id=None):
        environment = {
            "NOTION_API_KEY": "secret-token",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }
        if tracks_data_source_id:
            environment["NOTION_TRACKS_DATA_SOURCE_ID"] = tracks_data_source_id
        return environment


if __name__ == "__main__":
    unittest.main()
