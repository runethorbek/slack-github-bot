import json
import unittest
from datetime import date
from unittest.mock import Mock

import requests

from followup_task import (
    ADD_FOLLOWUP_TASK_ACTION_ID,
    FOLLOWUP_TASK_FAILURE_MESSAGE,
    FOLLOWUP_TASK_INVALID_MESSAGE,
    FOLLOWUP_TASK_STATUS_MISSING_MESSAGE,
    FOLLOWUP_TASK_UNCERTAIN_MESSAGE,
    build_followup_task_button,
    followup_task_button,
    handle_add_followup_task_submission,
    parse_task_payload,
)
from people_interaction import handle_add_interaction_submission


FIXED_TODAY = date(2026, 9, 26)

ENVIRONMENT = {
    "NOTION_API_KEY": "test-notion-token",
    "NOTION_TASKS_DATA_SOURCE_ID": "tasks-id",
    "NOTION_TRACKS_DATA_SOURCE_ID": "tracks-id",
    "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
}

PRIORITY_OPTIONS = [{"name": "High"}, {"name": "Medium"}, {"name": "Low"}]
STATUS_OPTIONS = [{"name": "Ikke startet"}, {"name": "I gang"}, {"name": "Færdig"}]


def tasks_schema_response(status_options=None, priority_options=None):
    response = Mock()
    response.json.return_value = {
        "properties": {
            "Navn": {"id": "title", "type": "title"},
            "People": {"type": "relation"},
            "Track": {"type": "relation"},
            "Priority": {
                "type": "select",
                "select": {"options": priority_options or PRIORITY_OPTIONS},
            },
            "Status": {
                "type": "status",
                "status": {
                    "options": STATUS_OPTIONS
                    if status_options is None
                    else status_options
                },
            },
            "Follow-up": {"type": "date"},
            "Created": {"type": "date"},
            "Description": {"type": "rich_text"},
        }
    }
    return response


def tracks_response(*tracks):
    response = Mock()
    response.json.return_value = {
        "results": [
            {
                "id": track_id,
                "properties": {
                    "Navn": {"type": "title", "title": [{"plain_text": name}]},
                },
            }
            for track_id, name in tracks
        ],
        "has_more": False,
        "next_cursor": None,
    }
    return response


def http_error(status_code):
    error = requests.HTTPError()
    error.response = Mock(status_code=status_code, headers={})
    response = Mock()
    response.raise_for_status.side_effect = error
    return response


def submit(
    task_name="Send the article",
    description="",
    follow_up="",
    priority="",
    track_id="",
    notion_post=None,
    notion_get=None,
    environment=ENVIRONMENT,
    person_page_id="person-page-id",
):
    post_slack_message = Mock()
    notion_post = notion_post or Mock(return_value=Mock())
    notion_get = notion_get or Mock(return_value=tasks_schema_response())
    handle_add_followup_task_submission(
        person_page_id,
        "Jane Doe",
        task_name,
        description,
        follow_up,
        priority,
        track_id,
        post_slack_message,
        notion_post,
        notion_get,
        environment,
        thread_ts="100.001",
        today=FIXED_TODAY,
        sleep=Mock(),
    )
    return post_slack_message, notion_post, notion_get


def task_writes(notion_post):
    return [
        call
        for call in notion_post.call_args_list
        if call.args[0] == "https://api.notion.com/v1/pages"
    ]


