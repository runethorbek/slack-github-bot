from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import math
import time
from zoneinfo import ZoneInfo

import requests


NOTION_API_VERSION = "2025-09-03"
TASKS_USAGE = "Usage: /tasks list"
TASKS_CHANNEL_REFUSAL = "The /tasks command is not available in this channel."
NO_TASKS_MESSAGE = "No tasks need attention right now."
MORE_TASKS_MESSAGE = "More tasks may need attention."
TASKS_FAILURE_MESSAGE = "Unable to retrieve tasks right now. Please try again later."
MAX_SCANNED_TASKS = 500
MAX_DISPLAYED_TASKS = 20
MAX_DISPLAYED_TRACKS = 3
NOTION_PAGE_SIZE = 100
MAX_NOTION_PAGES = MAX_SCANNED_TASKS // NOTION_PAGE_SIZE
PRIORITY_ORDER = {"High": 0, "Medium": 1, "Low": 2}
STATUS_DONE = "F\u00e6rdig"


@dataclass(frozen=True)
class Task:
    name: str
    url: str
    status: str | None
    follow_up: date | None
    priority: str | None
    track_ids: tuple[str, ...]


@dataclass(frozen=True)
class Track:
    name: str
    priority: str | None


class TaskListCommandError(Exception):
    """A Notion task-list failure that is safe to expose generically."""


class NotionAuthenticationError(RuntimeError):
    """A Notion credential failure that must fail the workflow clearly."""


class MalformedTaskPageError(ValueError):
    """A single task record cannot be interpreted using the expected schema."""


class MalformedTrackPageError(ValueError):
    """A Track record cannot be interpreted using the expected schema."""


def handle_tasks_command(
    command,
    text,
    _channel_id,
    post_slack_message,
    notion_post,
    environment,
    today=None,
    post_ephemeral_response=None,
    notion_get=None,
    sleep=time.sleep,
):
    """Handle the owned /tasks command family without using Gemini.

    Returning True means the command was fully handled and must not continue
    into the Gemini conversation path. False is reserved for other command
    families. ``today`` is injectable so date-based command behavior can be
    verified without relying on the runner clock.
    """
    if command != "/tasks":
        return False

    if text.strip().casefold() != "list":
        post_task_validation_response(
            TASKS_USAGE, post_slack_message, post_ephemeral_response
        )
        return True

    root_message = post_slack_message("/tasks list")
    try:
        command_today = today or copenhagen_today()
        pages, has_unexamined_tasks = fetch_tasks(
            notion_post,
            environment["NOTION_API_KEY"],
            environment["NOTION_TASKS_DATA_SOURCE_ID"],
            sleep=sleep,
        )
        eligible_tasks, skipped_task_count = select_tasks_needing_attention(
            pages, command_today
        )
        resolved_tracks = resolve_tracks(
            eligible_tasks,
            notion_get,
            environment["NOTION_API_KEY"],
            sleep=sleep,
        )
    except TaskListCommandError:
        post_slack_message(TASKS_FAILURE_MESSAGE, thread_ts=root_message["ts"])
        return True

    if eligible_tasks:
        message = format_task_list(eligible_tasks, command_today, resolved_tracks)
        if has_unexamined_tasks:
            message = f"{message}\n\n{MORE_TASKS_MESSAGE}"
    elif has_unexamined_tasks:
        # The bounded result is not complete, so the normal empty-state claim
        # would be misleading.
        message = MORE_TASKS_MESSAGE
    else:
        message = NO_TASKS_MESSAGE

    if skipped_task_count:
        noun = "task" if skipped_task_count == 1 else "tasks"
        message = f"{message}\n\nSkipped {skipped_task_count} malformed {noun}."

    post_slack_message(message, thread_ts=root_message["ts"])
    return True


def post_task_validation_response(message, post_slack_message, post_ephemeral_response):
    if post_ephemeral_response:
        post_ephemeral_response(message)
    else:
        post_slack_message(message)


