import json
import time
from datetime import date

from people_due import PeopleDueCommandError, fetch_notion_pages
from tasks_list import (
    MalformedTrackPageError,
    NotionAuthenticationError,
    TaskListCommandError,
    call_notion_with_retries,
    copenhagen_today,
    notion_headers,
    track_from_notion_page,
)


# Matches ADD_INTERACTION_ACTION_ID in api/slack-request.js.
ADD_INTERACTION_ACTION_ID = "people_add_interaction"

# Matches ADD_INTERACTION_CALLBACK_ID in api/slack-request.js.
ADD_INTERACTION_CALLBACK_ID = "add_interaction_modal"

# Notion property name for the Interactions Track relation, exactly as
# named in the live schema (docs/notion-interactions-schema.md).
INTERACTION_TRACK_PROPERTY = "Track"

# Bounds both the Track selector's option list and the validation query
# below to a single Notion request, well above the small number of Tracks
# this workspace actually has, and under Slack's 100-option static_select
# cap.
MAX_TRACK_OPTIONS = 25

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


def add_interaction_button(person_page_id, person_name, tracks=(), default_track_id=None):
    """A Block Kit button carrying the stable Person page id forward.

    The value is opaque structured JSON (not free text), so the Slack
    interaction payload - not a re-typed or re-resolved name - is the only
    source of Person identity used later by the write path. ``tracks`` (a
    sequence of {"id", "name"} options already resolved from Notion) and
    ``default_track_id`` are carried the same way, so the Vercel webhook
    that opens the modal never needs Notion access of its own - it only
    ever renders data Python already resolved. When there are no tracks to
    offer, both are simply omitted rather than sent as empty placeholders.
    """
    value = {"page_id": person_page_id, "name": person_name}
    if tracks:
        value["tracks"] = list(tracks)
        if default_track_id:
            value["default_track_id"] = default_track_id
    return {
        "type": "button",
        "text": {"type": "plain_text", "text": "Add interaction"},
        "action_id": ADD_INTERACTION_ACTION_ID,
        "value": json.dumps(value),
    }


def fetch_available_tracks(notion_post, api_key, tracks_data_source_id, sleep):
    """Fetch up to MAX_TRACK_OPTIONS Tracks as {"id", "name"} options.

    Used both to populate the Track selector (people_suggest.py) and,
    independently, to validate a submitted Track id against the live
    Tracks data source before any write - a client-supplied id is never
    trusted on its own. A malformed individual Track page is skipped
    rather than failing the whole listing; a Notion request failure
    (including a credential failure) propagates to the caller, matching
    every other Notion read in this codebase.
    """

    def build_request_json(cursor):
        request_json = {"page_size": MAX_TRACK_OPTIONS}
        if cursor:
            request_json["start_cursor"] = cursor
        return request_json

    try:
        pages, _ = fetch_notion_pages(
            notion_post,
            api_key,
            tracks_data_source_id,
            build_request_json,
            MAX_TRACK_OPTIONS,
            MAX_TRACK_OPTIONS,
            sleep,
        )
    except PeopleDueCommandError as error:
        raise AddInteractionCommandError() from error

    options = []
    for page in pages[:MAX_TRACK_OPTIONS]:
        try:
            page_id = page["id"]
            track = track_from_notion_page(page)
        except (MalformedTrackPageError, KeyError, TypeError):
            continue
        if page_id:
            options.append({"id": page_id, "name": track.name})
    options.sort(key=lambda option: option["name"].casefold())
    return options


def is_valid_track(track_id, notion_post, api_key, tracks_data_source_id, sleep):
    """Confirm a submitted Track id names a real, current Track record.

    A manipulated or stale id (an id no longer among the live Tracks, or
    never a Track at all) must not reach the write path. An unconfigured
    Tracks data source fails closed rather than silently accepting an
    unverifiable id.
    """
    if not tracks_data_source_id:
        return False
    available_tracks = fetch_available_tracks(
        notion_post, api_key, tracks_data_source_id, sleep
    )
    return any(option["id"] == track_id for option in available_tracks)


def handle_add_interaction_submission(
    person_page_id,
    person_name,
    interaction_type,
    notes,
    date_value,
    track_id,
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
    controlled dropdown, or free text preserved as-is. ``track_id`` is
    optional (Slack sends "" when the Track selector was left empty) and,
    when present, is independently re-validated against the live Tracks
    data source below rather than trusted from the submission alone.
    ``thread_ts`` keeps the confirmation/failure reply in the same Slack
    thread as the suggestion message the "Add interaction" button was
    clicked from, matching every other command's root-message/threaded-reply
    convention.
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
        if track_id and not is_valid_track(
            track_id,
            notion_post,
            environment["NOTION_API_KEY"],
            environment.get("NOTION_TRACKS_DATA_SOURCE_ID", ""),
            sleep,
        ):
            post_slack_message(INTERACTION_INVALID_MESSAGE, thread_ts=thread_ts)
            return

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
            track_id,
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
    track_id,
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
        INTERACTION_TRACK_PROPERTY: {
            "relation": [{"id": track_id}] if track_id else []
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
