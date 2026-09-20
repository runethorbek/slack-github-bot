import os
import runpy
import sys
import types
import unittest
from unittest.mock import Mock, patch


class MainRoutingTests(unittest.TestCase):
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
            "SLACK_CHANNEL_ID": "C-channel",
            "SLACK_BOT_TOKEN": "test-slack-token",
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
                            "status": {"name": "Ikke started"},
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
                            "status": {"name": "Ikke started"},
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
