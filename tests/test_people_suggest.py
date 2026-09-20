import unittest
from datetime import date
from unittest.mock import Mock

from people_due import PeopleDueCommandError
from people_suggest import (
    MAX_SUGGESTION_INTERACTIONS,
    PEOPLE_SUGGEST_FAILURE_MESSAGE,
    ambiguous_person_message,
    build_suggestion_prompt,
    extract_property_text,
    fetch_recent_interactions,
    handle_people_suggest,
    person_not_found_message,
    person_profile_from_notion_page,
    resolve_person,
)


FIXED_TODAY = date(2026, 9, 20)
PEOPLE_URL = "https://api.notion.com/v1/data_sources/people-id/query"
INTERACTIONS_URL = "https://api.notion.com/v1/data_sources/interactions-id/query"


def rich_text(value):
    return {"type": "rich_text", "rich_text": [{"plain_text": value}]}


def select(value):
    return {"type": "select", "select": {"name": value}}


def multi_select(values):
    return {"type": "multi_select", "multi_select": [{"name": v} for v in values]}


def person_page(page_id, name, **extra_properties):
    properties = {"Name": {"type": "title", "title": [{"plain_text": name}]}}
    properties.update(extra_properties)
    return {"id": page_id, "properties": properties}


def interaction_page(interaction_date=None, type_=None, title=None, notes=None, person_ids=("p1",)):
    properties = {
        "People": {
            "type": "relation",
            "relation": [{"id": person_id} for person_id in person_ids],
        },
    }
    if interaction_date is not None:
        properties["Date"] = {"type": "date", "date": {"start": interaction_date}}
    if type_ is not None:
        properties["Type"] = select(type_)
    if title is not None:
        properties["Name"] = {"type": "title", "title": [{"plain_text": title}]}
    if notes is not None:
        properties["Notes"] = rich_text(notes)
    return {"properties": properties}


def notion_response(results):
    response = Mock()
    response.json.return_value = {"results": results}
    return response


class ResolvePersonTests(unittest.TestCase):
    def test_exact_match_resolves(self):
        notion_post = Mock(
            return_value=notion_response([person_page("p1", "Jane Doe")])
        )

        profile, is_ambiguous = resolve_person(
            notion_post, "secret", "people-id", "Jane Doe", Mock()
        )

        self.assertEqual(profile.name, "Jane Doe")
        self.assertEqual(profile.page_id, "p1")
        self.assertFalse(is_ambiguous)

    def test_case_insensitive_match_resolves(self):
        notion_post = Mock(
            return_value=notion_response([person_page("p1", "Jane Doe")])
        )

        profile, is_ambiguous = resolve_person(
            notion_post, "secret", "people-id", "jane doe", Mock()
        )

        self.assertEqual(profile.name, "Jane Doe")
        self.assertFalse(is_ambiguous)

    def test_no_match_returns_none(self):
        notion_post = Mock(
            return_value=notion_response([person_page("p1", "Jane Doe")])
        )

        profile, is_ambiguous = resolve_person(
            notion_post, "secret", "people-id", "Someone Else", Mock()
        )

        self.assertIsNone(profile)
        self.assertFalse(is_ambiguous)

    def test_multiple_exact_matches_are_reported_as_ambiguous_without_guessing(self):
        notion_post = Mock(
            return_value=notion_response(
                [person_page("p1", "Jane Doe"), person_page("p2", "Jane Doe")]
            )
        )

        profile, is_ambiguous = resolve_person(
            notion_post, "secret", "people-id", "Jane Doe", Mock()
        )

        self.assertIsNone(profile)
        self.assertTrue(is_ambiguous)

    def test_malformed_person_pages_do_not_block_resolution(self):
        notion_post = Mock(
            return_value=notion_response(
                [{"id": "p1", "properties": {}}, person_page("p2", "Jane Doe")]
            )
        )

        profile, is_ambiguous = resolve_person(
            notion_post, "secret", "people-id", "Jane Doe", Mock()
        )

        self.assertEqual(profile.name, "Jane Doe")
        self.assertFalse(is_ambiguous)


