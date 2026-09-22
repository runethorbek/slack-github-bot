import time
from dataclasses import dataclass

from people_due import (
    MAX_SCANNED_PEOPLE,
    PEOPLE_PAGE_SIZE,
    PeopleDueCommandError,
    fetch_notion_pages,
    query_data_source,
)
from people_interaction import add_interaction_button
from tasks_list import copenhagen_today


PEOPLE_SUGGEST_FAILURE_MESSAGE = (
    "Unable to prepare a suggested message right now. Please try again later."
)
MAX_SUGGESTION_INTERACTIONS = 5

# Slack rejects a section block whose mrkdwn text exceeds this length. Gemini's
# draft has no length cap of its own, so the block (not the plain-text
# fallback, which has a much higher limit) must be defensively truncated.
SLACK_SECTION_TEXT_LIMIT = 3000

# Notion People property display names, exactly as named in the schema.
PERSON_CONTEXT_PROPERTIES = (
    "Why this person",
    "Relationship intent",
    "Relationship status",
    "Relationship strength",
    "Interests",
    "Expertise",
    "Notes",
)

SUGGESTION_SYSTEM_INSTRUCTION = """
You are drafting a short reconnect message on behalf of the user. The user
will review the draft before deciding whether to send anything themselves.

Rules:
- Use only the context supplied below.
- Do not invent facts, relationship history, interests, commitments, or
  meetings that are not present in the supplied context.
- Do not decide who to contact; a person to contact has already been chosen.
- Draft a short, natural reconnect message.
- Keep it concise.
- Avoid sounding sales-oriented.
- Do not mention Notion, CRM fields, cadence, or internal metadata.
- If there is not enough context for a specific message, produce a generic
  but honest draft rather than inventing details.
- Respond with only the drafted message text, with no preamble or
  explanation.
"""


@dataclass(frozen=True)
class PersonProfile:
    page_id: str
    name: str
    context_fields: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class InteractionSummary:
    date: str | None
    type: str | None
    title: str | None
    notes: str | None


def person_not_found_message(person_name):
    return f'No Person found matching "{person_name}".'


def ambiguous_person_message(person_name):
    return (
        f'Multiple People match "{person_name}" exactly; '
        "cannot determine which one was meant."
    )


def handle_people_suggest(
    person_name,
    post_slack_message,
    notion_post,
    generate_text,
    environment,
    today=None,
    sleep=time.sleep,
):
    """Handle `/people suggest <person>`.

    Notion access and Person resolution stay entirely deterministic; Gemini
    (via the injected ``generate_text``) only ever sees the bounded context
    built here and is only ever asked to draft text, never to choose a
    Person or perform a side effect.
    """
    root_message = post_slack_message(f"/people suggest {person_name}")

    try:
        command_today = today or copenhagen_today()
        profile, is_ambiguous = resolve_person(
            notion_post,
            environment["NOTION_API_KEY"],
            environment["NOTION_PEOPLE_DATA_SOURCE_ID"],
            person_name,
            sleep,
        )
        interactions = (
            fetch_recent_interactions(
                notion_post,
                environment["NOTION_API_KEY"],
                environment["NOTION_INTERACTIONS_DATA_SOURCE_ID"],
                profile.page_id,
                command_today,
                sleep,
            )
            if profile is not None
            else []
        )
    except PeopleDueCommandError:
        post_slack_message(
            PEOPLE_SUGGEST_FAILURE_MESSAGE, thread_ts=root_message["ts"]
        )
        return

    if is_ambiguous:
        post_slack_message(
            ambiguous_person_message(person_name), thread_ts=root_message["ts"]
        )
        return
    if profile is None:
        post_slack_message(
            person_not_found_message(person_name), thread_ts=root_message["ts"]
        )
        return

    prompt = build_suggestion_prompt(profile, interactions)
    answer = generate_text(prompt).strip()
    message = format_suggestion_message(profile.name, answer)
    post_slack_message(
        message,
        thread_ts=root_message["ts"],
        blocks=build_suggestion_blocks(profile, message),
    )


def resolve_person(notion_post, api_key, people_data_source_id, person_name, sleep):
    """Find the Person whose Name matches exactly, ignoring case.

    Returns (profile, is_ambiguous). profile is None when there is no exact
    match; is_ambiguous is True when more than one Person matches, in which
    case the caller must not guess which one was meant.
    """

    def build_request_json(cursor):
        request_json = {"page_size": PEOPLE_PAGE_SIZE}
        if cursor:
            request_json["start_cursor"] = cursor
        return request_json

    pages, _ = fetch_notion_pages(
        notion_post,
        api_key,
        people_data_source_id,
        build_request_json,
        MAX_SCANNED_PEOPLE,
        PEOPLE_PAGE_SIZE,
        sleep,
    )

    target = person_name.casefold()
    matches = [
        profile
        for profile in (person_profile_from_notion_page(page) for page in pages)
        if profile is not None and profile.name.casefold() == target
    ]
    if len(matches) != 1:
        return None, len(matches) > 1
    return matches[0], False


