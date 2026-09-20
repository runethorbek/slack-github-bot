import unittest
from datetime import date
from unittest.mock import Mock

from people_due import (
    INCOMPLETE_SCAN_MESSAGE,
    MAX_DISPLAYED_PEOPLE,
    PEOPLE_FAILURE_MESSAGE,
    CadenceStatus,
    DuePerson,
    NO_DUE_PERSON_MESSAGE,
    Person,
    add_calendar_months,
    evaluate_cadence,
    find_due_people,
    find_one_due_person,
    format_due_people,
    handle_people_command,
)
from tasks_list import NotionAuthenticationError


class NotionHttpError(Exception):
    def __init__(self, status_code, headers=None):
        self.response = type(
            "Response", (), {"status_code": status_code, "headers": headers or {}}
        )()


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
    def interaction(interaction_date, person_ids=("p1",)):
        return {
            "properties": {
                "Date": {
                    "type": "date",
                    "date": (
                        {"start": interaction_date}
                        if interaction_date is not None
                        else None
                    ),
                },
                "People": {
                    "type": "relation",
                    "relation": [{"id": person_id} for person_id in person_ids],
                },
            }
        }


class PeopleDueListTests(unittest.TestCase):
    """Slice 3: bulk evaluation, ordering, limits, and Slack formatting."""

    def test_multiple_due_people_are_returned(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.person("p1", "Alex", "1 month"),
                        self.person("p2", "Blair", "1 month"),
                    ]
                ),
                self.response(
                    [
                        self.interaction("2026-06-01", person_ids=("p1",)),
                        self.interaction("2026-08-01", person_ids=("p2",)),
                    ]
                ),
            ]
        )

        due_people, is_incomplete, _ = self.call_find_due_people(notion_post)

        self.assertEqual(
            [due_person.person.name for due_person in due_people],
            ["Alex", "Blair"],
        )

    def test_people_not_due_are_excluded(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.person("p1", "Alex", "1 month"),
                        self.person("p2", "Blair", "1 month"),
                    ]
                ),
                self.response(
                    [
                        # Alex's next contact isn't due until 2026-10-01.
                        self.interaction("2026-09-01", person_ids=("p1",)),
                        # Blair's next contact was due 2026-07-01.
                        self.interaction("2026-06-01", person_ids=("p2",)),
                    ]
                ),
            ]
        )

        due_people, is_incomplete, _ = self.call_find_due_people(notion_post)

        self.assertEqual([due_person.person.name for due_person in due_people], ["Blair"])

    def test_ordering_places_most_overdue_first(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.person("p1", "A", "1 month"),
                        self.person("p2", "B", "1 month"),
                        self.person("p3", "C", "1 month"),
                    ]
                ),
                self.response(
                    [
                        self.interaction("2026-08-01", person_ids=("p1",)),  # due 09-01
                        self.interaction("2026-06-01", person_ids=("p2",)),  # due 07-01
                        self.interaction("2026-07-01", person_ids=("p3",)),  # due 08-01
                    ]
                ),
            ]
        )

        due_people, is_incomplete, _ = self.call_find_due_people(notion_post)

        self.assertEqual(
            [due_person.person.name for due_person in due_people], ["B", "C", "A"]
        )

    def test_no_previous_interaction_people_are_ordered_after_dated_overdue(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.person("p1", "Aaron", "1 month"),
                        self.person("p2", "Zack", "1 month"),
                    ]
                ),
                self.response(
                    [
                        # Only Zack has an Interaction; Aaron has none.
                        self.interaction("2026-06-01", person_ids=("p2",)),
                    ]
                ),
            ]
        )

        due_people, is_incomplete, _ = self.call_find_due_people(notion_post)

        self.assertEqual(
            [due_person.person.name for due_person in due_people], ["Zack", "Aaron"]
        )
        self.assertIsNone(due_people[1].next_contact_due)

    def test_name_is_a_stable_tiebreaker_within_each_group(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.person("p1", "Zoe", "1 month"),
                        self.person("p2", "Amy", "1 month"),
                        self.person("p3", "Zed", "1 month"),
                        self.person("p4", "Ann", "1 month"),
                    ]
                ),
                self.response(
                    [
                        # Zoe and Amy share the same next contact due date.
                        self.interaction("2026-06-01", person_ids=("p1",)),
                        self.interaction("2026-06-01", person_ids=("p2",)),
                        # Zed and Ann have no Interaction (no-interaction group).
                    ]
                ),
            ]
        )

        due_people, is_incomplete, _ = self.call_find_due_people(notion_post)

        self.assertEqual(
            [due_person.person.name for due_person in due_people],
            ["Amy", "Zoe", "Ann", "Zed"],
        )

    def test_person_without_cadence_is_excluded_from_bulk_evaluation(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.person("p1", "NoCadence", None),
                        self.person("p2", "Blair", "1 month"),
                    ]
                ),
                self.response([]),
            ]
        )

        due_people, is_incomplete, _ = self.call_find_due_people(notion_post)

        self.assertEqual([due_person.person.name for due_person in due_people], ["Blair"])
        self.assertEqual(notion_post.call_count, 2)

    def test_no_due_people_produces_the_deterministic_empty_state(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.person("p1", "Alex", "1 month"),
                        self.person("p2", "Blair", "1 month"),
                    ]
                ),
                self.response(
                    [
                        self.interaction("2026-09-10", person_ids=("p1",)),
                        self.interaction("2026-09-15", person_ids=("p2",)),
                    ]
                ),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )

        handle_people_command(
            "/people", "due", post_slack_message, notion_post,
            self.environment(), today=FIXED_TODAY, sleep=Mock(),
        )

        self.assertEqual(
            post_slack_message.call_args_list[-1].args[0], NO_DUE_PERSON_MESSAGE
        )

    def test_reads_are_query_only_and_bounded_to_two_notion_calls(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.person("p1", "Alex", "1 month"),
                        self.person("p2", "Blair", "1 month"),
                    ]
                ),
                self.response(
                    [
                        self.interaction("2026-06-01", person_ids=("p1",)),
                        self.interaction("2026-08-01", person_ids=("p2",)),
                    ]
                ),
            ]
        )

        self.call_find_due_people(notion_post)

        self.assertEqual(notion_post.call_count, 2)
        self.assertTrue(
            all(call.args[0].endswith("/query") for call in notion_post.call_args_list)
        )

    def test_result_count_is_bounded_and_shows_a_remainder_indicator(self):
        due_people = [
            self.due_person(f"Person{index:02d}") for index in range(25)
        ]

        message = format_due_people(due_people)

        blocks = message.split("\n\n")
        self.assertEqual(len(blocks), MAX_DISPLAYED_PEOPLE + 1)
        self.assertEqual(blocks[-1], "+5 more")
        self.assertIn("Person00", message)
        self.assertNotIn("Person24", message)

    def test_result_within_the_limit_has_no_remainder_indicator(self):
        due_people = [self.due_person(f"Person{index:02d}") for index in range(3)]

        message = format_due_people(due_people)

        self.assertNotIn("more", message)

    def test_people_pagination_collects_every_page_when_complete(self):
        notion_post = Mock(
            side_effect=[
                self.paged_response(
                    [self.person("p1", "Alex", "1 month")],
                    has_more=True,
                    next_cursor="cursor-2",
                ),
                self.paged_response([self.person("p2", "Blair", "1 month")]),
                self.response([]),
            ]
        )

        due_people, is_incomplete, _ = self.call_find_due_people(notion_post)

        self.assertEqual(
            [due_person.person.name for due_person in due_people], ["Alex", "Blair"]
        )
        self.assertFalse(is_incomplete)
        self.assertEqual(notion_post.call_count, 3)
        self.assertEqual(
            notion_post.call_args_list[1].kwargs["json"]["start_cursor"], "cursor-2"
        )

    def test_people_scan_reaching_the_bound_marks_the_result_incomplete(self):
        people_pages = [
            self.paged_response(
                [self.person(f"p{page}", f"Person{page}", "1 month")],
                has_more=True,
                next_cursor=f"cursor-{page + 1}",
            )
            for page in range(1, 6)
        ]
        notion_post = Mock(side_effect=[*people_pages, self.response([])])

        due_people, is_incomplete, _ = self.call_find_due_people(notion_post)

        # All 5 scanned People had no Interaction within the bound, so all
        # are (possibly incorrectly) evaluated as due; is_incomplete tells
        # the caller not to trust this as a complete or reliable result.
        self.assertEqual(len(due_people), 5)
        self.assertTrue(is_incomplete)
        self.assertEqual(notion_post.call_count, 6)

    def test_missing_next_cursor_marks_incomplete_without_looping_forever(self):
        notion_post = Mock(
            side_effect=[
                self.paged_response(
                    [self.person("p1", "Alex", "1 month")],
                    has_more=True,
                    next_cursor=None,
                ),
                self.response([]),
            ]
        )

        due_people, is_incomplete, _ = self.call_find_due_people(notion_post)

        self.assertTrue(is_incomplete)
        self.assertEqual(notion_post.call_count, 2)

    def test_interaction_scan_bound_flags_incomplete_instead_of_mislabeling(self):
        interaction_pages = [
            self.paged_response(
                [self.interaction(f"2026-0{page}-01", person_ids=("someone-else",))],
                has_more=True,
                next_cursor=f"cursor-{page + 1}",
            )
            for page in range(1, 6)
        ]
        notion_post = Mock(
            side_effect=[
                self.response([self.person("p1", "Alex", "1 month")]),
                *interaction_pages,
            ]
        )

        due_people, is_incomplete, _ = self.call_find_due_people(notion_post)

        # Alex's real Interaction, if any, was never reached by the bounded
        # scan (every scanned page belonged to another Person), so Alex is
        # shown due with no previous Interaction. is_incomplete flags that
        # this cannot be trusted as a confirmed "no previous interaction".
        self.assertEqual([due_person.person.name for due_person in due_people], ["Alex"])
        self.assertIsNone(due_people[0].latest_interaction)
        self.assertTrue(is_incomplete)
        self.assertEqual(notion_post.call_count, 6)

    def test_incomplete_scan_appends_a_disclaimer_after_the_due_list(self):
        people_pages = [
            self.paged_response(
                [self.person(f"p{page}", f"Person{page}", "1 month")],
                has_more=True,
                next_cursor=f"cursor-{page + 1}",
            )
            for page in range(1, 6)
        ]
        notion_post = Mock(side_effect=[*people_pages, self.response([])])
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )

        handle_people_command(
            "/people", "due", post_slack_message, notion_post,
            self.environment(), today=FIXED_TODAY, sleep=Mock(),
        )

        output = post_slack_message.call_args_list[-1].args[0]
        self.assertIn("Person1", output)
        self.assertIn(INCOMPLETE_SCAN_MESSAGE, output)

    def test_incomplete_scan_replaces_the_empty_state_message(self):
        notion_post = Mock(
            side_effect=[
                self.paged_response(
                    [self.person("p1", "Alex", "1 month")],
                    has_more=True,
                    next_cursor=None,
                ),
                # Alex's next contact isn't due until 2026-10-01.
                self.response([self.interaction("2026-09-01", person_ids=("p1",))]),
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
        self.assertEqual(output, INCOMPLETE_SCAN_MESSAGE)

    @staticmethod
    def paged_response(results, has_more=False, next_cursor=None):
        response = Mock()
        response.json.return_value = {
            "results": results,
            "has_more": has_more,
            "next_cursor": next_cursor,
        }
        return response

    def call_find_due_people(self, notion_post):
        return find_due_people(
            notion_post,
            "secret-token",
            "people-id",
            "interactions-id",
            FIXED_TODAY,
            Mock(),
        )

    @staticmethod
    def due_person(name, latest_interaction=None, next_contact_due=None):
        return DuePerson(
            Person(name, name, "1 month"), latest_interaction, next_contact_due
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
    def interaction(interaction_date, person_ids=("p1",)):
        return {
            "properties": {
                "Date": {
                    "type": "date",
                    "date": (
                        {"start": interaction_date}
                        if interaction_date is not None
                        else None
                    ),
                },
                "People": {
                    "type": "relation",
                    "relation": [{"id": person_id} for person_id in person_ids],
                },
            }
        }


class PeopleDueRobustnessTests(unittest.TestCase):
    """Slice 4: malformed records, Notion failures, and safe reporting."""

    def test_malformed_person_record_does_not_block_other_people(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.malformed_person("p1"),
                        self.person("p2", "Blair", "1 month"),
                    ]
                ),
                self.response([]),
            ]
        )

        due_people, is_incomplete, skipped_person_count = self.call_find_due_people(
            notion_post
        )

        self.assertEqual([d.person.name for d in due_people], ["Blair"])
        self.assertEqual(skipped_person_count, 1)
        self.assertFalse(is_incomplete)

    def test_invalid_cadence_is_skipped_without_being_interpreted(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.person("p1", "Weekly Alex", "weekly"),
                        self.person("p2", "Blair", "1 month"),
                    ]
                ),
                self.response([]),
            ]
        )

        due_people, is_incomplete, skipped_person_count = self.call_find_due_people(
            notion_post
        )

        self.assertEqual([d.person.name for d in due_people], ["Blair"])
        self.assertEqual(skipped_person_count, 1)

    def test_malformed_interaction_record_does_not_block_valid_people(self):
        notion_post = Mock(
            side_effect=[
                self.response([self.person("p1", "Alex", "1 month")]),
                self.response(
                    [
                        {},  # entirely malformed Interaction page
                        self.interaction("2026-09-01", person_ids=("p1",)),
                    ]
                ),
            ]
        )

        due_people, is_incomplete, skipped_person_count = self.call_find_due_people(
            notion_post
        )

        # Alex's real Interaction on 2026-09-01 makes the next contact due
        # 2026-10-01, so Alex is correctly not due yet. If the malformed
        # record had crashed or corrupted the scan, this would fail.
        self.assertEqual(due_people, [])
        self.assertFalse(is_incomplete)

    def test_missing_and_invalid_interaction_dates_do_not_crash_the_scan(self):
        notion_post = Mock(
            side_effect=[
                self.response([self.person("p1", "Alex", "1 month")]),
                self.response(
                    [
                        {},  # missing "properties" entirely
                        self.interaction(None, person_ids=("p1",)),  # missing Date value
                        {
                            "properties": {
                                "Date": {"type": "rich_text"},
                                "People": {
                                    "type": "relation",
                                    "relation": [{"id": "p1"}],
                                },
                            }
                        },  # Date has the wrong property type
                    ]
                ),
            ]
        )

        due_people, is_incomplete, skipped_person_count = self.call_find_due_people(
            notion_post
        )

        self.assertEqual([d.person.name for d in due_people], ["Alex"])
        self.assertIsNone(due_people[0].latest_interaction)
        self.assertFalse(is_incomplete)

    def test_malformed_person_is_skipped_and_reported_with_a_count(self):
        notion_post = Mock(
            side_effect=[
                self.response(
                    [
                        self.malformed_person("p1"),
                        self.person("p2", "Blair", "1 month"),
                    ]
                ),
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
        self.assertIn("Blair", output)
        self.assertIn("Skipped 1 malformed person.", output)

    def test_transient_notion_failure_recovers_via_shared_retry(self):
        people_response = self.response([self.person("p1", "Alex", "1 month")])
        rate_limited = Mock()
        rate_limited.raise_for_status.side_effect = NotionHttpError(
            429, {"Retry-After": "2"}
        )
        interactions_response = self.response([])
        notion_post = Mock(
            side_effect=[people_response, rate_limited, interactions_response]
        )
        sleep = Mock()

        due_people, is_incomplete, skipped_person_count = find_due_people(
            notion_post, "secret-token", "people-id", "interactions-id",
            FIXED_TODAY, sleep,
        )

        self.assertEqual(notion_post.call_count, 3)
        sleep.assert_called_once_with(2.0)
        self.assertEqual([d.person.name for d in due_people], ["Alex"])
        self.assertFalse(is_incomplete)

    def test_notion_auth_failure_is_not_retried_and_propagates_uncaught(self):
        unauthorized = Mock()
        unauthorized.raise_for_status.side_effect = NotionHttpError(401)
        notion_post = Mock(return_value=unauthorized)
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )
        sleep = Mock()

        with self.assertRaises(NotionAuthenticationError):
            handle_people_command(
                "/people", "due", post_slack_message, notion_post,
                self.environment(), today=FIXED_TODAY, sleep=sleep,
            )

        notion_post.assert_called_once()
        sleep.assert_not_called()
        # Only the root "/people due" message was posted before the
        # unretryable failure propagated, matching /tasks convention.
        self.assertEqual(post_slack_message.call_count, 1)

    def test_exhausted_transient_failure_produces_a_safe_generic_message(self):
        failing = Mock()
        failing.raise_for_status.side_effect = NotionHttpError(503)
        notion_post = Mock(return_value=failing)
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )
        sleep = Mock()

        handle_people_command(
            "/people", "due", post_slack_message, notion_post,
            self.environment(), today=FIXED_TODAY, sleep=sleep,
        )

        output = post_slack_message.call_args_list[-1].args[0]
        self.assertEqual(output, PEOPLE_FAILURE_MESSAGE)
        self.assertNotIn("secret-token", output)
        self.assertEqual(notion_post.call_count, 3)

    def test_malformed_query_response_produces_a_safe_message_without_raw_payload(self):
        malformed = Mock()
        malformed.json.return_value = {"results": "not-a-list-of-people"}
        notion_post = Mock(return_value=malformed)
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )

        handle_people_command(
            "/people", "due", post_slack_message, notion_post,
            self.environment(), today=FIXED_TODAY, sleep=Mock(),
        )

        output = post_slack_message.call_args_list[-1].args[0]
        self.assertEqual(output, PEOPLE_FAILURE_MESSAGE)
        self.assertNotIn("not-a-list-of-people", output)

    def call_find_due_people(self, notion_post):
        return find_due_people(
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
    def malformed_person(page_id):
        return {
            "id": page_id,
            "properties": {
                "Contact cadence": {
                    "type": "select",
                    "select": {"name": "1 month"},
                },
                # "Name" is missing entirely.
            },
        }

    @staticmethod
    def interaction(interaction_date, person_ids=("p1",)):
        return {
            "properties": {
                "Date": {
                    "type": "date",
                    "date": (
                        {"start": interaction_date}
                        if interaction_date is not None
                        else None
                    ),
                },
                "People": {
                    "type": "relation",
                    "relation": [{"id": person_id} for person_id in person_ids],
                },
            }
        }


if __name__ == "__main__":
    unittest.main()
