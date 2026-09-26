import io
import unittest
from contextlib import redirect_stdout
from datetime import date
from unittest.mock import Mock, patch

from requests.exceptions import Timeout

from attention_summary import (
    AttentionSummaryError,
    build_slack_dm_poster,
    describe_source_error,
    main,
    send_attention_summary,
)
from people_due import find_due_people
from tasks_list import select_tasks_needing_attention


FIXED_TODAY = date(2026, 9, 28)  # A Monday.
TASKS_SOURCE = "tasks-source"
PEOPLE_SOURCE = "people-source"
INTERACTIONS_SOURCE = "interactions-source"


class NotionHttpError(Exception):
    def __init__(self, status_code):
        self.response = type(
            "Response", (), {"status_code": status_code, "headers": {}}
        )()


def response(results, has_more=False, next_cursor=None):
    notion_response = Mock()
    notion_response.json.return_value = {
        "results": results,
        "has_more": has_more,
        "next_cursor": next_cursor,
    }
    return notion_response


def failing_response(status_code):
    notion_response = Mock()
    notion_response.raise_for_status.side_effect = NotionHttpError(status_code)
    return notion_response


def task(name, follow_up=None, priority=None, status="Ikke startet"):
    return {
        "url": f"https://www.notion.so/{name.casefold().replace(' ', '-')}",
        "properties": {
            "Navn": {"id": "title", "type": "title", "title": [{"plain_text": name}]},
            "Status": {"type": "status", "status": {"name": status}},
            "Priority": {
                "type": "select",
                "select": {"name": priority} if priority else None,
            },
            "Follow-up": {
                "type": "date",
                "date": {"start": follow_up} if follow_up else None,
            },
        },
    }


def person(page_id, name, cadence="1 month"):
    return {
        "id": page_id,
        "properties": {
            "Name": {"type": "title", "title": [{"plain_text": name}]},
            "Contact cadence": {"type": "select", "select": {"name": cadence}},
        },
    }


def interaction(date_value, person_id):
    return {
        "properties": {
            "Date": {"type": "date", "date": {"start": date_value}},
            "People": {"type": "relation", "relation": [{"id": person_id}]},
        }
    }


def environment():
    return {
        "NOTION_API_KEY": "secret-token",
        "NOTION_TASKS_DATA_SOURCE_ID": TASKS_SOURCE,
        "NOTION_PEOPLE_DATA_SOURCE_ID": PEOPLE_SOURCE,
        "NOTION_INTERACTIONS_DATA_SOURCE_ID": INTERACTIONS_SOURCE,
    }


def routing_notion_post(tasks=(), people=(), interactions=(), tasks_response=None,
                        people_response=None):
    """Route each Notion query to its data source's canned response."""

    def notion_post(url, **_kwargs):
        if f"/{TASKS_SOURCE}/" in url:
            return tasks_response or response(list(tasks))
        if f"/{PEOPLE_SOURCE}/" in url:
            return people_response or response(list(people))
        if f"/{INTERACTIONS_SOURCE}/" in url:
            return response(list(interactions))
        raise AssertionError(f"Unexpected Notion URL {url}")

    return Mock(side_effect=notion_post)


