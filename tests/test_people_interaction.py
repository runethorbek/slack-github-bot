import json
import unittest
from datetime import date
from unittest.mock import Mock

from people_interaction import (
    ADD_INTERACTION_ACTION_ID,
    ALLOWED_INTERACTION_TYPES,
    INTERACTION_ADDED_MESSAGE_TEMPLATE,
    INTERACTION_FAILURE_MESSAGE,
    INTERACTION_INVALID_MESSAGE,
    add_interaction_button,
    handle_add_interaction_submission,
)


FIXED_TODAY = date(2026, 9, 22)


def schema_response(title_property_name="Title of interaction"):
    response = Mock()
    response.json.return_value = {
        "properties": {
            "People": {"type": "relation"},
            "Type": {"type": "select"},
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
    # write a required title, and must not crash the caller.
    response = Mock()
    response.json.return_value = {
        "properties": {
            "People": {"type": "relation"},
            "Type": {"type": "select"},
        }
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
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        properties = notion_post.call_args.kwargs["json"]["properties"]
        self.assertEqual(
            set(properties.keys()),
            {"People", "Type", "Date", "Notes", "Title of interaction"},
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
        notion_get = Mock()
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Linkedon",
            "Notes",
            "2026-09-22",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        notion_post.assert_not_called()
        notion_get.assert_not_called()
        post_slack_message.assert_called_once_with(INTERACTION_INVALID_MESSAGE, thread_ts=None)

    def test_empty_type_is_rejected(self):
        notion_post = Mock()
        notion_get = Mock()
        post_slack_message = Mock()

        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "",
            "Notes",
            "2026-09-22",
            post_slack_message,
            notion_post,
            notion_get,
            self.environment(),
            sleep=Mock(),
        )

        notion_post.assert_not_called()
        post_slack_message.assert_called_once_with(INTERACTION_INVALID_MESSAGE, thread_ts=None)

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
            post_slack_message,
            Mock(),
            Mock(),
            self.environment(),
            thread_ts="100.001",
            sleep=Mock(),
        )

        post_slack_message.assert_called_once_with(
            INTERACTION_INVALID_MESSAGE, thread_ts="100.001"
        )

    def test_allowed_types_match_the_expected_current_values(self):
        # Pinned so a future change to this allowlist is a deliberate,
        # reviewed edit rather than an accidental one.
        self.assertEqual(
            ALLOWED_INTERACTION_TYPES,
            (
                "Coffee",
                "Network Meeting",
                "Meeting",
                "LinkedIn Message",
                "Online meeting",
                "Lunch",
                "LinkedIn invite",
                "Walk",
                "Phone call",
            ),
        )

    @staticmethod
    def environment():
        return {
            "NOTION_API_KEY": "secret-token",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }


if __name__ == "__main__":
    unittest.main()
