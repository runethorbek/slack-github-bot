import unittest
from datetime import date
from unittest.mock import Mock

from people_due import (
    NO_DUE_PERSON_MESSAGE,
    add_calendar_months,
    find_one_due_person,
    handle_people_command,
)


FIXED_TODAY = date(2026, 9, 20)
PEOPLE_URL = "https://api.notion.com/v1/data_sources/people-id/query"
INTERACTIONS_URL = (
    "https://api.notion.com/v1/data_sources/interactions-id/query"
)


class PeopleDueTests(unittest.TestCase):
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
        self.assertEqual(interaction_query["page_size"], 1)
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
