import unittest
from unittest.mock import Mock

from tasks_list import handle_tasks_command


class TasksListCommandTests(unittest.TestCase):
    def test_other_commands_are_not_owned(self):
        notion_post = Mock()
        post_slack_message = Mock()

        handled = handle_tasks_command(
            "/testbot",
            "hello",
            "C-channel",
            post_slack_message,
            notion_post,
            {},
        )

        self.assertFalse(handled)
        notion_post.assert_not_called()
        post_slack_message.assert_not_called()

    def test_normalized_list_commands_reach_the_existing_task_flow(self):
        for text in ("list", "LIST", " list", "list ", "  LiSt  "):
            with self.subTest(text=text):
                notion_post, post_slack_message = self.task_dependencies()

                handled = handle_tasks_command(
                    "/tasks",
                    text,
                    "C-allowed",
                    post_slack_message,
                    notion_post,
                    self.authorized_environment(),
                )

                self.assertTrue(handled)
                notion_post.assert_called_once()

    def test_invalid_task_commands_return_usage_without_accessing_notion(self):
        for text in ("", "   ", "show", "list extra"):
            with self.subTest(text=text):
                notion_post = Mock()
                post_slack_message = Mock()

                handled = handle_tasks_command(
                    "/tasks",
                    text,
                    "C-channel",
                    post_slack_message,
                    notion_post,
                    {},
                )

                self.assertTrue(handled)
                notion_post.assert_not_called()
                post_slack_message.assert_called_once_with("Usage: /tasks list")

    def test_unauthorized_channel_returns_refusal_without_accessing_notion(self):
        notion_post = Mock()
        post_slack_message = Mock()
        environment = {"TASKS_SLACK_CHANNEL_ID": "C-allowed"}

        handled = handle_tasks_command(
            "/tasks",
            "list",
            "C-other",
            post_slack_message,
            notion_post,
            environment,
        )

        self.assertTrue(handled)
        notion_post.assert_not_called()
        post_slack_message.assert_called_once_with(
            "The /tasks command is not available in this channel."
        )

    def test_authorized_channel_reads_and_posts_one_linked_task(self):
        notion_post, post_slack_message = self.task_dependencies()

        handled = handle_tasks_command(
            "/tasks",
            "list",
            "C-allowed",
            post_slack_message,
            notion_post,
            self.authorized_environment(),
        )

        self.assertTrue(handled)
        notion_post.assert_called_once_with(
            "https://api.notion.com/v1/data_sources/data-source-id/query",
            headers={
                "Authorization": "Bearer secret-token",
                "Content-Type": "application/json",
                "Notion-Version": "2025-09-03",
            },
            params={"filter_properties[]": "title"},
            json={"page_size": 1},
            timeout=10,
        )
        notion_post.return_value.raise_for_status.assert_called_once_with()
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

    @staticmethod
    def authorized_environment():
        return {
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "NOTION_API_KEY": "secret-token",
            "NOTION_TASKS_DATA_SOURCE_ID": "data-source-id",
        }

    @staticmethod
    def task_dependencies():
        notion_response = Mock()
        notion_response.ok = True
        notion_response.status_code = 200
        notion_response.json.return_value = {
            "results": [
                {
                    "url": "https://www.notion.so/example-task",
                    "properties": {
                        "Navn": {
                            "id": "title",
                            "type": "title",
                            "title": [
                                {"plain_text": "Known staging task"},
                            ],
                        }
                    },
                }
            ]
        }
        return (
            Mock(return_value=notion_response),
            Mock(side_effect=[{"ts": "123.456"}, {}]),
        )

if __name__ == "__main__":
    unittest.main()