class AttentionSummaryTests(unittest.TestCase):
    def run_summary(self, notion_post):
        post_direct_message = Mock()
        log = Mock()
        sent = send_attention_summary(
            post_direct_message,
            notion_post,
            environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
            log=log,
        )
        return sent, post_direct_message, log

    def run_failing_summary(self, notion_post, env=None):
        post_direct_message = Mock()
        log = Mock()
        with self.assertRaises(AttentionSummaryError) as error_context:
            send_attention_summary(
                post_direct_message,
                notion_post,
                env or environment(),
                today=FIXED_TODAY,
                sleep=Mock(),
                log=log,
            )
        return str(error_context.exception), post_direct_message, log

    def sent_message(self, post_direct_message):
        post_direct_message.assert_called_once()
        return post_direct_message.call_args.args[0]

    def logged(self, log):
        return "\n".join(str(call.args[0]) for call in log.call_args_list)

    # --- Composition -------------------------------------------------------

    def test_tasks_only(self):
        sent, post, _ = self.run_summary(
            routing_notion_post(tasks=[task("Ship report", "2026-09-27", "High")])
        )

        self.assertTrue(sent)
        message = self.sent_message(post)
        self.assertIn("*Tasks*", message)
        self.assertIn(
            "• <https://www.notion.so/ship-report|Ship report> — Priority: High "
            "— Overdue: 2026-09-27",
            message,
        )
        self.assertNotIn("*People due*", message)
        self.assertNotIn("unavailable", message)

    def test_people_only(self):
        sent, post, _ = self.run_summary(
            routing_notion_post(
                people=[person("p1", "Alex"), person("p2", "Blair")],
                interactions=[interaction("2026-08-01", "p1")],
            )
        )

        self.assertTrue(sent)
        message = self.sent_message(post)
        self.assertIn("*People due*", message)
        self.assertIn("• Alex — Next contact due: 2026-09-01", message)
        self.assertIn("• Blair — No previous interaction", message)
        self.assertNotIn("*Tasks*", message)

    def test_both_sections(self):
        sent, post, _ = self.run_summary(
            routing_notion_post(
                tasks=[task("Call bank", "2026-09-30")],
                people=[person("p1", "Alex")],
            )
        )

        self.assertTrue(sent)
        message = self.sent_message(post)
        self.assertTrue(message.startswith("*Attention summary*"))
        self.assertLess(message.index("*Tasks*"), message.index("*People due*"))
        self.assertIn("Follow-up: 2026-09-30", message)
        self.assertIn("• Alex — No previous interaction", message)

    def test_nothing_needs_attention_posts_nothing(self):
        sent, post, log = self.run_summary(
            routing_notion_post(
                tasks=[
                    task("Later", "2026-10-06"),
                    task("Done", "2026-09-01", status="Færdig"),
                ],
                people=[person("p1", "Alex")],
                interactions=[interaction("2026-09-10", "p1")],
            )
        )

        self.assertFalse(sent)
        post.assert_not_called()
        self.assertIn("no DM sent", self.logged(log))

    # --- Truncation and undated count --------------------------------------

    def test_dated_tasks_are_capped_at_five_with_more_hint(self):
        tasks = [task(f"Task {index}", f"2026-09-2{index}") for index in range(7)]

        _, post, _ = self.run_summary(routing_notion_post(tasks=tasks))

        message = self.sent_message(post)
        for index in range(5):
            self.assertIn(f"|Task {index}>", message)
        self.assertNotIn("|Task 5>", message)
        self.assertNotIn("|Task 6>", message)
        self.assertIn("+2 more — run /tasks list", message)

    def test_exactly_five_dated_tasks_has_no_more_hint(self):
        tasks = [task(f"Task {index}", f"2026-09-2{index}") for index in range(5)]

        _, post, _ = self.run_summary(routing_notion_post(tasks=tasks))

        self.assertNotIn("more", self.sent_message(post))

    def test_undated_tasks_are_shown_as_a_count_only(self):
        tasks = [task(f"Undated {index}") for index in range(7)]
        tasks.append(task("Dated", "2026-09-29"))

        _, post, _ = self.run_summary(routing_notion_post(tasks=tasks))

        message = self.sent_message(post)
        self.assertIn("7 open tasks without follow-up date", message)
        self.assertIn("|Dated>", message)
        self.assertNotIn("Undated", message)

    def test_single_undated_task_uses_singular_noun(self):
        _, post, _ = self.run_summary(routing_notion_post(tasks=[task("Undated")]))

        self.assertIn("1 open task without follow-up date", self.sent_message(post))

    def test_counts_are_not_limited_by_the_tasks_list_display_cap(self):
        dated = [task(f"Dated {index:02}", "2026-09-29") for index in range(22)]
        undated = [task(f"Undated {index:02}") for index in range(4)]

        _, post, _ = self.run_summary(routing_notion_post(tasks=dated + undated))

        message = self.sent_message(post)
        self.assertIn("+17 more — run /tasks list", message)
        self.assertIn("4 open tasks without follow-up date", message)

    def test_due_people_are_capped_at_five_with_more_hint(self):
        people = [person(f"p{index}", f"Person {index}") for index in range(8)]

        _, post, _ = self.run_summary(routing_notion_post(people=people))

        message = self.sent_message(post)
        for index in range(5):
            self.assertIn(f"• Person {index} —", message)
        self.assertNotIn("Person 5", message)
        self.assertIn("+3 more — run /people due", message)

    def test_people_are_plain_text_without_suggest_buttons(self):
        _, post, _ = self.run_summary(routing_notion_post(people=[person("p1", "Alex")]))

        self.assertNotIn("Suggest", self.sent_message(post))
        self.assertNotIn("blocks", post.call_args.kwargs)

    # --- Reuse of existing selection logic ---------------------------------

    def test_task_selection_and_order_match_tasks_list(self):
        pages = [
            task("Low later", "2026-10-02", "Low"),
            task("Too far", "2026-10-06", "High"),
            task("High soon", "2026-10-02", "High"),
            task("Overdue", "2026-09-01"),
            task("Finished", "2026-09-01", status="Færdig"),
            task("No date"),
        ]
        expected, _ = select_tasks_needing_attention(pages, FIXED_TODAY)
        expected_dated = [t.name for t in expected if t.follow_up is not None]

        _, post, _ = self.run_summary(routing_notion_post(tasks=pages))

        message = self.sent_message(post)
        positions = [message.index(f"|{name}>") for name in expected_dated]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(expected_dated, ["Overdue", "High soon", "Low later"])
        self.assertNotIn("Too far", message)
        self.assertNotIn("Finished", message)
        self.assertIn("1 open task without follow-up date", message)

    def test_people_selection_and_order_match_people_due(self):
        people = [person("p1", "A"), person("p2", "B"), person("p3", "C"),
                  person("p4", "Not due")]
        interactions = [
            interaction("2026-08-01", "p1"),
            interaction("2026-06-01", "p2"),
            interaction("2026-07-01", "p3"),
            interaction("2026-09-20", "p4"),
        ]
        expected, _, _ = find_due_people(
            routing_notion_post(people=people, interactions=interactions),
            "secret-token", PEOPLE_SOURCE, INTERACTIONS_SOURCE, FIXED_TODAY, Mock(),
        )

        _, post, _ = self.run_summary(
            routing_notion_post(people=people, interactions=interactions)
        )

        message = self.sent_message(post)
        names = [due.person.name for due in expected]
        self.assertEqual(names, ["B", "C", "A"])
        positions = [message.index(f"• {name} —") for name in names]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn("Not due", message)

    # --- Incomplete scans ---------------------------------------------------

    def test_incomplete_task_scan_without_items_is_reported(self):
        # has_more without a cursor cannot be claimed complete.
        sent, post, _ = self.run_summary(
            routing_notion_post(
                tasks_response=response([task("Later", "2026-10-06")], has_more=True)
            )
        )

        self.assertTrue(sent)
        message = self.sent_message(post)
        self.assertIn("*Tasks*\nMore tasks may need attention.", message)
        self.assertNotIn("Later", message)
        self.assertNotIn("*People due*", message)

    def test_incomplete_people_scan_without_items_is_reported(self):
        sent, post, _ = self.run_summary(
            routing_notion_post(people_response=response([], has_more=True))
        )

        self.assertTrue(sent)
        message = self.sent_message(post)
        self.assertIn(
            "*People due*\nSome People or Interactions could not be scanned; "
            "results may be incomplete.",
            message,
        )
        self.assertNotIn("*Tasks*", message)

    def test_complete_scans_without_items_send_nothing(self):
        sent, post, _ = self.run_summary(
            routing_notion_post(
                tasks=[task("Later", "2026-10-06")],
                people=[person("p1", "Alex")],
                interactions=[interaction("2026-09-10", "p1")],
            )
        )

        self.assertFalse(sent)
        post.assert_not_called()

    # --- Skipped malformed rows --------------------------------------------

    def test_skipped_malformed_task_is_reported_in_shown_section(self):
        broken = task("Broken")
        del broken["properties"]["Status"]

        _, post, _ = self.run_summary(
            routing_notion_post(tasks=[broken, task("Valid", "2026-09-29")])
        )

        message = self.sent_message(post)
        self.assertIn("Skipped 1 malformed task.", message)
        self.assertNotIn("Broken", message)

    def test_skipped_malformed_tasks_use_plural(self):
        broken = [task(f"Broken {index}") for index in range(2)]
        for page in broken:
            del page["properties"]["Status"]

        _, post, _ = self.run_summary(
            routing_notion_post(tasks=broken + [task("Valid", "2026-09-29")])
        )

        self.assertIn("Skipped 2 malformed tasks.", self.sent_message(post))

    def test_skipped_malformed_people_are_reported_in_shown_section(self):
        _, post, _ = self.run_summary(
            routing_notion_post(
                people=[
                    person("p1", "Alex"),
                    person("p2", "Bad one", cadence="weekly"),
                    person("p3", "Bad two", cadence="weekly"),
                ]
            )
        )

        message = self.sent_message(post)
        self.assertIn("Skipped 2 malformed people.", message)
        self.assertNotIn("Bad", message)

    def test_skipped_malformed_person_uses_singular(self):
        _, post, _ = self.run_summary(
            routing_notion_post(
                people=[person("p1", "Alex"), person("p2", "Bad", cadence="weekly")]
            )
        )

        self.assertIn("Skipped 1 malformed person.", self.sent_message(post))

    def test_skipped_rows_alone_send_nothing(self):
        broken = task("Broken")
        del broken["properties"]["Status"]

        sent, post, _ = self.run_summary(
            routing_notion_post(
                tasks=[broken], people=[person("p1", "Bad", cadence="weekly")]
            )
        )

        self.assertFalse(sent)
        post.assert_not_called()

    def test_skipped_count_is_not_shown_for_a_hidden_section(self):
        broken = task("Broken")
        del broken["properties"]["Status"]

        _, post, _ = self.run_summary(
            routing_notion_post(tasks=[broken], people=[person("p1", "Alex")])
        )

        message = self.sent_message(post)
        self.assertNotIn("*Tasks*", message)
        self.assertNotIn("malformed task", message)

    # --- Failure behavior --------------------------------------------------

    def test_tasks_failure_sends_people_then_fails(self):
        error, post, log = self.run_failing_summary(
            routing_notion_post(
                tasks_response=failing_response(500),
                people=[person("p1", "Alex")],
            )
        )

        message = self.sent_message(post)
        self.assertIn("Tasks unavailable right now.", message)
        self.assertIn("• Alex — No previous interaction", message)
        self.assertEqual(error, "Tasks unavailable; partial summary sent.")
        self.assertIn(
            "::error::Tasks unavailable: TaskListCommandError (HTTP 500)",
            self.logged(log),
        )

    def test_people_failure_sends_tasks_then_fails(self):
        error, post, log = self.run_failing_summary(
            routing_notion_post(
                tasks=[task("Call bank", "2026-09-30")],
                people_response=failing_response(401),
            )
        )

        message = self.sent_message(post)
        self.assertIn("People unavailable right now.", message)
        self.assertIn("|Call bank>", message)
        self.assertEqual(error, "People unavailable; partial summary sent.")
        self.assertIn(
            "::error::People unavailable: Notion authentication failed (HTTP 401).",
            self.logged(log),
        )

    def test_one_source_failing_and_other_empty_sends_nothing_and_fails(self):
        error, post, log = self.run_failing_summary(
            routing_notion_post(tasks_response=failing_response(500))
        )

        post.assert_not_called()
        self.assertEqual(error, "Tasks unavailable; no summary sent.")
        self.assertIn("::error::Tasks unavailable", self.logged(log))

    def test_both_sources_failing_sends_nothing_and_fails(self):
        error, post, log = self.run_failing_summary(
            routing_notion_post(
                tasks_response=failing_response(500),
                people_response=failing_response(503),
            )
        )

        post.assert_not_called()
        self.assertEqual(error, "Tasks and People are both unavailable; no summary sent.")
        logged = self.logged(log)
        self.assertIn("::error::Tasks unavailable: TaskListCommandError (HTTP 500)", logged)
        self.assertIn("::error::People unavailable: TaskListCommandError (HTTP 503)", logged)

    def test_failure_without_http_status_logs_type_name_only(self):
        timing_out = Mock(side_effect=Timeout("https://api.notion.com secret-token"))
        malformed = Mock()
        malformed.json.return_value = {"results": "private person contents"}

        def notion_post(url, **kwargs):
            if f"/{TASKS_SOURCE}/" in url:
                return timing_out(url, **kwargs)
            return malformed

        _, _, log = self.run_failing_summary(Mock(side_effect=notion_post))

        logged = self.logged(log)
        log_lines = logged.split("\n")
        self.assertIn("::error::Tasks unavailable: TaskListCommandError", log_lines)
        self.assertIn("::error::People unavailable: PeopleDueCommandError", log_lines)
        self.assertNotIn("HTTP", logged)
        self.assertNotIn("secret-token", logged)
        self.assertNotIn("private person contents", logged)

    def test_missing_configuration_is_reported_by_name(self):
        env = environment()
        del env["NOTION_TASKS_DATA_SOURCE_ID"]

        _, _, log = self.run_failing_summary(
            routing_notion_post(people=[person("p1", "Alex")]), env
        )

        self.assertIn(
            "Tasks unavailable: missing configuration NOTION_TASKS_DATA_SOURCE_ID",
            self.logged(log),
        )

    def test_unknown_key_error_is_described_by_type_name_only(self):
        self.assertEqual(describe_source_error(KeyError("Private task name")), "KeyError")
        self.assertEqual(
            describe_source_error(KeyError("NOTION_API_KEY")),
            "missing configuration NOTION_API_KEY",
        )

    def test_logs_contain_no_private_content_or_secrets(self):
        error, _, log = self.run_failing_summary(
            routing_notion_post(
                tasks=[task("Private task", "2026-09-27")],
                people_response=failing_response(503),
            )
        )

        logged = f"{self.logged(log)}\n{error}"
        self.assertNotIn("Private task", logged)
        self.assertNotIn("notion.so", logged)
        self.assertNotIn("secret-token", logged)