class FollowupTaskButtonTests(unittest.TestCase):
    def test_value_carries_person_priorities_tracks_and_default(self):
        tracks = [{"id": "t1", "name": "AI Network"}]
        button = followup_task_button(
            "person-page-id", "Jane Doe", tracks, "t1", ["High", "Low"]
        )

        self.assertEqual(button["action_id"], ADD_FOLLOWUP_TASK_ACTION_ID)
        self.assertEqual(button["text"]["text"], "Add follow-up task")
        self.assertEqual(
            json.loads(button["value"]),
            {
                "page_id": "person-page-id",
                "name": "Jane Doe",
                "priorities": ["High", "Low"],
                "tracks": tracks,
                "default_track_id": "t1",
            },
        )

    def test_empty_options_are_omitted(self):
        button = followup_task_button("person-page-id", "Jane Doe")

        self.assertEqual(
            json.loads(button["value"]),
            {"page_id": "person-page-id", "name": "Jane Doe"},
        )

    def test_build_resolves_live_priorities_and_tracks_with_interaction_track_default(self):
        notion_get = Mock(return_value=tasks_schema_response())
        notion_post = Mock(
            return_value=tracks_response(("t2", "Investors"), ("t1", "AI Network"))
        )

        button = build_followup_task_button(
            "person-page-id", "Jane Doe", "t2", notion_post, notion_get, ENVIRONMENT, Mock()
        )

        value = json.loads(button["value"])
        self.assertEqual(value["priorities"], ["High", "Medium", "Low"])
        self.assertEqual(
            value["tracks"],
            [{"id": "t1", "name": "AI Network"}, {"id": "t2", "name": "Investors"}],
        )
        self.assertEqual(value["default_track_id"], "t2")
        notion_get.assert_called_once()
        self.assertEqual(
            notion_get.call_args.args[0],
            "https://api.notion.com/v1/data_sources/tasks-id",
        )

    def test_build_without_interaction_track_has_no_default(self):
        button = build_followup_task_button(
            "person-page-id",
            "Jane Doe",
            "",
            Mock(return_value=tracks_response(("t1", "AI Network"))),
            Mock(return_value=tasks_schema_response()),
            ENVIRONMENT,
            Mock(),
        )

        self.assertNotIn("default_track_id", json.loads(button["value"]))

    def test_build_returns_none_when_priority_schema_fails(self):
        button = build_followup_task_button(
            "person-page-id",
            "Jane Doe",
            "t1",
            Mock(return_value=tracks_response(("t1", "AI Network"))),
            Mock(return_value=http_error(400)),
            ENVIRONMENT,
            Mock(),
        )

        self.assertIsNone(button)

    def test_build_returns_none_when_tracks_fail(self):
        button = build_followup_task_button(
            "person-page-id",
            "Jane Doe",
            "t1",
            Mock(return_value=http_error(400)),
            Mock(return_value=tasks_schema_response()),
            ENVIRONMENT,
            Mock(),
        )

        self.assertIsNone(button)

    def test_build_returns_none_on_notion_credential_failure(self):
        button = build_followup_task_button(
            "person-page-id",
            "Jane Doe",
            "",
            Mock(),
            Mock(return_value=http_error(401)),
            ENVIRONMENT,
            Mock(),
        )

        self.assertIsNone(button)

    def test_build_returns_none_when_the_button_value_is_too_long_for_slack(self):
        many_tracks = [
            (f"00000000-0000-0000-0000-{index:012d}", f"A fairly long Track name {index}")
            for index in range(25)
        ]

        button = build_followup_task_button(
            "person-page-id",
            "Jane Doe",
            "",
            Mock(return_value=tracks_response(*many_tracks)),
            Mock(return_value=tasks_schema_response()),
            ENVIRONMENT,
            Mock(),
        )

        self.assertIsNone(button)

    def test_missing_priority_property_still_offers_the_button_without_priorities(self):
        schema = tasks_schema_response()
        del schema.json.return_value["properties"]["Priority"]

        button = build_followup_task_button(
            "person-page-id",
            "Jane Doe",
            "",
            Mock(return_value=tracks_response()),
            Mock(return_value=schema),
            ENVIRONMENT,
            Mock(),
        )

        self.assertNotIn("priorities", json.loads(button["value"]))

    def test_build_returns_none_without_a_tasks_data_source(self):
        notion_get = Mock()
        environment = {**ENVIRONMENT, "NOTION_TASKS_DATA_SOURCE_ID": ""}

        button = build_followup_task_button(
            "person-page-id", "Jane Doe", "", Mock(), notion_get, environment, Mock()
        )

        self.assertIsNone(button)
        notion_get.assert_not_called()


class InteractionConfirmationTests(unittest.TestCase):
    def interaction_schema_response(self):
        response = Mock()
        response.json.return_value = {
            "properties": {
                "Title of interaction": {"type": "title"},
                "Type": {"type": "select", "select": {"options": [{"name": "Coffee"}]}},
            }
        }
        return response

    def save_interaction(self, build_followup_button):
        post_slack_message = Mock()
        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Coffee",
            "",
            "2026-09-26",
            "",
            post_slack_message,
            Mock(return_value=Mock()),
            Mock(return_value=self.interaction_schema_response()),
            ENVIRONMENT,
            thread_ts="100.001",
            sleep=Mock(),
            build_followup_button=build_followup_button,
        )
        return post_slack_message

    def test_successful_save_offers_the_followup_button(self):
        button = followup_task_button("person-page-id", "Jane Doe")
        build = Mock(return_value=button)

        post_slack_message = self.save_interaction(build)

        build.assert_called_once_with("person-page-id", "Jane Doe", "")
        post_slack_message.assert_called_once()
        call = post_slack_message.call_args
        self.assertEqual(call.args[0], "Interaction added for Jane Doe.")
        self.assertEqual(call.kwargs["thread_ts"], "100.001")
        self.assertEqual(call.kwargs["blocks"][-1], {"type": "actions", "elements": [button]})

    def test_unresolvable_options_still_confirm_without_the_button(self):
        post_slack_message = self.save_interaction(Mock(return_value=None))

        post_slack_message.assert_called_once_with(
            "Interaction added for Jane Doe.", thread_ts="100.001"
        )

    def test_failed_interaction_save_never_builds_the_button(self):
        build = Mock()
        post_slack_message = Mock()
        handle_add_interaction_submission(
            "person-page-id",
            "Jane Doe",
            "Unknown type",
            "",
            "2026-09-26",
            "",
            post_slack_message,
            Mock(),
            Mock(return_value=self.interaction_schema_response()),
            ENVIRONMENT,
            sleep=Mock(),
            build_followup_button=build,
        )

        build.assert_not_called()


