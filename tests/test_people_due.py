import unittest
from datetime import date
from unittest.mock import Mock

from people_due import (
    CadenceStatus,
    NO_DUE_PERSON_MESSAGE,
    add_calendar_months,
    evaluate_cadence,
    find_one_due_person,
    handle_people_command,
)


FIXED_TODAY = date(2026, 9, 20)
PEOPLE_URL = "https://api.notion.com/v1/data_sources/people-id/query"
INTERACTIONS_URL = (
    "https://api.notion.com/v1/data_sources/interactions-id/query"
)


class PeopleDueTests(unittest.TestCase):
    def test_each_supported_cadence_uses_calendar_months(self):
        cases = {
            "1 month": date(2026, 2, 15),
            "2 months": date(2026, 3, 15),
            "3 months": date(2026, 4, 15),
            "6 months": date(2026, 7, 15),
            "12 months": date(2027, 1, 15),
        }

        for cadence, expected_due_date in cases.items():
            with self.subTest(cadence=cadence):
                result = evaluate_cadence(
                    cadence, ["2026-01-15"], date(2026, 1, 15)
                )

                self.assertEqual(result.next_due_date, expected_due_date)
                self.assertEqual(result.status, CadenceStatus.NOT_DUE)

    def test_no_valid_previous_interaction_is_due(self):
        result = evaluate_cadence("1 month", [], FIXED_TODAY)

        self.assertEqual(
            result.status, CadenceStatus.DUE_WITH_NO_PREVIOUS_INTERACTION
        )
        self.assertTrue(result.is_due)
        self.assertIsNone(result.latest_interaction_date)
        self.assertIsNone(result.next_due_date)

    def test_missing_invalid_and_future_interaction_dates_are_ignored(self):
        result = evaluate_cadence(
            "1 month",
            [None, "not-a-date", "2026-13-40", "2026-10-01"],
            FIXED_TODAY,
        )

        self.assertEqual(
            result.status, CadenceStatus.DUE_WITH_NO_PREVIOUS_INTERACTION
        )
        self.assertIsNone(result.latest_interaction_date)

    def test_latest_valid_interaction_wins(self):
        result = evaluate_cadence(
            "2 months",
            ["2026-01-10", "2026-06-15", "2027-01-01", "invalid"],
            FIXED_TODAY,
        )

        self.assertEqual(result.latest_interaction_date, date(2026, 6, 15))
        self.assertEqual(result.next_due_date, date(2026, 8, 15))
        self.assertEqual(result.status, CadenceStatus.OVERDUE)

    def test_due_exactly_today(self):
        result = evaluate_cadence("1 month", ["2026-08-20"], FIXED_TODAY)

        self.assertEqual(result.status, CadenceStatus.DUE_TODAY)
        self.assertTrue(result.is_due)

    def test_one_day_before_due_is_not_due(self):
        result = evaluate_cadence(
            "1 month", ["2026-08-21"], FIXED_TODAY
        )

        self.assertEqual(result.next_due_date, date(2026, 9, 21))
        self.assertEqual(result.status, CadenceStatus.NOT_DUE)
        self.assertFalse(result.is_due)

    def test_past_due_date_is_overdue(self):
        result = evaluate_cadence("1 month", ["2026-08-19"], FIXED_TODAY)

        self.assertEqual(result.status, CadenceStatus.OVERDUE)
        self.assertTrue(result.is_due)

    def test_month_end_and_leap_year_arithmetic(self):
        cases = (
            (date(2024, 1, 31), 1, date(2024, 2, 29)),
            (date(2024, 2, 29), 12, date(2025, 2, 28)),
        )

        for value, months, expected in cases:
            with self.subTest(value=value, months=months):
                self.assertEqual(add_calendar_months(value, months), expected)

    def test_people_without_cadence_are_ignored_defensively(self):
        notion_post = Mock(return_value=self.response([self.person("p1", "Alex", None)]))

        result = self.find_due(notion_post)

        self.assertIsNone(result)
        notion_post.assert_called_once()

    def test_person_with_cadence_and_no_interaction_is_due(self):
        notion_post = Mock(
            side_effect=[
                self.response([self.person("p1", "Alex", "1 month")]),
                self.response([]),
            ]
        )

        result = self.find_due(notion_post)

        self.assertEqual(result.person.name, "Alex")
        self.assertIsNone(result.latest_interaction)
        self.assertIsNone(result.next_contact_due)

    def test_latest_valid_interaction_is_used(self):
        notion_post = Mock(
            side_effect=[
                self.response([self.person("p1", "Alex", "2 months")]),
                self.response(
                    [
                        self.interaction("2026-01-10"),
                        self.interaction("2026-06-15"),
                        self.interaction(None),
                    ]
                ),
            ]
        )

        result = self.find_due(notion_post)

        self.assertEqual(result.latest_interaction, date(2026, 6, 15))
        self.assertEqual(result.next_contact_due, date(2026, 8, 15))

    def test_future_interaction_is_ignored(self):
        notion_post = Mock(
            side_effect=[
                self.response([self.person("p1", "Alex", "1 month")]),
                self.response(
                    [
                        self.interaction("2027-01-01"),
                        self.interaction("2026-08-20"),
                    ]
                ),
            ]
        )

        result = self.find_due(notion_post)

        self.assertEqual(result.latest_interaction, date(2026, 8, 20))
        self.assertEqual(result.next_contact_due, FIXED_TODAY)

    def test_stops_after_the_first_due_person(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.person("p1", "Alex", "1 month"),
                        self.person("p2", "Blair", "1 month"),
                    ]
                ),
                self.response([]),
            ]
        )

        result = self.find_due(notion_post)

        self.assertEqual(result.person.name, "Alex")
        self.assertEqual(notion_post.call_count, 2)

    def test_not_due_person_is_skipped_and_empty_result_is_deterministic(self):
        notion_post = Mock(
            side_effect=[
                self.response([self.person("p1", "Alex", "3 months")]),
                self.response([self.interaction("2026-08-20")]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )

        handled = handle_people_command(
            "/people",
            "due",
            post_slack_message,
            notion_post,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        self.assertTrue(handled)
        self.assertEqual(
            post_slack_message.call_args_list[-1].args[0], NO_DUE_PERSON_MESSAGE
        )

    def test_output_includes_required_fields_and_queries_are_read_only(self):
        notion_post = Mock(
            side_effect=[
                self.response([self.person("p1", "Private name", "6 months")]),
                self.response([self.interaction("2026-02-28")]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )

        handle_people_command(
            "/people", "due", post_slack_message, notion_post,
            self.environment(), today=FIXED_TODAY, sleep=Mock(),
        )

        output = post_slack_message.call_args_list[-1].args[0]
        self.assertIn("Private name", output)
        self.assertIn("Contact cadence: 6 months", output)
        self.assertIn("Latest interaction: 2026-02-28", output)
        self.assertIn("Next contact due: 2026-08-28", output)
        self.assertEqual(
            [call.args[0] for call in notion_post.call_args_list],
            [PEOPLE_URL, INTERACTIONS_URL],
        )
        self.assertTrue(
            all(call.args[0].endswith("/query") for call in notion_post.call_args_list)
        )
        interaction_query = notion_post.call_args_list[1].kwargs["json"]
        self.assertEqual(interaction_query["page_size"], 100)
        self.assertEqual(
            interaction_query["sorts"],
            [{"property": "Date", "direction": "descending"}],
        )

    def test_no_interaction_output_says_so_without_a_due_date(self):
        notion_post = Mock(
            side_effect=[
                self.response([self.person("p1", "Alex", "12 months")]),
                self.response([]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )

        handle_people_command(
            "/people", "due", post_slack_message, notion_post,
            self.environment(), today=FIXED_TODAY, sleep=Mock(),
        )

        output = post_slack_message.call_args_list[-1].args[0]
        self.assertIn("Latest interaction: No previous interaction", output)
        self.assertNotIn("Next contact due:", output)

    def test_calendar_month_addition_clamps_month_end(self):
        self.assertEqual(
            add_calendar_months(date(2026, 1, 31), 1), date(2026, 2, 28)
        )

    def test_unknown_cadence_is_skipped_without_being_interpreted(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.person("p1", "Alex", "weekly"),
                        self.person("p2", "Blair", "1 month"),
                    ]
                ),
                self.response([]),
            ]
        )

        result = self.find_due(notion_post)

        self.assertEqual(result.person.name, "Blair")
        self.assertEqual(notion_post.call_count, 2)
        interaction_filter = notion_post.call_args_list[1].kwargs["json"]["filter"]
        self.assertEqual(
            interaction_filter["and"][0]["relation"]["contains"], "p2"
        )

    def find_due(self, notion_post):
        return find_one_due_person(
            notion_post,
            "secret-token",
            "people-id",
            "interactions-id",
            FIXED_TODAY,
            Mock(),
        )

    @staticmethod
    def environment():
        return {
            "NOTION_API_KEY": "secret-token",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "people-id",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }

    @staticmethod
    def response(results):
        response = Mock()
        response.json.return_value = {"results": results}
        return response

    @staticmethod
    def person(page_id, name, cadence):
        return {
            "id": page_id,
            "properties": {
                "Name": {
                    "type": "title",
                    "title": [{"plain_text": name}],
                },
                "Contact cadence": {
                    "type": "select",
                    "select": {"name": cadence} if cadence else None,
                },
            },
        }

    @staticmethod
    def interaction(interaction_date):
        return {
            "properties": {
                "Date": {
                    "type": "date",
                    "date": (
                        {"start": interaction_date}
                        if interaction_date is not None
                        else None
                    ),
                }
            }
        }


if __name__ == "__main__":
    unittest.main()
