import json
import unittest
from datetime import date
from unittest.mock import Mock

from people_due import PeopleDueCommandError
from people_interaction import ADD_INTERACTION_ACTION_ID
from people_suggest import (
    MAX_SUGGESTION_INTERACTIONS,
    PEOPLE_SUGGEST_FAILURE_MESSAGE,
    SLACK_SECTION_TEXT_LIMIT,
    ambiguous_person_message,
    build_recap_prompt,
    build_suggestion_prompt,
    collect_track_ids,
    extract_property_text,
    extract_relation_ids,
    fetch_recent_interactions,
    handle_people_suggest,
    person_not_found_message,
    person_profile_from_notion_page,
    relevant_track_names,
    resolve_person,
    resolve_track_names,
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


def relation(track_ids):
    return {
        "type": "relation",
        "relation": [{"id": track_id} for track_id in track_ids],
    }


def person_page(page_id, name, track_ids=(), **extra_properties):
    properties = {"Name": {"type": "title", "title": [{"plain_text": name}]}}
    if track_ids:
        properties["Track Goal"] = relation(track_ids)
    properties.update(extra_properties)
    return {"id": page_id, "properties": properties}


def interaction_page(
    interaction_date=None,
    type_=None,
    title=None,
    notes=None,
    person_ids=("p1",),
    track_ids=(),
):
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
    if track_ids:
        properties["Track"] = relation(track_ids)
    return {"properties": properties}


def track_page(name, priority=None):
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


def notion_response(results):
    response = Mock()
    response.json.return_value = {"results": results}
    return response


def notion_get_response(json_body):
    response = Mock()
    response.json.return_value = json_body
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


class PersonProfileTrackTests(unittest.TestCase):
    def test_track_goal_relation_is_captured(self):
        page = person_page("p1", "Jane Doe", track_ids=["track-1", "track-2"])

        profile = person_profile_from_notion_page(page)

        self.assertEqual(profile.track_ids, ("track-1", "track-2"))

    def test_missing_track_goal_is_empty(self):
        page = person_page("p1", "Jane Doe")

        profile = person_profile_from_notion_page(page)

        self.assertEqual(profile.track_ids, ())

    def test_malformed_track_goal_relation_is_safely_ignored(self):
        page = person_page("p1", "Jane Doe")
        page["properties"]["Track Goal"] = {"type": "rich_text", "rich_text": []}

        profile = person_profile_from_notion_page(page)

        self.assertEqual(profile.track_ids, ())


class ExtractPropertyTextTests(unittest.TestCase):
    def test_multi_select_joins_names(self):
        properties = {"Interests": multi_select(["Climbing", "Chess"])}

        self.assertEqual(
            extract_property_text(properties, "Interests"), "Climbing, Chess"
        )

    def test_missing_property_returns_none(self):
        self.assertIsNone(extract_property_text({}, "Notes"))


class ExtractRelationIdsTests(unittest.TestCase):
    def test_reads_relation_ids(self):
        properties = {"Tracks": relation(["t1", "t2"])}

        self.assertEqual(extract_relation_ids(properties, "Tracks"), ("t1", "t2"))

    def test_missing_property_returns_empty(self):
        self.assertEqual(extract_relation_ids({}, "Tracks"), ())

    def test_non_relation_property_returns_empty(self):
        properties = {"Tracks": select("Not a relation")}

        self.assertEqual(extract_relation_ids(properties, "Tracks"), ())

    def test_relation_entries_missing_id_are_skipped(self):
        properties = {"Tracks": {"type": "relation", "relation": [{}, {"id": "t1"}]}}

        self.assertEqual(extract_relation_ids(properties, "Tracks"), ("t1",))


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

    def test_tracks_relation_is_captured(self):
        pages = [interaction_page("2026-01-01", title="Chat", track_ids=["t1", "t2"])]
        notion_post = Mock(return_value=notion_response(pages))

        summaries = fetch_recent_interactions(
            notion_post, "secret", "interactions-id", "p1", FIXED_TODAY, Mock()
        )

        self.assertEqual(summaries[0].track_ids, ("t1", "t2"))

    def test_missing_tracks_relation_is_empty(self):
        pages = [interaction_page("2026-01-01", title="Chat")]
        notion_post = Mock(return_value=notion_response(pages))

        summaries = fetch_recent_interactions(
            notion_post, "secret", "interactions-id", "p1", FIXED_TODAY, Mock()
        )

        self.assertEqual(summaries[0].track_ids, ())


class CollectTrackIdsTests(unittest.TestCase):
    def test_dedupes_across_person_and_interactions_preserving_order(self):
        from people_suggest import InteractionSummary, PersonProfile

        profile = PersonProfile(
            page_id="p1", name="Jane", context_fields=(), track_ids=("t1", "t2")
        )
        interactions = [
            InteractionSummary(
                date=None, type=None, title=None, notes=None, track_ids=("t2", "t3")
            ),
            InteractionSummary(
                date=None, type=None, title=None, notes=None, track_ids=("t3",)
            ),
        ]

        self.assertEqual(collect_track_ids(profile, interactions), ("t1", "t2", "t3"))

    def test_no_tracks_returns_empty(self):
        from people_suggest import PersonProfile

        profile = PersonProfile(page_id="p1", name="Jane", context_fields=())

        self.assertEqual(collect_track_ids(profile, []), ())


class ResolveTrackNamesTests(unittest.TestCase):
    def test_resolves_each_distinct_id_once(self):
        notion_get = Mock(return_value=notion_get_response(track_page("AI Network")))

        resolved = resolve_track_names(("t1", "t1"), notion_get, "secret", Mock())

        self.assertEqual(resolved, {"t1": "AI Network"})
        notion_get.assert_called_once()

    def test_multiple_distinct_tracks_each_resolved(self):
        notion_get = Mock(
            side_effect=[
                notion_get_response(track_page("AI Network")),
                notion_get_response(track_page("Investors")),
            ]
        )

        resolved = resolve_track_names(("t1", "t2"), notion_get, "secret", Mock())

        self.assertEqual(resolved, {"t1": "AI Network", "t2": "Investors"})

    def test_notion_get_none_resolves_nothing(self):
        resolved = resolve_track_names(("t1",), None, "secret", Mock())

        self.assertEqual(resolved, {})

    def test_malformed_track_page_is_omitted_not_raised(self):
        notion_get = Mock(return_value=notion_get_response({"properties": {}}))

        resolved = resolve_track_names(("t1",), notion_get, "secret", Mock())

        self.assertEqual(resolved, {"t1": None})

    def test_no_track_ids_makes_no_requests(self):
        notion_get = Mock()

        resolved = resolve_track_names((), notion_get, "secret", Mock())

        self.assertEqual(resolved, {})
        notion_get.assert_not_called()


class RelevantTrackNamesTests(unittest.TestCase):
    def test_filters_unresolved_and_dedupes_names(self):
        names = relevant_track_names(
            ("t1", "t2", "t3"),
            {"t1": "AI Network", "t2": None, "t3": "AI Network"},
        )

        self.assertEqual(names, ["AI Network"])

    def test_empty_when_nothing_resolved(self):
        self.assertEqual(relevant_track_names(("t1",), {}), [])


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

    def test_track_names_never_appear_in_the_message_prompt(self):
        from people_suggest import PersonProfile

        profile = PersonProfile(page_id="p1", name="Jane Doe", context_fields=())

        prompt = build_suggestion_prompt(profile, [])

        self.assertNotIn("RELEVANT TRACKS", prompt)
        self.assertNotIn("Track", prompt)


class BuildRecapPromptTests(unittest.TestCase):
    def test_no_tracks_omits_track_section(self):
        from people_suggest import PersonProfile

        profile = PersonProfile(page_id="p1", name="Jane Doe", context_fields=())

        prompt = build_recap_prompt(profile, [], [])

        self.assertNotIn("RELEVANT TRACKS", prompt)

    def test_track_names_are_included_verbatim(self):
        from people_suggest import PersonProfile

        profile = PersonProfile(page_id="p1", name="Jane Doe", context_fields=())

        prompt = build_recap_prompt(profile, [], ["AI Network", "Investors"])

        self.assertIn("RELEVANT TRACKS:", prompt)
        self.assertIn("- AI Network", prompt)
        self.assertIn("- Investors", prompt)

    def test_no_interactions_says_so_explicitly(self):
        from people_suggest import PersonProfile

        profile = PersonProfile(page_id="p1", name="Jane Doe", context_fields=())

        prompt = build_recap_prompt(profile, [], [])

        self.assertIn("No previous Interactions are recorded.", prompt)


class HandlePeopleSuggestTests(unittest.TestCase):
    def test_valid_exact_match_returns_gemini_draft_to_slack(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response([]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["- Recap bullet.", "Hey Jane, been a while!"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        self.assertEqual(generate_text.call_count, 2)
        output = post_slack_message.call_args_list[-1].args[0]
        self.assertEqual(
            output,
            "Context:\n- Recap bullet.\n\n"
            "Suggested message for Jane Doe:\n\nHey Jane, been a while!",
        )
        self.assertEqual(
            [call.args[0] for call in notion_post.call_args_list],
            [PEOPLE_URL, INTERACTIONS_URL],
        )

    def test_reply_includes_an_add_interaction_button_carrying_the_person_page_id(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response([]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["- Recap bullet.", "Hey Jane, been a while!"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        blocks = post_slack_message.call_args_list[-1].kwargs["blocks"]
        actions_block = next(block for block in blocks if block["type"] == "actions")
        button = actions_block["elements"][0]
        self.assertEqual(button["action_id"], ADD_INTERACTION_ACTION_ID)
        self.assertEqual(
            json.loads(button["value"]), {"page_id": "p1", "name": "Jane Doe"}
        )

    def test_reply_includes_a_context_recap_block_before_the_message_block(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response([]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["- Recap bullet.", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        blocks = post_slack_message.call_args_list[-1].kwargs["blocks"]
        section_blocks = [block for block in blocks if block["type"] == "section"]
        self.assertEqual(len(section_blocks), 2)
        self.assertIn("Context:\n- Recap bullet.", section_blocks[0]["text"]["text"])
        self.assertIn("Suggested message for Jane Doe:", section_blocks[1]["text"]["text"])

    def test_an_oversized_gemini_draft_is_truncated_to_slacks_block_text_limit(self):
        # Gemini's output has no length cap of its own; a draft over Slack's
        # ~3000-char section-block limit must not break the reply.
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response([]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        oversized_draft = "x" * 4000
        generate_text = Mock(side_effect=["- Recap bullet.", oversized_draft])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        # The plain-text fallback (a much higher Slack limit) keeps the full
        # draft; only the rendered section block is truncated.
        output = post_slack_message.call_args_list[-1].args[0]
        self.assertIn(oversized_draft, output)

        blocks = post_slack_message.call_args_list[-1].kwargs["blocks"]
        message_block = next(
            block
            for block in blocks
            if block["type"] == "section"
            and "Suggested message" in block["text"]["text"]
        )
        self.assertLessEqual(len(message_block["text"]["text"]), SLACK_SECTION_TEXT_LIMIT)

    def test_case_insensitive_input_still_resolves(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response([]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

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
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
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
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
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
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Generic honest draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        message_prompt = generate_text.call_args_list[1].args[0]
        self.assertIn("No previous Interactions are recorded.", message_prompt)

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
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        for prompt in (call.args[0] for call in generate_text.call_args_list):
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
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
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

    def test_person_with_one_track_includes_it_in_the_recap_context(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response(
                    [
                        interaction_page(
                            "2026-08-01",
                            type_="Coffee",
                            title="Coffee chat",
                            track_ids=["track-1"],
                        )
                    ]
                ),
            ]
        )
        notion_get = Mock(return_value=notion_get_response(track_page("AI Network")))
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["- Relevant Track: AI Network", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
            notion_get=notion_get,
        )

        recap_prompt = generate_text.call_args_list[0].args[0]
        self.assertIn("RELEVANT TRACKS:", recap_prompt)
        self.assertIn("- AI Network", recap_prompt)
        notion_get.assert_called_once()
        self.assertEqual(
            notion_get.call_args.args[0],
            "https://api.notion.com/v1/pages/track-1",
        )

    def test_multiple_interactions_referencing_the_same_track_resolve_it_once(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response(
                    [
                        interaction_page("2026-08-01", title="Coffee", track_ids=["track-1"]),
                        interaction_page("2026-07-01", title="Call", track_ids=["track-1"]),
                    ]
                ),
            ]
        )
        notion_get = Mock(return_value=notion_get_response(track_page("AI Network")))
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
            notion_get=notion_get,
        )

        # Bounded to one GET per distinct Track id, never per Interaction.
        notion_get.assert_called_once()

    def test_multiple_relevant_tracks_are_all_included(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe", track_ids=["track-1"])]),
                notion_response(
                    [interaction_page("2026-08-01", title="Coffee", track_ids=["track-2"])]
                ),
            ]
        )
        notion_get = Mock(
            side_effect=[
                notion_get_response(track_page("AI Network")),
                notion_get_response(track_page("Investors")),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
            notion_get=notion_get,
        )

        recap_prompt = generate_text.call_args_list[0].args[0]
        self.assertIn("- AI Network", recap_prompt)
        self.assertIn("- Investors", recap_prompt)

    def test_no_track_omits_track_context_and_makes_no_track_requests(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response([interaction_page("2026-08-01", title="Coffee")]),
            ]
        )
        notion_get = Mock()
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
            notion_get=notion_get,
        )

        recap_prompt = generate_text.call_args_list[0].args[0]
        self.assertNotIn("RELEVANT TRACKS", recap_prompt)
        notion_get.assert_not_called()

    def test_malformed_track_relation_is_treated_as_no_track(self):
        person = person_page("p1", "Jane Doe")
        person["properties"]["Track Goal"] = {"type": "rich_text", "rich_text": []}
        notion_post = Mock(
            side_effect=[
                notion_response([person]),
                notion_response([]),
            ]
        )
        notion_get = Mock()
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
            notion_get=notion_get,
        )

        recap_prompt = generate_text.call_args_list[0].args[0]
        self.assertNotIn("RELEVANT TRACKS", recap_prompt)
        notion_get.assert_not_called()

    def test_unresolvable_track_is_omitted_without_inventing_a_name(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe", track_ids=["track-1"])]),
                notion_response([]),
            ]
        )
        notion_get = Mock(return_value=notion_get_response({"properties": {}}))
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
            notion_get=notion_get,
        )

        recap_prompt = generate_text.call_args_list[0].args[0]
        self.assertNotIn("RELEVANT TRACKS", recap_prompt)

    def test_track_names_are_not_leaked_into_the_outbound_message_prompt(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe", track_ids=["track-1"])]),
                notion_response([]),
            ]
        )
        notion_get = Mock(return_value=notion_get_response(track_page("AI Network")))
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["- Relevant Track: AI Network", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
            notion_get=notion_get,
        )

        message_prompt = generate_text.call_args_list[1].args[0]
        self.assertNotIn("AI Network", message_prompt)
        self.assertNotIn("RELEVANT TRACKS", message_prompt)

    def test_no_notion_get_supplied_skips_track_resolution(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe", track_ids=["track-1"])]),
                notion_response([]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        recap_prompt = generate_text.call_args_list[0].args[0]
        self.assertNotIn("RELEVANT TRACKS", recap_prompt)

    @staticmethod
    def environment():
        return {
            "NOTION_API_KEY": "secret-token",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "people-id",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }


def selectable_track_page(track_id, name):
    return {
        "id": track_id,
        "properties": {"Navn": {"type": "title", "title": [{"plain_text": name}]}},
    }


class AddInteractionTrackSelectorTests(unittest.TestCase):
    """Covers the Add Interaction button's Track selector data: which Track
    options are offered and which one (if any) is preselected, per issue
    #16's default-selection rules (no Track / exactly one Track / multiple
    Tracks).
    """

    def test_person_with_no_track_has_no_default_but_still_offers_all_tracks(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response([]),
                notion_response([selectable_track_page("t1", "AI Network")]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        button = self.add_interaction_button(post_slack_message)
        value = json.loads(button["value"])
        self.assertEqual(value["tracks"], [{"id": "t1", "name": "AI Network"}])
        self.assertNotIn("default_track_id", value)

    def test_person_with_exactly_one_track_preselects_it(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe", track_ids=["t1"])]),
                notion_response([]),
                notion_response(
                    [
                        selectable_track_page("t1", "AI Network"),
                        selectable_track_page("t2", "Investors"),
                    ]
                ),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        button = self.add_interaction_button(post_slack_message)
        value = json.loads(button["value"])
        self.assertEqual(value["default_track_id"], "t1")

    def test_person_with_multiple_tracks_has_no_default_but_can_still_choose(self):
        notion_post = Mock(
            side_effect=[
                notion_response(
                    [person_page("p1", "Jane Doe", track_ids=["t1", "t2"])]
                ),
                notion_response([]),
                notion_response(
                    [
                        selectable_track_page("t1", "AI Network"),
                        selectable_track_page("t2", "Investors"),
                    ]
                ),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        button = self.add_interaction_button(post_slack_message)
        value = json.loads(button["value"])
        self.assertNotIn("default_track_id", value)
        self.assertEqual(
            {track["id"] for track in value["tracks"]}, {"t1", "t2"}
        )

    def test_no_tracks_data_source_configured_omits_the_track_selector(self):
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe", track_ids=["t1"])]),
                notion_response([]),
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        environment = {
            "NOTION_API_KEY": "secret-token",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "people-id",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
        }

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            environment,
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        button = self.add_interaction_button(post_slack_message)
        self.assertEqual(json.loads(button["value"]), {"page_id": "p1", "name": "Jane Doe"})
        # No extra Notion call was made to list Tracks.
        self.assertEqual(notion_post.call_count, 2)

    def test_a_track_listing_failure_does_not_break_the_rest_of_the_reply(self):
        failing = Mock()
        failing.raise_for_status.side_effect = Exception("boom")
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response([]),
                failing,
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        # The reply still goes out; Track selection is simply unavailable.
        button = self.add_interaction_button(post_slack_message)
        self.assertEqual(json.loads(button["value"]), {"page_id": "p1", "name": "Jane Doe"})

    def test_a_track_listing_credential_failure_does_not_break_the_rest_of_the_reply(self):
        # A 401/403 from Notion raises NotionAuthenticationError, a distinct
        # exception type from a generic TaskListCommandError. Track
        # selection is still only an optional add-on to the reply, so this
        # must degrade the same way a generic listing failure does, not
        # crash the whole /people suggest command.
        failing = Mock()
        error = Exception("unauthorized")
        error.response = Mock(status_code=401)
        failing.raise_for_status.side_effect = error
        notion_post = Mock(
            side_effect=[
                notion_response([person_page("p1", "Jane Doe")]),
                notion_response([]),
                failing,
            ]
        )
        post_slack_message = Mock(
            side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"}
        )
        generate_text = Mock(side_effect=["Recap", "Draft"])

        handle_people_suggest(
            "Jane Doe",
            post_slack_message,
            notion_post,
            generate_text,
            self.environment(),
            today=FIXED_TODAY,
            sleep=Mock(),
        )

        button = self.add_interaction_button(post_slack_message)
        self.assertEqual(json.loads(button["value"]), {"page_id": "p1", "name": "Jane Doe"})
        output = post_slack_message.call_args_list[-1].args[0]
        self.assertIn("Suggested message for Jane Doe:", output)

    @staticmethod
    def add_interaction_button(post_slack_message):
        blocks = post_slack_message.call_args_list[-1].kwargs["blocks"]
        actions_block = next(block for block in blocks if block["type"] == "actions")
        return actions_block["elements"][0]

    @staticmethod
    def environment():
        return {
            "NOTION_API_KEY": "secret-token",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "people-id",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "interactions-id",
            "NOTION_TRACKS_DATA_SOURCE_ID": "tracks-id",
        }


if __name__ == "__main__":
    unittest.main()
