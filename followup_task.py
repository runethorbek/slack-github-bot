import json
import time
from dataclasses import dataclass
from datetime import date

from people_interaction import (
    AddInteractionCommandError,
    fetch_available_tracks,
    is_valid_track,
)
from tasks_list import (
    NotionAuthenticationError,
    TaskListCommandError,
    call_notion_with_retries,
    copenhagen_today,
    external_error_status_code,
    notion_headers,
)


# Matches ADD_FOLLOWUP_TASK_ACTION_ID in api/slack-request.js.
ADD_FOLLOWUP_TASK_ACTION_ID = "add_followup_task"

# Matches ADD_FOLLOWUP_TASK_CALLBACK_ID in api/slack-request.js, which
# forwards it as SLACK_VIEW_CALLBACK_ID so main.py can tell this
# submission apart from an Add Interaction one.
ADD_FOLLOWUP_TASK_CALLBACK_ID = "add_followup_task_modal"

# Notion Tasks property names, exactly as named in the live schema
# (docs/notion-tasks-schema.md). The title property is resolved by type at
# request time instead, as for Interactions.
TASK_PEOPLE_PROPERTY = "People"
TASK_TRACK_PROPERTY = "Track"
TASK_PRIORITY_PROPERTY = "Priority"
TASK_STATUS_PROPERTY = "Status"
TASK_FOLLOW_UP_PROPERTY = "Follow-up"
TASK_CREATED_PROPERTY = "Created"
TASK_DESCRIPTION_PROPERTY = "Description"

# Every follow-up Task starts in this exact existing Status, matching the
# Danish Status names tasks_list.py already relies on. It is checked
# against the live schema before each write and never created.
TASK_STATUS_NOT_STARTED = "Ikke startet"

# Slack's maximum length for a Block Kit button value.
SLACK_BUTTON_VALUE_LIMIT = 2000

FOLLOWUP_TASK_ADDED_MESSAGE_TEMPLATE = "Follow-up task added for {name}: {task}"
FOLLOWUP_TASK_INVALID_MESSAGE = (
    "Unable to add that follow-up task. Please try again."
)
FOLLOWUP_TASK_FAILURE_MESSAGE = (
    "Unable to add the follow-up task right now. Please try again later."
)
FOLLOWUP_TASK_UNCERTAIN_MESSAGE = (
    "The follow-up task may not have been added. Check Notion before trying again."
)
FOLLOWUP_TASK_STATUS_MISSING_MESSAGE = (
    f'Unable to add the follow-up task: Notion Tasks has no "{TASK_STATUS_NOT_STARTED}" Status.'
)


class FollowupTaskCommandError(Exception):
    """A Task write failure that is safe to expose generically."""


@dataclass(frozen=True)
class TasksSchema:
    """The parts of the live Tasks schema this write path depends on."""

    title_property_name: str
    priorities: list[str]
    statuses: list[str]
    has_description: bool


def followup_task_button(
    person_page_id, person_name, tracks=(), default_track_id=None, priorities=()
):
    """A Block Kit button carrying everything the Task modal needs.

    Mirrors add_interaction_button: Person identity, Track options, the
    default Track and the live Priority options are all resolved by Python
    ahead of time and carried opaquely in the value, so the Vercel webhook
    that opens the modal never needs Notion access of its own.
    """
    value = {"page_id": person_page_id, "name": person_name}
    if priorities:
        value["priorities"] = list(priorities)
    if tracks:
        value["tracks"] = list(tracks)
        if default_track_id:
            value["default_track_id"] = default_track_id
    return {
        "type": "button",
        "text": {"type": "plain_text", "text": "Add follow-up task"},
        "action_id": ADD_FOLLOWUP_TASK_ACTION_ID,
        "value": json.dumps(value),
    }