class SlackDmPosterTests(unittest.TestCase):
    def test_posts_to_the_authorized_user_id(self):
        slack_response = Mock()
        slack_response.json.return_value = {"ok": True, "ts": "1.2"}
        slack_post = Mock(return_value=slack_response)

        build_slack_dm_poster("xoxb-secret", "U123", slack_post)("hello")

        slack_post.assert_called_once()
        self.assertEqual(
            slack_post.call_args.args[0], "https://slack.com/api/chat.postMessage"
        )
        self.assertEqual(
            slack_post.call_args.kwargs["json"],
            {"channel": "U123", "text": "hello", "mrkdwn": True},
        )

    def test_slack_api_error_raises_a_safe_message(self):
        slack_response = Mock()
        slack_response.json.return_value = {"ok": False, "error": "invalid_auth"}
        slack_post = Mock(return_value=slack_response)

        with self.assertRaisesRegex(
            RuntimeError, r"^Slack DM delivery failed \(invalid_auth\)\.$"
        ) as error_context:
            build_slack_dm_poster("xoxb-secret", "U123", slack_post)("private text")

        self.assertNotIn("xoxb-secret", str(error_context.exception))
        self.assertNotIn("private text", str(error_context.exception))

    def test_http_error_raises_a_safe_message(self):
        slack_response = Mock()
        slack_response.raise_for_status.side_effect = NotionHttpError(500)
        slack_post = Mock(return_value=slack_response)

        with self.assertRaisesRegex(
            RuntimeError, r"^Slack DM delivery failed \(HTTP 500\)\.$"
        ):
            build_slack_dm_poster("xoxb-secret", "U123", slack_post)("hello")


