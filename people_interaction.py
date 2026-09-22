import json
import time
from datetime import date

from tasks_list import (
    NotionAuthenticationError,
    TaskListCommandError,
    call_notion_with_retries,
    copenhagen_today,
    notion_headers,
)


# Matches ADD_INTERACTION_ACTION_ID in api/slack-request.js.
ADD_INTERACTION_ACTION_ID = "people_add_interaction"

# Matches ADD_INTERACTION_CALLBACK_ID in api/slack-request.js.
ADD_INTERACTION_CALLBACK_ID = "add_interaction_modal"

# The write path below independently validates a submitted Type against this
# exact allowlist before ever calling Notion, so a manipulated payload can
# never create a new Notion select option. Mirrored (for display only, not
# for validation) as INTERACTION_TYPE_OPTIONS in api/slack-request.js.
#
# Confirmed against the live Interactions "Type" select property.
ALLOWED_INTERACTION_TYPES = (
    "Coffee",
    "Network Meeting",
    "Meeting",
    "LinkedIn Message",
    "Online meeting",
    "Lunch",
    "LinkedIn invite",
    "Walk",
    "Phone call",
)

INTERACTION_ADDED_MESSAGE_TEMPLATE = "Interaction added for {name}."
INTERACTION_INVALID_MESSAGE = "Unable to add that interaction. Please try again."
INTERACTION_FAILURE_MESSAGE = (
    "Unable to add the interaction right now. Please try again later."
)


class AddInteractionCommandError(Exception):
    """An Interaction write failure that is safe to expose generically."""


def add_interaction_button(person_page_id, person_name):
    """A Block Kit button carrying the stable Person page id forward.

    The value is opaque structured JSON (not free text), so the Slack
    interaction payload - not a re-typed or re-resolved name - is the only
    source of Person identity used later by the write path.
    """
    return {
        "type": "button",
        "text": {"type": "plain_text", "text": "Add interaction"},
        "action_id": ADD_INTERACTION_ACTION_ID,
        "value": json.dumps({"page_id": person_page_id, "name": person_name}),
    }


def handle_add_interaction_submission(
    person_page_id,
    person_name,
    interaction_type,
    notes,
    date_value,
    post_slack_message,
    notion_post,
    notion_get,
    environment,
    thread_ts=None,
    today=None,
    sleep=time.sleep,
):
    """Validate and perform exactly one Interaction write.

    Gemini is never involved here: every field either comes from the fixed
    Person identity carried through the modal's structured state, a
    controlled dropdown, or free text preserved as-is. ``thread_ts`` keeps
    the confirmation/failure reply in the same Slack thread as the
    suggestion message the "Add interaction" button was clicked from,
    matching every other command's root-message/threaded-reply convention.
    """
    if not person_page_id or not person_name:
        # A malformed or spoofed submission with no Person identity to
        # attach to. Nothing safe to report; fail silently rather than
        # guessing a Person.
        return

    if interaction_type not in ALLOWED_INTERACTION_TYPES:
        post_slack_message(INTERACTION_INVALID_MESSAGE, thread_ts=thread_ts)
        return

    try:
        interaction_date = (
            date.fromisoformat(date_value)
            if date_value
            else (today or copenhagen_today())
        )
    except ValueError:
        post_slack_message(INTERACTION_INVALID_MESSAGE, thread_ts=thread_ts)
        return

    try:
        title_property_name = fetch_interactions_title_property(
            notion_get,
            environment["NOTION_API_KEY"],
            environment["NOTION_INTERACTIONS_DATA_SOURCE_ID"],
            sleep,
        )
        create_interaction_page(
            notion_post,
            environment["NOTION_API_KEY"],
            environment["NOTION_INTERACTIONS_DATA_SOURCE_ID"],
            person_page_id,
            person_name,
            interaction_type,
            notes or "",
            interaction_date,
            title_property_name,
            sleep,
        )
    except (TaskListCommandError, AddInteractionCommandError, NotionAuthenticationError):
        post_slack_message(INTERACTION_FAILURE_MESSAGE, thread_ts=thread_ts)
        return

    post_slack_message(
        INTERACTION_ADDED_MESSAGE_TEMPLATE.format(name=person_name),
        thread_ts=thread_ts,
    )


def fetch_interactions_title_property(
    notion_get, api_key, interactions_data_source_id, sleep
):
    """Resolve the Interactions data source's title property by its type.

    Every Notion page requires a value for its title property, whatever it
    is displayed as. Resolving it here at request time, rather than
    hardcoding a guessed display name, keeps the write correct even though
    this environment could not inspect the live schema beforehand.
    """
    response = call_notion_with_retries(
        lambda: notion_get(
            f"https://api.notion.com/v1/data_sources/{interactions_data_source_id}",
            headers=notion_headers(api_key),
            timeout=10,
        ),
        sleep,
        credential_failure_status_codes=(401,),
    )
    try:
        properties = response.json()["properties"]
        for display_name, definition in properties.items():
            if isinstance(definition, dict) and definition.get("type") == "title":
                return display_name
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        raise AddInteractionCommandError() from error
    raise AddInteractionCommandError()


def create_interaction_page(
    notion_post,
    api_key,
    interactions_data_source_id,
    person_page_id,
    person_name,
    interaction_type,
    notes,
    interaction_date,
    title_property_name,
    sleep,
):
    properties = {
        "People": {"relation": [{"id": person_page_id}]},
        "Type": {"select": {"name": interaction_type}},
        "Date": {"date": {"start": interaction_date.isoformat()}},
        "Notes": {
            "rich_text": (
                [{"type": "text", "text": {"content": notes}}] if notes else []
            )
        },
        title_property_name: {
            "title": [
                {
                    "type": "text",
                    "text": {"content": f"{person_name} – {interaction_type}"},
                }
            ]
        },
    }
    call_notion_with_retries(
        lambda: notion_post(
            "https://api.notion.com/v1/pages",
            headers=notion_headers(api_key),
            json={
                "parent": {"data_source_id": interactions_data_source_id},
                "properties": properties,
            },
            timeout=10,
        ),
        sleep,
    )
