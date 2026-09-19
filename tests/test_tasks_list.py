import unittest
from datetime import date
from unittest.mock import Mock, call, patch

from requests.exceptions import ConnectionError as RequestsConnectionError
from requests.exceptions import Timeout

from tasks_list import (
    NotionAuthenticationError,
    handle_tasks_command,
    retry_delay,
    select_tasks_needing_attention,
)


FIXED_TODAY = date(2026, 8, 29)
NOTION_QUERY_URL = "https://api.notion.com/v1/data_sources/data-source-id/query"


class NotionHttpError(Exception):
    def __init__(self, status_code, headers=None):
        self.response = type(
            "Response", (), {"status_code": status_code, "headers": headers or {}}
        )()


class TasksListCommandTests(unittest.TestCase):
    def test_retries_a_rate_limited_query_twice_at_most_and_respects_retry_after(self):
        rate_limited = Mock()
        rate_limited_error = NotionHttpError(429, {"Retry-After": "7"})
        rate_limited.raise_for_status.side_effect = rate_limited_error
        successful = Mock()
        successful.json.return_value = self.notion_page([self.task("Recovered")])
        notion_post = Mock(side_effect=[rate_limited, successful])
        post_slack_message = Mock(side_effect=lambda message, thread_ts=None: {"ts": "123.456"})
        sleep = Mock()

        handled = handle_tasks_command(
            "/tasks", "list", "C-allowed", post_slack_message, notion_post,
            self.authorized_environment(), today=FIXED_TODAY, sleep=sleep,
        )

        self.assertTrue(handled)
        self.assertEqual(notion_post.call_count, 2)
        sleep.assert_called_once_with(7.0)
        self.assertIn("Recovered", self.thread_output(post_slack_message))

    def test_credential_failure_fails_with_a_safe_notion_specific_message(self):
        unauthorized = Mock()
        unauthorized.raise_for_status.side_effect = NotionHttpError(401)
        notion_post = Mock(return_value=unauthorized)
        post_slack_message = Mock(side_effect=lambda message, thread_ts=None: {"ts": "123.456"})
        sleep = Mock()

        with self.assertRaisesRegex(
            NotionAuthenticationError, r"^Notion authentication failed \(HTTP 401\)\.$"
        ) as error_context:
            handle_tasks_command(
                "/tasks", "list", "C-allowed", post_slack_message, notion_post,
                self.authorized_environment(), today=FIXED_TODAY, sleep=sleep,
            )

        notion_post.assert_called_once()
        sleep.assert_not_called()
        self.assertEqual(post_slack_message.call_count, 1)
        self.assertIsNone(error_context.exception.__cause__)
        self.assertNotIn("secret-token", str(error_context.exception))

    def test_stops_after_two_retries_for_a_transient_query_failure(self):
        failed_responses = []
        for _ in range(3):
            response = Mock()
            response.raise_for_status.side_effect = NotionHttpError(503)
            failed_responses.append(response)
        notion_post = Mock(side_effect=failed_responses)
        post_slack_message = Mock(side_effect=lambda message, thread_ts=None: {"ts": "123.456"})
        sleep = Mock()

        handle_tasks_command(
            "/tasks", "list", "C-allowed", post_slack_message, notion_post,
            self.authorized_environment(), today=FIXED_TODAY, sleep=sleep,
        )

        self.assertEqual(notion_post.call_count, 3)
        self.assertEqual(sleep.call_args_list, [call(1), call(2)])
        self.assertEqual(
            self.thread_output(post_slack_message),
            "Unable to retrieve tasks right now. Please try again later.",
        )

    def test_does_not_retry_a_malformed_query_response(self):
        malformed = Mock()
        malformed.json.return_value = {"results": "private task contents"}
        notion_post = Mock(return_value=malformed)
        post_slack_message = Mock(side_effect=lambda message, thread_ts=None: {"ts": "123.456"})
        sleep = Mock()

        handle_tasks_command(
            "/tasks", "list", "C-allowed", post_slack_message, notion_post,
            self.authorized_environment(), today=FIXED_TODAY, sleep=sleep,
        )

        notion_post.assert_called_once()
        sleep.assert_not_called()
        self.assertNotIn("private task contents", self.thread_output(post_slack_message))

    def test_skips_malformed_tasks_and_reports_the_count(self):
        malformed = self.task("Broken")
        del malformed["properties"]["Status"]

        _, _, post_slack_message = self.run_list(
            [self.notion_page([malformed, self.task("Valid")])]
        )

        output = self.thread_output(post_slack_message)
        self.assertIn("Valid", output)
        self.assertNotIn("Broken", output)
        self.assertIn("Skipped 1 malformed task.", output)

    def test_retries_a_transient_track_lookup(self):
        query_response = Mock()
        query_response.json.return_value = self.notion_page(
            [self.task("Task", track_ids=["track-id"])]
        )
        track_response = Mock()
        track_response.json.return_value = self.track("Recovered track")
        notion_get = Mock(side_effect=[Timeout(), track_response])
        post_slack_message = Mock(side_effect=lambda message, thread_ts=None: {"ts": "123.456"})
        sleep = Mock()

        handle_tasks_command(
            "/tasks", "list", "C-allowed", post_slack_message,
            Mock(return_value=query_response), self.authorized_environment(),
            today=FIXED_TODAY, notion_get=notion_get, sleep=sleep,
        )

        self.assertEqual(notion_get.call_count, 2)
        sleep.assert_called_once_with(1)
        self.assertIn("Recovered track", self.thread_output(post_slack_message))

    def test_recovers_from_a_connection_error_and_a_server_error(self):
        connection_recovery = Mock()
        connection_recovery.json.return_value = self.notion_page([self.task("Connected")])
        connection_post = Mock(side_effect=[RequestsConnectionError(), connection_recovery])
        post_slack_message = Mock(side_effect=lambda message, thread_ts=None: {"ts": "123.456"})
        sleep = Mock()

        handle_tasks_command(
            "/tasks", "list", "C-allowed", post_slack_message, connection_post,
            self.authorized_environment(), today=FIXED_TODAY, sleep=sleep,
        )

        self.assertEqual(connection_post.call_count, 2)
        sleep.assert_called_once_with(1)
        self.assertIn("Connected", self.thread_output(post_slack_message))

        server_error = Mock()
        server_error.raise_for_status.side_effect = NotionHttpError(503)
        server_recovery = Mock()
        server_recovery.json.return_value = self.notion_page([self.task("Recovered")])
        server_post = Mock(side_effect=[server_error, server_recovery])
        server_sleep = Mock()

        handle_tasks_command(
            "/tasks", "list", "C-allowed", post_slack_message, server_post,
            self.authorized_environment(), today=FIXED_TODAY, sleep=server_sleep,
        )

        self.assertEqual(server_post.call_count, 2)
        server_sleep.assert_called_once_with(1)

    def test_invalid_retry_after_values_use_backoff(self):
        self.assertEqual(retry_delay(NotionHttpError(429), 0), 1)
        self.assertEqual(retry_delay(NotionHttpError(429, {"Retry-After": "nope"}), 0), 1)
        self.assertEqual(retry_delay(NotionHttpError(429, {"Retry-After": "NaN"}), 1), 2)
        self.assertEqual(
            retry_delay(
                NotionHttpError(429, {"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"}),
                1,
            ),
            0,
        )

    def test_malformed_query_json_is_not_retried(self):
        malformed = Mock()
        malformed.json.side_effect = ValueError("not JSON")
        notion_post = Mock(return_value=malformed)
        post_slack_message = Mock(side_effect=lambda message, thread_ts=None: {"ts": "123.456"})

        handle_tasks_command(
            "/tasks", "list", "C-allowed", post_slack_message, notion_post,
            self.authorized_environment(), today=FIXED_TODAY, sleep=Mock(),
        )

        notion_post.assert_called_once()
        self.assertEqual(
            self.thread_output(post_slack_message),
            "Unable to retrieve tasks right now. Please try again later.",
        )

    def test_unexpected_task_parsing_error_is_not_reported_as_malformed(self):
        with self.assertRaises(AssertionError):
            with patch("tasks_list.task_from_notion_page", side_effect=AssertionError):
                select_tasks_needing_attention([self.task("Task")], FIXED_TODAY)

    def test_terminal_track_permission_failure_is_isolated(self):
        query_response = Mock()
        query_response.json.return_value = self.notion_page(
            [self.task("Task", track_ids=["forbidden"])]
        )
        forbidden = Mock()
        forbidden.raise_for_status.side_effect = NotionHttpError(403)
        post_slack_message = Mock(side_effect=lambda message, thread_ts=None: {"ts": "123.456"})

        handle_tasks_command(
            "/tasks", "list", "C-allowed", post_slack_message,
            Mock(return_value=query_response), self.authorized_environment(),
            today=FIXED_TODAY, notion_get=Mock(return_value=forbidden), sleep=Mock(),
        )

        self.assertIn("Track unavailable", self.thread_output(post_slack_message))

    def test_other_commands_are_not_owned(self):
        notion_post = Mock()
        post_slack_message = Mock()

        handled = handle_tasks_command(
            "/testbot", "hello", "C-channel", post_slack_message, notion_post, {}
        )

        self.assertFalse(handled)
        notion_post.assert_not_called()
        post_slack_message.assert_not_called()

    def test_invalid_task_commands_return_usage_without_accessing_notion(self):
        for text in ("", "   ", "show", "list extra"):
            with self.subTest(text=text):
                notion_post = Mock()
                post_slack_message = Mock()

                handled = handle_tasks_command(
                    "/tasks", text, "C-channel", post_slack_message, notion_post, {}
                )

                self.assertTrue(handled)
                notion_post.assert_not_called()
                post_slack_message.assert_called_once_with("Usage: /tasks list")

    def test_unauthorized_channel_returns_refusal_without_accessing_notion(self):
        notion_post = Mock()
        post_slack_message = Mock()

        handled = handle_tasks_command(
            "/tasks",
            "list",
            "C-other",
            post_slack_message,
            notion_post,
            {"TASKS_SLACK_CHANNEL_ID": "C-allowed"},
        )

        self.assertTrue(handled)
        notion_post.assert_not_called()
        post_slack_message.assert_called_once_with(
            "The /tasks command is not available in this channel."
        )

    def test_lists_eligible_tasks_in_date_priority_and_name_order(self):
        pages = [
            self.notion_page(
                [
                    self.task("Finished", "2026-08-20", status="Færdig"),
                    self.task("Too far away", "2026-09-06"),
                    self.task("Same date high beta", "2026-09-01", priority="High"),
                    self.task("Undated no priority"),
                    self.task("Today high", "2026-08-29", priority="High"),
                    self.task("Same date medium", "2026-09-01", priority="Medium"),
                    self.task("Overdue low", "2026-08-28", priority="Low"),
                    self.task("Same date high alpha", "2026-09-01", priority="High"),
                    self.task("Undated high", priority="High"),
                    self.task("Seven days away", "2026-09-05", priority="Low"),
                ]
            )
        ]

        notion_post, _, post_slack_message = self.run_list(pages)

        notion_post.assert_called_once_with(
            NOTION_QUERY_URL,
            headers=self.notion_headers(),
            json={
                "filter": {
                    "property": "Status",
                    "status": {"does_not_equal": "Færdig"},
                },
                "page_size": 100,
            },
            timeout=10,
        )
        output = self.thread_output(post_slack_message)
        self.assert_ordered_links(
            output,
            [
                "Overdue low",
                "Today high",
                "Same date high alpha",
                "Same date high beta",
                "Same date medium",
                "Seven days away",
                "Undated high",
                "Undated no priority",
            ],
        )
        self.assertNotIn("Finished", output)
        self.assertNotIn("Too far away", output)

    def test_empty_result_uses_the_specified_message(self):
        _, _, post_slack_message = self.run_list(
            [self.notion_page([self.task("Later", "2026-09-06")])]
        )

        self.assertEqual(
            self.thread_output(post_slack_message), "No tasks need attention right now."
        )

    def test_renders_no_more_than_twenty_eligible_tasks(self):
        _, _, post_slack_message = self.run_list(
            [self.notion_page([self.task(f"Task {number:02d}") for number in range(1, 22)])]
        )

        output = self.thread_output(post_slack_message)
        self.assertEqual(output.count("https://www.notion.so/"), 20)
        self.assertIn("Task 20", output)
        self.assertNotIn("Task 21", output)

    def test_stops_after_five_pages_and_avoids_a_false_empty_claim(self):
        pages = [
            self.notion_page(
                [self.task(f"Later {page}-{item}", "2026-09-06") for item in range(100)],
                has_more=True,
                next_cursor=f"cursor-{page + 1}",
            )
            for page in range(1, 6)
        ]

        notion_post, _, post_slack_message = self.run_list(pages)

        self.assertEqual(notion_post.call_count, 5)
        expected_queries = [
            {
                "filter": {
                    "property": "Status",
                    "status": {"does_not_equal": "Færdig"},
                },
                "page_size": 100,
            }
        ]
        expected_queries.extend(
            {
                "filter": {
                    "property": "Status",
                    "status": {"does_not_equal": "Færdig"},
                },
                "page_size": 100,
                "start_cursor": f"cursor-{page}",
            }
            for page in range(2, 6)
        )
        self.assertEqual(
            [request.kwargs["json"] for request in notion_post.call_args_list],
            expected_queries,
        )
        output = self.thread_output(post_slack_message).casefold()
        self.assertIn("more tasks may need attention", output)
        self.assertNotIn("no tasks need attention right now", output)
        self.assertNotRegex(output, r"\b\d+\s+more\b")

    def test_normalized_list_commands_use_the_task_path(self):
        for text in ("list", "LIST", " list", "list ", "  LiSt  "):
            with self.subTest(text=text):
                notion_post, _, post_slack_message = self.run_list(
                    [self.notion_page([self.task("Known task")])], text=text
                )
                notion_post.assert_called_once()
                self.assertIn("Known task", self.thread_output(post_slack_message))

    def test_renders_zero_one_and_exactly_three_tracks(self):
        track_pages = {
            "high": self.track("Alpha", "High"),
            "medium": self.track("Middle", "Medium"),
            "low": self.track("Lowly", "Low"),
        }
        _, notion_get, post_slack_message = self.run_list(
            [
                self.notion_page(
                    [
                        self.task("No relation"),
                        self.task("One relation", track_ids=["medium"]),
                        self.task(
                            "Exactly three",
                            track_ids=["low", "medium", "high"],
                        ),
                    ]
                )
            ],
            track_pages=track_pages,
        )

        output = self.thread_output(post_slack_message)
        self.assertIn("Track: No track", output)
        self.assertIn("Track: Middle", output)
        self.assertIn("Track: Alpha, Middle, Lowly", output)
        self.assertNotIn("+1 more", output)
        self.assertEqual(notion_get.call_count, 3)

    def test_truncates_after_ordering_and_reports_the_remainder(self):
        track_pages = {
            "none": self.track("Unprioritized"),
            "low": self.track("Lowly", "Low"),
            "high-zulu": self.track("Zulu", "High"),
            "medium": self.track("Middle", "Medium"),
            "high-alpha": self.track("Alpha", "High"),
        }
        _, notion_get, post_slack_message = self.run_list(
            [
                self.notion_page(
                    [
                        self.task(
                            "Many relations",
                            track_ids=[
                                "none",
                                "low",
                                "high-zulu",
                                "medium",
                                "high-alpha",
                            ],
                        )
                    ]
                )
            ],
            track_pages=track_pages,
        )

        output = self.thread_output(post_slack_message)
        self.assertIn("Track: Alpha, Zulu, Middle, +2 more", output)
        self.assertNotIn("Lowly", output)
        self.assertNotIn("Unprioritized", output)
        self.assertEqual(notion_get.call_count, 5)

    def test_unavailable_tracks_count_toward_the_cap_and_remainder(self):
        track_pages = {
            "high": self.track("Alpha", "High"),
            "medium": self.track("Middle", "Medium"),
            "failed-one": RuntimeError("Notion lookup failed"),
            "failed-two": RuntimeError("Notion lookup failed"),
        }
        _, _, post_slack_message = self.run_list(
            [
                self.notion_page(
                    [
                        self.task(
                            "Partial failure",
                            track_ids=["failed-one", "medium", "high", "failed-two"],
                        )
                    ]
                )
            ],
            track_pages=track_pages,
        )

        output = self.thread_output(post_slack_message)
        self.assertIn("Track: Alpha, Middle, Track unavailable, +1 more", output)
        self.assertEqual(output.count("Track unavailable"), 1)

    def test_reuses_track_lookups_and_keeps_tasks_when_a_track_is_unavailable(self):
        track_pages = {
            "shared": self.track("Shared", "Medium"),
            "missing-name": {
                "properties": {
                    "Other title": {
                        "type": "title",
                        "title": [{"plain_text": "Wrong title"}],
                    }
                }
            },
            "failed": RuntimeError("Notion lookup failed"),
        }
        _, notion_get, post_slack_message = self.run_list(
            [
                self.notion_page(
                    [
                        self.task("First", track_ids=["shared", "failed"]),
                        self.task("Second", track_ids=["shared", "missing-name"]),
                    ]
                )
            ],
            track_pages=track_pages,
        )

        output = self.thread_output(post_slack_message)
        self.assertIn("Track: Shared, Track unavailable", output)
        self.assertEqual(output.count("Shared"), 2)
        self.assertEqual(output.count("Track unavailable"), 2)
        requested_urls = [call.args[0] for call in notion_get.call_args_list]
        self.assertEqual(requested_urls.count("https://api.notion.com/v1/pages/shared"), 1)
        self.assertEqual(notion_get.call_count, 3)

    def test_only_displayed_tasks_trigger_track_resolution(self):
        tasks = [
            self.task(f"Task {number:02d}", track_ids=[f"track-{number:02d}"])
            for number in range(1, 22)
        ]
        track_pages = {
            f"track-{number:02d}": self.track(f"Track {number:02d}", "Low")
            for number in range(1, 22)
        }

        _, notion_get, _ = self.run_list(
            [self.notion_page(tasks)], track_pages=track_pages
        )

        self.assertEqual(notion_get.call_count, 20)
        requested_urls = {call.args[0] for call in notion_get.call_args_list}
        self.assertNotIn("https://api.notion.com/v1/pages/track-21", requested_urls)

    def run_list(self, pages, text="list", track_pages=None):
        responses = []
        for page in pages:
            response = Mock()
            response.json.return_value = page
            responses.append(response)
        notion_post = Mock(side_effect=responses)

        def get_track(url, **_kwargs):
            track_id = url.rsplit("/", 1)[-1]
            value = (track_pages or {}).get(track_id)
            if isinstance(value, Exception):
                raise value
            response = Mock()
            response.json.return_value = value
            return response

        notion_get = Mock(side_effect=get_track)

        def post_to_slack(message, thread_ts=None):
            if thread_ts is None:
                return {"ts": "123.456"}
            return {}

        post_slack_message = Mock(side_effect=post_to_slack)
        handled = handle_tasks_command(
            "/tasks",
            text,
            "C-allowed",
            post_slack_message,
            notion_post,
            self.authorized_environment(),
            today=FIXED_TODAY,
            notion_get=notion_get,
        )
        self.assertTrue(handled)
        for response in responses:
            response.raise_for_status.assert_called_once_with()
        if track_pages is None:
            self.assertEqual(notion_get.call_count, 0)
        return notion_post, notion_get, post_slack_message

    @staticmethod
    def thread_output(post_slack_message):
        return "\n".join(
            request.args[0]
            for request in post_slack_message.call_args_list
            if request.kwargs.get("thread_ts")
        )

    def assert_ordered_links(self, output, names):
        positions = []
        for name in names:
            url = f"https://www.notion.so/{name.casefold().replace(' ', '-')}"
            link = f"<{url}|{name}>"
            self.assertIn(link, output)
            positions.append(output.index(link))
        self.assertEqual(positions, sorted(positions))

    @staticmethod
    def notion_page(results, has_more=False, next_cursor=None):
        return {"results": results, "has_more": has_more, "next_cursor": next_cursor}

    @staticmethod
    def task(
        name,
        follow_up=None,
        priority=None,
        status="Ikke started",
        track_ids=None,
    ):
        return {
            "url": f"https://www.notion.so/{name.casefold().replace(' ', '-')}",
            "properties": {
                "Navn": {
                    "id": "title",
                    "type": "title",
                    "title": [{"plain_text": name}],
                },
                "Status": {"type": "status", "status": {"name": status}},
                "Priority": {
                    "type": "select",
                    "select": {"name": priority} if priority else None,
                },
                "Follow-up": {
                    "type": "date",
                    "date": {"start": follow_up} if follow_up else None,
                },
                "Track": {
                    "type": "relation",
                    "relation": [{"id": track_id} for track_id in (track_ids or [])],
                },
            },
        }

    @staticmethod
    def track(name, priority=None):
        return {
            "properties": {
                "Navn": {
                    "type": "title",
                    "title": [{"plain_text": name}] if name else [],
                },
                "Priority": {
                    "type": "select",
                    "select": {"name": priority} if priority else None,
                },
            }
        }

    @staticmethod
    def authorized_environment():
        return {
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "NOTION_API_KEY": "secret-token",
            "NOTION_TASKS_DATA_SOURCE_ID": "data-source-id",
        }

    @staticmethod
    def notion_headers():
        return {
            "Authorization": "Bearer secret-token",
            "Content-Type": "application/json",
            "Notion-Version": "2025-09-03",
        }


if __name__ == "__main__":
    unittest.main()