def build_followup_task_button(
    person_page_id,
    person_name,
    track_id,
    notion_post,
    notion_get,
    environment,
    sleep=time.sleep,
):
    """Resolve the Task modal's options, or None if they cannot be resolved.

    Called only after an Interaction was saved. Any failure here means the
    Interaction confirmation is posted without the button rather than
    failing the (already successful) Interaction write. An unconfigured
    Tracks data source simply yields no Track options, as elsewhere.
    """
    tasks_data_source_id = environment.get("NOTION_TASKS_DATA_SOURCE_ID", "")
    if not tasks_data_source_id:
        return None
    api_key = environment["NOTION_API_KEY"]
    tracks_data_source_id = environment.get("NOTION_TRACKS_DATA_SOURCE_ID", "")
    try:
        schema = fetch_tasks_schema(notion_get, api_key, tasks_data_source_id, sleep)
        tracks = (
            fetch_available_tracks(notion_post, api_key, tracks_data_source_id, sleep)
            if tracks_data_source_id
            else []
        )
    except (
        TaskListCommandError,
        AddInteractionCommandError,
        FollowupTaskCommandError,
        NotionAuthenticationError,
    ):
        return None
    default_track_id = (
        track_id if any(track["id"] == track_id for track in tracks) else None
    )
    button = followup_task_button(
        person_page_id, person_name, tracks, default_track_id, schema.priorities
    )
    # Slack rejects the whole message if a button value is too long, which
    # would also lose the Interaction confirmation; omit the button instead.
    if len(button["value"]) > SLACK_BUTTON_VALUE_LIMIT:
        return None
    return button


def fetch_tasks_schema(notion_get, api_key, tasks_data_source_id, sleep):
    """Read the title property, Priority/Status options and Description.

    Notion is the only source of truth for Priority and Status values. A
    malformed schema response is a failure, not an empty allowlist - except
    that a missing Priority property just means no Priority options, and a
    missing or non-rich_text Description just means no Description is
    written, since both are optional on a Task.
    """
    response = call_notion_with_retries(
        lambda: notion_get(
            f"https://api.notion.com/v1/data_sources/{tasks_data_source_id}",
            headers=notion_headers(api_key),
            timeout=10,
        ),
        sleep,
        credential_failure_status_codes=(401,),
    )
    try:
        properties = response.json()["properties"]
        title_property_name = next(
            display_name
            for display_name, definition in properties.items()
            if isinstance(definition, dict) and definition.get("type") == "title"
        )
        priority_property = properties.get(TASK_PRIORITY_PROPERTY)
        status_property = properties[TASK_STATUS_PROPERTY]
        description_property = properties.get(TASK_DESCRIPTION_PROPERTY)
        if (
            priority_property is not None
            and priority_property.get("type") != "select"
        ) or status_property.get("type") != "status":
            raise FollowupTaskCommandError()
        return TasksSchema(
            title_property_name,
            option_names(priority_property["select"]["options"])
            if priority_property is not None
            else [],
            option_names(status_property["status"]["options"]),
            isinstance(description_property, dict)
            and description_property.get("type") == "rich_text",
        )
    except (AttributeError, KeyError, StopIteration, TypeError, ValueError) as error:
        raise FollowupTaskCommandError() from error


def option_names(options):
    return [
        option["name"]
        for option in options
        if isinstance(option, dict) and option.get("name")
    ]


def parse_task_payload(value):
    """Decode the bundled Task fields from a follow-up Task submission.

    Matches api/slack-request.js: the fields travel together as one JSON
    field (SLACK_TASK) to stay within GitHub's 10-property client_payload
    limit. Malformed JSON yields empty fields, which validation rejects.
    """
    try:
        parsed = json.loads(value) if value else {}
    except ValueError:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    return {
        field: parsed.get(field) if isinstance(parsed.get(field), str) else ""
        for field in ("name", "description", "follow_up", "priority", "track_id")
    }