def person_profile_from_notion_page(page):
    try:
        properties = page["properties"]
        name_property = properties["Name"]
        if name_property.get("type") != "title":
            return None
        name = " ".join(
            "".join(
                part.get("plain_text", "") for part in name_property.get("title", [])
            ).split()
        )
        page_id = page["id"]
        if not name or not page_id:
            return None
    except (AttributeError, KeyError, TypeError):
        return None

    context_fields = tuple(
        (property_name, value)
        for property_name in PERSON_CONTEXT_PROPERTIES
        for value in [extract_property_text(properties, property_name)]
        if value is not None
    )
    return PersonProfile(page_id=page_id, name=name, context_fields=context_fields)


def fetch_recent_interactions(
    notion_post, api_key, interactions_data_source_id, person_page_id, today, sleep
):
    request_json = {
        "page_size": MAX_SUGGESTION_INTERACTIONS,
        "filter": {
            "and": [
                {"property": "People", "relation": {"contains": person_page_id}},
                {"property": "Date", "date": {"is_not_empty": True}},
                {
                    "property": "Date",
                    "date": {"on_or_before": today.isoformat()},
                },
            ]
        },
        "sorts": [{"property": "Date", "direction": "descending"}],
    }
    pages = query_data_source(
        notion_post, api_key, interactions_data_source_id, request_json, sleep
    )

    summaries = []
    for page in pages[:MAX_SUGGESTION_INTERACTIONS]:
        summary = interaction_summary_from_notion_page(page)
        if summary is not None:
            summaries.append(summary)
    return summaries


def interaction_summary_from_notion_page(page):
    try:
        properties = page["properties"]
    except (AttributeError, KeyError, TypeError):
        return None
    if not isinstance(properties, dict):
        return None

    date_value = extract_interaction_date(properties)
    type_value = extract_property_text(properties, "Type")
    title_value = extract_title_text(properties)
    notes_value = extract_property_text(properties, "Notes")

    if not any((date_value, type_value, title_value, notes_value)):
        return None

    return InteractionSummary(
        date=date_value, type=type_value, title=title_value, notes=notes_value
    )


def extract_interaction_date(properties):
    date_property = properties.get("Date")
    if not isinstance(date_property, dict) or date_property.get("type") != "date":
        return None
    start = (date_property.get("date") or {}).get("start")
    return start if isinstance(start, str) and start else None


def extract_title_text(properties):
    for property_value in properties.values():
        if isinstance(property_value, dict) and property_value.get("type") == "title":
            text = "".join(
                part.get("plain_text", "") for part in property_value.get("title", [])
            ).strip()
            if text:
                return text
    return None


def extract_property_text(properties, display_name):
    """Read a People/Interaction property as plain text, if it exists.

    Only the text-shaped Notion property types actually used by this schema
    are recognized. A missing property, or one of a type not recognized
    here, is safely omitted rather than guessed at.
    """
    property_value = properties.get(display_name)
    if not isinstance(property_value, dict):
        return None

    property_type = property_value.get("type")
    if property_type == "rich_text":
        text = "".join(
            part.get("plain_text", "") for part in property_value.get("rich_text", [])
        ).strip()
        return text or None
    if property_type == "select":
        select = property_value.get("select") or {}
        name = select.get("name")
        return name if isinstance(name, str) and name else None
    if property_type == "multi_select":
        names = [
            option.get("name")
            for option in property_value.get("multi_select", [])
            if isinstance(option, dict) and option.get("name")
        ]
        return ", ".join(names) if names else None
    return None


def build_suggestion_prompt(profile, interactions):
    context_lines = [f"Name: {profile.name}"]
    context_lines.extend(
        f"{label}: {value}" for label, value in profile.context_fields
    )

    if interactions:
        interaction_lines = [
            "- " + "; ".join(formatted_interaction_fields(interaction))
            for interaction in interactions
        ]
        interactions_block = "\n".join(interaction_lines)
    else:
        interactions_block = "No previous Interactions are recorded."

    person_context = "\n".join(context_lines)
    return (
        f"{SUGGESTION_SYSTEM_INSTRUCTION}\n\n"
        f"PERSON CONTEXT:\n{person_context}\n\n"
        f"RECENT INTERACTIONS:\n{interactions_block}\n"
    )


def formatted_interaction_fields(interaction):
    fields = []
    if interaction.date:
        fields.append(f"Date: {interaction.date}")
    if interaction.type:
        fields.append(f"Type: {interaction.type}")
    if interaction.title:
        fields.append(f"Title: {interaction.title}")
    if interaction.notes:
        fields.append(f"Notes: {interaction.notes}")
    return fields


def format_suggestion_message(person_name, answer):
    return f"Suggested message for {person_name}:\n\n{answer}"


def build_suggestion_blocks(profile, message_text):
    return [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": truncate_for_slack_section(message_text),
            },
        },
        {
            "type": "actions",
            "elements": [add_interaction_button(profile.page_id, profile.name)],
        },
    ]


def truncate_for_slack_section(text):
    if len(text) <= SLACK_SECTION_TEXT_LIMIT:
        return text
    suffix = "…"
    return text[: SLACK_SECTION_TEXT_LIMIT - len(suffix)] + suffix