def fetch_tasks(notion_post, api_key, data_source_id, sleep=time.sleep):
    """Fetch at most 500 non-finished task records from Notion.

    A true second result means Notion had another page after the examined set;
    that page is deliberately not fetched.
    """
    results = []
    cursor = None
    has_unexamined_tasks = False

    pages_fetched = 0
    while (
        len(results) < MAX_SCANNED_TASKS
        and pages_fetched < MAX_NOTION_PAGES
    ):
        request_json = {
            "page_size": min(NOTION_PAGE_SIZE, MAX_SCANNED_TASKS - len(results)),
            "filter": {
                "property": "Status",
                "status": {"does_not_equal": STATUS_DONE},
            },
        }
        if cursor:
            request_json["start_cursor"] = cursor

        response = call_notion_with_retries(
            lambda: notion_post(
                f"https://api.notion.com/v1/data_sources/{data_source_id}/query",
                headers=notion_headers(api_key),
                json=request_json,
                timeout=10,
            ),
            sleep,
        )
        pages_fetched += 1
        try:
            response_body = response.json()
        except (TypeError, ValueError) as error:
            raise TaskListCommandError() from error
        if not isinstance(response_body, dict):
            raise TaskListCommandError()
        page_results = response_body.get("results", [])
        if not isinstance(page_results, list):
            raise TaskListCommandError()
        remaining = MAX_SCANNED_TASKS - len(results)
        results.extend(page_results[:remaining])

        if len(page_results) > remaining:
            has_unexamined_tasks = True
            break
        if not response_body.get("has_more"):
            break

        cursor = response_body.get("next_cursor")
        if not cursor:
            # Do not issue an unsafe repeated request on a malformed pagination
            # response. It cannot be claimed complete.
            has_unexamined_tasks = True
            break
        if (
            len(results) == MAX_SCANNED_TASKS
            or pages_fetched == MAX_NOTION_PAGES
        ):
            has_unexamined_tasks = True
            break

    return results, has_unexamined_tasks


def select_tasks_needing_attention(pages, today):
    tasks = []
    skipped_task_count = 0
    for page in pages:
        try:
            tasks.append(task_from_notion_page(page))
        except MalformedTaskPageError:
            skipped_task_count += 1
    eligible_tasks = [task for task in tasks if needs_attention(task, today)]
    return sorted(eligible_tasks, key=task_sort_key)[:MAX_DISPLAYED_TASKS], skipped_task_count


def task_from_notion_page(page):
    try:
        properties = page["properties"]
        title_property = find_property(properties, "Name", "title")
        name = "".join(
            part.get("plain_text", "") for part in title_property.get("title", [])
        ).strip()
        url = page["url"]
        if not name or not url:
            raise MalformedTaskPageError("A task is missing its Name or URL")

        status_property = find_property(properties, "Status", "status")
        status = (status_property.get("status") or {}).get("name")
        priority_property = find_property(
            properties, "Priority", "select", required=False
        )
        priority = (
            (priority_property.get("select") or {}).get("name")
            if priority_property
            else None
        )
        follow_up_property = find_property(
            properties, "Follow-up", "date", required=False
        )
        follow_up_start = (
            (follow_up_property.get("date") or {}).get("start")
            if follow_up_property
            else None
        )
        track_property = properties.get("Track")
        if track_property and track_property.get("type") != "relation":
            track_property = None
        track_ids = tuple(
            relation["id"]
            for relation in (track_property.get("relation", []) if track_property else [])
            if relation.get("id")
        )
        return Task(
            name=name,
            url=url,
            status=status,
            follow_up=date.fromisoformat(follow_up_start) if follow_up_start else None,
            priority=priority,
            track_ids=track_ids,
        )
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        raise MalformedTaskPageError() from error


def resolve_tracks(tasks, notion_get, api_key, sleep=time.sleep):
    """Resolve each distinct Track at most once for this command."""
    resolved = {}
    for task in tasks:
        for track_id in task.track_ids:
            if track_id in resolved:
                continue

            if notion_get is None:
                resolved[track_id] = None
                continue

            try:
                response = call_notion_with_retries(
                    lambda: notion_get(
                        f"https://api.notion.com/v1/pages/{track_id}",
                        headers=notion_headers(api_key),
                        timeout=10,
                    ),
                    sleep,
                    credential_failure_status_codes=(401,),
                )
                try:
                    track_page = response.json()
                except (TypeError, ValueError) as error:
                    raise MalformedTrackPageError() from error
                resolved[track_id] = track_from_notion_page(track_page)
            except (TaskListCommandError, MalformedTrackPageError):
                # Track failures are intentionally isolated to the relation;
                # the task remains visible with a safe fallback.
                resolved[track_id] = None
    return resolved


def call_notion_with_retries(
    request, sleep, credential_failure_status_codes=(401, 403)
):
    """Make one Notion read, retrying only bounded transient failures."""
    for retry_number in range(3):
        try:
            response = request()
            response.raise_for_status()
            return response
        except Exception as error:
            status_code = external_error_status_code(error)
            if status_code in credential_failure_status_codes:
                raise NotionAuthenticationError(
                    f"Notion authentication failed (HTTP {status_code})."
                ) from None
            if not is_retryable_notion_error(error) or retry_number == 2:
                raise TaskListCommandError() from error
            sleep(retry_delay(error, retry_number))