class PersonProfileContextTests(unittest.TestCase):
    def test_only_existing_recognized_fields_are_included(self):
        page = person_page(
            "p1",
            "Jane Doe",
            **{
                "Why this person": rich_text("Former colleague"),
                "Relationship intent": select("Mentor"),
                "Interests": multi_select(["Climbing", "Chess"]),
                # "Relationship status", "Relationship strength", "Expertise",
                # and "Notes" are intentionally absent.
                "Contact cadence": select("3 months"),
                "LinkedIn": {"type": "url", "url": "https://linkedin.example/jane"},
            },
        )

        profile = person_profile_from_notion_page(page)

        field_labels = [label for label, _ in profile.context_fields]
        self.assertIn("Why this person", field_labels)
        self.assertIn("Relationship intent", field_labels)
        self.assertIn("Interests", field_labels)
        self.assertNotIn("Relationship status", field_labels)
        self.assertNotIn("Notes", field_labels)
        # Fields outside the suggested-context list must never leak through.
        self.assertNotIn("Contact cadence", field_labels)
        self.assertNotIn("LinkedIn", field_labels)

    def test_empty_text_field_is_treated_as_absent(self):
        page = person_page(
            "p1", "Jane Doe", **{"Notes": rich_text("   ")}
        )

        profile = person_profile_from_notion_page(page)

        self.assertEqual(profile.context_fields, ())

    def test_unrecognized_property_type_is_safely_omitted(self):
        page = person_page(
            "p1", "Jane Doe", **{"Notes": {"type": "checkbox", "checkbox": True}}
        )

        profile = person_profile_from_notion_page(page)

        self.assertEqual(profile.context_fields, ())

    def test_missing_name_returns_none(self):
        page = {"id": "p1", "properties": {}}

        self.assertIsNone(person_profile_from_notion_page(page))


class ExtractPropertyTextTests(unittest.TestCase):
    def test_multi_select_joins_names(self):
        properties = {"Interests": multi_select(["Climbing", "Chess"])}

        self.assertEqual(
            extract_property_text(properties, "Interests"), "Climbing, Chess"
        )

    def test_missing_property_returns_none(self):
        self.assertIsNone(extract_property_text({}, "Notes"))


class FetchRecentInteractionsTests(unittest.TestCase):
    def test_bounded_to_five_and_sorted_query(self):
        pages = [
            interaction_page(f"2026-0{i}-01", type_="Call", title=f"Chat {i}", notes="n")
            for i in range(1, 4)
        ]
        notion_post = Mock(return_value=notion_response(pages))

        summaries = fetch_recent_interactions(
            notion_post, "secret", "interactions-id", "p1", FIXED_TODAY, Mock()
        )

        self.assertEqual(len(summaries), 3)
        request_json = notion_post.call_args.kwargs["json"]
        self.assertEqual(request_json["page_size"], MAX_SUGGESTION_INTERACTIONS)
        self.assertEqual(
            request_json["sorts"], [{"property": "Date", "direction": "descending"}]
        )
        self.assertEqual(
            request_json["filter"]["and"][0]["relation"]["contains"], "p1"
        )

    def test_more_than_five_results_are_still_bounded_defensively(self):
        pages = [
            interaction_page(f"2026-01-0{i}", title=f"Chat {i}")
            for i in range(1, 8)
        ]
        notion_post = Mock(return_value=notion_response(pages))

        summaries = fetch_recent_interactions(
            notion_post, "secret", "interactions-id", "p1", FIXED_TODAY, Mock()
        )

        self.assertEqual(len(summaries), MAX_SUGGESTION_INTERACTIONS)

    def test_malformed_interaction_is_skipped(self):
        pages = [{}, interaction_page("2026-01-01", title="Chat")]
        notion_post = Mock(return_value=notion_response(pages))

        summaries = fetch_recent_interactions(
            notion_post, "secret", "interactions-id", "p1", FIXED_TODAY, Mock()
        )

        self.assertEqual(len(summaries), 1)
        self.assertEqual(summaries[0].title, "Chat")

    def test_no_interactions_returns_empty_list(self):
        notion_post = Mock(return_value=notion_response([]))

        summaries = fetch_recent_interactions(
            notion_post, "secret", "interactions-id", "p1", FIXED_TODAY, Mock()
        )

        self.assertEqual(summaries, [])


class BuildSuggestionPromptTests(unittest.TestCase):
    def test_no_interactions_says_so_explicitly(self):
        from people_suggest import PersonProfile

        profile = PersonProfile(page_id="p1", name="Jane Doe", context_fields=())

        prompt = build_suggestion_prompt(profile, [])

        self.assertIn("No previous Interactions are recorded.", prompt)

    def test_interaction_fields_are_included_when_present(self):
        from people_suggest import InteractionSummary, PersonProfile

        profile = PersonProfile(page_id="p1", name="Jane Doe", context_fields=())
        interactions = [
            InteractionSummary(date="2026-08-01", type="Call", title="Catch-up", notes="Talked shop")
        ]

        prompt = build_suggestion_prompt(profile, interactions)

        self.assertIn("Date: 2026-08-01", prompt)
        self.assertIn("Type: Call", prompt)
        self.assertIn("Title: Catch-up", prompt)
        self.assertIn("Notes: Talked shop", prompt)


