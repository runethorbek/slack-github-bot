import os
import runpy
import sys
import types
import unittest
from unittest.mock import Mock, patch


class MainRoutingTests(unittest.TestCase):
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
                        }
                    },
                }
            ]
        }
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = [
            notion_response,
            root_response,
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
                "https://api.notion.com/v1/data_sources/data-source-id/query",
                "https://slack.com/api/chat.postMessage",
                "https://slack.com/api/chat.postMessage",
            ],
        )

    def test_tasks_outcomes_exit_before_gemini(self):
        cases = (
            ("invalid", "unknown", "C-channel", {}),
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
                requests_module.post.assert_called_once()

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
            notion_response,
            root_response,
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