def external_error_status_code(error):
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    return status_code if isinstance(status_code, int) else None


def is_retryable_notion_error(error):
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if status_code == 429 or (isinstance(status_code, int) and 500 <= status_code < 600):
        return True
    return isinstance(error, (requests.exceptions.Timeout, requests.exceptions.ConnectionError))


def retry_delay(error, retry_number):
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", {}) or {}
    retry_after = headers.get("Retry-After")
    try:
        delay = float(retry_after)
    except (TypeError, ValueError):
        delay = None
    if delay is not None and math.isfinite(delay) and delay >= 0:
        return delay
    if isinstance(retry_after, str):
        try:
            retry_at = parsedate_to_datetime(retry_after)
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            return max(0, (retry_at - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, IndexError, OverflowError):
            pass
    return 1 + retry_number


def track_from_notion_page(page):
    try:
        properties = page["properties"]
        name_property = properties.get("Navn")
        if not name_property or name_property.get("type") != "title":
            raise MalformedTrackPageError("A Track is missing its Navn")
        name = "".join(
            part.get("plain_text", "") for part in name_property.get("title", [])
        ).strip()
        if not name:
            raise MalformedTrackPageError("A Track is missing its Navn")

        priority_property = properties.get("Priority")
        if priority_property and priority_property.get("type") != "select":
            priority_property = None
        priority = (
            (priority_property.get("select") or {}).get("name")
            if priority_property
            else None
        )
        return Track(name=name, priority=priority)
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        raise MalformedTrackPageError() from error


def notion_headers(api_key):
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Notion-Version": NOTION_API_VERSION,
    }


def find_property(properties, display_name, property_type, required=True):
    property_value = properties.get(display_name)
    if property_value and (
        property_value.get("type") == property_type
        or property_type in property_value
    ):
        return property_value

    for candidate in properties.values():
        if candidate.get("type") == property_type or property_type in candidate:
            return candidate
        if property_type == "title" and candidate.get("id") == "title":
            return candidate

    if required:
        raise MalformedTaskPageError(f"A task is missing its {display_name} property")
    return None


def copenhagen_today():
    return datetime.now(ZoneInfo("Europe/Copenhagen")).date()


def needs_attention(task, today):
    return task.status != STATUS_DONE and (
        task.follow_up is None or task.follow_up <= today + timedelta(days=7)
    )


def task_sort_key(task):
    priority_rank = PRIORITY_ORDER.get(task.priority, len(PRIORITY_ORDER))
    name_key = task.name.casefold()
    if task.follow_up is None:
        return (1, date.max, priority_rank, name_key)
    return (0, task.follow_up, priority_rank, name_key)


def format_task_list(tasks, today, resolved_tracks=None):
    return "\n".join(
        format_task(task, today, resolved_tracks or {}) for task in tasks
    )


def format_task(task, today, resolved_tracks=None):
    priority = task.priority or "No priority"
    if task.follow_up is None:
        follow_up = "No follow-up"
    elif task.follow_up < today:
        follow_up = f"Overdue: {task.follow_up.isoformat()}"
    elif task.follow_up == today:
        follow_up = "Follow-up: today"
    else:
        follow_up = f"Follow-up: {task.follow_up.isoformat()}"

    track_text = format_tracks(task, resolved_tracks or {})
    return (
        f"• <{task.url}|{task.name}> — Priority: {priority} — "
        f"Track: {track_text} — {follow_up}"
    )


def format_tracks(task, resolved_tracks):
    if not task.track_ids:
        return "No track"

    available = [
        resolved_tracks.get(track_id)
        for track_id in task.track_ids
        if resolved_tracks.get(track_id) is not None
    ]
    available.sort(
        key=lambda track: (
            PRIORITY_ORDER.get(track.priority, len(PRIORITY_ORDER)),
            track.name.casefold(),
        )
    )
    unavailable_count = sum(
        resolved_tracks.get(track_id) is None for track_id in task.track_ids
    )
    names = [track.name for track in available]
    names.extend("Track unavailable" for _ in range(unavailable_count))
    displayed_names = names[:MAX_DISPLAYED_TRACKS]
    if len(task.track_ids) > MAX_DISPLAYED_TRACKS:
        displayed_names.append(
            f"+{len(task.track_ids) - MAX_DISPLAYED_TRACKS} more"
        )
    return ", ".join(displayed_names)