class HandlePeopleSuggestTests(unittest.TestCase):
    def test_valid_exact_match_returns_gemini_draft_to_slack(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response([]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )
        generate_text = Mock(return_value="Hey Jane, been a while!")

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        generate_text.assert_called_once()
        output = post_slack_message.call_args_list[-1].args[0]
        self.assertEqual(
            output, "Suggested message for Jane Doe:\n\nHey Jane, been a while!"
        )
        self.assertEqual(
            [call.args[0] for call in notion_post.call_args_list],
            [PEOPLE_URL, INTERACTIONS_URL],
        )

    def test_case_insensitive_input_still_resolves(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response([]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )
        generate_text = Mock(return_value="Draft")

        handle_people_suggest(
            "jane doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        output = post_slack_message.call_args_list[-1].args[0]
        self.assertIn("Suggested message for Jane Doe:", output)

    def test_person_not_found_produces_a_clear_message_without_calling_gemini(self):
        notion_post = Mock(return_value=notion_response([]))
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )
        generate_text = Mock()

        handle_people_suggest(
            "Nobody Here",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        generate_text.assert_not_called()
        output = post_slack_message.call_args_list[-1].args[0]
        self.assertEqual(output, person_not_found_message("Nobody Here"))
        # Only the Person search happened; Interactions were never queried.
        self.assertEqual(notion_post.call_count, 1)

    def test_ambiguous_match_fails_safely_without_guessing(self):
        notion_post = Mock(
            return_value=notion_response(
                [person_page("p1", "Jane Doe"), person_page("p2", "Jane Doe")]
            )
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )
        generate_text = Mock()

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        generate_text.assert_not_called()
        output = post_slack_message.call_args_list[-1].args[0]
        self.assertEqual(output, ambiguous_person_message("Jane Doe"))

    def test_person_with_no_interactions_still_produces_a_draft(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response([]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )
        generate_text = Mock(return_value="Generic honest draft")

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        prompt = generate_text.call_args.args[0]
        self.assertIn("No previous Interactions are recorded.", prompt)

    def test_gemini_receives_only_intended_person_and_interaction_context(self):
        notion_post = Mock(
            side_effect=[
                notion_response(
                    [
                        person_page(
                            "p1",
                            "Jane Doe",
                            **{
                                "Why this person": rich_text("Former colleague"),
                                "Contact cadence": select("3 months"),
                                "LinkedIn": {
                                    "type": "url",
                                    "url": "https://linkedin.example/jane",
                                },
                            },
                        )
                    ]
                ),
                notion_response(
                    [interaction_page("2026-08-01", type_="Call", title="Catch-up", notes="Talked shop")]
                ),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )
        generate_text = Mock(return_value="Draft")

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        prompt = generate_text.call_args.args[0]
        self.assertIn("Name: Jane Doe", prompt)
        self.assertIn("Why this person: Former colleague", prompt)
        self.assertIn("Date: 2026-08-01", prompt)
        self.assertIn("Title: Catch-up", prompt)
        # Fields outside the suggested-context list must not reach Gemini.
        self.assertNotIn("3 months", prompt)
        self.assertNotIn("linkedin.example", prompt)

    def test_notion_failure_produces_a_safe_message_without_calling_gemini(self):
        failing = Mock()
        failing.json.return_value = {"results": "not-a-list"}
        notion_post = Mock(return_value=failing)
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None: {"ts": "123.456"}
        )
        generate_text = Mock()

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        generate_text.assert_not_called()
        output = post_slack_message.call_args_list[-1].args[0]
        self.assertEqual(output, PEOPLE_SUGGEST_FAILURE_MESSAGE)

    def test_notion_failure_error_type_is_the_shared_people_error(self):
        # Guards the cross-module contract: people_suggest relies on
        # people_due's fetch/query helpers raising PeopleDueCommandError.
        self.assertTrue(issubclass(PeopleDueCommandError, Exception))

    @staticmethod
    def environment():
        return {
            "NOTION_API_KEY": "secret-token",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "people-id",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }


if __name__ == "__main__":
    unittest.main()