class MainTests(unittest.TestCase):
    """main() turns every failure into an ::error:: line and exit code 1."""

    def run_main(self, slack_response, tasks_response=None):
        notion_post = routing_notion_post(
            tasks=[task("Private task", "2026-01-01")],
            tasks_response=tasks_response,
        )

        def fake_post(url, **kwargs):
            if url.startswith("https://slack.com/"):
                return slack_response
            return notion_post(url, **kwargs)

        env = dict(environment(), SLACK_BOT_TOKEN="xoxb-secret",
                   AUTHORIZED_SLACK_USER_ID="U123")
        stdout = io.StringIO()
        with patch.dict("os.environ", env, clear=True), \
                patch("attention_summary.requests.post", side_effect=fake_post), \
                redirect_stdout(stdout):
            exit_code = main()
        return exit_code, stdout.getvalue()

    @staticmethod
    def slack_response(result):
        slack_response = Mock()
        slack_response.json.return_value = result
        return slack_response

    def test_successful_send_exits_zero(self):
        exit_code, output = self.run_main(self.slack_response({"ok": True}))

        self.assertEqual(exit_code, 0)
        self.assertIn("Attention summary DM sent", output)

    def test_slack_delivery_failure_is_annotated_and_exits_non_zero(self):
        exit_code, output = self.run_main(
            self.slack_response({"ok": False, "error": "channel_not_found"})
        )

        self.assertEqual(exit_code, 1)
        self.assertIn("::error::Slack DM delivery failed (channel_not_found).", output)
        self.assertNotIn("Private task", output)
        self.assertNotIn("xoxb-secret", output)

    def test_source_failure_is_annotated_and_exits_non_zero(self):
        # 400 is not retried, so no real sleep happens.
        exit_code, output = self.run_main(
            self.slack_response({"ok": True}),
            tasks_response=failing_response(400),
        )

        self.assertEqual(exit_code, 1)
        self.assertIn("::error::Tasks unavailable: TaskListCommandError (HTTP 400)", output)
        self.assertIn("::error::Tasks unavailable; no summary sent.", output)


if __name__ == "__main__":
    unittest.main()
