import io
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock

from tasks_list import fetch_one_task, handle_tasks_list, is_tasks_list_command


class TasksListCommandTests(unittest.TestCase):
    def test_only_exact_tasks_list_command_matches(self):
        self.assertTrue(is_tasks_list_command("/tasks", "list"))

        for command, text in (
            ("/testbot", "list"),
            ("/tasks", "List"),
            ("/tasks", " list"),
            ("/tasks", "list "),
            ("/tasks", "list extra"),
            ("", "list"),
        ):
            with self.subTest(command=command, text=text):
                self.assertFalse(is_tasks_list_command(command, text))

    def test_unauthorized_channel_does_not_access_notion_or_slack(self):
        notion_post = Mock()
        post_slack_message = Mock()
        environment = {"TASKS_SLACK_CHANNEL_ID": "C-allowed"}

        handled = handle_tasks_list(
            "C-other",
            post_slack_message,
            notion_post,
            environment,
        )

        self.assertFalse(handled)
        notion_post.assert_not_called()
        post_slack_message.assert_not_called()

    def test_authorized_channel_reads_and_posts_one_linked_task(self):
        notion_response = Mock()
        notion_response.ok = True
        notion_response.status_code = 200
        notion_response.json.return_value = {
            "results": [
                {
                    "url": "https://www.notion.so/example-task",
                    "properties": {
                        "Name": {
                            "title": [
                                {"plain_text": "Known staging task"},
                            ]
                        }
                    },
                }
            ]
        }
        notion_post = Mock(return_value=notion_response)
        post_slack_message = Mock(side_effect=[{"ts": "123.456"}, {}])
        environment = {
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "NOTION_API_KEY": "secret-token",
            "NOTION_TASKS_DATA_SOURCE_ID": "data-source-id",
        }

        handled = handle_tasks_list(
            "C-allowed",
            post_slack_message,
            notion_post,
            environment,
        )

        self.assertTrue(handled)
        notion_post.assert_called_once_with(
            "https://api.notion.com/v1/data_sources/data-source-id/query",
            headers={
                "Authorization": "Bearer secret-token",
                "Content-Type": "application/json",
                "Notion-Version": "2025-09-03",
            },
            params={"filter_properties[]": "Name"},
            json={"page_size": 1},
            timeout=10,
        )
        notion_response.raise_for_status.assert_called_once_with()
        self.assertEqual(
            post_slack_message.call_args_list,
            [
                unittest.mock.call("/tasks list"),
                unittest.mock.call(
                    "<https://www.notion.so/example-task|Known staging task>",
                    thread_ts="123.456",
                ),
            ],
        )

    def test_notion_failure_logs_only_safe_diagnostic_fields(self):
        notion_response = Mock()
        notion_response.ok = False
        notion_response.status_code = 401
        notion_response.json.return_value = {
            "code": "unauthorized",
            "message": "API token is invalid.",
            "task": "must not be logged",
        }
        notion_response.raise_for_status.side_effect = RuntimeError(
            "request failed"
        )

        output = io.StringIO()
        with self.assertRaisesRegex(RuntimeError, "request failed"):
            with redirect_stdout(output):
                fetch_one_task(
                    Mock(return_value=notion_response),
                    "secret-token",
                    "data-source-id",
                )

        self.assertEqual(
            output.getvalue(),
            '{"http_status": 401, "notion_error_code": "unauthorized", '
            '"notion_error_message": "API token is invalid."}\n',
        )
        self.assertNotIn("secret-token", output.getvalue())
        self.assertNotIn("must not be logged", output.getvalue())


if __name__ == "__main__":
    unittest.main()
