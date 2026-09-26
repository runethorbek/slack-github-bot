import json
import re
import time
from dataclasses import dataclass
from datetime import date, timedelta

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

# Matches ADD_SUGGESTED_FOLLOWUP_TASK_ACTION_ID in api/slack-request.js,
# which opens the same Task modal (same callback_id) with the suggestion
# prefilled. Slack requires unique action_ids within one actions block.
ADD_SUGGESTED_FOLLOWUP_TASK_ACTION_ID = "add_suggested_followup_task"

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

# Slack's maximum length for a Block Kit button's text.
SLACK_BUTTON_TEXT_LIMIT = 75

# Bounds on a Gemini-suggested Task, enforced by Python whatever Gemini
# returns. An invalid name discards the whole suggestion; an invalid
# description or follow-up date is dropped on its own.
MAX_SUGGESTED_TASK_NAME_CHARS = 150
MAX_SUGGESTED_TASK_DESCRIPTION_CHARS = 500
MAX_SUGGESTED_FOLLOW_UP_DAYS = 365

ISO_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")

FOLLOWUP_SUGGESTION_SYSTEM_INSTRUCTION = """
You are reading the notes the user just saved about an Interaction with a
Person, to decide whether they contain a concrete commitment the user
should track as a follow-up Task. The user reviews and edits any
suggestion before anything is saved.

Rules:
- Use only the Interaction supplied below.
- Suggest a Task only when the notes contain a concrete commitment or
  agreed next action (for example "agreed to send the AI article").
  Otherwise, suggest nothing. Do not invent commitments.
- Suggest at most one Task.
- "name" is a short imperative Task name, at most 150 characters.
- "description" is optional: at most 500 characters of useful detail from
  the notes. Omit it when there is nothing to add beyond the name.
- "follow_up" is optional: an absolute date in the form YYYY-MM-DD, only
  when the notes state or clearly imply when to follow up. Resolve
  relative dates ("next week", "Friday") using TODAY below. Omit it
  otherwise.
- Respond with only a JSON object and no other text or formatting:
  {"task": null} when there is no follow-up, or
  {"task": {"name": "...", "description": "...", "follow_up": "YYYY-MM-DD"}}.
"""

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
class SuggestedTask:
    """A Gemini-suggested Task that has passed Python's validation."""

    name: str
    description: str | None = None
    follow_up: date | None = None


@dataclass(frozen=True)
class TasksSchema:
    """The parts of the live Tasks schema this write path depends on."""

    title_property_name: str
    priorities: list[str]
    statuses: list[str]
    has_description: bool


def followup_task_button(
    person_page_id,
    person_name,
    tracks=(),
    default_track_id=None,
    priorities=(),
    suggested_task=None,
):
    """A Block Kit button carrying everything the Task modal needs.

    Mirrors add_interaction_button: Person identity, Track options, the
    default Track and the live Priority options are all resolved by Python
    ahead of time and carried opaquely in the value, so the Vercel webhook
    that opens the modal never needs Notion access of its own. With a
    validated ``suggested_task`` the button instead opens the same modal
    with its Name, Description and Follow-up prefilled.
    """
    value = {"page_id": person_page_id, "name": person_name}
    if priorities:
        value["priorities"] = list(priorities)
    if tracks:
        value["tracks"] = list(tracks)
        if default_track_id:
            value["default_track_id"] = default_track_id
    if suggested_task is None:
        text = "Add follow-up task"
        action_id = ADD_FOLLOWUP_TASK_ACTION_ID
    else:
        value["task_name"] = suggested_task.name
        if suggested_task.description:
            value["task_description"] = suggested_task.description
        if suggested_task.follow_up:
            value["task_follow_up"] = suggested_task.follow_up.isoformat()
        text = truncate_button_text(f"Add task: {suggested_task.name}")
        action_id = ADD_SUGGESTED_FOLLOWUP_TASK_ACTION_ID
    return {
        "type": "button",
        "text": {"type": "plain_text", "text": text},
        "action_id": action_id,
        "value": json.dumps(value),
    }


def truncate_button_text(text):
    if len(text) <= SLACK_BUTTON_TEXT_LIMIT:
        return text
    suffix = "…"
    return text[: SLACK_BUTTON_TEXT_LIMIT - len(suffix)] + suffix


