import json
import os
import runpy
import sys
import types
import unittest
from unittest.mock import Mock, patch


class MainRoutingTests(unittest.TestCase):
    def test_authorized_root_dm_replies_under_event_timestamp_without_private_processing(self):
        requests_module, google_module, genai_module = self.fake_modules()
        private_message = "private root message"
        environment = {
            "SLACK_TEXT": private_message,
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "U-authorized",
            "SLACK_EVENT_TS": "100.001",
            "SLACK_THREAD_TS": "",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_EVENT_TYPE": "message",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print") as print_mock,
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        requests_module.post.assert_called_once_with(
            "https://slack.com/api/chat.postMessage",
            headers={
                "Authorization": "Bearer test-slack-token",
                "Content-Type": "application/json",
            },
            json={
                "channel": "D-private",
                "text": "DM conversation received.",
                "mrkdwn": True,
                "thread_ts": "100.001",
            },
            timeout=10,
        )
        requests_module.get.assert_not_called()
        genai_module.Client.assert_not_called()
        logged_text = " ".join(
            str(argument)
            for call in print_mock.call_args_list
            for argument in call.args
        )
        self.assertNotIn(private_message, logged_text)

    def test_authorized_dm_follow_up_preserves_existing_thread_timestamp(self):
        requests_module, google_module, genai_module = self.fake_modules()
        environment = {
            "SLACK_TEXT": "private follow-up",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "U-authorized",
            "SLACK_EVENT_TS": "100.002",
            "SLACK_THREAD_TS": "100.001",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_EVENT_TYPE": "message",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        self.assertEqual(
            requests_module.post.call_args.kwargs["json"]["thread_ts"],
            "100.001",
        )
        requests_module.get.assert_not_called()
        genai_module.Client.assert_not_called()

    def test_unauthorized_dm_uses_exact_user_id_comparison_and_stops_before_private_processing(self):
        requests_module, google_module, genai_module = self.fake_modules()
        environment = {
            "SLACK_COMMAND": "/people",
            "SLACK_TEXT": "due",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "u-authorized",
            "SLACK_EVENT_TS": "100.001",
            "SLACK_THREAD_TS": "",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_EVENT_TYPE": "message",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "NOTION_API_KEY": "must-not-be-used",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "must-not-be-used",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "must-not-be-used",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        requests_module.post.assert_not_called()
        requests_module.get.assert_not_called()
        genai_module.Client.assert_not_called()

    def test_unauthorized_dm_commands_stop_before_private_processing(self):
        for command, text in (("/tasks", "list"), ("/people", "due")):
            with self.subTest(command=command):
                requests_module, google_module, genai_module = self.fake_modules()
                environment = {
                    "SLACK_COMMAND": command,
                    "SLACK_TEXT": text,
                    "SLACK_CHANNEL_ID": "D-private",
                    "SLACK_USER_ID": "U-other",
                    "SLACK_USER_NAME": "U-authorized",
                    "SLACK_CHANNEL_TYPE": "im",
                    "SLACK_EVENT_TYPE": "slash_command",
                    "SLACK_BOT_TOKEN": "test-slack-token",
                    "AUTHORIZED_SLACK_USER_ID": "U-authorized",
                    "TASKS_SLACK_CHANNEL_ID": "C-allowed",
                    "NOTION_API_KEY": "must-not-be-used",
                    "NOTION_TASKS_DATA_SOURCE_ID": "must-not-be-used",
                    "NOTION_PEOPLE_DATA_SOURCE_ID": "must-not-be-used",
                    "NOTION_INTERACTIONS_DATA_SOURCE_ID": "must-not-be-used",
                }

                with (
                    patch.dict(os.environ, environment, clear=True),
                    patch.dict(
                        sys.modules,
                        {
                            "requests": requests_module,
                            "google": google_module,
                            "google.genai": genai_module,
                        },
                    ),
                    patch("builtins.print"),
                    self.assertRaises(SystemExit) as exit_context,
                ):
                    runpy.run_module("main", run_name="__main__")

                self.assertEqual(exit_context.exception.code, 0)
                requests_module.post.assert_not_called()
                requests_module.get.assert_not_called()
                genai_module.Client.assert_not_called()

    def test_unauthorized_add_interaction_submission_stops_before_notion(self):
        requests_module, google_module, genai_module = self.fake_modules()
        environment = {
            "SLACK_EVENT_TYPE": "view_submission",
            "SLACK_TEXT": "",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "U-other",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "SLACK_PERSON": json.dumps({"page_id": "person-page-id", "name": "Jane Doe"}),
            "SLACK_INTERACTION_TYPE": "Coffee",
            "SLACK_INTERACTION_NOTES": "Notes",
            "SLACK_INTERACTION_DATE": "2026-09-22",
            "NOTION_API_KEY": "must-not-be-used",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "must-not-be-used",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        requests_module.post.assert_not_called()
        requests_module.get.assert_not_called()
        genai_module.Client.assert_not_called()

    def test_authorized_add_interaction_submission_writes_the_interaction_without_gemini(self):
        requests_module, google_module, genai_module = self.fake_modules()
        schema_response = Mock()
        schema_response.json.return_value = {
            "properties": {
                "Title of interaction": {"type": "title"},
                "Type": {
                    "type": "select",
                    "select": {"options": [{"name": "Coffee"}]},
                },
            }
        }
        requests_module.get.return_value = schema_response
        create_response = Mock()
        create_response.json.return_value = {"id": "new-interaction-id"}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [create_response, reply_response]

        environment = {
            "SLACK_EVENT_TYPE": "view_submission",
            "SLACK_TEXT": "",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "U-authorized",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "SLACK_PERSON": json.dumps({"page_id": "person-page-id", "name": "Jane Doe"}),
            "SLACK_INTERACTION_TYPE": "Coffee",
            "SLACK_INTERACTION_NOTES": "Caught up over coffee.",
            "SLACK_INTERACTION_DATE": "2026-09-22",
            "NOTION_API_KEY": "test-notion-token",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        genai_module.Client.assert_not_called()
        create_call = requests_module.post.call_args_list[0]
        self.assertEqual(create_call.args[0], "https://api.notion.com/v1/pages")
        properties = create_call.kwargs["json"]["properties"]
        self.assertEqual(
            properties["People"], {"relation": [{"id": "person-page-id"}]}
        )
        self.assertEqual(properties["Track"], {"relation": []})
        reply_text = requests_module.post.call_args_list[-1].kwargs["json"]["text"]
        self.assertEqual(reply_text, "Interaction added for Jane Doe.")

    def run_main(self, environment, requests_module, google_module, genai_module):
        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")
        self.assertEqual(exit_context.exception.code, 0)

    @staticmethod
    def tasks_schema_response():
        response = Mock()
        response.json.return_value = {
            "properties": {
                "Navn": {"id": "title", "type": "title"},
                "Priority": {
                    "type": "select",
                    "select": {"options": [{"name": "High"}, {"name": "Low"}]},
                },
                "Status": {
                    "type": "status",
                    "status": {"options": [{"name": "Ikke startet"}]},
                },
                "Description": {"type": "rich_text"},
            }
        }
        return response

    def followup_task_environment(self, user_id="U-authorized"):
        return {
            "SLACK_EVENT_TYPE": "view_submission",
            "SLACK_VIEW_CALLBACK_ID": "add_followup_task_modal",
            "SLACK_TEXT": "",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": user_id,
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_THREAD_TS": "100.001",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "SLACK_PERSON": json.dumps({"page_id": "person-page-id", "name": "Jane Doe"}),
            "SLACK_TASK": json.dumps(
                {
                    "name": "Send the article",
                    "description": "Include the Q3 figures.",
                    "follow_up": "2026-10-01",
                    "priority": "High",
                    "track_id": "",
                }
            ),
            "NOTION_API_KEY": "test-notion-token",
            "NOTION_TASKS_DATA_SOURCE_ID": "tasks-id",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }

    def test_unauthorized_followup_task_submission_stops_before_notion(self):
        requests_module, google_module, genai_module = self.fake_modules()

        self.run_main(
            self.followup_task_environment(user_id="U-other"),
            requests_module,
            google_module,
            genai_module,
        )

        requests_module.post.assert_not_called()
        requests_module.get.assert_not_called()

    def test_authorized_followup_task_submission_writes_one_task_without_gemini(self):
        requests_module, google_module, genai_module = self.fake_modules()
        requests_module.get.return_value = self.tasks_schema_response()
        create_response = Mock()
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [create_response, reply_response]

        self.run_main(
            self.followup_task_environment(),
            requests_module,
            google_module,
            genai_module,
        )

        genai_module.Client.assert_not_called()
        self.assertEqual(
            [call.args[0] for call in requests_module.post.call_args_list],
            ["https://api.notion.com/v1/pages", "https://slack.com/api/chat.postMessage"],
        )
        create_json = requests_module.post.call_args_list[0].kwargs["json"]
        self.assertEqual(create_json["parent"], {"data_source_id": "tasks-id"})
        properties = create_json["properties"]
        self.assertEqual(properties["People"], {"relation": [{"id": "person-page-id"}]})
        self.assertEqual(properties["Status"], {"status": {"name": "Ikke startet"}})
        self.assertEqual(properties["Priority"], {"select": {"name": "High"}})
        self.assertEqual(
            properties["Description"],
            {
                "rich_text": [
                    {"type": "text", "text": {"content": "Include the Q3 figures."}}
                ]
            },
        )
        reply_json = requests_module.post.call_args_list[-1].kwargs["json"]
        self.assertEqual(reply_json["text"], "Follow-up task added for Jane Doe: Send the article")
        self.assertEqual(reply_json["thread_ts"], "100.001")

    def test_interaction_confirmation_offers_the_followup_task_button(self):
        requests_module, google_module, genai_module = self.fake_modules()
        interactions_schema = Mock()
        interactions_schema.json.return_value = {
            "properties": {
                "Title of interaction": {"type": "title"},
                "Type": {"type": "select", "select": {"options": [{"name": "Coffee"}]}},
            }
        }
        requests_module.get.side_effect = [
            interactions_schema,
            interactions_schema,
            self.tasks_schema_response(),
        ]
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [Mock(), reply_response]
        environment = {
            **self.followup_task_environment(),
            "SLACK_VIEW_CALLBACK_ID": "",
            "SLACK_TASK": "",
            "SLACK_INTERACTION_TYPE": "Coffee",
            "SLACK_INTERACTION_DATE": "2026-09-22",
        }

        self.run_main(environment, requests_module, google_module, genai_module)

        reply_json = requests_module.post.call_args_list[-1].kwargs["json"]
        self.assertEqual(reply_json["text"], "Interaction added for Jane Doe.")
        button = reply_json["blocks"][-1]["elements"][0]
        self.assertEqual(button["action_id"], "add_followup_task")
        self.assertEqual(
            json.loads(button["value"]),
            {
                "page_id": "person-page-id",
                "name": "Jane Doe",
                "priorities": ["High", "Low"],
            },
        )

    def test_interaction_notes_with_a_commitment_offer_a_suggested_task_button(self):
        requests_module, google_module, genai_module = self.fake_modules()
        interactions_schema = Mock()
        interactions_schema.json.return_value = {
            "properties": {
                "Title of interaction": {"type": "title"},
                "Type": {"type": "select", "select": {"options": [{"name": "Coffee"}]}},
            }
        }
        requests_module.get.side_effect = [
            interactions_schema,
            interactions_schema,
            self.tasks_schema_response(),
        ]
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [Mock(), reply_response]
        client = Mock()
        client.interactions.create.return_value = Mock(
            output_text='{"task": {"name": "Send the AI article"}}'
        )
        genai_module.Client = Mock(return_value=client)
        environment = {
            **self.followup_task_environment(),
            "SLACK_VIEW_CALLBACK_ID": "",
            "SLACK_TASK": "",
            "SLACK_INTERACTION_TYPE": "Coffee",
            "SLACK_INTERACTION_NOTES": "Agreed to send the AI article.",
            "SLACK_INTERACTION_DATE": "2026-09-22",
        }

        self.run_main(environment, requests_module, google_module, genai_module)

        client.interactions.create.assert_called_once()
        self.assertEqual(
            [call.args[0] for call in requests_module.post.call_args_list],
            ["https://api.notion.com/v1/pages", "https://slack.com/api/chat.postMessage"],
        )
        reply_json = requests_module.post.call_args_list[-1].kwargs["json"]
        self.assertEqual(reply_json["text"], "Interaction added for Jane Doe.")
        existing, suggested = reply_json["blocks"][-1]["elements"]
        self.assertEqual(existing["action_id"], "add_followup_task")
        self.assertEqual(suggested["action_id"], "add_suggested_followup_task")
        self.assertEqual(suggested["text"]["text"], "Add task: Send the AI article")
        self.assertEqual(json.loads(suggested["value"])["task_name"], "Send the AI article")

    def test_interaction_notes_without_a_tasks_data_source_make_no_gemini_call(self):
        requests_module, google_module, genai_module = self.fake_modules()
        interactions_schema = Mock()
        interactions_schema.json.return_value = {
            "properties": {
                "Title of interaction": {"type": "title"},
                "Type": {"type": "select", "select": {"options": [{"name": "Coffee"}]}},
            }
        }
        requests_module.get.return_value = interactions_schema
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [Mock(), reply_response]
        genai_module.Client = Mock()
        environment = {
            **self.followup_task_environment(),
            "SLACK_VIEW_CALLBACK_ID": "",
            "SLACK_TASK": "",
            "SLACK_INTERACTION_TYPE": "Coffee",
            "SLACK_INTERACTION_NOTES": "Agreed to send the AI article.",
            "SLACK_INTERACTION_DATE": "2026-09-22",
            "NOTION_TASKS_DATA_SOURCE_ID": "",
        }

        self.run_main(environment, requests_module, google_module, genai_module)

        genai_module.Client.assert_not_called()
        reply_json = requests_module.post.call_args_list[-1].kwargs["json"]
        self.assertEqual(reply_json["text"], "Interaction added for Jane Doe.")
        self.assertNotIn("blocks", reply_json)

    def test_authorized_add_interaction_submission_writes_a_selected_track(self):
        requests_module, google_module, genai_module = self.fake_modules()
        schema_response = Mock()
        schema_response.json.return_value = {
            "properties": {
                "Title of interaction": {"type": "title"},
                "Type": {
                    "type": "select",
                    "select": {"options": [{"name": "Coffee"}]},
                },
            }
        }
        requests_module.get.return_value = schema_response
        tracks_response = Mock()
        tracks_response.json.return_value = {
            "results": [
                {
                    "id": "track-1",
                    "properties": {
                        "Navn": {
                            "type": "title",
                            "title": [{"plain_text": "AI Network"}],
                        }
                    },
                }
            ],
            "has_more": False,
        }
        create_response = Mock()
        create_response.json.return_value = {"id": "new-interaction-id"}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [
            tracks_response,
            create_response,
            reply_response,
        ]

        environment = {
            "SLACK_EVENT_TYPE": "view_submission",
            "SLACK_TEXT": "",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "U-authorized",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "SLACK_PERSON": json.dumps({"page_id": "person-page-id", "name": "Jane Doe"}),
            "SLACK_INTERACTION_TYPE": "Coffee",
            "SLACK_INTERACTION_NOTES": "Caught up over coffee.",
            "SLACK_INTERACTION_DATE": "2026-09-22",
            "SLACK_INTERACTION_TRACK_ID": "track-1",
            "NOTION_API_KEY": "test-notion-token",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
            "NOTION_TRACKS_DATA_SOURCE_ID": "tracks-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        create_call = requests_module.post.call_args_list[1]
        self.assertEqual(create_call.args[0], "https://api.notion.com/v1/pages")
        properties = create_call.kwargs["json"]["properties"]
        self.assertEqual(properties["Track"], {"relation": [{"id": "track-1"}]})

    def test_authorized_add_interaction_submission_rejects_a_track_not_among_live_tracks(self):
        requests_module, google_module, genai_module = self.fake_modules()
        type_schema_response = Mock()
        type_schema_response.json.return_value = {
            "properties": {
                "Type": {"type": "select", "select": {"options": [{"name": "Coffee"}]}}
            }
        }
        requests_module.get.return_value = type_schema_response
        tracks_response = Mock()
        tracks_response.json.return_value = {"results": [], "has_more": False}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [tracks_response, reply_response]

        environment = {
            "SLACK_EVENT_TYPE": "view_submission",
            "SLACK_TEXT": "",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "U-authorized",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "SLACK_PERSON": json.dumps({"page_id": "person-page-id", "name": "Jane Doe"}),
            "SLACK_INTERACTION_TYPE": "Coffee",
            "SLACK_INTERACTION_NOTES": "Notes",
            "SLACK_INTERACTION_DATE": "2026-09-22",
            "SLACK_INTERACTION_TRACK_ID": "forged-track-id",
            "NOTION_API_KEY": "test-notion-token",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
            "NOTION_TRACKS_DATA_SOURCE_ID": "tracks-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        # The Type-schema GET ran (Type validation), but the title-property
        # GET never did - Track rejection happens first among the two
        # notion_post-based checks/writes, none of which ran either besides
        # the Track validation query itself.
        requests_module.get.assert_called_once()
        genai_module.Client.assert_not_called()
        reply_text = requests_module.post.call_args_list[-1].kwargs["json"]["text"]
        self.assertEqual(reply_text, "Unable to add that interaction. Please try again.")

    def test_add_interaction_invalid_type_is_rejected_before_notion(self):
        # "Before Notion" now means before any Notion *write*: rejecting an
        # unknown Type still requires reading the live Type schema (issue
        # #17), since Notion - not a hardcoded list - is the hard guardrail.
        requests_module, google_module, genai_module = self.fake_modules()
        type_schema_response = Mock()
        type_schema_response.json.return_value = {
            "properties": {
                "Type": {"type": "select", "select": {"options": [{"name": "Coffee"}]}}
            }
        }
        requests_module.get.return_value = type_schema_response
        environment = {
            "SLACK_EVENT_TYPE": "view_submission",
            "SLACK_TEXT": "",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "U-authorized",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "SLACK_PERSON": json.dumps({"page_id": "person-page-id", "name": "Jane Doe"}),
            "SLACK_INTERACTION_TYPE": "Linkedon",
            "SLACK_INTERACTION_NOTES": "Notes",
            "SLACK_INTERACTION_DATE": "2026-09-22",
            "NOTION_API_KEY": "test-notion-token",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.return_value = reply_response

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        # Only the Type-schema GET happened; the Interaction was never
        # written (no POST to /v1/pages).
        requests_module.get.assert_called_once()
        genai_module.Client.assert_not_called()
        requests_module.post.assert_called_once()
        reply_text = requests_module.post.call_args.kwargs["json"]["text"]
        self.assertEqual(reply_text, "Unable to add that interaction. Please try again.")

    def test_people_from_another_channel_is_rejected_before_notion(self):
        requests_module, google_module, genai_module = self.fake_modules()
        environment = {
            "SLACK_COMMAND": "/people",
            "SLACK_TEXT": "due",
            "SLACK_CHANNEL_ID": "C-other",
            "SLACK_USER_ID": "U-authorized",
            "SLACK_CHANNEL_TYPE": "channel",
            "SLACK_EVENT_TYPE": "slash_command",
            "SLACK_RESPONSE_URL": "https://hooks.slack.test/response",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "NOTION_API_KEY": "must-not-be-used",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "must-not-be-used",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "must-not-be-used",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        requests_module.post.assert_called_once_with(
            "https://hooks.slack.test/response",
            json={
                "response_type": "ephemeral",
                "text": "The /people command is not available in this channel.",
            },
            timeout=10,
        )
        requests_module.get.assert_not_called()
        genai_module.Client.assert_not_called()

    def test_people_due_exits_before_gemini_and_only_queries_notion(self):
        requests_module, google_module, genai_module = self.fake_modules()
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        people_response = Mock()
        people_response.json.return_value = {
            "results": [
                {
                    "id": "person-id",
                    "properties": {
                        "Name": {
                            "type": "title",
                            "title": [{"plain_text": "Known person"}],
                        },
                        "Contact cadence": {
                            "type": "select",
                            "select": {"name": "1 month"},
                        },
                    },
                }
            ]
        }
        interactions_response = Mock()
        interactions_response.json.return_value = {"results": []}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [
            root_response,
            people_response,
            interactions_response,
            reply_response,
        ]
        environment = {
            "SLACK_COMMAND": "/people",
            "SLACK_TEXT": "due",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "U-authorized",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "NOTION_API_KEY": "test-notion-token",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "people-id",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print") as print_mock,
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        genai_module.Client.assert_not_called()
        requests_module.get.assert_not_called()
        notion_calls = requests_module.post.call_args_list[1:3]
        self.assertEqual(
            [call.args[0] for call in notion_calls],
            [
                "https://api.notion.com/v1/data_sources/people-id/query",
                "https://api.notion.com/v1/data_sources/interactions-id/query",
            ],
        )
        self.assertTrue(all(call.args[0].endswith("/query") for call in notion_calls))
        logged_text = " ".join(
            str(argument)
            for call in print_mock.call_args_list
            for argument in call.args
        )
        self.assertNotIn("Known person", logged_text)

    def test_people_due_reply_includes_a_suggest_button_per_person(self):
        requests_module, google_module, genai_module = self.fake_modules()
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        people_response = Mock()
        people_response.json.return_value = {
            "results": [
                {
                    "id": "person-id",
                    "properties": {
                        "Name": {
                            "type": "title",
                            "title": [{"plain_text": "Known person"}],
                        },
                        "Contact cadence": {
                            "type": "select",
                            "select": {"name": "1 month"},
                        },
                    },
                }
            ]
        }
        interactions_response = Mock()
        interactions_response.json.return_value = {"results": []}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [
            root_response,
            people_response,
            interactions_response,
            reply_response,
        ]
        environment = {
            "SLACK_COMMAND": "/people",
            "SLACK_TEXT": "due",
            "SLACK_CHANNEL_ID": "C-channel",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "TASKS_SLACK_CHANNEL_ID": "C-channel",
            "NOTION_API_KEY": "test-notion-token",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "people-id",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        reply_payload = requests_module.post.call_args_list[-1].kwargs["json"]
        blocks = reply_payload["blocks"]
        self.assertEqual(len(blocks), 1)
        self.assertEqual(
            blocks[0]["accessory"],
            {
                "type": "button",
                "text": {"type": "plain_text", "text": "Suggest message"},
                "action_id": "people_suggest",
                "value": "Known person",
            },
        )

    def test_people_suggest_reaches_gemini_with_bounded_context_only(self):
        requests_module, google_module, genai_module = self.fake_modules()
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        people_response = Mock()
        people_response.json.return_value = {
            "results": [
                {
                    "id": "person-id",
                    "properties": {
                        "Name": {
                            "type": "title",
                            "title": [{"plain_text": "Jane Doe"}],
                        },
                        "Why this person": {
                            "type": "rich_text",
                            "rich_text": [{"plain_text": "Former colleague"}],
                        },
                        "Contact cadence": {
                            "type": "select",
                            "select": {"name": "3 months"},
                        },
                    },
                }
            ]
        }
        interactions_response = Mock()
        interactions_response.json.return_value = {"results": []}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [
            root_response,
            people_response,
            interactions_response,
            reply_response,
        ]
        type_schema_response = Mock()
        type_schema_response.json.return_value = {
            "properties": {
                "Type": {"type": "select", "select": {"options": [{"name": "Coffee"}]}}
            }
        }
        requests_module.get.return_value = type_schema_response

        client = Mock()
        client.interactions.create.return_value.output_text = "Hey Jane!"
        genai_module.Client.side_effect = None
        genai_module.Client.return_value = client

        environment = {
            "SLACK_COMMAND": "/people",
            "SLACK_TEXT": "suggest Jane Doe",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "U-authorized",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "NOTION_API_KEY": "test-notion-token",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "people-id",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        # The only GET is the Add Interaction button's Type-schema fetch.
        requests_module.get.assert_called_once()
        # One Gemini call drafts the recap, another drafts the reconnect
        # message; each currently creates its own Client, as before.
        self.assertEqual(genai_module.Client.call_count, 2)
        self.assertEqual(client.interactions.create.call_count, 2)
        for call in client.interactions.create.call_args_list:
            prompt = call.kwargs["input"]
            self.assertIn("Name: Jane Doe", prompt)
            self.assertIn("Why this person: Former colleague", prompt)
            self.assertNotIn("3 months", prompt)
        reply_text = requests_module.post.call_args_list[-1].kwargs["json"]["text"]
        self.assertEqual(
            reply_text,
            "Context:\nHey Jane!\n\nSuggested message for Jane Doe:\n\nHey Jane!",
        )

    def test_people_suggest_transient_gemini_failure_replies_safely_in_thread(self):
        requests_module, google_module, genai_module = self.fake_modules()
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        people_response = Mock()
        people_response.json.return_value = {
            "results": [
                {
                    "id": "person-id",
                    "properties": {
                        "Name": {
                            "type": "title",
                            "title": [{"plain_text": "Jane Doe"}],
                        },
                    },
                }
            ]
        }
        interactions_response = Mock()
        interactions_response.json.return_value = {"results": []}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [
            root_response,
            people_response,
            interactions_response,
            reply_response,
        ]
        type_schema_response = Mock()
        type_schema_response.json.return_value = {
            "properties": {
                "Type": {"type": "select", "select": {"options": [{"name": "Coffee"}]}}
            }
        }
        requests_module.get.return_value = type_schema_response

        client = Mock()
        transient_error = Exception("rate limited payload leak marker XYZ123")
        transient_error.response = Mock(status_code=429)
        client.interactions.create.side_effect = transient_error
        genai_module.Client.side_effect = None
        genai_module.Client.return_value = client

        environment = {
            "SLACK_COMMAND": "/people",
            "SLACK_TEXT": "suggest Jane Doe",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "U-authorized",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "NOTION_API_KEY": "test-notion-token",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "people-id",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        self.assertEqual(client.interactions.create.call_count, 1)
        reply_payload = requests_module.post.call_args_list[-1].kwargs["json"]
        self.assertEqual(
            reply_payload["text"],
            "Gemini is currently experiencing high demand. Please try again shortly.",
        )
        self.assertEqual(reply_payload["thread_ts"], "123.456")
        self.assertNotIn("XYZ123", reply_payload["text"])

    def test_people_suggest_unrelated_gemini_failure_still_crashes(self):
        requests_module, google_module, genai_module = self.fake_modules()
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        people_response = Mock()
        people_response.json.return_value = {
            "results": [
                {
                    "id": "person-id",
                    "properties": {
                        "Name": {
                            "type": "title",
                            "title": [{"plain_text": "Jane Doe"}],
                        },
                    },
                }
            ]
        }
        interactions_response = Mock()
        interactions_response.json.return_value = {"results": []}
        requests_module.post.side_effect = [
            root_response,
            people_response,
            interactions_response,
        ]
        type_schema_response = Mock()
        type_schema_response.json.return_value = {
            "properties": {
                "Type": {"type": "select", "select": {"options": [{"name": "Coffee"}]}}
            }
        }
        requests_module.get.return_value = type_schema_response

        client = Mock()
        unrelated_error = Exception("unexpected malformed response")
        unrelated_error.response = Mock(status_code=400)
        client.interactions.create.side_effect = unrelated_error
        genai_module.Client.side_effect = None
        genai_module.Client.return_value = client

        environment = {
            "SLACK_COMMAND": "/people",
            "SLACK_TEXT": "suggest Jane Doe",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "U-authorized",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "NOTION_API_KEY": "test-notion-token",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "people-id",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaisesRegex(Exception, "unexpected malformed response"),
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(requests_module.post.call_count, 3)

    def test_authorized_normalized_tasks_list_exits_before_gemini(self):
        requests_module, google_module, genai_module = self.fake_modules()

        notion_response = Mock()
        notion_response.json.return_value = {
            "results": [
                {
                    "url": "https://www.notion.so/example-task",
                    "properties": {
                        "Navn": {
                            "id": "title",
                            "type": "title",
                            "title": [{"plain_text": "Known staging task"}],
                        },
                        "Status": {
                            "type": "status",
                            "status": {"name": "Ikke startet"},
                        },
                    },
                }
            ]
        }
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [
            root_response,
            notion_response,
            reply_response,
        ]

        environment = {
            "SLACK_COMMAND": "/tasks",
            "SLACK_TEXT": "  LIST  ",
            "SLACK_CHANNEL_ID": "C-allowed",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "NOTION_API_KEY": "secret-token",
            "NOTION_TASKS_DATA_SOURCE_ID": "data-source-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        genai_module.Client.assert_not_called()
        requests_module.get.assert_not_called()
        self.assertEqual(
            [call.args[0] for call in requests_module.post.call_args_list],
            [
                "https://slack.com/api/chat.postMessage",
                "https://api.notion.com/v1/data_sources/data-source-id/query",
                "https://slack.com/api/chat.postMessage",
            ],
        )

    def test_authorized_dm_tasks_list_reaches_existing_task_path(self):
        requests_module, google_module, genai_module = self.fake_modules()
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        notion_response = Mock()
        notion_response.json.return_value = {"results": []}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [
            root_response,
            notion_response,
            reply_response,
        ]
        environment = {
            "SLACK_COMMAND": "/tasks",
            "SLACK_TEXT": "list",
            "SLACK_CHANNEL_ID": "D-private",
            "SLACK_USER_ID": "U-authorized",
            "SLACK_CHANNEL_TYPE": "im",
            "SLACK_EVENT_TYPE": "slash_command",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "NOTION_API_KEY": "secret-token",
            "NOTION_TASKS_DATA_SOURCE_ID": "data-source-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        self.assertEqual(
            requests_module.post.call_args_list[1].args[0],
            "https://api.notion.com/v1/data_sources/data-source-id/query",
        )
        requests_module.get.assert_not_called()
        genai_module.Client.assert_not_called()

    def test_tasks_outcomes_exit_before_gemini(self):
        cases = (
            (
                "invalid",
                "unknown",
                "C-channel",
                {"TASKS_SLACK_CHANNEL_ID": "C-channel"},
            ),
            (
                "unauthorized",
                "list",
                "C-other",
                {"TASKS_SLACK_CHANNEL_ID": "C-allowed"},
            ),
        )

        for name, text, channel_id, task_environment in cases:
            with self.subTest(name=name):
                requests_module, google_module, genai_module = self.fake_modules()
                environment = {
                    "SLACK_COMMAND": "/tasks",
                    "SLACK_TEXT": text,
                    "SLACK_CHANNEL_ID": channel_id,
                    "SLACK_RESPONSE_URL": "https://hooks.slack.test/response",
                    "SLACK_BOT_TOKEN": "test-slack-token",
                    **task_environment,
                }

                with (
                    patch.dict(os.environ, environment, clear=True),
                    patch.dict(
                        sys.modules,
                        {
                            "requests": requests_module,
                            "google": google_module,
                            "google.genai": genai_module,
                        },
                    ),
                    patch("builtins.print"),
                    self.assertRaises(SystemExit) as exit_context,
                ):
                    runpy.run_module("main", run_name="__main__")

                self.assertEqual(exit_context.exception.code, 0)
                genai_module.Client.assert_not_called()
                requests_module.get.assert_not_called()
                requests_module.post.assert_called_once_with(
                    "https://hooks.slack.test/response",
                    json={
                        "response_type": "ephemeral",
                        "text": (
                            "Usage: /tasks list"
                            if name == "invalid"
                            else "The /tasks command is not available in this channel."
                        ),
                    },
                    timeout=10,
                )

    def test_task_list_thread_reply_exits_before_gemini(self):
        requests_module, google_module, genai_module = self.fake_modules()
        thread_response = Mock()
        thread_response.json.return_value = {
            "ok": True,
            "messages": [
                {"text": "/tasks list", "bot_id": "B-task-bot"},
                {"text": "Can you update this?"},
            ],
        }
        requests_module.get.return_value = thread_response

        environment = {
            "SLACK_TEXT": "Can you update this?",
            "SLACK_CHANNEL_ID": "C-allowed",
            "SLACK_THREAD_TS": "123.456",
            "SLACK_EVENT_TYPE": "message",
            "SLACK_BOT_TOKEN": "test-slack-token",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        genai_module.Client.assert_not_called()
        requests_module.post.assert_called_once_with(
            "https://slack.com/api/chat.postMessage",
            headers={
                "Authorization": "Bearer test-slack-token",
                "Content-Type": "application/json",
            },
            json={
                "channel": "C-allowed",
                "text": "Task-list follow-ups are not supported. Run /tasks list.",
                "mrkdwn": True,
                "thread_ts": "123.456",
            },
            timeout=10,
        )

    def test_testbot_still_reaches_gemini(self):
        requests_module, google_module, genai_module = self.fake_modules()
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [root_response, reply_response]

        thread_response = Mock()
        thread_response.json.return_value = {
            "ok": True,
            "messages": [{"text": "hello"}],
        }
        requests_module.get.return_value = thread_response

        client = Mock()
        client.interactions.create.return_value.output_text = "Gemini answer"
        genai_module.Client.side_effect = None
        genai_module.Client.return_value = client

        environment = {
            "SLACK_COMMAND": "/testbot",
            "SLACK_TEXT": "hello",
            "SLACK_CHANNEL_ID": "C-channel",
            "SLACK_BOT_TOKEN": "test-slack-token",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
        ):
            runpy.run_module("main", run_name="__main__")

        genai_module.Client.assert_called_once_with()
        client.interactions.create.assert_called_once()
        self.assertEqual(requests_module.post.call_count, 2)
        requests_module.get.assert_called_once()

    def test_testbot_transient_gemini_failure_replies_safely_in_thread(self):
        requests_module, google_module, genai_module = self.fake_modules()
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [root_response, reply_response]

        thread_response = Mock()
        thread_response.json.return_value = {
            "ok": True,
            "messages": [{"text": "hello"}],
        }
        requests_module.get.return_value = thread_response

        client = Mock()
        transient_error = Exception("internal provider payload leak marker XYZ123")
        transient_error.response = Mock(status_code=503)
        client.interactions.create.side_effect = transient_error
        genai_module.Client.side_effect = None
        genai_module.Client.return_value = client

        environment = {
            "SLACK_COMMAND": "/testbot",
            "SLACK_TEXT": "hello",
            "SLACK_CHANNEL_ID": "C-channel",
            "SLACK_BOT_TOKEN": "test-slack-token",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        self.assertEqual(requests_module.post.call_count, 2)
        reply_payload = requests_module.post.call_args_list[-1].kwargs["json"]
        self.assertEqual(
            reply_payload["text"],
            "Gemini is currently experiencing high demand. Please try again shortly.",
        )
        self.assertEqual(reply_payload["thread_ts"], "123.456")
        self.assertNotIn("XYZ123", reply_payload["text"])

    def test_testbot_unrelated_gemini_failure_still_crashes(self):
        requests_module, google_module, genai_module = self.fake_modules()
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        requests_module.post.return_value = root_response

        thread_response = Mock()
        thread_response.json.return_value = {
            "ok": True,
            "messages": [{"text": "hello"}],
        }
        requests_module.get.return_value = thread_response

        client = Mock()
        unrelated_error = Exception("unexpected malformed response")
        unrelated_error.response = Mock(status_code=400)
        client.interactions.create.side_effect = unrelated_error
        genai_module.Client.side_effect = None
        genai_module.Client.return_value = client

        environment = {
            "SLACK_COMMAND": "/testbot",
            "SLACK_TEXT": "hello",
            "SLACK_CHANNEL_ID": "C-channel",
            "SLACK_BOT_TOKEN": "test-slack-token",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaisesRegex(Exception, "unexpected malformed response"),
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(requests_module.post.call_count, 1)

    def test_task_data_and_credentials_are_not_logged(self):
        requests_module, google_module, genai_module = self.fake_modules()
        private_task_name = "Confidential acquisition task"
        secret_token = "notion-secret-must-not-be-logged"
        notion_response = Mock()
        notion_response.json.return_value = {
            "results": [
                {
                    "url": "https://www.notion.so/private-task",
                    "properties": {
                        "Navn": {
                            "id": "title",
                            "type": "title",
                            "title": [{"plain_text": private_task_name}],
                        },
                        "Status": {
                            "type": "status",
                            "status": {"name": "Ikke startet"},
                        },
                        "Description": {
                            "type": "rich_text",
                            "rich_text": [{"plain_text": "private description"}],
                        },
                    },
                }
            ]
        }
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [
            root_response,
            notion_response,
            reply_response,
        ]
        environment = {
            "SLACK_COMMAND": "/tasks",
            "SLACK_TEXT": "list",
            "SLACK_CHANNEL_ID": "C-allowed",
            "SLACK_BOT_TOKEN": "slack-secret-must-not-be-logged",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "NOTION_API_KEY": secret_token,
            "NOTION_TASKS_DATA_SOURCE_ID": "data-source-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print") as print_mock,
            self.assertRaises(SystemExit),
        ):
            runpy.run_module("main", run_name="__main__")

        logged_text = " ".join(
            " ".join(str(argument) for argument in call.args)
            for call in print_mock.call_args_list
        )
        self.assertNotIn(private_task_name, logged_text)
        self.assertNotIn("private description", logged_text)
        self.assertNotIn(secret_token, logged_text)
        self.assertNotIn(environment["SLACK_BOT_TOKEN"], logged_text)

    def test_slack_authentication_error_is_safe_and_provider_specific(self):
        requests_module, google_module, genai_module = self.fake_modules()
        slack_response = Mock()
        slack_response.json.return_value = {"ok": False, "error": "invalid_auth"}
        requests_module.post.return_value = slack_response
        environment = {
            "SLACK_COMMAND": "/testbot",
            "SLACK_TEXT": "hello",
            "SLACK_CHANNEL_ID": "C-channel",
            "SLACK_BOT_TOKEN": "slack-secret-must-not-be-logged",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(sys.modules, {
                "requests": requests_module,
                "google": google_module,
                "google.genai": genai_module,
            }),
            patch("builtins.print") as print_mock,
            self.assertRaisesRegex(
                RuntimeError, r"^Slack authentication failed \(invalid_auth\)\.$"
            ) as error_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertNotIn(environment["SLACK_BOT_TOKEN"], str(error_context.exception))
        self.assertIsNone(error_context.exception.__cause__)
        self.assertNotIn(
            environment["SLACK_BOT_TOKEN"],
            " ".join(str(argument) for call in print_mock.call_args_list for argument in call.args),
        )

    def test_ephemeral_slack_authentication_error_is_safe_and_provider_specific(self):
        for status_code in (401, 403):
            with self.subTest(status_code=status_code):
                requests_module, google_module, genai_module = self.fake_modules()
                response_url = "https://hooks.slack.test/signed-response-url"
                http_error = Exception(
                    f"{status_code} Client Error: Unauthorized for url: {response_url}"
                )
                http_error.response = Mock(status_code=status_code)
                response = Mock()
                response.raise_for_status.side_effect = http_error
                requests_module.post.return_value = response
                environment = {
                    "SLACK_COMMAND": "/tasks",
                    "SLACK_TEXT": "invalid",
                    "SLACK_CHANNEL_ID": "C-channel",
                    "SLACK_RESPONSE_URL": response_url,
                    "SLACK_BOT_TOKEN": "slack-secret-must-not-be-logged",
                }

                with (
                    patch.dict(os.environ, environment, clear=True),
                    patch.dict(sys.modules, {
                        "requests": requests_module,
                        "google": google_module,
                        "google.genai": genai_module,
                    }),
                    patch("builtins.print") as print_mock,
                    self.assertRaisesRegex(
                        RuntimeError,
                        rf"^Slack authentication failed \(HTTP {status_code}\)\.$",
                    ) as error_context,
                ):
                    runpy.run_module("main", run_name="__main__")

                self.assertIsNone(error_context.exception.__cause__)
                self.assertNotIn(response_url, str(error_context.exception))
                self.assertNotIn(
                    response_url,
                    " ".join(
                        str(argument)
                        for call in print_mock.call_args_list
                        for argument in call.args
                    ),
                )
                genai_module.Client.assert_not_called()

    def test_ephemeral_slack_failure_does_not_expose_signed_response_url(self):
        requests_module, google_module, genai_module = self.fake_modules()
        response_url = "https://hooks.slack.test/signed-response-url"
        http_error = Exception(
            f"404 Client Error: Not Found for url: {response_url}"
        )
        http_error.response = Mock(status_code=404)
        response = Mock()
        response.raise_for_status.side_effect = http_error
        requests_module.post.return_value = response
        environment = {
            "SLACK_COMMAND": "/tasks",
            "SLACK_TEXT": "invalid",
            "SLACK_CHANNEL_ID": "C-channel",
            "SLACK_RESPONSE_URL": response_url,
            "SLACK_BOT_TOKEN": "slack-secret-must-not-be-logged",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(sys.modules, {
                "requests": requests_module,
                "google": google_module,
                "google.genai": genai_module,
            }),
            patch("builtins.print") as print_mock,
            self.assertRaisesRegex(
                RuntimeError, r"^Slack response delivery failed\.$"
            ) as error_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertIsNone(error_context.exception.__cause__)
        self.assertNotIn(response_url, str(error_context.exception))
        self.assertNotIn(
            response_url,
            " ".join(
                str(argument)
                for call in print_mock.call_args_list
                for argument in call.args
            ),
        )
        genai_module.Client.assert_not_called()

    def test_gemini_authentication_error_is_safe_and_provider_specific(self):
        requests_module, google_module, genai_module = self.fake_modules()
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        requests_module.post.return_value = root_response
        thread_response = Mock()
        thread_response.json.return_value = {"ok": True, "messages": [{"text": "hello"}]}
        requests_module.get.return_value = thread_response
        gemini_error = Exception("credential rejected")
        gemini_error.code = 403
        genai_module.Client.side_effect = gemini_error
        environment = {
            "SLACK_COMMAND": "/testbot",
            "SLACK_TEXT": "hello",
            "SLACK_CHANNEL_ID": "C-channel",
            "SLACK_BOT_TOKEN": "test-slack-token",
            "GEMINI_API_KEY": "gemini-secret-must-not-be-logged",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(sys.modules, {
                "requests": requests_module,
                "google": google_module,
                "google.genai": genai_module,
            }),
            patch("builtins.print") as print_mock,
            self.assertRaisesRegex(
                RuntimeError, r"^Gemini authentication failed \(HTTP 403\)\.$"
            ) as error_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertNotIn(environment["GEMINI_API_KEY"], str(error_context.exception))
        self.assertIsNone(error_context.exception.__cause__)
        self.assertNotIn(
            environment["GEMINI_API_KEY"],
            " ".join(str(argument) for call in print_mock.call_args_list for argument in call.args),
        )

    @staticmethod
    def fake_modules():
        slack_response = Mock()
        slack_response.json.return_value = {"ok": True}

        requests_module = types.ModuleType("requests")
        requests_module.post = Mock(return_value=slack_response)
        requests_module.get = Mock()

        genai_module = types.ModuleType("google.genai")
        genai_module.Client = Mock(
            side_effect=AssertionError("Gemini must not be initialized")
        )
        google_module = types.ModuleType("google")
        google_module.genai = genai_module

        return requests_module, google_module, genai_module


if __name__ == "__main__":
    unittest.main()