def handle_add_followup_task_submission(
    person_page_id,
    person_name,
    task_name,
    description,
    follow_up_value,
    priority,
    track_id,
    post_slack_message,
    notion_post,
    notion_get,
    environment,
    thread_ts=None,
    today=None,
    sleep=time.sleep,
):
    """Validate and perform exactly one Task write.

    Gemini is never involved. Person identity comes from the modal's
    structured state; Priority and Track are re-validated against live
    Notion data rather than trusted from the submission. ``description`` is
    the user's own typed text (Interaction notes are never copied); blank
    means Description is left unset.
    """
    if not person_page_id or not person_name:
        # No Person to link the Task to; nothing safe to report.
        return

    task_name = (task_name or "").strip()
    if not task_name:
        post_slack_message(FOLLOWUP_TASK_INVALID_MESSAGE, thread_ts=thread_ts)
        return
    description = (description or "").strip()

    try:
        follow_up = date.fromisoformat(follow_up_value) if follow_up_value else None
    except ValueError:
        post_slack_message(FOLLOWUP_TASK_INVALID_MESSAGE, thread_ts=thread_ts)
        return

    api_key = environment["NOTION_API_KEY"]
    tasks_data_source_id = environment.get("NOTION_TASKS_DATA_SOURCE_ID", "")
    try:
        if not tasks_data_source_id:
            raise FollowupTaskCommandError()
        schema = fetch_tasks_schema(notion_get, api_key, tasks_data_source_id, sleep)

        if priority and priority not in schema.priorities:
            post_slack_message(FOLLOWUP_TASK_INVALID_MESSAGE, thread_ts=thread_ts)
            return

        if track_id and not is_valid_track(
            track_id,
            notion_post,
            api_key,
            environment.get("NOTION_TRACKS_DATA_SOURCE_ID", ""),
            sleep,
        ):
            post_slack_message(FOLLOWUP_TASK_INVALID_MESSAGE, thread_ts=thread_ts)
            return

        if TASK_STATUS_NOT_STARTED not in schema.statuses:
            post_slack_message(
                FOLLOWUP_TASK_STATUS_MISSING_MESSAGE, thread_ts=thread_ts
            )
            return

        try:
            create_task_page(
                notion_post,
                api_key,
                tasks_data_source_id,
                schema.title_property_name,
                task_name,
                description if schema.has_description else "",
                person_page_id,
                track_id,
                priority,
                follow_up,
                today or copenhagen_today(),
                sleep,
            )
        except TaskListCommandError as error:
            # A timeout, connection error or 5xx may arrive after Notion
            # already created the page; a blind retry could duplicate it.
            status_code = external_error_status_code(error.__cause__)
            if status_code is None or status_code >= 500:
                post_slack_message(
                    FOLLOWUP_TASK_UNCERTAIN_MESSAGE, thread_ts=thread_ts
                )
                return
            raise
    except (
        TaskListCommandError,
        AddInteractionCommandError,
        FollowupTaskCommandError,
        NotionAuthenticationError,
    ):
        post_slack_message(FOLLOWUP_TASK_FAILURE_MESSAGE, thread_ts=thread_ts)
        return

    post_slack_message(
        FOLLOWUP_TASK_ADDED_MESSAGE_TEMPLATE.format(name=person_name, task=task_name),
        thread_ts=thread_ts,
    )


def create_task_page(
    notion_post,
    api_key,
    tasks_data_source_id,
    title_property_name,
    task_name,
    description,
    person_page_id,
    track_id,
    priority,
    follow_up,
    created,
    sleep,
):
    properties = {
        title_property_name: {
            "title": [{"type": "text", "text": {"content": task_name}}]
        },
        TASK_PEOPLE_PROPERTY: {"relation": [{"id": person_page_id}]},
        TASK_STATUS_PROPERTY: {"status": {"name": TASK_STATUS_NOT_STARTED}},
        TASK_CREATED_PROPERTY: {"date": {"start": created.isoformat()}},
    }
    if track_id:
        properties[TASK_TRACK_PROPERTY] = {"relation": [{"id": track_id}]}
    if priority:
        properties[TASK_PRIORITY_PROPERTY] = {"select": {"name": priority}}
    if description:
        properties[TASK_DESCRIPTION_PROPERTY] = {
            "rich_text": [{"type": "text", "text": {"content": description}}]
        }
    if follow_up:
        properties[TASK_FOLLOW_UP_PROPERTY] = {
            "date": {"start": follow_up.isoformat()}
        }
    call_notion_with_retries(
        lambda: notion_post(
            "https://api.notion.com/v1/pages",
            headers=notion_headers(api_key),
            json={
                "parent": {"data_source_id": tasks_data_source_id},
                "properties": properties,
            },
            timeout=10,
        ),
        sleep,
        is_retryable=is_rejected_before_processing,
    )


def is_rejected_before_processing(error):
    """Only a 429 is safe to retry for a Task create.

    A timeout, connection error or 5xx may arrive after Notion already
    created the page, so retrying those could duplicate the Task.
    """
    return external_error_status_code(error) == 429