def build_followup_task_buttons(
    person_page_id,
    person_name,
    track_id,
    interaction_type,
    notes,
    interaction_date,
    notion_post,
    notion_get,
    environment,
    generate_text=None,
    today=None,
    sleep=time.sleep,
):
    """Resolve the Task modal buttons, or an empty list if none can be.

    Called only after an Interaction was saved. Any failure here means the
    Interaction confirmation is posted without the buttons rather than
    failing the (already successful) Interaction write. An unconfigured
    Tracks data source simply yields no Track options, as elsewhere.

    Besides the plain "Add follow-up task" button, non-empty Interaction
    Notes lead to one Gemini call (``generate_text``) that may suggest a
    prefilled Task; any Gemini failure or invalid output just means that
    second button is omitted.
    """
    tasks_data_source_id = environment.get("NOTION_TASKS_DATA_SOURCE_ID", "")
    if not tasks_data_source_id:
        return []
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
        return []
    default_track_id = (
        track_id if any(track["id"] == track_id for track in tracks) else None
    )
    buttons = [
        followup_task_button(
            person_page_id, person_name, tracks, default_track_id, schema.priorities
        )
    ]
    suggested_task = (
        suggest_followup_task(
            generate_text,
            person_name,
            interaction_type,
            notes,
            interaction_date,
            today or copenhagen_today(),
        )
        if generate_text and (notes or "").strip()
        else None
    )
    if suggested_task is not None:
        buttons.append(
            followup_task_button(
                person_page_id,
                person_name,
                tracks,
                default_track_id,
                schema.priorities,
                suggested_task,
            )
        )
    # Slack rejects the whole message if a button value is too long, which
    # would also lose the Interaction confirmation; omit that button instead.
    return [
        button
        for button in buttons
        if len(button["value"]) <= SLACK_BUTTON_VALUE_LIMIT
    ]


def suggest_followup_task(
    generate_text, person_name, interaction_type, notes, interaction_date, today
):
    """Ask Gemini for at most one follow-up Task, or None.

    Gemini only sees the just-saved Interaction and today's date. Any
    exception is treated as "no suggestion" (no retries), and neither the
    prompt nor the response is ever logged.
    """
    prompt = build_followup_suggestion_prompt(
        person_name, interaction_type, notes, interaction_date, today
    )
    try:
        response = generate_text(prompt)
    except Exception:
        return None
    return parse_suggested_task(response, today)


def build_followup_suggestion_prompt(
    person_name, interaction_type, notes, interaction_date, today
):
    return (
        f"{FOLLOWUP_SUGGESTION_SYSTEM_INSTRUCTION}\n"
        f"TODAY: {today.isoformat()}\n\n"
        "INTERACTION:\n"
        f"Person: {person_name}\n"
        f"Date: {interaction_date.isoformat()}\n"
        f"Type: {interaction_type}\n"
        f"Notes: {notes.strip()}\n"
    )


def parse_suggested_task(response, today):
    """Validate Gemini's response into a SuggestedTask, or None.

    Anything but the expected JSON structure, or a missing, blank or
    over-long name, means no suggestion. An over-long description and an
    invalid, past or too-distant follow-up date are dropped on their own.
    A single surrounding Markdown code fence is tolerated.
    """
    if not isinstance(response, str):
        return None
    text = response.strip()
    fence = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    task = parsed.get("task")
    if not isinstance(task, dict):
        return None

    name = task.get("name")
    if not isinstance(name, str):
        return None
    name = name.strip()
    if not name or len(name) > MAX_SUGGESTED_TASK_NAME_CHARS:
        return None

    description = task.get("description")
    description = description.strip() if isinstance(description, str) else ""
    if len(description) > MAX_SUGGESTED_TASK_DESCRIPTION_CHARS:
        description = ""

    return SuggestedTask(
        name,
        description or None,
        parse_suggested_follow_up(task.get("follow_up"), today),
    )


def parse_suggested_follow_up(value, today):
    if not isinstance(value, str) or not ISO_DATE_PATTERN.match(value):
        return None
    try:
        follow_up = date.fromisoformat(value)
    except ValueError:
        return None
    if not today <= follow_up <= today + timedelta(days=MAX_SUGGESTED_FOLLOW_UP_DAYS):
        return None
    return follow_up


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