class ParseTaskPayloadTests(unittest.TestCase):
    def test_parses_bundled_fields(self):
        self.assertEqual(
            parse_task_payload(
                json.dumps(
                    {
                        "name": "Send the article",
                        "description": "Line one\nLine two",
                        "follow_up": "2026-10-01",
                        "priority": "High",
                        "track_id": "t1",
                    }
                )
            ),
            {
                "name": "Send the article",
                "description": "Line one\nLine two",
                "follow_up": "2026-10-01",
                "priority": "High",
                "track_id": "t1",
            },
        )

    def test_malformed_or_non_string_values_become_empty(self):
        empty = {
            "name": "",
            "description": "",
            "follow_up": "",
            "priority": "",
            "track_id": "",
        }
        self.assertEqual(parse_task_payload(""), empty)
        self.assertEqual(parse_task_payload("not json"), empty)
        self.assertEqual(parse_task_payload("[1]"), empty)
        self.assertEqual(
            parse_task_payload(
                json.dumps({"name": 5, "description": 7, "priority": ["High"]})
            ),
            empty,
        )


class AddFollowupTaskSubmissionTests(unittest.TestCase):
    def test_minimal_valid_submission_creates_exactly_one_task(self):
        post_slack_message, notion_post, _ = submit(task_name="  Send the article  ")

        writes = task_writes(notion_post)
        self.assertEqual(len(writes), 1)
        self.assertEqual(
            writes[0].kwargs["json"],
            {
                "parent": {"data_source_id": "tasks-id"},
                "properties": {
                    "Navn": {
                        "title": [{"type": "text", "text": {"content": "Send the article"}}]
                    },
                    "People": {"relation": [{"id": "person-page-id"}]},
                    "Status": {"status": {"name": "Ikke startet"}},
                    "Created": {"date": {"start": "2026-09-26"}},
                },
            },
        )
        post_slack_message.assert_called_once_with(
            "Follow-up task added for Jane Doe: Send the article", thread_ts="100.001"
        )

    def test_full_submission_writes_track_priority_and_follow_up(self):
        notion_post = Mock(
            side_effect=[tracks_response(("t1", "AI Network")), Mock()]
        )

        _, notion_post, _ = submit(
            follow_up="2026-10-01",
            priority="High",
            track_id="t1",
            notion_post=notion_post,
        )

        properties = task_writes(notion_post)[0].kwargs["json"]["properties"]
        self.assertEqual(properties["Track"], {"relation": [{"id": "t1"}]})
        self.assertEqual(properties["Priority"], {"select": {"name": "High"}})
        self.assertEqual(properties["Follow-up"], {"date": {"start": "2026-10-01"}})
        self.assertNotIn("Description", properties)

    def test_missing_person_writes_nothing_and_says_nothing(self):
        post_slack_message, notion_post, notion_get = submit(person_page_id="")

        post_slack_message.assert_not_called()
        notion_post.assert_not_called()
        notion_get.assert_not_called()

    def test_invalid_input_is_rejected_before_any_notion_call(self):
        for name, kwargs in (
            ("blank name", {"task_name": "   "}),
            ("invalid follow-up", {"follow_up": "next tuesday"}),
        ):
            with self.subTest(name):
                post_slack_message, notion_post, notion_get = submit(**kwargs)

                post_slack_message.assert_called_once_with(
                    FOLLOWUP_TASK_INVALID_MESSAGE, thread_ts="100.001"
                )
                notion_post.assert_not_called()
                notion_get.assert_not_called()

    def test_unknown_priority_is_rejected_without_a_write(self):
        post_slack_message, notion_post, _ = submit(priority="Urgent")

        post_slack_message.assert_called_once_with(
            FOLLOWUP_TASK_INVALID_MESSAGE, thread_ts="100.001"
        )
        self.assertEqual(task_writes(notion_post), [])

    def test_tampered_track_is_rejected_without_a_write(self):
        notion_post = Mock(return_value=tracks_response(("t1", "AI Network")))

        post_slack_message, notion_post, _ = submit(
            track_id="not-a-track", notion_post=notion_post
        )

        post_slack_message.assert_called_once_with(
            FOLLOWUP_TASK_INVALID_MESSAGE, thread_ts="100.001"
        )
        self.assertEqual(task_writes(notion_post), [])

    def test_missing_ikke_started_status_writes_nothing_and_reports(self):
        post_slack_message, notion_post, _ = submit(
            notion_get=Mock(
                return_value=tasks_schema_response(
                    status_options=[{"name": "I gang"}, {"name": "Færdig"}]
                )
            )
        )

        post_slack_message.assert_called_once_with(
            FOLLOWUP_TASK_STATUS_MISSING_MESSAGE, thread_ts="100.001"
        )
        notion_post.assert_not_called()

    def test_malformed_schema_is_a_failure_without_a_write(self):
        malformed = Mock()
        malformed.json.return_value = {"properties": {"Navn": {"type": "title"}}}

        post_slack_message, notion_post, _ = submit(notion_get=Mock(return_value=malformed))

        post_slack_message.assert_called_once_with(
            FOLLOWUP_TASK_FAILURE_MESSAGE, thread_ts="100.001"
        )
        notion_post.assert_not_called()

    def test_notion_write_failure_returns_a_concise_error(self):
        for status_code in (400, 401):
            with self.subTest(status_code):
                post_slack_message, notion_post, _ = submit(
                    notion_post=Mock(return_value=http_error(status_code))
                )

                self.assertEqual(len(task_writes(notion_post)), 1)
                post_slack_message.assert_called_once_with(
                    FOLLOWUP_TASK_FAILURE_MESSAGE, thread_ts="100.001"
                )

    def test_ambiguous_write_failures_are_not_retried(self):
        # The page may already exist after a timeout or 5xx; a retry could
        # create a duplicate Task.
        timeout_response = Mock()
        timeout_response.raise_for_status.side_effect = requests.exceptions.Timeout()
        for name, response in (("timeout", timeout_response), ("503", http_error(503))):
            with self.subTest(name):
                post_slack_message, notion_post, _ = submit(
                    notion_post=Mock(return_value=response)
                )

                self.assertEqual(len(task_writes(notion_post)), 1)
                post_slack_message.assert_called_once_with(
                    FOLLOWUP_TASK_UNCERTAIN_MESSAGE, thread_ts="100.001"
                )

    def test_rate_limited_write_is_retried(self):
        notion_post = Mock(side_effect=[http_error(429), Mock()])

        post_slack_message, notion_post, _ = submit(notion_post=notion_post)

        self.assertEqual(len(task_writes(notion_post)), 2)
        post_slack_message.assert_called_once_with(
            "Follow-up task added for Jane Doe: Send the article", thread_ts="100.001"
        )

    def test_description_is_trimmed_and_written_as_rich_text(self):
        _, notion_post, _ = submit(description="  Link: example.test\nThanks  ")

        properties = task_writes(notion_post)[0].kwargs["json"]["properties"]
        self.assertEqual(
            properties["Description"],
            {
                "rich_text": [
                    {"type": "text", "text": {"content": "Link: example.test\nThanks"}}
                ]
            },
        )

    def test_blank_or_whitespace_description_leaves_description_unset(self):
        for description in ("", "   \n  "):
            with self.subTest(repr(description)):
                _, notion_post, _ = submit(description=description)

                properties = task_writes(notion_post)[0].kwargs["json"]["properties"]
                self.assertNotIn("Description", properties)

    def test_missing_or_non_text_description_property_still_creates_the_task(self):
        for name, definition in (("missing", None), ("wrong type", {"type": "select"})):
            with self.subTest(name):
                schema = tasks_schema_response()
                properties = schema.json.return_value["properties"]
                if definition is None:
                    del properties["Description"]
                else:
                    properties["Description"] = definition

                post_slack_message, notion_post, _ = submit(
                    description="Some context",
                    notion_get=Mock(return_value=schema),
                )

                writes = task_writes(notion_post)
                self.assertEqual(len(writes), 1)
                self.assertNotIn("Description", writes[0].kwargs["json"]["properties"])
                post_slack_message.assert_called_once_with(
                    "Follow-up task added for Jane Doe: Send the article",
                    thread_ts="100.001",
                )

    def test_unconfigured_tasks_data_source_fails_without_notion_calls(self):
        post_slack_message, notion_post, notion_get = submit(
            environment={**ENVIRONMENT, "NOTION_TASKS_DATA_SOURCE_ID": ""}
        )

        post_slack_message.assert_called_once_with(
            FOLLOWUP_TASK_FAILURE_MESSAGE, thread_ts="100.001"
        )
        notion_post.assert_not_called()
        notion_get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
